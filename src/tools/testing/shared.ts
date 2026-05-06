/**
 * Shared constants for CUA test plan generators.
 *
 * Single source of truth for body templates and required fields.
 * Used by both multiConnectorPlan.ts and testPlanGenerator.ts.
 *
 * Template variables use angle brackets: <tenantDomain>, <testUserPassword>
 * to avoid Power Fx collisions with [] and {{}} in Power Platform.
 */

// ─── Known Required Fields ─────────────────────────────────────────────────

export const KNOWN_REQUIRED_FIELDS: Record<string, readonly string[]> = {
  users: ["accountEnabled", "displayName", "mailNickname", "passwordProfile", "userPrincipalName"],
  groups: ["displayName", "mailEnabled", "mailNickname", "securityEnabled"],
  applications: ["displayName"],
  serviceprincipals: ["appId"],
  teams: ["displayName"],
  channels: ["displayName"],
  sites: ["displayName"],
  exportjobs: ["reportName"],
};

// ─── Known Body Templates ──────────────────────────────────────────────────

/**
 * Body templates for known Graph entity sets.
 * The nonce is appended to names/nicknames to avoid collisions on repeat runs.
 * Template vars use angle brackets: <tenantDomain>, <testUserPassword>.
 */
export const KNOWN_BODY_TEMPLATES: Record<string, (nonce: string) => Record<string, unknown>> = {
  users: (nonce) => ({
    accountEnabled: true,
    displayName: `GCF Test User ${nonce}`,
    mailNickname: `gcf-test-user-${nonce}`,
    passwordProfile: {
      forceChangePasswordNextSignIn: true,
      password: "<generate a strong temporary password>",
    },
    userPrincipalName: `gcf-test-user-${nonce}@<tenantDomain>`,
  }),
  groups: (nonce) => ({
    displayName: `GCF Test Group ${nonce}`,
    mailEnabled: false,
    mailNickname: `gcf-test-group-${nonce}`,
    securityEnabled: true,
  }),
  applications: (nonce) => ({
    displayName: `GCF Test Application ${nonce}`,
  }),
  serviceprincipals: () => ({
    appId: "<appId of a test application>",
  }),
  teams: (nonce) => ({
    "template@odata.bind": "https://graph.microsoft.com/v1.0/teamsTemplates('standard')",
    displayName: `GCF Test Team ${nonce}`,
    description: "Created by GCF test plan",
  }),
  channels: (nonce) => ({
    displayName: `GCF Test Channel ${nonce}`,
    description: "Created by GCF test plan",
  }),
};

// ─── Entity Identifier Metadata ─────────────────────────────────────────────

/**
 * Describes the preferred identifier for lookup operations and which fields
 * should appear in $select for LIST operations so subsequent steps can
 * reference the correct property.
 *
 * Keys are lowercase entity set names (e.g., "users", "groups").
 */
export interface EntityIdentifierMeta {
  /** The response property to use as the path parameter in GET/PATCH/DELETE. */
  readonly preferredKey: string;
  /** Human-readable description of the preferred key. */
  readonly keyDescription: string;
  /** Example value for the preferred key. */
  readonly example: string;
  /** Fields to include in $select on LIST operations. */
  readonly selectFields: readonly string[];
}

export const ENTITY_IDENTIFIER_META: Record<string, EntityIdentifierMeta> = {
  users: {
    preferredKey: "userPrincipalName",
    keyDescription: "the user's email-format UPN",
    example: "user@domain.com",
    selectFields: ["id", "userPrincipalName", "displayName"],
  },
  groups: {
    preferredKey: "id",
    keyDescription: "the Entra object ID (GUID)",
    example: "a GUID from the response",
    selectFields: ["id", "displayName", "mailNickname"],
  },
  applications: {
    preferredKey: "id",
    keyDescription: "the Entra object ID (GUID)",
    example: "a GUID from the response",
    selectFields: ["id", "appId", "displayName"],
  },
  serviceprincipals: {
    preferredKey: "id",
    keyDescription: "the Entra object ID (GUID)",
    example: "a GUID from the response",
    selectFields: ["id", "appId", "displayName"],
  },
  devices: {
    preferredKey: "id",
    keyDescription: "the Entra object ID (GUID)",
    example: "a GUID from the response",
    selectFields: ["id", "deviceId", "displayName"],
  },
  teams: {
    preferredKey: "id",
    keyDescription: "the team ID (GUID)",
    example: "a GUID from the response",
    selectFields: ["id", "displayName"],
  },
  channels: {
    preferredKey: "id",
    keyDescription: "the channel ID (GUID)",
    example: "a GUID from the response",
    selectFields: ["id", "displayName"],
  },
  sites: {
    preferredKey: "id",
    keyDescription: "the site ID",
    example: "a site ID from the response",
    selectFields: ["id", "displayName", "webUrl"],
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Generate a short random nonce for unique resource names. */
export function generateNonce(): string {
  return Math.random().toString(36).substring(2, 6);
}

/** Singularize a plural entity set name. */
export function singularize(plural: string): string {
  if (plural.endsWith("ies")) return plural.slice(0, -3) + "y";
  if (plural.endsWith("ses") || plural.endsWith("xes")) return plural.slice(0, -2);
  if (plural.endsWith("s")) return plural.slice(0, -1);
  return plural;
}

/** Extract entity set name from a swagger path (last non-parameter segment). */
export function entitySetNameFromPath(pathStr: string): string {
  const segments = pathStr.split("/").filter((s) => s && !s.startsWith("{"));
  return (segments[segments.length - 1] ?? "").toLowerCase();
}

/** Check if a method is a write operation. */
export function isWriteMethod(method: string): boolean {
  return method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";
}

/** Default expected HTTP status code by method. */
export function defaultStatusCode(method: string): number {
  if (method === "POST") return 201;
  if (method === "DELETE" || method === "PATCH" || method === "PUT") return 204;
  return 200;
}

/**
 * Generate a Microsoft Learn docs URL for a Graph API operation.
 */
export function buildGraphDocsUrl(entitySet: string, method: string, hasPathParam: boolean): string {
  const entity = singularize(entitySet);
  let verb: string;
  switch (method.toUpperCase()) {
    case "GET": verb = hasPathParam ? "get" : "list"; break;
    case "POST": verb = "create"; break;
    case "PATCH": case "PUT": verb = "update"; break;
    case "DELETE": verb = "delete"; break;
    default: verb = method.toLowerCase();
  }
  return `https://learn.microsoft.com/en-us/graph/api/${entity}-${verb}?view=graph-rest-1.0`;
}
