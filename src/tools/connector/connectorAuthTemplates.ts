/**
 * Connector authentication templates.
 * Generates the connectionParameters / connectionParameterSets sections
 * of apiProperties.json for each supported auth type.
 *
 * These configure how the CONNECTOR authenticates to its backend API,
 * NOT how the deploy agent authenticates to Power Platform.
 */

export type ConnectorAuthType =
  | "NoAuth"
  | "BasicAuth"
  | "ApiKey"
  | "OAuthAAD"
  | "OAuthGeneric"
  | "FederatedIdentity";

export interface OAuthAADOptions {
  /** Entra ID application (client) ID for the connector. */
  readonly clientId: string;
  /** The resource URI the connector authenticates to (e.g., https://graph.microsoft.com). */
  readonly resourceUri: string;
  /** Tenant ID — 'common' for multi-tenant, or a specific tenant GUID. */
  readonly tenantId?: string | undefined;
  /** OAuth scopes (space-separated string or array). */
  readonly scopes?: readonly string[] | undefined;
}

export interface OAuthGenericOptions {
  /** OAuth client ID. */
  readonly clientId: string;
  /** Authorization URL. */
  readonly authorizationUrl: string;
  /** Token URL. */
  readonly tokenUrl: string;
  /** Refresh URL (defaults to tokenUrl). */
  readonly refreshUrl?: string;
  /** OAuth scopes. */
  readonly scopes?: readonly string[];
}

export interface FederatedIdentityOptions {
  /** Entra ID application (client) ID for the connector. */
  readonly clientId: string;
  /** The resource URI the connector authenticates to (e.g., https://graph.microsoft.com). */
  readonly resourceUri: string;
  /** Tenant ID (GUID) — required for Federated Identity. */
  readonly tenantId: string;
  /** OAuth scopes (array of scope strings). */
  readonly scopes?: readonly string[] | undefined;
  /** Connector ID — used to build the redirect URL. If omitted, GlobalPerConnector redirect is used. */
  readonly connectorId?: string | undefined;
}

export const DEFAULT_GRAPH_RESOURCE_URI = "https://graph.microsoft.com";

export interface FederatedResourceUriGuardrailResult {
  readonly resourceUri: string;
  readonly warnings: readonly string[];
}

/**
 * Applies guardrails for FederatedIdentity OAuth resource URIs.
 *
 * Rules:
 *  - Missing/blank values default to Microsoft Graph delegated resource URI.
 *  - `api://...` patterns are rejected (known-bad delegated pattern).
 *  - Non-HTTPS values are rejected.
 *  - Trailing slashes are normalised.
 *  - Non-Graph HTTPS URIs are allowed but warned.
 */
export function resolveFederatedResourceUri(
  resourceUriInput: string | undefined
): FederatedResourceUriGuardrailResult {
  const warnings: string[] = [];
  const raw = (resourceUriInput ?? "").trim();

  if (!raw) {
    warnings.push(
      "FederatedIdentity oauthResourceUri not provided. Defaulting to https://graph.microsoft.com."
    );
    return {
      resourceUri: DEFAULT_GRAPH_RESOURCE_URI,
      warnings,
    };
  }

  const normalized = raw.replace(/\/+$/, "");

  if (/^api:\/\//i.test(normalized)) {
    throw new Error(
      `Invalid oauthResourceUri '${normalized}'. ` +
      "api:// resources are not supported for delegated FederatedIdentity connector auth. " +
      `Use '${DEFAULT_GRAPH_RESOURCE_URI}' for Microsoft Graph delegated permissions.`
    );
  }

  if (!/^https:\/\//i.test(normalized)) {
    throw new Error(
      `Invalid oauthResourceUri '${normalized}'. ` +
      "FederatedIdentity requires an HTTPS resource URI (for example, https://graph.microsoft.com)."
    );
  }

  if (normalized !== raw) {
    warnings.push(
      `FederatedIdentity oauthResourceUri normalized from '${raw}' to '${normalized}'.`
    );
  }

  if (normalized.toLowerCase() !== DEFAULT_GRAPH_RESOURCE_URI) {
    warnings.push(
      `FederatedIdentity oauthResourceUri '${normalized}' is non-default. ` +
      `For Microsoft Graph delegated permissions, '${DEFAULT_GRAPH_RESOURCE_URI}' is recommended.`
    );
  }

  return {
    resourceUri: normalized,
    warnings,
  };
}

export interface ApiKeyOptions {
  /** The header or query parameter name for the API key. */
  readonly keyName: string;
  /** Where to send the key: 'header' or 'query'. */
  readonly location: "header" | "query";
  /** Display name for the UI. */
  readonly displayName?: string;
}

/**
 * Generate connectionParameters for No Authentication.
 */
export function generateNoAuthProperties(): Record<string, unknown> {
  return {};
}

/**
 * Generate connectionParameters for Basic Authentication.
 */
export function generateBasicAuthProperties(): Record<string, unknown> {
  return {
    username: {
      type: "securestring",
      uiDefinition: {
        displayName: "Username",
        description: "The user name for this API",
        tooltip: "Enter the user name",
        constraints: {
          clearText: true,
          required: "true",
          tabIndex: 1,
        },
      },
    },
    password: {
      type: "securestring",
      uiDefinition: {
        displayName: "Password",
        description: "The password for this API",
        tooltip: "Enter the password",
        constraints: {
          clearText: false,
          required: "true",
          tabIndex: 2,
        },
      },
    },
  };
}

/**
 * Generate connectionParameters for API Key authentication.
 */
export function generateApiKeyProperties(options: ApiKeyOptions): Record<string, unknown> {
  return {
    api_key: {
      type: "securestring",
      uiDefinition: {
        displayName: options.displayName ?? "API Key",
        description: `The API Key for this API (sent in ${options.location}: ${options.keyName})`,
        tooltip: "Provide your API Key",
        constraints: {
          clearText: false,
          required: "true",
          tabIndex: 2,
        },
      },
    },
  };
}

/**
 * Generate the securityDefinitions entry for API Key.
 */
export function generateApiKeySecurityDefinition(options: ApiKeyOptions): Record<string, unknown> {
  return {
    api_key: {
      type: "apiKey",
      in: options.location,
      name: options.keyName,
    },
  };
}

/**
 * Generate connectionParameters for OAuth 2.0 (Entra ID / AAD).
 */
export function generateOAuthAADProperties(options: OAuthAADOptions): Record<string, unknown> {
  const tenantId = options.tenantId ?? "common";
  const scopes = options.scopes ? options.scopes.join(" ") : "";

  return {
    token: {
      type: "oauthSetting",
      oAuthSettings: {
        clientId: options.clientId,
        identityProvider: "aad",
        redirectMode: "GlobalPerConnector",
        customParameters: {
          loginUri: {
            value: "https://login.windows.net",
          },
          resourceUri: {
            value: options.resourceUri,
          },
          tenantId: {
            value: tenantId,
          },
        },
        properties: {
          IsFirstParty: "False",
        },
        ...(scopes ? { scopes: [scopes] } : {}),
      },
    },
  };
}

/**
 * Generate connectionParameters for OAuth 2.0 (Generic / Custom IdP).
 */
export function generateOAuthGenericProperties(options: OAuthGenericOptions): Record<string, unknown> {
  const scopes = options.scopes ? options.scopes.join(" ") : "";

  return {
    token: {
      type: "oauthSetting",
      oAuthSettings: {
        clientId: options.clientId,
        identityProvider: "oauth2",
        redirectMode: "GlobalPerConnector",
        customParameters: {
          authorizationUrl: {
            value: options.authorizationUrl,
          },
          tokenUrl: {
            value: options.tokenUrl,
          },
          refreshUrl: {
            value: options.refreshUrl ?? options.tokenUrl,
          },
        },
        ...(scopes ? { scopes: [scopes] } : {}),
      },
    },
  };
}

/**
 * ⚠️ PREVIEW: Federated Identity Credentials for custom connectors.
 *
 * This feature is currently in preview. Microsoft may change the API contract,
 * field names, or behavior without notice. Do not rely on this in production
 * without accepting the risk of breaking changes.
 *
 * Generate connectionParameters for Federated Identity Credential (Managed Identity).
 * Uses `GenericFederatedIdentityCredential` assertion type with
 * `authorization_code_with_federated_identity_credentials` grant type.
 *
 * After deployment, the Power Platform API auto-generates a `Subject` value in the
 * `FederatedIdentityCredentials` block. That subject must be registered as a
 * Federated Identity Credential in the Entra ID app registration for the auth
 * flow to complete.
 */
export function generateFederatedIdentityProperties(
  options: FederatedIdentityOptions
): Record<string, unknown> {
  const guardedResource = resolveFederatedResourceUri(options.resourceUri);
  for (const warning of guardedResource.warnings) {
    console.warn(`[FederatedIdentity Guardrail] ${warning}`);
  }

  const redirectUrl = options.connectorId
    ? `https://global.consent.azure-apim.net/redirect/${options.connectorId}`
    : undefined;

  return {
    token: {
      type: "oauthSetting",
      oAuthSettings: {
        identityProvider: "aad",
        clientId: options.clientId,
        clientAssertionType: "GenericFederatedIdentityCredential",
        scopes: options.scopes ? [...options.scopes] : [],
        redirectMode: "GlobalPerConnector",
        ...(redirectUrl ? { redirectUrl } : {}),
        properties: {
          IsFirstParty: "False",
          AzureActiveDirectoryResourceId: guardedResource.resourceUri,
          IsOnbehalfofLoginSupported: true,
          FederatedIdentityCredentials: {
            Issuer: `https://login.microsoftonline.com/${options.tenantId}/v2.0`,
            Subject: "",
            Audience: "api://AzureADTokenExchange",
          },
        },
        customParameters: {
          LoginUri: { value: "https://login.microsoftonline.com" },
          TenantId: { value: options.tenantId },
          ResourceUri: { value: guardedResource.resourceUri },
          EnableOnbehalfOfLogin: { value: "false" },
          grantType: { value: "authorization_code_with_federated_identity_credentials" },
        },
      },
      uiDefinition: {
        displayName: "OAuth Connection",
        description: "OAuth Connection",
        constraints: {
          required: "true",
          hidden: "false",
        },
      },
    },
    "token:TenantId": {
      type: "string",
      metadata: {
        sourceType: "AzureActiveDirectoryTenant",
      },
      uiDefinition: {
        constraints: {
          required: "false",
          hidden: "true",
        },
      },
    },
  };
}

/**
 * Build a complete apiProperties.json structure.
 */
export function buildApiPropertiesFile(
  authType: ConnectorAuthType,
  options?: {
    readonly oauthAAD?: OAuthAADOptions | undefined;
    readonly oauthGeneric?: OAuthGenericOptions | undefined;
    readonly federatedIdentity?: FederatedIdentityOptions | undefined;
    readonly apiKey?: ApiKeyOptions | undefined;
    readonly iconBrandColor?: string | undefined;
    readonly publisher?: string | undefined;
  }
): Record<string, unknown> {
  let connectionParameters: Record<string, unknown>;

  switch (authType) {
    case "NoAuth":
      connectionParameters = generateNoAuthProperties();
      break;
    case "BasicAuth":
      connectionParameters = generateBasicAuthProperties();
      break;
    case "ApiKey":
      if (!options?.apiKey) {
        throw new Error("ApiKey auth requires apiKey options (keyName, location).");
      }
      connectionParameters = generateApiKeyProperties(options.apiKey);
      break;
    case "OAuthAAD":
      if (!options?.oauthAAD) {
        throw new Error("OAuthAAD auth requires oauthAAD options (clientId, resourceUri).");
      }
      connectionParameters = generateOAuthAADProperties(options.oauthAAD);
      break;
    case "OAuthGeneric":
      if (!options?.oauthGeneric) {
        throw new Error("OAuthGeneric auth requires oauthGeneric options (clientId, authorizationUrl, tokenUrl).");
      }
      connectionParameters = generateOAuthGenericProperties(options.oauthGeneric);
      break;
    case "FederatedIdentity":
      if (!options?.federatedIdentity) {
        throw new Error(
          "FederatedIdentity auth requires federatedIdentity options (clientId, resourceUri, tenantId)."
        );
      }
      connectionParameters = generateFederatedIdentityProperties(options.federatedIdentity);
      break;
    default:
      throw new Error(`Unknown auth type: ${authType}`);
  }

  return {
    properties: {
      connectionParameters,
      iconBrandColor: options?.iconBrandColor ?? "#007ee5",
      capabilities: [],
      ...(options?.publisher ? { publisher: options.publisher } : {}),
    },
  };
}
