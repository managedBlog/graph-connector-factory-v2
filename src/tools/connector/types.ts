/**
 * Type definitions for the Power Apps Connector Management API.
 * Reverse-engineered from the paconn CLI source (microsoft/PowerPlatformConnectors).
 */

/* ── Environments (Flow RP) ── */

export interface PowerPlatformEnvironment {
  readonly name: string;
  readonly id: string;
  readonly location: string;
  readonly properties: {
    readonly displayName: string;
    readonly environmentSku?: string;
    readonly isDefault?: boolean;
  };
}

export interface EnvironmentListResponse {
  readonly value: readonly PowerPlatformEnvironment[];
}

/* ── Connectors (PowerApps RP) ── */

export interface ConnectorProperties {
  readonly displayName: string;
  readonly description?: string;
  readonly iconUri?: string;
  readonly iconBrandColor?: string;
  readonly openApiDefinition?: Record<string, unknown>;
  readonly connectionParameters?: Record<string, unknown>;
  readonly connectionParameterSets?: Record<string, unknown>;
  readonly backendService?: {
    readonly serviceUrl: string;
  };
  readonly environment?: {
    readonly name: string;
  };
  readonly capabilities?: readonly string[];
  readonly policyTemplateInstances?: readonly Record<string, unknown>[];
  readonly publisher?: string;
  readonly createdTime?: string;
  readonly changedTime?: string;
}

export interface ConnectorDefinition {
  readonly name: string;
  readonly id: string;
  readonly type: string;
  readonly properties: ConnectorProperties;
}

export interface ConnectorListResponse {
  readonly value: readonly ConnectorDefinition[];
}

/* ── Create / Update Payloads ── */

export interface ConnectorCreatePayload {
  readonly properties: {
    readonly displayName: string;
    readonly description?: string;
    readonly openApiDefinition: Record<string, unknown>;
    readonly backendService: {
      readonly serviceUrl: string;
    };
    readonly environment: {
      readonly name: string;
    };
    readonly connectionParameters?: Record<string, unknown>;
    readonly connectionParameterSets?: Record<string, unknown>;
    readonly iconBrandColor?: string;
    readonly iconUri?: string;
    readonly capabilities?: readonly string[];
    readonly policyTemplateInstances?: readonly Record<string, unknown>[];
    readonly publisher?: string;
  };
}

export interface ConnectorUpdatePayload {
  readonly properties: {
    readonly openApiDefinition: Record<string, unknown>;
    readonly backendService: {
      readonly serviceUrl: string;
    };
    readonly environment: {
      readonly name: string;
    };
    readonly description?: string;
    readonly connectionParameters?: Record<string, unknown>;
    readonly connectionParameterSets?: Record<string, unknown>;
    readonly iconBrandColor?: string;
    readonly iconUri?: string;
    readonly capabilities?: readonly string[];
    readonly policyTemplateInstances?: readonly Record<string, unknown>[];
    readonly publisher?: string;
  };
}

/* ── Validation ── */

export interface ValidationResult {
  readonly status: "pass" | "fail";
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/* ── Resource Storage (Blob SAS for icon/script upload) ── */

export interface ResourceStorageResponse {
  readonly sharedAccessSignature: string;
}

/* ── API Properties File ── */

export interface ApiPropertiesFile {
  readonly properties: {
    readonly connectionParameters?: Record<string, unknown>;
    readonly connectionParameterSets?: Record<string, unknown>;
    readonly iconBrandColor?: string;
    readonly capabilities?: readonly string[];
    readonly policyTemplateInstances?: readonly Record<string, unknown>[];
    readonly publisher?: string;
  };
}

/* ── Tool Definition ── */

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly handler: (input: unknown, config: unknown) => Promise<unknown>;
}

/* ── Tool Registry ── */

export type ToolRegistry = Record<string, ToolDefinition>;

/* ── Tool Invocation Result ── */

export interface ToolInvocationResult {
  readonly ok: boolean;
  readonly toolName: string;
  readonly result?: unknown;
  readonly error?: string;
}
