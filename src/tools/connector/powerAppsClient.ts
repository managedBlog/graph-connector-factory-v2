/**
 * HTTP client for the Power Platform APIs.
 *
 * Two resource providers:
 *  - PowerApps RP (api.powerapps.com) — connector CRUD, validation, storage
 *  - Flow RP (api.flow.microsoft.com) — environment listing
 *
 * Based on reverse-engineering the paconn CLI (microsoft/PowerPlatformConnectors).
 */

import { CredentialProvider, decodeTokenClaims } from "../../auth/types";
import { log, logError, logDebug } from "../../logging/logger";
import {
  EnvironmentListResponse,
  ConnectorDefinition,
  ConnectorListResponse,
  ConnectorCreatePayload,
  ConnectorUpdatePayload,
  ResourceStorageResponse,
} from "./types";

export interface PowerAppsClientOptions {
  readonly powerAppsApiUrl: string;
  readonly powerAppsApiVersion: string;
  readonly flowApiUrl: string;
  readonly flowApiVersion: string;
  readonly scope: string;
  /**
   * When true, use the BAP admin API for environment listing.
   * Required for service-principal (appOnly) auth — the Flow RP
   * user-context endpoint returns empty for service principals.
   */
  readonly useAdminApi?: boolean;
}

const POWERAPPS_BASE_PATH = "providers/Microsoft.PowerApps";
const FLOW_BASE_PATH = "providers/Microsoft.ProcessSimple";
const BAP_ADMIN_BASE = "https://api.bap.microsoft.com";
const BAP_ADMIN_ENV_PATH = "providers/Microsoft.BusinessAppPlatform/scopes/admin/environments";
const ORIGIN_HEADER = "connector-deploy-agent";

/** Exponential backoff delay (ms) for retries. */
function backoffDelay(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 30000);
}

export class PowerAppsClient {
  private readonly options: PowerAppsClientOptions;
  private readonly credential: CredentialProvider;

  constructor(credential: CredentialProvider, options: PowerAppsClientOptions) {
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

  /**
   * Get auth headers for Microsoft Graph API calls.
   * Uses the same credential provider but with the Graph scope.
   */
  private async getGraphAuthHeaders(): Promise<Record<string, string>> {
    const tokenResult = await this.credential.getToken("https://graph.microsoft.com/.default");
    return {
      Authorization: `Bearer ${tokenResult.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private async getOid(): Promise<string> {
    const tokenResult = await this.credential.getToken(this.options.scope);
    const claims = decodeTokenClaims(tokenResult.accessToken);
    if (!claims.oid) {
      throw new Error("Could not extract 'oid' from access token. Required for validation and storage endpoints.");
    }
    return claims.oid;
  }

  private powerAppsUrl(path: string, environmentId?: string): string {
    const base = `${this.options.powerAppsApiUrl}/${POWERAPPS_BASE_PATH}/${path}`;
    const params = new URLSearchParams({ "api-version": this.options.powerAppsApiVersion });
    if (environmentId) {
      params.set("$filter", `environment eq '${environmentId}'`);
    }
    return `${base}?${params.toString()}`;
  }

  private flowUrl(path: string): string {
    return `${this.options.flowApiUrl}/${FLOW_BASE_PATH}/${path}?api-version=${this.options.flowApiVersion}`;
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

      const fetchOptions: RequestInit = {
        method,
        headers,
      };
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
        logError(`Retryable error (${response.status}): ${errorText.slice(0, 200)}`);
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`Power Platform API error ${response.status}: ${errorText}`);
      }

      // Some responses (204 No Content) have no body
      const contentType = response.headers.get("content-type") ?? "";
      if (response.status === 204 || !contentType.includes("application/json")) {
        return {} as T;
      }

      return (await response.json()) as T;
    }

    throw lastError ?? new Error("Request failed after retries.");
  }

  /* ── Environments ── */

  async listEnvironments(): Promise<EnvironmentListResponse> {
    if (this.options.useAdminApi) {
      // Service-principal auth must use the BAP admin endpoint.
      // The Flow RP user-context endpoint returns empty for SPs.
      const url = `${BAP_ADMIN_BASE}/${BAP_ADMIN_ENV_PATH}?api-version=${this.options.flowApiVersion}`;
      log("Using BAP admin API for environment listing (service-principal mode).");
      return this.request<EnvironmentListResponse>("GET", url);
    }
    const url = this.flowUrl("environments");
    return this.request<EnvironmentListResponse>("GET", url);
  }

  /* ── Connectors ── */

  async listConnectors(environmentId: string): Promise<ConnectorListResponse> {
    const url = this.powerAppsUrl("apis", environmentId);
    return this.request<ConnectorListResponse>("GET", url);
  }

  async getConnector(connectorId: string, environmentId: string): Promise<ConnectorDefinition> {
    const url = this.powerAppsUrl(`apis/${connectorId}`, environmentId);
    return this.request<ConnectorDefinition>("GET", url);
  }

  async createConnector(
    environmentId: string,
    payload: ConnectorCreatePayload
  ): Promise<ConnectorDefinition> {
    const url = this.powerAppsUrl("apis", environmentId);
    log(`Creating connector '${payload.properties.displayName}' in environment ${environmentId}…`);
    return this.request<ConnectorDefinition>("POST", url, payload);
  }

  async updateConnector(
    connectorId: string,
    environmentId: string,
    payload: ConnectorUpdatePayload
  ): Promise<unknown> {
    const url = this.powerAppsUrl(`apis/${connectorId}`, environmentId);
    log(`Updating connector ${connectorId}…`);
    return this.request<unknown>("PATCH", url, payload);
  }

  async deleteConnector(connectorId: string, environmentId: string): Promise<void> {
    const url = this.powerAppsUrl(`apis/${connectorId}`, environmentId);
    log(`Deleting connector ${connectorId}…`);
    await this.request<unknown>("DELETE", url);
  }

  /* ── Sharing ── */

  /**
   * Share a custom connector with a user (by Entra ID object ID).
   *
   * Uses the Power Platform modifyPermissions endpoint:
   *   POST /apis/{connectorId}/modifyPermissions
   *
   * This is required when connectors are created by a service principal
   * (appOnly auth) — SP-created connectors are invisible to users unless
   * explicitly shared.
   */
  async shareConnectorWithUser(
    connectorId: string,
    environmentId: string,
    userObjectId: string,
    role: "CanEdit" | "CanView" = "CanEdit"
  ): Promise<void> {
    const url = `${this.options.powerAppsApiUrl}/${POWERAPPS_BASE_PATH}/apis/${connectorId}/modifyPermissions?api-version=${this.options.powerAppsApiVersion}&$filter=environment eq '${environmentId}'`;

    const payload = {
      put: [{
        properties: {
          roleName: role,
          principal: {
            id: userObjectId,
            type: "User",
          },
        },
      }],
    };

    log(`Sharing connector ${connectorId} with user ${userObjectId} (role: ${role})…`);
    await this.request<unknown>("POST", url, payload);
  }

  /**
   * Share a custom connector with a security group (by Entra ID group object ID).
   *
   * Uses the Power Platform modifyPermissions endpoint with principal type "Group".
   */
  async shareConnectorWithGroup(
    connectorId: string,
    environmentId: string,
    groupObjectId: string,
    role: "CanEdit" | "CanView" = "CanEdit"
  ): Promise<void> {
    const url = `${this.options.powerAppsApiUrl}/${POWERAPPS_BASE_PATH}/apis/${connectorId}/modifyPermissions?api-version=${this.options.powerAppsApiVersion}&$filter=environment eq '${environmentId}'`;

    const payload = {
      put: [{
        properties: {
          roleName: role,
          principal: {
            id: groupObjectId,
            type: "Group",
          },
        },
      }],
    };

    log(`Sharing connector ${connectorId} with group ${groupObjectId} (role: ${role})…`);
    await this.request<unknown>("POST", url, payload);
  }

  /**
   * Resolve a user email address to an Entra ID object ID via Microsoft Graph.
   *
   * Requires User.Read.All application permission on the service principal.
   * Returns the user's OID, or null if the user cannot be found.
   */
  async resolveUserByEmail(email: string): Promise<string | null> {
    const headers = await this.getGraphAuthHeaders();
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}?$select=id`;

    logDebug(`Resolving user email to OID: ${email}`);

    let response: Response;
    try {
      response = await fetch(url, { method: "GET", headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Network error resolving user '${email}': ${message}`);
      return null;
    }

    if (!response.ok) {
      if (response.status === 404) {
        log(`User not found: ${email}`);
        return null;
      }
      const errorText = await response.text().catch(() => "");
      logError(`Graph API error resolving user '${email}' (${response.status}): ${errorText}`);
      return null;
    }

    const data = (await response.json()) as { id?: string };
    if (data.id) {
      log(`Resolved user '${email}' → OID: ${data.id}`);
      return data.id;
    }
    return null;
  }

  /* ── Validation ── */

  async validateSwagger(swaggerDefinition: Record<string, unknown>): Promise<unknown> {
    const oid = await this.getOid();
    const url = this.powerAppsUrl(`objectIds/${oid}/validateApiSwagger`);
    log("Validating swagger definition with Power Platform…");
    return this.request<unknown>("POST", url, swaggerDefinition);
  }

  /* ── Resource Storage (for icon/script upload) ── */

  async generateResourceStorage(environmentId: string): Promise<ResourceStorageResponse> {
    const oid = await this.getOid();
    const url = this.powerAppsUrl(`objectIds/${oid}/generateResourceStorage`);
    return this.request<ResourceStorageResponse>("POST", url, {
      environment: { name: environmentId },
    });
  }

  /**
   * Upload a file (icon, script) to Azure Blob Storage via SAS URL.
   * Returns the download URL for the uploaded file.
   */
  async uploadFileToStorage(
    environmentId: string,
    fileName: string,
    fileBuffer: Buffer,
    contentType: string
  ): Promise<string> {
    const storage = await this.generateResourceStorage(environmentId);
    const sasUrl = storage.sharedAccessSignature;

    // Build the blob upload URL
    const blobUrl = `${sasUrl.split("?")[0]}/${fileName}?${sasUrl.split("?")[1]}`;

    const response = await fetch(blobUrl, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "x-ms-blob-type": "BlockBlob",
      },
      body: fileBuffer,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Blob upload failed (${response.status}): ${errorText}`);
    }

    // Return the download URL (without SAS params for the connector property)
    const downloadUrl = `${sasUrl.split("?")[0]}/${fileName}?${sasUrl.split("?")[1]}`;
    log(`Uploaded ${fileName} to blob storage.`);
    return downloadUrl;
  }
}
