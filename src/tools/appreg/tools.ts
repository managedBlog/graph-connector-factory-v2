/**
 * Tool registry, dispatcher, and all tool implementations for the App Registration Agent.
 *
 * Tools:
 *   1.  appreg_create                — create an Entra ID app registration
 *   2.  appreg_get                   — get app registration details
 *   3.  appreg_update                — update app registration properties
 *   4.  appreg_delete                — delete an app registration (gated)
 *   5.  appreg_addSecret             — add a client secret
 *   6.  appreg_removeSecret          — remove a client secret by keyId
 *   7.  appreg_addFederatedCredential — add a federated identity credential
 *   8.  appreg_listFederatedCredentials — list federated identity credentials
 *   9.  appreg_setRedirectUris       — set redirect URIs (merge, not replace)
 *  10.  appreg_ensureServicePrincipal — ensure a service principal exists
 *  11.  appreg_configureForConnector — composite: configure app for connector
 *  12.  appreg_addPermissions        — add API permission scopes/roles to an app
 *  13.  appreg_grantAdminConsent     — grant admin consent for delegated permissions
 *  14.  setAutonomyMode             — session-scoped autonomy toggle
 */

import { AgentConfig } from "../../config/types";
import { createCredentialProvider } from "../../auth";
import { GraphClient } from "./graphClient";
import { ToolDefinition, ToolRegistry, ToolInvocationResult } from "./types";
import { log, logError } from "../../logging/logger";

/* ── Lazy-initialised shared state ── */

let _client: GraphClient | null = null;

function getClient(config: AgentConfig): GraphClient {
  if (!_client) {
    const credential = createCredentialProvider(config.graphApi.auth);
    _client = new GraphClient(credential, {
      baseUrl: config.graphApi.baseUrl,
      apiVersion: config.graphApi.apiVersion,
      scope: config.graphApi.auth.scope,
    });
  }
  return _client;
}

/* ── Session-scoped autonomy state ── */

let _autonomyMode: "confirm" | "autonomous" = "confirm";

export function getAutonomyMode(): "confirm" | "autonomous" {
  return _autonomyMode;
}

export function setAutonomyModeValue(mode: "confirm" | "autonomous"): void {
  _autonomyMode = mode;
}

/* ── Tool 1: appreg_create ── */

const appregCreateTool: ToolDefinition = {
  name: "appreg_create",
  description:
    "Create a new Entra ID application (app registration) via Microsoft Graph. " +
    "Returns the full application object including id (object ID) and appId (client ID). " +
    "Cross-agent: the returned appId is the clientId needed by connector_create in the Connector Deploy Agent.",
  inputSchema: {
    type: "object",
    properties: {
      displayName: {
        type: "string",
        description: "Display name for the app registration. Overridden by baseName if both are provided.",
      },
      baseName: {
        type: "string",
        description:
          "Base name for all objects in the Connector Factory workflow. " +
          "A contextual suffix is appended automatically (e.g., 'Contoso Users' → " +
          "'Contoso Users - App Registration'). Takes priority over displayName.",
      },
      description: {
        type: "string",
        description: "Description of the app registration.",
      },
      signInAudience: {
        type: "string",
        enum: ["AzureADMyOrg", "AzureADMultipleOrgs", "AzureADandPersonalMicrosoftAccount", "PersonalMicrosoftAccount"],
        description: "Who can sign in. Defaults to AzureADMyOrg.",
      },
      webRedirectUris: {
        type: "array",
        items: { type: "string" },
        description: "Initial web redirect URIs.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Tags for the app registration.",
      },
      notes: {
        type: "string",
        description: "Notes for the app registration.",
      },
      requiredResourceAccess: {
        type: "array",
        description:
          "API permissions to add. Each entry: { resourceAppId, resourceAccess: [{ id, type }] }. " +
          "resourceAppId is the API's app ID (e.g., '00000003-0000-0000-c000-000000000000' for Microsoft Graph). " +
          "type is 'Scope' for delegated or 'Role' for application permissions.",
        items: {
          type: "object",
          properties: {
            resourceAppId: { type: "string" },
            resourceAccess: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "The permission scope or role ID (GUID)." },
                  type: { type: "string", enum: ["Scope", "Role"] },
                },
                required: ["id", "type"],
              },
            },
          },
          required: ["resourceAppId", "resourceAccess"],
        },
      },
    },
    required: ["displayName"],
  },
  handler: async (input: unknown, config: unknown) => {
    const cfg = config as AgentConfig;
    const inp = (input ?? {}) as Record<string, unknown>;
    const baseName = inp["baseName"] as string | undefined;
    const rawDisplayName = inp["displayName"] as string;
    const displayName = baseName
      ? `${baseName} - App Registration`
      : rawDisplayName;

    // Check for existing app with same name
    const client = getClient(cfg);
    const existing = await client.listApplicationsByDisplayName(displayName);
    if (existing.length > 0) {
      return {
        created: false,
        warning: `An app registration with displayName '${displayName}' already exists.`,
        existingApps: existing.map((a) => ({
          objectId: a.id,
          appId: a.appId,
          displayName: a.displayName,
        })),
        hint: "Use appreg_get to inspect the existing app, or choose a different name.",
      };
    }

    const payload: Record<string, unknown> = { displayName };
    if (inp["description"]) payload["description"] = inp["description"];
    if (inp["signInAudience"]) payload["signInAudience"] = inp["signInAudience"];
    if (inp["tags"]) payload["tags"] = inp["tags"];
    if (inp["notes"]) payload["notes"] = inp["notes"];
    if (inp["requiredResourceAccess"]) {
      payload["requiredResourceAccess"] = inp["requiredResourceAccess"];
    }
    if (inp["webRedirectUris"]) {
      payload["web"] = { redirectUris: inp["webRedirectUris"] };
    }

    const app = await client.createApplication(payload as any);
    return {
      created: true,
      objectId: app.id,
      appId: app.appId,
      displayName: app.displayName,
      description: app.description ?? null,
      signInAudience: app.signInAudience ?? "AzureADMyOrg",
      ...(baseName ? { baseName } : {}),
      crossAgent: {
        hint: "Pass appId as clientId to connector_create in the Connector Deploy Agent.",
        clientId: app.appId,
        objectId: app.id,
      },
    };
  },
};

/* ── Tool 2: appreg_get ── */

const appregGetTool: ToolDefinition = {
  name: "appreg_get",
  description:
    "Get details of an Entra ID app registration by object ID or by display name search.",
  inputSchema: {
    type: "object",
    properties: {
      objectId: {
        type: "string",
        description: "The object ID (id) of the app registration.",
      },
      displayName: {
        type: "string",
        description: "Search by display name (exact match). Used if objectId is not provided.",
      },
    },
  },
  handler: async (input: unknown, config: unknown) => {
    const cfg = config as AgentConfig;
    const inp = (input ?? {}) as Record<string, unknown>;
    const client = getClient(cfg);

    if (inp["objectId"]) {
      const app = await client.getApplication(inp["objectId"] as string);
      return {
        objectId: app.id,
        appId: app.appId,
        displayName: app.displayName,
        description: app.description ?? null,
        signInAudience: app.signInAudience ?? "AzureADMyOrg",
        web: app.web ?? null,
        spa: app.spa ?? null,
        publicClient: app.publicClient ?? null,
        requiredResourceAccess: app.requiredResourceAccess ?? [],
        identifierUris: app.identifierUris ?? [],
        tags: app.tags ?? [],
        notes: app.notes ?? null,
        createdDateTime: app.createdDateTime ?? null,
      };
    }

    if (inp["displayName"]) {
      const apps = await client.listApplicationsByDisplayName(inp["displayName"] as string);
      return {
        count: apps.length,
        applications: apps.map((a) => ({
          objectId: a.id,
          appId: a.appId,
          displayName: a.displayName,
          description: a.description ?? null,
        })),
      };
    }

    throw new Error("Either 'objectId' or 'displayName' must be provided.");
  },
};

/* ── Tool 3: appreg_update ── */

const appregUpdateTool: ToolDefinition = {
  name: "appreg_update",
  description:
    "Update properties of an existing Entra ID app registration.",
  inputSchema: {
    type: "object",
    properties: {
      objectId: {
        type: "string",
        description: "The object ID of the app registration to update.",
      },
      displayName: { type: "string", description: "New display name." },
      description: { type: "string", description: "New description." },
      signInAudience: {
        type: "string",
        enum: ["AzureADMyOrg", "AzureADMultipleOrgs", "AzureADandPersonalMicrosoftAccount"],
        description: "Updated sign-in audience.",
      },
      notes: { type: "string", description: "Updated notes." },
      tags: { type: "array", items: { type: "string" }, description: "Updated tags." },
      requiredResourceAccess: {
        type: "array",
        description:
          "API permissions to set (replaces all). Each entry: { resourceAppId, resourceAccess: [{ id, type }] }. " +
          "Use appreg_addPermissions for merge-based permission updates.",
        items: {
          type: "object",
          properties: {
            resourceAppId: { type: "string" },
            resourceAccess: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  type: { type: "string", enum: ["Scope", "Role"] },
                },
                required: ["id", "type"],
              },
            },
          },
          required: ["resourceAppId", "resourceAccess"],
        },
      },
    },
    required: ["objectId"],
  },
  handler: async (input: unknown, config: unknown) => {
    const cfg = config as AgentConfig;
    const inp = (input ?? {}) as Record<string, unknown>;
    const objectId = inp["objectId"] as string;
    const client = getClient(cfg);

    const payload: Record<string, unknown> = {};
    if (inp["displayName"]) payload["displayName"] = inp["displayName"];
    if (inp["description"]) payload["description"] = inp["description"];
    if (inp["signInAudience"]) payload["signInAudience"] = inp["signInAudience"];
    if (inp["notes"]) payload["notes"] = inp["notes"];
    if (inp["tags"]) payload["tags"] = inp["tags"];
    if (inp["requiredResourceAccess"]) payload["requiredResourceAccess"] = inp["requiredResourceAccess"];

    if (Object.keys(payload).length === 0) {
      return { updated: false, reason: "No properties to update." };
    }

    await client.updateApplication(objectId, payload as any);
    return { updated: true, objectId, updatedFields: Object.keys(payload) };
  },
};

/* ── Tool 4: appreg_delete ── */

const appregDeleteTool: ToolDefinition = {
  name: "appreg_delete",
  description:
    "Delete an Entra ID app registration. Gated by policies.allowDelete and autonomy mode. " +
    "In 'confirm' mode, returns a confirmation prompt instead of deleting.",
  inputSchema: {
    type: "object",
    properties: {
      objectId: {
        type: "string",
        description: "The object ID of the app registration to delete.",
      },
      confirmed: {
        type: "boolean",
        description: "Set to true to confirm deletion after receiving a confirmation prompt.",
      },
    },
    required: ["objectId"],
  },
  handler: async (input: unknown, config: unknown) => {
    const cfg = config as AgentConfig;
    const inp = (input ?? {}) as Record<string, unknown>;
    const objectId = inp["objectId"] as string;
    const confirmed = inp["confirmed"] === true;

    // Policy gate
    if (!cfg.policies.allowDelete) {
      return {
        deleted: false,
        reason: "Deletion is disabled by policy (policies.allowDelete = false).",
      };
    }

    // Autonomy gate
    if (_autonomyMode === "confirm" && !confirmed) {
      const client = getClient(cfg);
      const app = await client.getApplication(objectId);
      return {
        deleted: false,
        requiresConfirmation: true,
        application: {
          objectId: app.id,
          appId: app.appId,
          displayName: app.displayName,
        },
        instruction: "This will permanently delete the app registration. Call appreg_delete again with confirmed=true to proceed.",
      };
    }

    const client = getClient(cfg);
    await client.deleteApplication(objectId);
    log(`Deleted app registration ${objectId}.`);
    return { deleted: true, objectId };
  },
};

/* ── Tool 5: appreg_addSecret ── */

const appregAddSecretTool: ToolDefinition = {
  name: "appreg_addSecret",
  description:
    "Add a client secret (password credential) to an app registration. " +
    "Returns the secretText which is only visible once. " +
    "WARNING: Store this value securely (e.g., Key Vault). It cannot be retrieved later.",
  inputSchema: {
    type: "object",
    properties: {
      objectId: {
        type: "string",
        description: "The object ID of the app registration.",
      },
      displayName: {
        type: "string",
        description: "Friendly name for the secret.",
      },
      endDateTime: {
        type: "string",
        description: "Expiry date (ISO 8601). Defaults to 2 years if omitted.",
      },
    },
    required: ["objectId"],
  },
  handler: async (input: unknown, config: unknown) => {
    const cfg = config as AgentConfig;
    const inp = (input ?? {}) as Record<string, unknown>;
    const objectId = inp["objectId"] as string;
    const displayName = inp["displayName"] as string | undefined;
    const endDateTime = inp["endDateTime"] as string | undefined;

    const client = getClient(cfg);
    const credential = await client.addPassword(objectId, displayName, endDateTime);

    return {
      added: true,
      objectId,
      keyId: credential.keyId,
      displayName: credential.displayName ?? null,
      startDateTime: credential.startDateTime ?? null,
      endDateTime: credential.endDateTime ?? null,
      secretText: credential.secretText ?? null,
      warning: "Store secretText securely. It cannot be retrieved after this response.",
    };
  },
};

/* ── Tool 6: appreg_removeSecret ── */

const appregRemoveSecretTool: ToolDefinition = {
  name: "appreg_removeSecret",
  description:
    "Remove a client secret from an app registration by keyId.",
  inputSchema: {
    type: "object",
    properties: {
      objectId: {
        type: "string",
        description: "The object ID of the app registration.",
      },
      keyId: {
        type: "string",
        description: "The keyId of the password credential to remove.",
      },
    },
    required: ["objectId", "keyId"],
  },
  handler: async (input: unknown, config: unknown) => {
    const cfg = config as AgentConfig;
    const inp = (input ?? {}) as Record<string, unknown>;
    const objectId = inp["objectId"] as string;
    const keyId = inp["keyId"] as string;

    const client = getClient(cfg);
    await client.removePassword(objectId, keyId);
    return { removed: true, objectId, keyId };
  },
};

/* ── Tool 7: appreg_addFederatedCredential ── */

const appregAddFederatedCredentialTool: ToolDefinition = {
  name: "appreg_addFederatedCredential",
  description:
    "Add a federated identity credential (FIC) to an app registration. " +
    "Idempotent: if a FIC with the same subject already exists, returns it without creating a duplicate. " +
    "Cross-agent: use the federatedIdentitySubject, federatedIdentityIssuer, and federatedIdentityAudience " +
    "values from the connector_create output of the Connector Deploy Agent. " +
    "Warning: apps are limited to 20 FICs; a warning is emitted at 15+.",
  inputSchema: {
    type: "object",
    properties: {
      objectId: {
        type: "string",
        description: "The object ID of the app registration.",
      },
      name: {
        type: "string",
        description: "Unique name for the FIC (alphanumeric, dash, underscore; max 120 chars).",
      },
      issuer: {
        type: "string",
        description: "The issuer URL (e.g., from connector_create output: federatedIdentityIssuer).",
      },
      subject: {
        type: "string",
        description: "The subject identifier (e.g., from connector_create output: federatedIdentitySubject).",
      },
      audiences: {
        type: "array",
        items: { type: "string" },
        description: "Audiences. Typically ['api://AzureADTokenExchange'] for Power Platform FIC.",
      },
      description: {
        type: "string",
        description: "Optional description.",
      },
    },
    required: ["objectId", "name", "issuer", "subject"],
  },
  handler: async (input: unknown, config: unknown) => {
    const cfg = config as AgentConfig;
    const inp = (input ?? {}) as Record<string, unknown>;
    const objectId = inp["objectId"] as string;
    const name = inp["name"] as string;
    const issuer = inp["issuer"] as string;
    const subject = inp["subject"] as string;
    const audiences = (inp["audiences"] as string[]) ?? ["api://AzureADTokenExchange"];
    const description = inp["description"] as string | undefined;

    const client = getClient(cfg);

    // Idempotency: check for existing FIC with same subject
    const existing = await client.getFederatedIdentityCredentialBySubject(objectId, subject);
    if (existing) {
      return {
        created: false,
        alreadyExists: true,
        fic: {
          id: existing.id,
          name: existing.name,
          issuer: existing.issuer,
          subject: existing.subject,
          audiences: existing.audiences,
          description: existing.description ?? null,
        },
        hint: "A FIC with this subject already exists. No duplicate was created.",
      };
    }

    // Check FIC count (warn at 15+, hard limit is 20)
    const allFics = await client.listFederatedIdentityCredentials(objectId);
    if (allFics.length >= 20) {
      return {
        created: false,
        error: `App ${objectId} has reached the maximum of 20 federated identity credentials.`,
        currentCount: allFics.length,
      };
    }
    const ficCountWarning = allFics.length >= 15
      ? `Warning: app has ${allFics.length}/20 FICs. Approaching the limit.`
      : undefined;

    const payload = {
      name,
      issuer,
      subject,
      audiences,
      ...(description ? { description } : {}),
    };

    const fic = await client.addFederatedIdentityCredential(objectId, payload);

    return {
      created: true,
      fic: {
        id: fic.id,
        name: fic.name,
        issuer: fic.issuer,
        subject: fic.subject,
        audiences: fic.audiences,
        description: fic.description ?? null,
      },
      objectId,
      ...(ficCountWarning ? { warning: ficCountWarning } : {}),
    };
  },
};

/* ── Tool 8: appreg_listFederatedCredentials ── */

const appregListFederatedCredentialsTool: ToolDefinition = {
  name: "appreg_listFederatedCredentials",
  description:
    "List all federated identity credentials for an app registration.",
  inputSchema: {
    type: "object",
    properties: {
      objectId: {
        type: "string",
        description: "The object ID of the app registration.",
      },
    },
    required: ["objectId"],
  },
  handler: async (input: unknown, config: unknown) => {
    const cfg = config as AgentConfig;
    const inp = (input ?? {}) as Record<string, unknown>;
    const objectId = inp["objectId"] as string;

    const client = getClient(cfg);
    const fics = await client.listFederatedIdentityCredentials(objectId);
    return {
      objectId,
      count: fics.length,
      federatedIdentityCredentials: fics.map((f) => ({
        id: f.id,
        name: f.name,
        issuer: f.issuer,
        subject: f.subject,
        audiences: f.audiences,
        description: f.description ?? null,
      })),
      ...(fics.length >= 15 ? { warning: `${fics.length}/20 FICs — approaching the limit.` } : {}),
    };
  },
};

/* ── Tool 9: appreg_setRedirectUris ── */

const appregSetRedirectUrisTool: ToolDefinition = {
  name: "appreg_setRedirectUris",
  description:
    "Add redirect URIs to an app registration. Merges with existing URIs (does not replace). " +
    "Cross-agent: use the redirectUri from the connector_create output of the Connector Deploy Agent.",
  inputSchema: {
    type: "object",
    properties: {
      objectId: {
        type: "string",
        description: "The object ID of the app registration.",
      },
      redirectUris: {
        type: "array",
        items: { type: "string" },
        description: "Redirect URIs to add.",
      },
      platform: {
        type: "string",
        enum: ["web", "spa", "publicClient"],
        description: "Platform type. Defaults to 'web'.",
      },
    },
    required: ["objectId", "redirectUris"],
  },
  handler: async (input: unknown, config: unknown) => {
    const cfg = config as AgentConfig;
    const inp = (input ?? {}) as Record<string, unknown>;
    const objectId = inp["objectId"] as string;
    const redirectUris = inp["redirectUris"] as string[];
    const platform = (inp["platform"] as "web" | "spa" | "publicClient") ?? "web";

    const client = getClient(cfg);
    await client.updateRedirectUris(objectId, redirectUris, platform);

    // Re-read to confirm
    const app = await client.getApplication(objectId);
    let currentUris: readonly string[] = [];
    if (platform === "web") currentUris = app.web?.redirectUris ?? [];
    else if (platform === "spa") currentUris = app.spa?.redirectUris ?? [];
    else currentUris = app.publicClient?.redirectUris ?? [];

    return {
      updated: true,
      objectId,
      platform,
      currentRedirectUris: [...currentUris],
      count: currentUris.length,
    };
  },
};

/* ── Tool 10: appreg_ensureServicePrincipal ── */

const appregEnsureServicePrincipalTool: ToolDefinition = {
  name: "appreg_ensureServicePrincipal",
  description:
    "Ensure a service principal (enterprise application) exists for an app registration. " +
    "Creates one if it doesn't exist. Required for permission grants and enterprise app features.",
  inputSchema: {
    type: "object",
    properties: {
      appId: {
        type: "string",
        description: "The application (client) ID of the app registration.",
      },
    },
    required: ["appId"],
  },
  handler: async (input: unknown, config: unknown) => {
    const cfg = config as AgentConfig;
    const inp = (input ?? {}) as Record<string, unknown>;
    const appId = inp["appId"] as string;

    const client = getClient(cfg);
    const sp = await client.ensureServicePrincipal(appId);

    return {
      servicePrincipalId: sp.id,
      appId: sp.appId,
      displayName: sp.displayName,
      servicePrincipalType: sp.servicePrincipalType ?? "Application",
      created: true,
    };
  },
};

/* ── Tool 11: appreg_configureForConnector ── */

const appregConfigureForConnectorTool: ToolDefinition = {
  name: "appreg_configureForConnector",
  description:
    "Composite tool: configure an app registration for use with a Power Platform custom connector. " +
    "Accepts raw connector_create output from the Connector Deploy Agent and performs: " +
    "(1) search for or create app, (2) add redirect URI, (3) add federated identity credential, " +
    "(4) ensure service principal, (5) add Graph API permissions if graphApiScopes provided, " +
    "(6) grant admin consent for those permissions. " +
    "Skips FIC/redirectUri setup for NoAuth connectors. " +
    "In 'confirm' mode, returns a plan for review before executing.",
  inputSchema: {
    type: "object",
    properties: {
      connectorOutput: {
        type: "object",
        description:
          "Raw output from connector_create or connector_deploy in the Connector Deploy Agent. " +
          "Expected fields: federatedIdentitySubject, federatedIdentityIssuer, " +
          "federatedIdentityAudience, redirectUri, clientId, resourceUri, connectorId, graphApiScopes.",
      },
      appObjectId: {
        type: "string",
        description: "Object ID of an existing app registration. If omitted, creates a new one.",
      },
      displayName: {
        type: "string",
        description: "Display name for a new app registration (used when appObjectId is omitted). Overridden by baseName if both are provided.",
      },
      baseName: {
        type: "string",
        description:
          "Base name for consistent naming across all Connector Factory objects. " +
          "Appends ' - App Registration' suffix automatically. " +
          "If not provided, falls back to baseName from connectorOutput, then displayName, then auto-generated name.",
      },
      authType: {
        type: "string",
        enum: ["NoAuth", "OAuthAAD", "FederatedIdentity"],
        description: "The connector's auth type. If 'NoAuth', skips FIC and redirect URI setup.",
      },
      graphApiScopes: {
        type: "array",
        items: { type: "string" },
        description:
          "Graph API permission scope names to add to the app registration " +
          "(e.g., ['CloudPC.Read.All', 'User.Read.All']). " +
          "If provided here, overrides any scopes from connectorOutput. " +
          "Scope names are automatically resolved to permission GUIDs via the Graph SP.",
      },
      permissionType: {
        type: "string",
        enum: ["Role", "Scope"],
        description:
          "Whether to add permissions as application ('Role') or delegated ('Scope'). " +
          "Defaults to 'Scope' since Power Platform connectors use OAuth authorization code flow (delegated).",
      },
      confirmed: {
        type: "boolean",
        description: "Set to true to skip the confirmation prompt and execute immediately.",
      },
    },
  },
  handler: async (input: unknown, config: unknown) => {
    const cfg = config as AgentConfig;
    const inp = (input ?? {}) as Record<string, unknown>;
    const connectorOutput = (inp["connectorOutput"] ?? {}) as Record<string, unknown>;
    const authType = (inp["authType"] as string) ?? "FederatedIdentity";
    const confirmed = inp["confirmed"] === true;

    // If NoAuth, skip all identity config
    if (authType === "NoAuth") {
      return {
        configured: false,
        skipped: true,
        reason: "Connector uses NoAuth — no app registration configuration needed.",
      };
    }

    // Extract fields from connector output
    const ficSubject = connectorOutput["federatedIdentitySubject"] as string | undefined;
    const ficIssuer = connectorOutput["federatedIdentityIssuer"] as string | undefined;
    const ficAudience = connectorOutput["federatedIdentityAudience"] as string | undefined;
    const redirectUri = connectorOutput["redirectUri"] as string | undefined;
    const clientId = connectorOutput["clientId"] as string | undefined;
    const connectorId = connectorOutput["connectorId"] as string | undefined;

    // Resolve baseName: tool input > connector output > none
    const baseName = (inp["baseName"] as string | undefined)
      ?? (connectorOutput["baseName"] as string | undefined);

    // Extract Graph API scopes — tool input takes priority over connector output
    const scopesFromInput = inp["graphApiScopes"] as string[] | undefined;
    const scopesFromConnector = connectorOutput["graphApiScopes"] as string[] | undefined;
    const graphApiScopes = scopesFromInput ?? scopesFromConnector ?? [];
    const permissionType = (inp["permissionType"] as "Role" | "Scope") ?? "Scope";

    // Build the plan
    const plan: string[] = [];
    let appObjectId = inp["appObjectId"] as string | undefined;

    // Resolve display name: explicit displayName (from orchestrator / caller)
    // takes top priority, then baseName fallback, then auto-generated.
    // L61: When displayName is provided (e.g., the actual connector display name
    // from CDA), it is used as-is — no suffix or transformation.
    let displayName: string;
    const explicitDisplayName = inp["displayName"] as string | undefined;
    if (explicitDisplayName) {
      displayName = explicitDisplayName;
    } else if (baseName) {
      displayName = `${baseName} - App Registration`;
    } else {
      displayName = `Connector-${connectorId ?? "app"}`;
    }

    if (!appObjectId) {
      plan.push(`Create app registration '${displayName}'`);
    }
    if (redirectUri) {
      plan.push(`Add redirect URI: ${redirectUri}`);
    }
    if (ficSubject && ficIssuer) {
      plan.push(`Add FIC: subject=${ficSubject}, issuer=${ficIssuer}`);
    }
    plan.push("Ensure service principal exists");
    if (graphApiScopes.length > 0) {
      plan.push(`Add Graph API permissions (${permissionType}): ${graphApiScopes.join(", ")}`);
      plan.push("Grant admin consent for permissions");
    }

    // In confirm mode, return the plan for review
    if (_autonomyMode === "confirm" && !confirmed) {
      return {
        configured: false,
        requiresConfirmation: true,
        plan,
        connectorOutput: {
          federatedIdentitySubject: ficSubject ?? null,
          federatedIdentityIssuer: ficIssuer ?? null,
          federatedIdentityAudience: ficAudience ?? null,
          redirectUri: redirectUri ?? null,
          clientId: clientId ?? null,
        },
        instruction: "Review the plan above. Call appreg_configureForConnector again with confirmed=true to execute.",
      };
    }

    // Execute the plan
    const client = getClient(cfg);
    const results: Record<string, unknown> = {};

    // Step 1: Create or get app
    if (!appObjectId) {
      // Check for existing app with same name
      const existing = await client.listApplicationsByDisplayName(displayName);
      const firstExisting = existing[0];
      if (firstExisting) {
        appObjectId = firstExisting.id;
        results["app"] = {
          reused: true,
          objectId: firstExisting.id,
          appId: firstExisting.appId,
          displayName: firstExisting.displayName,
          hint: "Found existing app with this display name — reusing it.",
        };
      } else {
        const app = await client.createApplication({
          displayName,
          signInAudience: "AzureADMyOrg",
          ...(connectorId ? { notes: `Auto-configured for connector: ${connectorId}` } : {}),
        });
        appObjectId = app.id;
        results["app"] = {
          created: true,
          objectId: app.id,
          appId: app.appId,
          displayName: app.displayName,
        };
      }
    } else {
      const app = await client.getApplication(appObjectId);
      results["app"] = {
        existing: true,
        objectId: app.id,
        appId: app.appId,
        displayName: app.displayName,
      };
    }

    // L61: If the app's current display name doesn't match our resolved
    // displayName (e.g., Step 1 created it with a temp name, or the
    // orchestrator passed the actual connector display name), rename it.
    if (appObjectId) {
      const currentApp = (results["app"] as Record<string, unknown>) ?? {};
      const currentName = currentApp["displayName"] as string | undefined;
      if (currentName && currentName !== displayName) {
        await client.updateApplication(appObjectId, { displayName });
        (results["app"] as Record<string, unknown>)["displayName"] = displayName;
        (results["app"] as Record<string, unknown>)["renamed"] = true;
        (results["app"] as Record<string, unknown>)["previousName"] = currentName;
      }
    }

    // Step 2: Add redirect URI
    if (redirectUri) {
      await client.updateRedirectUris(appObjectId, [redirectUri], "web");
      results["redirectUri"] = { added: true, uri: redirectUri };
    }

    // Step 3: Add FIC
    if (ficSubject && ficIssuer) {
      // Idempotency: check if FIC with same subject exists
      const existingFic = await client.getFederatedIdentityCredentialBySubject(
        appObjectId,
        ficSubject
      );
      if (existingFic) {
        results["federatedIdentityCredential"] = {
          created: false,
          alreadyExists: true,
          id: existingFic.id,
          name: existingFic.name,
          subject: existingFic.subject,
        };
      } else {
        const ficName = `fic-${connectorId ?? "connector"}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
        const fic = await client.addFederatedIdentityCredential(appObjectId, {
          name: ficName,
          issuer: ficIssuer,
          subject: ficSubject,
          audiences: ficAudience ? [ficAudience] : ["api://AzureADTokenExchange"],
        });
        results["federatedIdentityCredential"] = {
          created: true,
          id: fic.id,
          name: fic.name,
          subject: fic.subject,
          issuer: fic.issuer,
          audiences: fic.audiences,
        };
      }
    }

    // Step 4: Ensure service principal
    const app = await client.getApplication(appObjectId);
    const sp = await client.ensureServicePrincipal(app.appId);
    results["servicePrincipal"] = {
      id: sp.id,
      appId: sp.appId,
      displayName: sp.displayName,
    };

    // Step 5: Add Graph API permissions if graphApiScopes provided
    const GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";
    if (graphApiScopes.length > 0) {
      try {
        // Resolve scope names to permission GUIDs
        const resolution = await client.resolvePermissionsByName(
          GRAPH_APP_ID,
          graphApiScopes,
          permissionType
        );

        if (resolution.resolved.length > 0) {
          // Add permissions to app manifest
          const permissionEntries = resolution.resolved.map((p) => ({
            id: p.id,
            type: p.type,
          }));
          await client.addRequiredResourceAccess(appObjectId, [
            { resourceAppId: GRAPH_APP_ID, resourceAccess: permissionEntries },
          ]);

          // Step 6: Grant admin consent
          // For Role (app permissions): use app role assignments
          const rolePermissions = resolution.resolved.filter((p) => p.type === "Role");
          const scopePermissions = resolution.resolved.filter((p) => p.type === "Scope");

          const consentResults: Record<string, unknown> = {};

          if (rolePermissions.length > 0) {
            const resourceSp = await client.getServicePrincipalByAppId(GRAPH_APP_ID);
            if (resourceSp) {
              const roleResult = await client.grantAppRoleAssignments(
                sp.id,
                resourceSp.id,
                rolePermissions.map((p) => p.id)
              );
              consentResults["appRoleAssignments"] = {
                granted: roleResult.granted.length,
                alreadyExist: roleResult.alreadyExists.length,
                failed: roleResult.failed.length,
              };
            }
          }

          if (scopePermissions.length > 0) {
            const resourceSp = await client.getServicePrincipalByAppId(GRAPH_APP_ID);
            if (resourceSp) {
              const scopeString = scopePermissions.map((p) => p.name).join(" ");
              const grant = await client.grantOAuth2Permissions({
                clientId: sp.id,
                consentType: "AllPrincipals",
                resourceId: resourceSp.id,
                scope: scopeString,
              });
              consentResults["delegatedPermissions"] = {
                grantId: grant.id,
                scopes: scopeString,
              };
            }
          }

          results["permissions"] = {
            resolved: resolution.resolved.map((p) => ({
              name: p.name,
              id: p.id,
              type: p.type,
            })),
            unresolved: resolution.unresolved,
            adminConsent: consentResults,
          };
        }

        if (resolution.unresolved.length > 0) {
          results["permissionWarnings"] = {
            unresolved: resolution.unresolved,
            hint: "These scope names could not be resolved to permission GUIDs. " +
              "They may need to be added manually via the Azure portal.",
          };
        }
      } catch (permErr) {
        const permMsg = permErr instanceof Error ? permErr.message : String(permErr);
        results["permissionError"] = {
          error: permMsg,
          hint: "Permission setup failed. You may need to add permissions manually.",
        };
      }
    }

    return {
      configured: true,
      objectId: appObjectId,
      appId: app.appId,
      displayName: app.displayName,
      steps: results,
      crossAgent: {
        hint: "App registration is now configured for the connector.",
        clientId: app.appId,
        objectId: appObjectId,
      },
    };
  },
};

/* ── Tool 12: appreg_addPermissions ── */

const appregAddPermissionsTool: ToolDefinition = {
  name: "appreg_addPermissions",
  description:
    "Add API permission scopes or application roles to an app registration. " +
    "Merges with existing permissions (does not replace). " +
    "Common resourceAppId values: " +
    "Microsoft Graph = '00000003-0000-0000-c000-000000000000', " +
    "SharePoint = '00000003-0000-0ff1-ce00-000000000000', " +
    "Exchange Online = '00000002-0000-0ff1-ce00-000000000000'. " +
    "Use 'Scope' for delegated permissions and 'Role' for application permissions. " +
    "After adding permissions, use appreg_grantAdminConsent to grant admin consent.",
  inputSchema: {
    type: "object",
    properties: {
      objectId: {
        type: "string",
        description: "The object ID of the app registration.",
      },
      permissions: {
        type: "array",
        description:
          "Array of permission entries to add. Each entry targets one API (resourceAppId) " +
          "and lists one or more permission scopes/roles.",
        items: {
          type: "object",
          properties: {
            resourceAppId: {
              type: "string",
              description:
                "The app ID of the resource API (e.g., '00000003-0000-0000-c000-000000000000' for Microsoft Graph).",
            },
            resourceAccess: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: {
                    type: "string",
                    description:
                      "The permission ID (GUID). For Microsoft Graph, common IDs: " +
                      "User.Read = 'e1fe6dd8-ba31-4d61-89e7-88639da4683d', " +
                      "User.ReadWrite.All = '741f803b-c850-494e-b5df-cde7c675a1ca', " +
                      "Directory.Read.All = '7ab1d382-f21e-4acd-a863-ba3e13f7da61', " +
                      "Mail.Read = '570282fd-fa5c-430d-a7fd-fc8dc98a9dca'.",
                  },
                  type: {
                    type: "string",
                    enum: ["Scope", "Role"],
                    description: "'Scope' for delegated permissions, 'Role' for application permissions.",
                  },
                },
                required: ["id", "type"],
              },
            },
          },
          required: ["resourceAppId", "resourceAccess"],
        },
      },
    },
    required: ["objectId", "permissions"],
  },
  handler: async (input: unknown, config: unknown) => {
    const cfg = config as AgentConfig;
    const inp = (input ?? {}) as Record<string, unknown>;
    const objectId = inp["objectId"] as string;
    const permissions = inp["permissions"] as Array<{
      resourceAppId: string;
      resourceAccess: Array<{ id: string; type: "Scope" | "Role" }>;
    }>;

    if (!permissions || permissions.length === 0) {
      return { updated: false, reason: "No permissions provided." };
    }

    const client = getClient(cfg);
    const result = await client.addRequiredResourceAccess(objectId, permissions);

    // Summarize what was applied
    const summary = result.map((entry) => ({
      resourceAppId: entry.resourceAppId,
      permissionCount: entry.resourceAccess.length,
      permissions: entry.resourceAccess.map((ra) => ({
        id: ra.id,
        type: ra.type,
      })),
    }));

    return {
      updated: true,
      objectId,
      requiredResourceAccess: summary,
      totalResources: summary.length,
      hint: "Permissions have been added to the app registration manifest. " +
        "Use appreg_grantAdminConsent to grant admin consent for these permissions.",
    };
  },
};

/* ── Tool 13: appreg_grantAdminConsent ── */

const appregGrantAdminConsentTool: ToolDefinition = {
  name: "appreg_grantAdminConsent",
  description:
    "Grant admin consent for delegated permission scopes on an app registration. " +
    "Requires a service principal to exist (use appreg_ensureServicePrincipal first). " +
    "This creates an OAuth2 permission grant for 'AllPrincipals', equivalent to clicking " +
    "'Grant admin consent' in the Azure portal. " +
    "Only grants delegated permissions (Scope type). For application permissions (Role type), " +
    "use app role assignments instead.",
  inputSchema: {
    type: "object",
    properties: {
      appId: {
        type: "string",
        description:
          "The application (client) ID of the app registration.",
      },
      resourceAppId: {
        type: "string",
        description:
          "The app ID of the resource API to consent to " +
          "(e.g., '00000003-0000-0000-c000-000000000000' for Microsoft Graph).",
      },
      scopes: {
        type: "string",
        description:
          "Space-delimited list of delegated permission scope names to consent " +
          "(e.g., 'User.Read User.ReadWrite.All Mail.Read').",
      },
    },
    required: ["appId", "resourceAppId", "scopes"],
  },
  handler: async (input: unknown, config: unknown) => {
    const cfg = config as AgentConfig;
    const inp = (input ?? {}) as Record<string, unknown>;
    const appId = inp["appId"] as string;
    const resourceAppId = inp["resourceAppId"] as string;
    const scopes = inp["scopes"] as string;

    const client = getClient(cfg);

    // Step 1: Ensure service principal exists for the app
    const clientSp = await client.ensureServicePrincipal(appId);

    // Step 2: Find the resource service principal
    const resourceSp = await client.getServicePrincipalByAppId(resourceAppId);
    if (!resourceSp) {
      return {
        granted: false,
        error: `No service principal found for resourceAppId '${resourceAppId}'. ` +
          "Ensure the resource API's service principal exists in this tenant.",
      };
    }

    // Step 3: Check for existing grant to merge scopes
    const existingGrants = await client.listOAuth2PermissionGrants(clientSp.id);
    const existingGrant = existingGrants.find((g) => g.resourceId === resourceSp.id);

    if (existingGrant) {
      // Merge scopes
      const existingScopes = new Set(existingGrant.scope.split(" ").filter((s) => s.length > 0));
      const newScopes = scopes.split(" ").filter((s) => s.length > 0);
      for (const s of newScopes) {
        existingScopes.add(s);
      }
      const mergedScope = [...existingScopes].join(" ");

      // PATCH existing grant
      const patchUrl = `oauth2PermissionGrants/${existingGrant.id}`;
      log(`Updating existing admin consent grant ${existingGrant.id} with merged scopes…`);
      // Use updateApplication-style PATCH via the raw request path
      // We need to call the Graph API PATCH directly
      const grant = await client.grantOAuth2Permissions({
        clientId: clientSp.id,
        consentType: "AllPrincipals",
        resourceId: resourceSp.id,
        scope: mergedScope,
      });

      return {
        granted: true,
        grantId: grant.id,
        clientServicePrincipalId: clientSp.id,
        resourceServicePrincipalId: resourceSp.id,
        scopes: mergedScope,
        merged: true,
        previousScopes: existingGrant.scope,
      };
    }

    // Step 4: Create new grant
    const grant = await client.grantOAuth2Permissions({
      clientId: clientSp.id,
      consentType: "AllPrincipals",
      resourceId: resourceSp.id,
      scope: scopes,
    });

    return {
      granted: true,
      grantId: grant.id,
      clientServicePrincipalId: clientSp.id,
      resourceServicePrincipalId: resourceSp.id,
      scopes,
      merged: false,
    };
  },
};

/* ── Tool 14: setAutonomyMode ── */

const setAutonomyModeTool: ToolDefinition = {
  name: "setAutonomyMode",
  description:
    "Toggle the session-scoped autonomy mode. In 'autonomous' mode, destructive operations " +
    "(delete, overwrite) proceed without confirmation prompts. In 'confirm' mode (default), " +
    "the agent returns a confirmation prompt before executing destructive operations. " +
    "Session-scoped: resets to 'confirm' on each new session. " +
    "Gated by policies.autonomy.allowAutoApprove in the config.",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["confirm", "autonomous"],
        description: "The autonomy mode to set.",
      },
    },
    required: ["mode"],
  },
  handler: async (input: unknown, config: unknown) => {
    const cfg = config as AgentConfig;
    const inp = (input ?? {}) as Record<string, unknown>;
    const requestedMode = inp["mode"] as "confirm" | "autonomous";

    if (requestedMode === "autonomous") {
      if (!cfg.policies.autonomy?.allowAutoApprove) {
        return {
          mode: _autonomyMode,
          changed: false,
          reason: "Autonomous mode is disabled by admin policy (policies.autonomy.allowAutoApprove = false).",
        };
      }
    }

    const previousMode = _autonomyMode;
    setAutonomyModeValue(requestedMode);

    return {
      mode: _autonomyMode,
      previousMode,
      changed: previousMode !== _autonomyMode,
      sessionScoped: true,
    };
  },
};

/* ── Tool Registry ── */

export const toolRegistry: ToolRegistry = {
  [appregCreateTool.name]: appregCreateTool,
  [appregGetTool.name]: appregGetTool,
  [appregUpdateTool.name]: appregUpdateTool,
  [appregDeleteTool.name]: appregDeleteTool,
  [appregAddSecretTool.name]: appregAddSecretTool,
  [appregRemoveSecretTool.name]: appregRemoveSecretTool,
  [appregAddFederatedCredentialTool.name]: appregAddFederatedCredentialTool,
  [appregListFederatedCredentialsTool.name]: appregListFederatedCredentialsTool,
  [appregSetRedirectUrisTool.name]: appregSetRedirectUrisTool,
  [appregEnsureServicePrincipalTool.name]: appregEnsureServicePrincipalTool,
  [appregConfigureForConnectorTool.name]: appregConfigureForConnectorTool,
  [appregAddPermissionsTool.name]: appregAddPermissionsTool,
  [appregGrantAdminConsentTool.name]: appregGrantAdminConsentTool,
  [setAutonomyModeTool.name]: setAutonomyModeTool,
};

/* ── Dispatcher ── */

export async function invokeTool(
  toolName: string,
  input: unknown,
  config: AgentConfig
): Promise<ToolInvocationResult> {
  const tool = toolRegistry[toolName];
  if (!tool) {
    return { ok: false, toolName, error: `Unknown tool: ${toolName}` };
  }

  try {
    const result = await tool.handler(input, config);
    return { ok: true, toolName, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`Tool '${toolName}' error: ${message}`);
    return { ok: false, toolName, error: message };
  }
}
