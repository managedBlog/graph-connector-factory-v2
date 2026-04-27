/**
 * HTTP client for the Microsoft Graph API — Entra ID application management.
 *
 * Endpoints used:
 *   - POST   /applications                     → createApplication
 *   - GET    /applications/{id}                 → getApplication
 *   - GET    /applications?$filter=...          → listApplicationsByDisplayName
 *   - PATCH  /applications/{id}                 → updateApplication
 *   - DELETE /applications/{id}                 → deleteApplication
 *   - POST   /applications/{id}/addPassword     → addPassword
 *   - POST   /applications/{id}/removePassword  → removePassword
 *   - POST   /applications/{id}/federatedIdentityCredentials → addFederatedIdentityCredential
 *   - GET    /applications/{id}/federatedIdentityCredentials → listFederatedIdentityCredentials
 *   - DELETE /applications/{id}/federatedIdentityCredentials/{ficId} → deleteFederatedIdentityCredential
 *   - PATCH  /applications/{id}                 → updateRedirectUris (via updateApplication)
 *   - PATCH  /applications/{id}                 → addRequiredResourceAccess (merge permissions)
 *   - GET    /applications/{id}                 → getRequiredResourceAccess
 *   - POST   /servicePrincipals                 → createServicePrincipal
 *   - GET    /servicePrincipals?$filter=...     → getServicePrincipalByAppId
 *   - POST   /oauth2PermissionGrants            → grantOAuth2Permissions
 *   - GET    /oauth2PermissionGrants?$filter=...→ listOAuth2PermissionGrants
 */

import { CredentialProvider } from "../../auth/types";
import { log, logDebug, logError } from "../../logging/logger";
import {
  Application,
  ApplicationCreatePayload,
  ApplicationUpdatePayload,
  AddPasswordPayload,
  RemovePasswordPayload,
  PasswordCredential,
  FederatedIdentityCredential,
  FederatedIdentityCredentialCreatePayload,
  FederatedIdentityCredentialListResponse,
  ServicePrincipal,
  ServicePrincipalCreatePayload,
  OAuth2PermissionGrant,
  OAuth2PermissionGrantPayload,
  RequiredResourceAccess,
  GraphListResponse,
} from "./types";

export interface GraphClientOptions {
  readonly baseUrl: string;
  readonly apiVersion: string;
  readonly scope: string;
}

const ORIGIN_HEADER = "graph-connector-factory";

/** Exponential backoff delay (ms) for retries. */
function backoffDelay(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 30000);
}

export class GraphClient {
  private readonly options: GraphClientOptions;
  private readonly credential: CredentialProvider;

  constructor(credential: CredentialProvider, options: GraphClientOptions) {
    this.credential = credential;
    this.options = options;
  }

  /* ── Private helpers ── */

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const tokenResult = await this.credential.getToken(this.options.scope);
    return {
      Authorization: `Bearer ${tokenResult.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-ms-origin": ORIGIN_HEADER,
    };
  }

  private url(path: string): string {
    return `${this.options.baseUrl}/${this.options.apiVersion}/${path}`;
  }

  private async request<T>(
    method: string,
    url: string,
    body?: unknown,
    maxRetries: number = 3
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = backoffDelay(attempt);
        logDebug(`Retry ${attempt}/${maxRetries} after ${delay}ms…`);
        await new Promise((r) => setTimeout(r, delay));
      }

      const headers = await this.getAuthHeaders();
      const fetchOptions: RequestInit = { method, headers };
      if (body !== undefined) {
        fetchOptions.body = JSON.stringify(body);
      }

      logDebug(`${method} ${url}`);

      let response: Response;
      try {
        response = await fetch(url, fetchOptions);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logError(`Network error: ${lastError.message}`);
        continue;
      }

      // Retry on 429 (throttled) or 5xx
      if (response.status === 429 || response.status >= 500) {
        const errorText = await response.text().catch(() => "");
        lastError = new Error(`HTTP ${response.status}: ${errorText}`);

        // Respect Retry-After header
        const retryAfterHeader = response.headers.get("Retry-After");
        if (retryAfterHeader) {
          const retryMs = parseInt(retryAfterHeader, 10) * 1000;
          if (!isNaN(retryMs) && retryMs > 0) {
            logDebug(`Retry-After header: waiting ${retryMs}ms…`);
            await new Promise((r) => setTimeout(r, retryMs));
          }
        }

        logError(`Retryable error (${response.status}): ${errorText.slice(0, 200)}`);
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`Graph API error ${response.status}: ${errorText}`);
      }

      // 204 No Content
      if (response.status === 204) {
        return {} as T;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        return {} as T;
      }

      return (await response.json()) as T;
    }

    throw lastError ?? new Error("Request failed after retries.");
  }

  /* ── Applications ── */

  /**
   * Create a new application (app registration).
   */
  async createApplication(payload: ApplicationCreatePayload): Promise<Application> {
    const url = this.url("applications");
    log(`Creating app registration '${payload.displayName}'…`);
    return this.request<Application>("POST", url, payload);
  }

  /**
   * Get an application by its object ID.
   */
  async getApplication(objectId: string): Promise<Application> {
    const url = this.url(`applications/${objectId}`);
    logDebug(`Getting app registration ${objectId}…`);
    return this.request<Application>("GET", url);
  }

  /**
   * List applications by display name (exact match).
   * Returns all matching applications.
   */
  async listApplicationsByDisplayName(displayName: string): Promise<Application[]> {
    const filter = encodeURIComponent(`displayName eq '${displayName}'`);
    const url = this.url(`applications?$filter=${filter}`);
    logDebug(`Searching apps by displayName='${displayName}'…`);
    const response = await this.request<GraphListResponse<Application>>("GET", url);
    return [...response.value];
  }

  /**
   * Update an application's properties.
   */
  async updateApplication(
    objectId: string,
    payload: ApplicationUpdatePayload
  ): Promise<void> {
    const url = this.url(`applications/${objectId}`);
    log(`Updating app registration ${objectId}…`);
    await this.request<unknown>("PATCH", url, payload);
  }

  /**
   * Delete an application permanently.
   */
  async deleteApplication(objectId: string): Promise<void> {
    const url = this.url(`applications/${objectId}`);
    log(`Deleting app registration ${objectId}…`);
    await this.request<unknown>("DELETE", url);
  }

  /* ── Password Credentials (Client Secrets) ── */

  /**
   * Add a client secret (password credential) to an application.
   * Returns the full PasswordCredential including the secretText (visible only once).
   */
  async addPassword(
    objectId: string,
    displayName?: string,
    endDateTime?: string
  ): Promise<PasswordCredential> {
    const url = this.url(`applications/${objectId}/addPassword`);
    const payload: AddPasswordPayload = {
      passwordCredential: {
        ...(displayName ? { displayName } : {}),
        ...(endDateTime ? { endDateTime } : {}),
      },
    };
    log(`Adding client secret to app ${objectId}…`);
    return this.request<PasswordCredential>("POST", url, payload);
  }

  /**
   * Remove a client secret from an application by keyId.
   */
  async removePassword(objectId: string, keyId: string): Promise<void> {
    const url = this.url(`applications/${objectId}/removePassword`);
    const payload: RemovePasswordPayload = { keyId };
    log(`Removing client secret ${keyId} from app ${objectId}…`);
    await this.request<unknown>("POST", url, payload);
  }

  /* ── Federated Identity Credentials ── */

  /**
   * Add a federated identity credential to an application.
   */
  async addFederatedIdentityCredential(
    objectId: string,
    payload: FederatedIdentityCredentialCreatePayload
  ): Promise<FederatedIdentityCredential> {
    const url = this.url(`applications/${objectId}/federatedIdentityCredentials`);
    log(`Adding FIC '${payload.name}' (subject: ${payload.subject}) to app ${objectId}…`);
    return this.request<FederatedIdentityCredential>("POST", url, payload);
  }

  /**
   * List all federated identity credentials for an application.
   */
  async listFederatedIdentityCredentials(
    objectId: string
  ): Promise<FederatedIdentityCredential[]> {
    const url = this.url(`applications/${objectId}/federatedIdentityCredentials`);
    logDebug(`Listing FICs for app ${objectId}…`);
    const response = await this.request<FederatedIdentityCredentialListResponse>("GET", url);
    return [...response.value];
  }

  /**
   * Get a federated identity credential by subject match.
   * Returns null if no match found.
   */
  async getFederatedIdentityCredentialBySubject(
    objectId: string,
    subject: string
  ): Promise<FederatedIdentityCredential | null> {
    const fics = await this.listFederatedIdentityCredentials(objectId);
    return fics.find((f) => f.subject === subject) ?? null;
  }

  /**
   * Delete a federated identity credential by its ID.
   */
  async deleteFederatedIdentityCredential(
    objectId: string,
    ficId: string
  ): Promise<void> {
    const url = this.url(`applications/${objectId}/federatedIdentityCredentials/${ficId}`);
    log(`Deleting FIC ${ficId} from app ${objectId}…`);
    await this.request<unknown>("DELETE", url);
  }

  /* ── Redirect URIs ── */

  /**
   * Update redirect URIs for an application.
   * Merges with existing redirect URIs (union) rather than replacing.
   */
  async updateRedirectUris(
    objectId: string,
    redirectUris: string[],
    platform: "web" | "spa" | "publicClient" = "web"
  ): Promise<void> {
    // First, get current app to merge URIs
    const app = await this.getApplication(objectId);

    let existingUris: readonly string[] = [];
    if (platform === "web") {
      existingUris = app.web?.redirectUris ?? [];
    } else if (platform === "spa") {
      existingUris = app.spa?.redirectUris ?? [];
    } else {
      existingUris = app.publicClient?.redirectUris ?? [];
    }

    // Merge (deduplicate)
    const merged = [...new Set([...existingUris, ...redirectUris])];

    const payload: ApplicationUpdatePayload = {
      [platform === "publicClient" ? "publicClient" : platform]: {
        redirectUris: merged,
      },
    };

    log(`Updating ${platform} redirect URIs for app ${objectId}: ${merged.length} URIs…`);
    await this.updateApplication(objectId, payload);
  }

  /* ── Service Principals ── */

  /**
   * Create a service principal for an application.
   */
  async createServicePrincipal(
    payload: ServicePrincipalCreatePayload
  ): Promise<ServicePrincipal> {
    const url = this.url("servicePrincipals");
    log(`Creating service principal for appId ${payload.appId}…`);
    return this.request<ServicePrincipal>("POST", url, payload);
  }

  /**
   * Get a service principal by its application (client) ID.
   * Returns null if not found.
   */
  async getServicePrincipalByAppId(
    appId: string
  ): Promise<ServicePrincipal | null> {
    const filter = encodeURIComponent(`appId eq '${appId}'`);
    const url = this.url(`servicePrincipals?$filter=${filter}`);
    logDebug(`Searching service principal by appId=${appId}…`);
    const response = await this.request<GraphListResponse<ServicePrincipal>>("GET", url);
    return response.value[0] ?? null;
  }

  /**
   * Ensure a service principal exists for the given appId.
   * Creates one if it doesn't exist. Returns the service principal.
   */
  async ensureServicePrincipal(appId: string): Promise<ServicePrincipal> {
    const existing = await this.getServicePrincipalByAppId(appId);
    if (existing) {
      log(`Service principal already exists for appId ${appId} (id: ${existing.id}).`);
      return existing;
    }
    return this.createServicePrincipal({ appId });
  }

  /* ── OAuth2 Permission Grants (Admin Consent) ── */

  /**
   * Grant admin consent for delegated permissions.
   */
  async grantOAuth2Permissions(
    payload: OAuth2PermissionGrantPayload
  ): Promise<OAuth2PermissionGrant> {
    const url = this.url("oauth2PermissionGrants");
    log(`Granting OAuth2 permissions for service principal ${payload.clientId}…`);
    return this.request<OAuth2PermissionGrant>("POST", url, payload);
  }

  /**
   * List existing OAuth2 permission grants for a service principal.
   */
  async listOAuth2PermissionGrants(
    servicePrincipalId: string
  ): Promise<OAuth2PermissionGrant[]> {
    const filter = encodeURIComponent(`clientId eq '${servicePrincipalId}'`);
    const url = this.url(`oauth2PermissionGrants?$filter=${filter}`);
    logDebug(`Listing OAuth2 permission grants for SP ${servicePrincipalId}…`);
    const response = await this.request<GraphListResponse<OAuth2PermissionGrant>>("GET", url);
    return [...response.value];
  }

  /* ── Required Resource Access (API Permissions) ── */

  /**
   * Get the current requiredResourceAccess for an application.
   */
  async getRequiredResourceAccess(
    objectId: string
  ): Promise<readonly RequiredResourceAccess[]> {
    const app = await this.getApplication(objectId);
    return app.requiredResourceAccess ?? [];
  }

  /**
   * Add API permission scopes/roles to an application.
   * Merges with existing permissions — does not replace.
   *
   * For each resourceAppId:
   *   - If the app already has entries for that resourceAppId, new resourceAccess
   *     entries are merged (deduplicated by id+type).
   *   - If the resourceAppId is new, a new entry is appended.
   */
  async addRequiredResourceAccess(
    objectId: string,
    permissions: readonly RequiredResourceAccess[]
  ): Promise<readonly RequiredResourceAccess[]> {
    const existing = await this.getRequiredResourceAccess(objectId);

    // Build a map keyed by resourceAppId for merge
    const merged = new Map<string, { resourceAppId: string; resourceAccess: Map<string, "Scope" | "Role"> }>();

    // Seed with existing permissions
    for (const entry of existing) {
      const accessMap = new Map<string, "Scope" | "Role">();
      for (const ra of entry.resourceAccess) {
        accessMap.set(`${ra.id}|${ra.type}`, ra.type);
      }
      merged.set(entry.resourceAppId, { resourceAppId: entry.resourceAppId, resourceAccess: accessMap });
    }

    // Merge in new permissions
    for (const entry of permissions) {
      const current = merged.get(entry.resourceAppId);
      if (current) {
        for (const ra of entry.resourceAccess) {
          current.resourceAccess.set(`${ra.id}|${ra.type}`, ra.type);
        }
      } else {
        const accessMap = new Map<string, "Scope" | "Role">();
        for (const ra of entry.resourceAccess) {
          accessMap.set(`${ra.id}|${ra.type}`, ra.type);
        }
        merged.set(entry.resourceAppId, { resourceAppId: entry.resourceAppId, resourceAccess: accessMap });
      }
    }

    // Convert back to the API shape
    const payload: RequiredResourceAccess[] = [];
    for (const [, entry] of merged) {
      const resourceAccess: { id: string; type: "Scope" | "Role" }[] = [];
      for (const [key] of entry.resourceAccess) {
        const [id, type] = key.split("|");
        if (id && type) {
          resourceAccess.push({ id, type: type as "Scope" | "Role" });
        }
      }
      payload.push({ resourceAppId: entry.resourceAppId, resourceAccess });
    }

    log(`Updating requiredResourceAccess for app ${objectId} (${payload.length} resources)…`);
    await this.updateApplication(objectId, { requiredResourceAccess: payload });
    return payload;
  }

  /* ── Permission GUID Resolution ── */

  /**
   * Resolve permission scope/role names to GUIDs by querying a resource service principal.
   *
   * Looks up both `appRoles` (application permissions, type="Role") and
   * `oauth2PermissionScopes` (delegated permissions, type="Scope") on the resource SP.
   *
   * Returns an array of { id, type, name } for each resolved permission,
   * plus a list of unresolved names.
   *
   * @param resourceAppId - The appId of the resource API
   *   (e.g., "00000003-0000-0000-c000-000000000000" for Microsoft Graph)
   * @param scopeNames - Array of scope name strings (e.g., ["User.Read.All", "CloudPC.Read.All"])
   * @param preferredType - Whether to prefer "Role" (app permissions) or "Scope" (delegated).
   *   Defaults to "Role" since connector service principals typically use app permissions.
   */
  async resolvePermissionsByName(
    resourceAppId: string,
    scopeNames: readonly string[],
    preferredType: "Role" | "Scope" = "Role"
  ): Promise<{
    resolved: { id: string; type: "Role" | "Scope"; name: string }[];
    unresolved: string[];
  }> {
    // Get the resource service principal with appRoles and oauth2PermissionScopes
    const filter = encodeURIComponent(`appId eq '${resourceAppId}'`);
    const select = "id,appId,displayName,appRoles,oauth2PermissionScopes";
    const url = this.url(`servicePrincipals?$filter=${filter}&$select=${select}`);
    logDebug(`Resolving permission GUIDs from resource SP (appId=${resourceAppId})…`);

    const response = await this.request<GraphListResponse<ServicePrincipal>>("GET", url);
    const resourceSp = response.value[0];
    if (!resourceSp) {
      logError(`No service principal found for resourceAppId '${resourceAppId}'.`);
      return { resolved: [], unresolved: [...scopeNames] };
    }

    // Build lookup maps: scope name (lowercase) → { id, type }
    const roleMap = new Map<string, string>();
    for (const role of resourceSp.appRoles ?? []) {
      if (role.isEnabled !== false && role.value) {
        roleMap.set(role.value.toLowerCase(), role.id);
      }
    }

    const scopeMap = new Map<string, string>();
    for (const scope of resourceSp.oauth2PermissionScopes ?? []) {
      if (scope.isEnabled !== false && scope.value) {
        scopeMap.set(scope.value.toLowerCase(), scope.id);
      }
    }

    const resolved: { id: string; type: "Role" | "Scope"; name: string }[] = [];
    const unresolved: string[] = [];

    for (const name of scopeNames) {
      const nameLower = name.toLowerCase();

      // Try preferred type first, then fallback
      if (preferredType === "Role") {
        const roleId = roleMap.get(nameLower);
        if (roleId) {
          resolved.push({ id: roleId, type: "Role", name });
          continue;
        }
        const scopeId = scopeMap.get(nameLower);
        if (scopeId) {
          resolved.push({ id: scopeId, type: "Scope", name });
          continue;
        }
      } else {
        const scopeId = scopeMap.get(nameLower);
        if (scopeId) {
          resolved.push({ id: scopeId, type: "Scope", name });
          continue;
        }
        const roleId = roleMap.get(nameLower);
        if (roleId) {
          resolved.push({ id: roleId, type: "Role", name });
          continue;
        }
      }

      unresolved.push(name);
    }

    log(
      `Permission resolution: ${resolved.length} resolved, ${unresolved.length} unresolved` +
      (unresolved.length > 0 ? ` (${unresolved.join(", ")})` : "")
    );
    return { resolved, unresolved };
  }

  /**
   * Grant app role assignments (application permissions) to a service principal.
   * This is the equivalent of admin consent for application permissions (Role type).
   *
   * @param servicePrincipalId - The object ID of the client service principal
   * @param resourceServicePrincipalId - The object ID of the resource service principal
   * @param appRoleIds - Array of appRole IDs to assign
   */
  async grantAppRoleAssignments(
    servicePrincipalId: string,
    resourceServicePrincipalId: string,
    appRoleIds: readonly string[]
  ): Promise<{ granted: string[]; alreadyExists: string[]; failed: string[] }> {
    const granted: string[] = [];
    const alreadyExists: string[] = [];
    const failed: string[] = [];

    for (const appRoleId of appRoleIds) {
      const url = this.url(`servicePrincipals/${servicePrincipalId}/appRoleAssignments`);
      const payload = {
        principalId: servicePrincipalId,
        resourceId: resourceServicePrincipalId,
        appRoleId,
      };

      try {
        await this.request<unknown>("POST", url, payload);
        granted.push(appRoleId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Permission being assigned already exists")) {
          alreadyExists.push(appRoleId);
        } else {
          logError(`Failed to grant appRole ${appRoleId}: ${msg}`);
          failed.push(appRoleId);
        }
      }
    }

    log(
      `App role assignments: ${granted.length} granted, ` +
      `${alreadyExists.length} already exist, ${failed.length} failed`
    );
    return { granted, alreadyExists, failed };
  }
}
