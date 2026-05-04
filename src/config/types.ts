/**
 * Unified configuration types for Graph Connector Factory.
 *
 * Merges the essential config from GRS (graph research), CDA (connector deploy),
 * and ARA (app registration) into a single schema. Removes A2A routing,
 * gateway config, path security, and repository config that were specific
 * to the multi-server architecture.
 */

// ─── Server ────────────────────────────────────────────────────────

export interface TokenValidationConfig {
  readonly tenantId: string;
  readonly allowedAudience: string;
  readonly issuer?: string | undefined;
  readonly clockSkewSeconds?: number | undefined;
}

export interface ServerConfig {
  /** HTTP transport auth mode. */
  readonly authMode: "noauth" | "authenticated";
  /** Token validation settings — required when authMode = "authenticated". */
  readonly tokenValidation?: TokenValidationConfig | undefined;
  /** Allow unauthenticated access to /health. */
  readonly allowUnauthenticatedHealth?: boolean | undefined;
  /** Port to listen on (default 3001). */
  readonly port?: number | undefined;
}

// ─── Graph Research ────────────────────────────────────────────────

export interface GraphResearchConfig {
  /** Default Graph API version for metadata operations. */
  readonly defaultVersion: "v1.0" | "beta";
  /** CSDL metadata cache duration in hours. */
  readonly csdlCacheTtlHours: number;
  /** Enable automatic schema flattening for Power Platform compatibility. */
  readonly autoFlatten: boolean;
  /** Maximum operations per generated connector. */
  readonly maxOperationsPerConnector: number;
  /** Resolve CSDL ComplexTypes into nested object schemas (default: false). */
  readonly enrichComplexTypes?: boolean;
}

// ─── Power Platform (CDA) ──────────────────────────────────────────

export interface BackendAuthConfig {
  /** Authentication method for backend API calls. */
  readonly method:
    | "clientCredential"
    | "certificate"
    | "managedIdentity"
    | "delegatedToken"
    | "appOnly";
  readonly tenantId: string;
  readonly clientId: string;
  readonly scope: string;
  /** Key Vault URL for client secret retrieval. */
  readonly keyVaultUrl?: string | undefined;
  /** Key Vault secret name for client secret. */
  readonly keyVaultSecretName?: string | undefined;
  /** Direct client secret (dev only — prefer Key Vault). */
  readonly clientSecret?: string | undefined;
  /** Path to certificate file for certificate auth. */
  readonly certificatePath?: string | undefined;
  /** Execution-phase credentials (separate from auth-phase). */
  readonly execution?: {
    readonly method: "clientCredential" | "certificate" | "managedIdentity";
    readonly keyVaultUrl?: string | undefined;
    readonly keyVaultSecretName?: string | undefined;
    readonly clientSecret?: string | undefined;
    readonly certificatePath?: string | undefined;
  } | undefined;
}

export interface PowerPlatformConfig {
  /** Power Apps API base URL. */
  readonly apiUrl: string;
  /** Power Apps API version. */
  readonly apiVersion: string;
  /** Power Apps full API URL (e.g., https://api.powerapps.com). */
  readonly powerAppsApiUrl: string;
  /** Power Apps API version string. */
  readonly powerAppsApiVersion: string;
  /** Flow API base URL (e.g., https://api.flow.microsoft.com). */
  readonly flowApiUrl: string;
  /** Flow API version string. */
  readonly flowApiVersion: string;
  /** Default Power Platform environment ID. */
  readonly defaultEnvironmentId: string;
  /** Backend auth for Power Platform API calls. */
  readonly auth: BackendAuthConfig;
  /** Email addresses to auto-share new connectors with. */
  readonly shareWithUsers?: readonly string[] | undefined;
  /** Default email address to share connectors with. */
  readonly defaultShareUser?: string | undefined;
  /** Group OIDs to share connectors with. */
  readonly shareWithGroups?: readonly string[] | undefined;
}

// ─── Microsoft Graph (ARA) ─────────────────────────────────────────

export interface GraphApiConfig {
  /** Graph API base URL (default: https://graph.microsoft.com). */
  readonly baseUrl: string;
  /** Graph API version (default: v1.0). */
  readonly apiVersion: string;
  /** Backend auth for Graph API calls. */
  readonly auth: BackendAuthConfig;
}

// ─── Deploy Defaults ───────────────────────────────────────────────

export interface DeployDefaults {
  /** Entra ID tenant GUID for connector OAuth. */
  readonly oauthTenantId?: string | undefined;
  /** OAuth client ID (app registration). */
  readonly oauthClientId?: string | undefined;
  /** OAuth resource URI (audience). */
  readonly oauthResourceUri?: string | undefined;
  /** Default auth type: NoAuth, OAuthAAD, or FederatedIdentity. */
  readonly defaultAuthType?: string | undefined;
  /** Default Power Platform environment ID. */
  readonly defaultEnvironmentId?: string | undefined;
  /** Default app registration strategy. */
  readonly defaultAppRegistrationStrategy?: "single" | "separate" | undefined;
  /** Prefix prepended to connector base names. */
  readonly namingPrefix?: string | undefined;
}

// ─── Policies ──────────────────────────────────────────────────────

export interface PoliciesConfig {
  readonly riskTolerance: "cautious" | "moderate" | "permissive";
  readonly allowDelete: boolean;
  readonly secrets: {
    readonly inlineSecretsAllowed: boolean;
  };
  readonly autonomy?: {
    readonly allowAutoApprove: boolean;
    readonly defaultMode: "confirm" | "autonomous";
  } | undefined;
}

// ─── Output ────────────────────────────────────────────────────────

export interface OutputConfig {
  /** Directory for generated connector artifacts. */
  readonly dir: string;
  /** Time-to-live for generated files in minutes. */
  readonly ttlMinutes: number;
  /** GitHub Gist publishing configuration. */
  readonly gist?: {
    readonly enabled: boolean;
    readonly token?: string | undefined;
  } | undefined;
}

// ─── Modes ─────────────────────────────────────────────────────────

export interface ModeEntry {
  readonly id: string;
  readonly enabled: boolean;
}

// ─── Design Context (runtime, not persisted in config) ─────────────

export interface ConnectorGroup {
  readonly name?: string | undefined;
  readonly endpoints: readonly string[];
}

export interface DesignContext {
  readonly authType?: "NoAuth" | "OAuthAAD" | "FederatedIdentity" | undefined;
  readonly connectorCount?: number | undefined;
  readonly connectorGroups?: readonly ConnectorGroup[] | undefined;
  readonly appRegistrationStrategy?: "single" | "separate" | undefined;
  readonly environmentId?: string | undefined;
  readonly baseName?: string | undefined;
  readonly targetVersion?: "v1.0" | "beta" | undefined;
  readonly notes?: string | undefined;
}

// ─── Root Config ───────────────────────────────────────────────────

export interface AgentConfig {
  readonly configVersion: string;
  readonly id: string;
  readonly description: string;
  /** Server auth and port configuration. */
  readonly server: ServerConfig;
  /** Graph research settings (CSDL parsing, swagger generation). */
  readonly graphResearch: GraphResearchConfig;
  /** Power Platform API connection (connector CRUD). */
  readonly powerPlatform: PowerPlatformConfig;
  /** Microsoft Graph API connection (app registration CRUD). */
  readonly graphApi: GraphApiConfig;
  /** Default values applied to deploy pipeline operations. */
  readonly deploy: DeployDefaults;
  /** Policy enforcement settings. */
  readonly policies: PoliciesConfig;
  /** Output artifact settings. */
  readonly output: OutputConfig;
  /** Tool filtering modes. */
  readonly modes: readonly ModeEntry[];
  /** Enable verbose debug logging. */
  readonly debugLogging?: boolean | undefined;
}
