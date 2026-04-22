/**
 * Type definitions for the Microsoft Graph API (Entra ID application management).
 *
 * Based on the Microsoft Graph REST API v1.0 / beta reference:
 *   https://learn.microsoft.com/en-us/graph/api/resources/application
 */

/* ── Application ── */

export interface WebApplication {
  readonly redirectUris?: readonly string[];
  readonly homePageUrl?: string;
  readonly logoutUrl?: string;
  readonly implicitGrantSettings?: {
    readonly enableIdTokenIssuance?: boolean;
    readonly enableAccessTokenIssuance?: boolean;
  };
}

export interface SpaApplication {
  readonly redirectUris?: readonly string[];
}

export interface PublicClientApplication {
  readonly redirectUris?: readonly string[];
}

export interface RequiredResourceAccess {
  readonly resourceAppId: string;
  readonly resourceAccess: readonly {
    readonly id: string;
    readonly type: "Scope" | "Role";
  }[];
}

export interface Application {
  readonly id: string;
  readonly appId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly signInAudience?: string;
  readonly web?: WebApplication;
  readonly spa?: SpaApplication;
  readonly publicClient?: PublicClientApplication;
  readonly requiredResourceAccess?: readonly RequiredResourceAccess[];
  readonly identifierUris?: readonly string[];
  readonly tags?: readonly string[];
  readonly notes?: string;
  readonly createdDateTime?: string;
  readonly deletedDateTime?: string;
}

export interface ApplicationCreatePayload {
  readonly displayName: string;
  readonly description?: string;
  readonly signInAudience?: string;
  readonly web?: {
    readonly redirectUris?: string[];
    readonly homePageUrl?: string;
    readonly implicitGrantSettings?: {
      readonly enableIdTokenIssuance?: boolean;
      readonly enableAccessTokenIssuance?: boolean;
    };
  };
  readonly spa?: {
    readonly redirectUris?: string[];
  };
  readonly publicClient?: {
    readonly redirectUris?: string[];
  };
  readonly requiredResourceAccess?: readonly RequiredResourceAccess[];
  readonly identifierUris?: string[];
  readonly tags?: string[];
  readonly notes?: string;
}

export interface ApplicationUpdatePayload {
  readonly displayName?: string;
  readonly description?: string;
  readonly signInAudience?: string;
  readonly web?: {
    readonly redirectUris?: string[];
    readonly homePageUrl?: string;
    readonly implicitGrantSettings?: {
      readonly enableIdTokenIssuance?: boolean;
      readonly enableAccessTokenIssuance?: boolean;
    };
  };
  readonly spa?: {
    readonly redirectUris?: string[];
  };
  readonly publicClient?: {
    readonly redirectUris?: string[];
  };
  readonly requiredResourceAccess?: readonly RequiredResourceAccess[];
  readonly identifierUris?: string[];
  readonly tags?: string[];
  readonly notes?: string;
}

/* ── Password Credential (Client Secret) ── */

export interface PasswordCredential {
  readonly customKeyIdentifier?: string;
  readonly displayName?: string;
  readonly endDateTime?: string;
  readonly hint?: string;
  readonly keyId: string;
  readonly secretText?: string;
  readonly startDateTime?: string;
}

export interface AddPasswordPayload {
  readonly passwordCredential: {
    readonly displayName?: string;
    readonly endDateTime?: string;
  };
}

export interface RemovePasswordPayload {
  readonly keyId: string;
}

/* ── Federated Identity Credential ── */

export interface FederatedIdentityCredential {
  readonly id: string;
  readonly name: string;
  readonly issuer: string;
  readonly subject: string;
  readonly description?: string;
  readonly audiences: readonly string[];
}

export interface FederatedIdentityCredentialCreatePayload {
  readonly name: string;
  readonly issuer: string;
  readonly subject: string;
  readonly description?: string;
  readonly audiences: string[];
}

export interface FederatedIdentityCredentialListResponse {
  readonly value: readonly FederatedIdentityCredential[];
  readonly "@odata.nextLink"?: string;
}

/* ── Service Principal ── */

export interface ServicePrincipal {
  readonly id: string;
  readonly appId: string;
  readonly displayName: string;
  readonly servicePrincipalType?: string;
  readonly appRoleAssignmentRequired?: boolean;
  readonly tags?: readonly string[];
  /** Application roles (used for resolving permission GUIDs). */
  readonly appRoles?: readonly AppRole[];
  /** Delegated permission scopes (used for resolving permission GUIDs). */
  readonly oauth2PermissionScopes?: readonly OAuth2PermissionScope[];
}

/** An application role (application-level permission). */
export interface AppRole {
  readonly id: string;
  readonly value: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly isEnabled?: boolean;
}

/** A delegated permission scope. */
export interface OAuth2PermissionScope {
  readonly id: string;
  readonly value: string;
  readonly adminConsentDisplayName?: string;
  readonly adminConsentDescription?: string;
  readonly type?: "Admin" | "User";
  readonly isEnabled?: boolean;
}

export interface ServicePrincipalCreatePayload {
  readonly appId: string;
  readonly tags?: string[];
}

/* ── OAuth2 Permission Grant (Admin Consent) ── */

export interface OAuth2PermissionGrant {
  readonly id: string;
  readonly clientId: string;
  readonly consentType: "AllPrincipals" | "Principal";
  readonly principalId?: string;
  readonly resourceId: string;
  readonly scope: string;
}

export interface OAuth2PermissionGrantPayload {
  readonly clientId: string;
  readonly consentType: "AllPrincipals" | "Principal";
  readonly principalId?: string;
  readonly resourceId: string;
  readonly scope: string;
}

/* ── Generic List Response ── */

export interface GraphListResponse<T> {
  readonly value: readonly T[];
  readonly "@odata.nextLink"?: string;
  readonly "@odata.count"?: number;
}

/* ── Tool Types ── */

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly handler: (input: unknown, config: unknown) => Promise<unknown>;
}

export type ToolRegistry = Record<string, ToolDefinition>;

export interface ToolInvocationResult {
  readonly ok: boolean;
  readonly toolName: string;
  readonly result?: unknown;
  readonly error?: string;
}
