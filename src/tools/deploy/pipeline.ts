/**
 * Deploy Pipeline — Direct function call orchestration.
 *
 * Chains three steps to deploy a connector end-to-end:
 *  1. ARA `appreg_create` — Create or reuse an Entra ID app registration
 *  2. CDA `connector_deploy` — Deploy swagger to Power Platform
 *  3. ARA `appreg_configureForConnector` — Configure FIC, redirect URI, permissions
 *
 * Replaces the previous A2A MCP orchestrator (~700 LOC) with direct
 * invokeTool calls (~350 LOC). No inter-process communication, no
 * MCP protocol overhead, no compatibility fallbacks.
 */

import type { AgentConfig } from "../../config/types";
import { invokeTool as invokeConnectorTool } from "../connector/tools";
import { invokeTool as invokeAppregTool } from "../appreg/tools";
import { log, logError } from "../../logging/logger";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DeployPipelineInput {
  readonly swaggerUrl?: string | undefined;
  readonly swagger?: string | Record<string, unknown> | undefined;
  readonly baseName?: string | undefined;
  readonly environmentId?: string | undefined;
  readonly authType?: string | undefined;
  readonly oauthClientId?: string | undefined;
  readonly oauthResourceUri?: string | undefined;
  readonly oauthTenantId?: string | undefined;
  readonly skipAppRegistration?: boolean | undefined;
  readonly confirmed?: boolean | undefined;
  readonly shareWithEmails?: readonly string[] | undefined;
}

export interface DeployPipelineResult {
  readonly status: "success" | "partial" | "failed";
  readonly connector: ConnectorDeployResult | null;
  readonly appRegistration: AppRegistrationResult | null;
  readonly errors: string[];
  readonly summary: string;
  readonly timing?: PipelineTimingInfo | undefined;
  readonly appRegRetryAvailable?: boolean | undefined;
}

export interface PipelineTimingInfo {
  readonly totalMs: number;
  readonly appCreateMs?: number | undefined;
  readonly connectorDeployMs?: number | undefined;
  readonly appRegistrationMs?: number | undefined;
}

export interface ConnectorDeployResult {
  readonly connectorId: string;
  readonly displayName: string;
  readonly environmentId: string;
  readonly status: string;
  readonly authType?: string | undefined;
  readonly baseName?: string | undefined;
  readonly redirectUri?: string | undefined;
  readonly clientId?: string | undefined;
  readonly federatedIdentitySubject?: string | undefined;
  readonly federatedIdentityIssuer?: string | undefined;
  readonly federatedIdentityAudience?: string | undefined;
  readonly graphApiScopes?: string[] | undefined;
  readonly sharedWith?: string[] | undefined;
}

export interface AppRegistrationResult {
  readonly configured: boolean;
  readonly appId?: string | undefined;
  readonly objectId?: string | undefined;
  readonly displayName?: string | undefined;
  readonly skipped?: boolean | undefined;
  readonly skipReason?: string | undefined;
  readonly steps?: Record<string, unknown> | undefined;
  readonly partialDetail?: AppRegPartialDetail | undefined;
}

export interface AppRegPartialDetail {
  readonly appCreated: boolean;
  readonly appId?: string | undefined;
  readonly objectId?: string | undefined;
  readonly ficConfigured: boolean;
  readonly redirectUriAdded: boolean;
  readonly servicePrincipalReady: boolean;
  readonly permissionsGranted: boolean;
  readonly remainingSteps: string[];
  readonly retryGuidance: string;
}

export interface AppRegRetryInput {
  readonly connectorId: string;
  readonly baseName?: string | undefined;
  readonly federatedIdentitySubject?: string | undefined;
  readonly federatedIdentityIssuer?: string | undefined;
  readonly federatedIdentityAudience?: string | undefined;
  readonly redirectUri?: string | undefined;
  readonly clientId?: string | undefined;
  readonly graphApiScopes?: string[] | undefined;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse ARA configureForConnector response to extract step-by-step detail.
 */
function parseAraSteps(araData: Record<string, unknown>): AppRegPartialDetail {
  const steps = (araData["steps"] ?? {}) as Record<string, unknown>;
  const appStep = steps["app"] as Record<string, unknown> | undefined;
  const ficStep = steps["federatedIdentityCredential"] as Record<string, unknown> | undefined;
  const redirectStep = steps["redirectUri"] as Record<string, unknown> | undefined;
  const spStep = steps["servicePrincipal"] as Record<string, unknown> | undefined;
  const permStep = steps["permissions"] as Record<string, unknown> | undefined;

  const appCreated = !!(appStep && (appStep["created"] || appStep["reused"] || appStep["existing"]));
  const ficConfigured = !!(ficStep && (ficStep["created"] || ficStep["alreadyExists"]));
  const redirectUriAdded = !!(redirectStep && redirectStep["added"]);
  const servicePrincipalReady = !!spStep;
  const permissionsGranted = !!(permStep && !steps["permissionError"]);

  const remaining: string[] = [];
  if (!appCreated) remaining.push("Create app registration");
  if (!ficConfigured) remaining.push("Configure Federated Identity Credential (FIC)");
  if (!redirectUriAdded) remaining.push("Add redirect URI");
  if (!servicePrincipalReady) remaining.push("Create service principal");
  if (!permissionsGranted) remaining.push("Grant API permissions");

  let guidance: string;
  if (remaining.length === 0) {
    guidance = "All steps completed successfully.";
  } else if (appCreated && !ficConfigured) {
    guidance = `App registration was created (${araData["appId"] ?? "unknown"}), but FIC configuration failed. You can retry to complete the FIC setup.`;
  } else if (appCreated && ficConfigured && !permissionsGranted) {
    guidance = `App and FIC are configured, but admin consent for API permissions could not be granted automatically. ` +
      `To grant consent manually: open Azure portal → Entra ID → App registrations → find the connector's app → ` +
      `API permissions → click "Grant admin consent". The connector will work once consent is granted.`;
  } else {
    guidance = `The following steps still need to be completed: ${remaining.join(", ")}. You can retry the app registration process.`;
  }

  return {
    appCreated,
    appId: araData["appId"] as string | undefined,
    objectId: araData["objectId"] as string | undefined,
    ficConfigured,
    redirectUriAdded,
    servicePrincipalReady,
    permissionsGranted,
    remainingSteps: remaining,
    retryGuidance: guidance,
  };
}

/**
 * Delay helper for replication retry backoff.
 */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Main Pipeline ──────────────────────────────────────────────────────────

/**
 * Execute the full deploy pipeline:
 *  1. Create/reuse app registration via ARA
 *  2. Deploy connector to Power Platform via CDA
 *  3. Configure app registration with connector output (FIC, redirect URI, permissions)
 *
 * All calls are direct function invocations — no inter-process communication.
 */
export async function executeDeployPipeline(
  input: DeployPipelineInput,
  config: AgentConfig,
): Promise<DeployPipelineResult> {
  const errors: string[] = [];
  let connectorResult: ConnectorDeployResult | null = null;
  let appRegResult: AppRegistrationResult | null = null;
  let createdApp: { appId: string; objectId: string; displayName?: string } | null = null;
  const pipelineStart = Date.now();
  let appCreateMs: number | undefined;
  let connectorDeployMs: number | undefined;
  let appRegistrationMs: number | undefined;

  const resolvedAuthType = input.authType?.trim() || config.deploy?.defaultAuthType?.trim() || "FederatedIdentity";

  // Resolve tenant ID: for FederatedIdentity, fall back to config if caller didn't provide one.
  // OAuthAAD intentionally defaults to "common" elsewhere, so we only inject the config value for FIC.
  const resolvedTenantId =
    resolvedAuthType === "FederatedIdentity"
      ? (input.oauthTenantId?.trim() || config.deploy?.oauthTenantId?.trim())
      : (input.oauthTenantId?.trim() || undefined);

  log(
    `[Deploy Pipeline] Resolved authType=${resolvedAuthType}, ` +
    `tenantId=${resolvedTenantId ?? "(none)"} (source: ${input.oauthTenantId?.trim() ? "input" : resolvedTenantId ? "config" : "none"})`,
  );

  // Validate swagger source early
  if (!input.swagger && !input.swaggerUrl) {
    return {
      status: "failed",
      connector: null,
      appRegistration: null,
      errors: ["No swagger provided. Pass 'swagger' (inline) or 'swaggerUrl' (URL to fetch from)."],
      summary: "Deploy failed: no swagger source provided.",
    };
  }

  // ── Step 1: Create/reuse app registration ──

  if (!input.skipAppRegistration && resolvedAuthType !== "NoAuth") {
    log("[Deploy Pipeline] ════════════════════════════════════════════════════");
    log("[Deploy Pipeline] Step 1/3: Creating/reusing app registration…");

    const appCreateArgs: Record<string, unknown> = {
      displayName: input.baseName ?? "Graph Connector App Registration",
      signInAudience: "AzureADMyOrg",
    };
    if (input.baseName) appCreateArgs["baseName"] = input.baseName;

    const appCreateStart = Date.now();
    try {
      const appCreateResult = await invokeAppregTool("appreg_create", appCreateArgs, config);

      appCreateMs = Date.now() - appCreateStart;
      log(`[Deploy Pipeline] Step 1 completed in ${appCreateMs}ms`);

      if (!appCreateResult.ok) {
        errors.push(`App registration create failed: ${appCreateResult.error ?? "unknown error"}`);
        return {
          status: "failed",
          connector: null,
          appRegistration: null,
          errors,
          summary: `Deploy failed: ${appCreateResult.error ?? "unknown error"}`,
          timing: { totalMs: Date.now() - pipelineStart, appCreateMs },
        };
      }

      const appData = appCreateResult.result as Record<string, unknown>;
      if (appData["created"] === true) {
        const appId = appData["appId"] as string | undefined;
        const objectId = appData["objectId"] as string | undefined;
        if (appId && objectId) {
          createdApp = {
            appId,
            objectId,
            ...(appData["displayName"] ? { displayName: appData["displayName"] as string } : {}),
          };
        }
      } else {
        // Reuse existing app
        const existingApps = appData["existingApps"] as Array<Record<string, unknown>> | undefined;
        const first = existingApps?.[0];
        const appId = (first?.["appId"] as string | undefined) ?? (appData["appId"] as string | undefined);
        const objectId = (first?.["objectId"] as string | undefined) ?? (appData["objectId"] as string | undefined);
        if (appId && objectId) {
          const existingDisplayName =
            (first?.["displayName"] as string | undefined) ??
            (appData["displayName"] as string | undefined);
          createdApp = {
            appId,
            objectId,
            ...(existingDisplayName ? { displayName: existingDisplayName } : {}),
          };
        }
      }

      if (!createdApp) {
        errors.push("App registration step did not return appId/objectId.");
        return {
          status: "failed",
          connector: null,
          appRegistration: null,
          errors,
          summary: "Deploy failed: app registration pre-create did not return required IDs.",
          timing: { totalMs: Date.now() - pipelineStart, appCreateMs },
        };
      }

      log(
        `[Deploy Pipeline] ✓ App registration ready: ${createdApp.displayName ?? "(unnamed)"} ` +
        `(App ID: ${createdApp.appId}, Object ID: ${createdApp.objectId})`
      );
    } catch (err) {
      appCreateMs = Date.now() - appCreateStart;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`App registration create error: ${msg}`);
      logError(`[Deploy Pipeline] ✗ ARA create failed after ${appCreateMs}ms: ${msg}`);
      return {
        status: "failed",
        connector: null,
        appRegistration: null,
        errors,
        summary: `Deploy failed with error: ${msg}`,
        timing: { totalMs: Date.now() - pipelineStart, appCreateMs },
      };
    }
  } else {
    log("[Deploy Pipeline] Step 1/3: Skipped app pre-create (NoAuth or skipAppRegistration=true)");
  }

  // ── Step 2: Deploy connector to Power Platform ──

  log("[Deploy Pipeline] ════════════════════════════════════════════════════");
  log("[Deploy Pipeline] Step 2/3: Deploying connector to Power Platform…");

  const cdaArgs: Record<string, unknown> = {};

  if (input.swagger) {
    cdaArgs["apiDefinition"] =
      typeof input.swagger === "string" ? input.swagger : JSON.stringify(input.swagger);
  } else if (input.swaggerUrl) {
    cdaArgs["apiDefinitionUrl"] = input.swaggerUrl;
  }

  if (input.baseName) cdaArgs["baseName"] = input.baseName;
  if (input.environmentId) cdaArgs["environmentId"] = input.environmentId;
  cdaArgs["authType"] = resolvedAuthType;
  if (createdApp?.appId) cdaArgs["oauthClientId"] = createdApp.appId;
  else if (input.oauthClientId) cdaArgs["oauthClientId"] = input.oauthClientId;
  if (input.oauthResourceUri) cdaArgs["oauthResourceUri"] = input.oauthResourceUri;
  if (resolvedTenantId) cdaArgs["oauthTenantId"] = resolvedTenantId;
  if (input.shareWithEmails) cdaArgs["shareWithEmails"] = input.shareWithEmails;

  log(
    `[Deploy Pipeline] CDA args: baseName=${input.baseName ?? "(none)"}, authType=${resolvedAuthType}, ` +
    `oauthClientId=${(cdaArgs["oauthClientId"] as string | undefined) ?? "(none)"}, ` +
    `oauthTenantId=${resolvedTenantId ?? "(none)"}`
  );

  const cdaStart = Date.now();

  try {
    const cdaResult = await invokeConnectorTool("connector_deploy", cdaArgs, config);

    connectorDeployMs = Date.now() - cdaStart;
    log(`[Deploy Pipeline] Step 2 completed in ${connectorDeployMs}ms`);

    if (!cdaResult.ok) {
      errors.push(`Connector deploy failed: ${cdaResult.error ?? "unknown error"}`);
      return {
        status: "failed",
        connector: null,
        appRegistration: null,
        errors,
        summary: `Deploy failed: ${cdaResult.error ?? "unknown error"}`,
        timing: { totalMs: Date.now() - pipelineStart, appCreateMs, connectorDeployMs },
      };
    }

    const cdaData = cdaResult.result as Record<string, unknown>;

    // Detect validation-only failures
    if (cdaData["action"] === "validation_failed") {
      const validation = cdaData["validation"] as Record<string, unknown> | undefined;
      const valErrors = (validation?.["errors"] as string[]) ?? ["Unknown validation error"];
      errors.push(`Swagger validation failed: ${valErrors.join("; ")}`);
      logError(`[Deploy Pipeline] ✗ CDA validation failed: ${valErrors.join("; ")}`);
      return {
        status: "failed",
        connector: null,
        appRegistration: null,
        errors,
        summary: `Deploy failed — swagger validation error: ${valErrors.join("; ")}`,
        timing: { totalMs: Date.now() - pipelineStart, appCreateMs, connectorDeployMs },
      };
    }

    const deployData = (cdaData["deploy"] ?? cdaData) as Record<string, unknown>;

    connectorResult = {
      connectorId: (deployData["connectorId"] as string) ?? "",
      displayName: (deployData["displayName"] as string) ?? "",
      environmentId: (deployData["environmentId"] as string) ?? "",
      status: (deployData["status"] as string) ?? "unknown",
      authType: deployData["authType"] as string | undefined,
      baseName: deployData["baseName"] as string | undefined,
      redirectUri: deployData["redirectUri"] as string | undefined,
      clientId: deployData["clientId"] as string | undefined,
      federatedIdentitySubject: deployData["federatedIdentitySubject"] as string | undefined,
      federatedIdentityIssuer: deployData["federatedIdentityIssuer"] as string | undefined,
      federatedIdentityAudience: deployData["federatedIdentityAudience"] as string | undefined,
      graphApiScopes: deployData["graphApiScopes"] as string[] | undefined,
      sharedWith: deployData["sharedWith"] as string[] | undefined,
    };

    // Guard: if CDA returned a response but the connector fields are empty,
    // the deploy silently failed.
    if (!connectorResult.connectorId && !connectorResult.displayName) {
      const rawHint = cdaData["action"] ? ` (CDA action: ${cdaData["action"]})` : "";
      errors.push(`Connector deploy returned empty result — connector was not created${rawHint}`);
      logError(`[Deploy Pipeline] ✗ CDA returned empty connector result. Raw keys: ${Object.keys(cdaData).join(", ")}`);
      return {
        status: "failed",
        connector: null,
        appRegistration: null,
        errors,
        summary: "Deploy failed — the connector was not created. Check the swagger URL and try again.",
        timing: { totalMs: Date.now() - pipelineStart, appCreateMs, connectorDeployMs },
      };
    }

    log(`[Deploy Pipeline] ✓ Connector deployed: ${connectorResult.displayName} (${connectorResult.connectorId})`);
  } catch (err) {
    connectorDeployMs = Date.now() - cdaStart;
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Connector deploy error: ${msg}`);
    logError(`[Deploy Pipeline] ✗ CDA call failed after ${connectorDeployMs}ms: ${msg}`);
    return {
      status: "failed",
      connector: null,
      appRegistration: null,
      errors,
      summary: `Deploy failed with error: ${msg}`,
      timing: { totalMs: Date.now() - pipelineStart, appCreateMs, connectorDeployMs },
    };
  }

  // ── Step 3: Configure app registration ──

  const connector = connectorResult!;

  if (input.skipAppRegistration) {
    log("[Deploy Pipeline] Step 3/3: Skipped — skipAppRegistration=true");
    appRegResult = { configured: false, skipped: true, skipReason: "User opted to skip app registration." };
  } else if (
    connector.authType === "NoAuth" ||
    (!connector.federatedIdentitySubject && !connector.redirectUri)
  ) {
    log("[Deploy Pipeline] Step 3/3: Skipped — NoAuth connector or no FIC fields");
    appRegResult = {
      configured: false,
      skipped: true,
      skipReason: "Connector uses NoAuth or has no federated identity / redirect URI fields.",
    };
  } else {
    log("[Deploy Pipeline] ────────────────────────────────────────────────────");
    log("[Deploy Pipeline] Step 3/3: Configuring app registration…");

    const araArgs: Record<string, unknown> = {
      connectorOutput: {
        baseName: input.baseName,
        connectorId: connector.connectorId,
        federatedIdentitySubject: connector.federatedIdentitySubject,
        federatedIdentityIssuer: connector.federatedIdentityIssuer,
        federatedIdentityAudience: connector.federatedIdentityAudience,
        redirectUri: connector.redirectUri,
        clientId: connector.clientId,
        graphApiScopes: connector.graphApiScopes,
      },
      appObjectId: createdApp?.objectId,
      authType: resolvedAuthType,
      confirmed: input.confirmed ?? true,
    };

    if (input.baseName) araArgs["baseName"] = input.baseName;

    // Pass actual connector display name so ARA can rename the app to match
    if (connector.displayName) {
      araArgs["displayName"] = connector.displayName;
    } else if (input.baseName) {
      araArgs["displayName"] = input.baseName;
    }

    const araStart = Date.now();
    const REPLICATION_RETRIES = 3;
    const REPLICATION_DELAY_MS = 5_000;

    try {
      let araResult: Awaited<ReturnType<typeof invokeAppregTool>> | undefined;

      // Retry loop for Graph API replication lag (404 Request_ResourceNotFound).
      // The app created in Step 1 may not be visible on all Graph replicas yet.
      for (let attempt = 0; attempt <= REPLICATION_RETRIES; attempt++) {
        araResult = await invokeAppregTool("appreg_configureForConnector", araArgs, config);

        const isReplicationError =
          !araResult.ok &&
          araResult.error?.includes("Request_ResourceNotFound");

        if (isReplicationError && attempt < REPLICATION_RETRIES) {
          const backoff = REPLICATION_DELAY_MS * (attempt + 1);
          log(`[Deploy Pipeline] ⏳ Graph API replication lag detected (404). Retrying in ${backoff}ms… (attempt ${attempt + 1}/${REPLICATION_RETRIES})`);
          await delay(backoff);
          continue;
        }
        break;
      }

      appRegistrationMs = Date.now() - araStart;
      log(`[Deploy Pipeline] Step 3 completed in ${appRegistrationMs}ms`);

      if (!araResult!.ok) {
        errors.push(`App registration configuration failed: ${araResult!.error ?? "unknown error"}`);
        const araData = (araResult!.result ?? {}) as Record<string, unknown>;
        const partialDetail = parseAraSteps(araData);
        appRegResult = { configured: false, skipped: false, partialDetail };
        log(`[Deploy Pipeline] ✗ App registration failed. ${partialDetail.retryGuidance}`);
      } else {
        const araData = araResult!.result as Record<string, unknown>;
        const partialDetail = parseAraSteps(araData);
        appRegResult = {
          configured: (araData["configured"] as boolean) ?? false,
          appId: araData["appId"] as string | undefined,
          objectId: araData["objectId"] as string | undefined,
          displayName: araData["displayName"] as string | undefined,
          skipped: araData["skipped"] as boolean | undefined,
          skipReason: araData["reason"] as string | undefined,
          steps: araData["steps"] as Record<string, unknown> | undefined,
          partialDetail,
        };

        if (appRegResult.configured) {
          log(`[Deploy Pipeline] ✓ App registration configured: ${appRegResult.displayName} (${appRegResult.appId})`);
        } else if (appRegResult.skipped) {
          log(`[Deploy Pipeline] ○ App registration skipped: ${appRegResult.skipReason}`);
        }
      }
    } catch (err) {
      appRegistrationMs = Date.now() - araStart;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`App registration error: ${msg}`);
      logError(`[Deploy Pipeline] ✗ ARA failed after ${appRegistrationMs}ms: ${msg}`);
      appRegResult = {
        configured: false,
        skipped: false,
        partialDetail: {
          appCreated: false,
          ficConfigured: false,
          redirectUriAdded: false,
          servicePrincipalReady: false,
          permissionsGranted: false,
          remainingSteps: ["Full app registration process"],
          retryGuidance: `App registration failed: ${msg}. The connector was deployed — you can retry app registration separately.`,
        },
      };
    }
  }

  // ── Build summary ──

  const totalMs = Date.now() - pipelineStart;
  const connectorValid = !!connector?.connectorId;
  const status: "success" | "partial" | "failed" =
    errors.length === 0 && connectorValid
      ? "success"
      : connectorValid
        ? "partial"
        : "failed";

  const summaryParts: string[] = [];

  if (createdApp) {
    summaryParts.push(
      `App registration "${createdApp.displayName ?? "(unnamed)"}" prepared ` +
      `(App ID: ${createdApp.appId}, Object ID: ${createdApp.objectId}).`
    );
  }

  summaryParts.push(
    `Connector "${connector.displayName}" deployed to environment ${connector.environmentId} ` +
    `(ID: ${connector.connectorId}).`,
  );
  if (connector.sharedWith && connector.sharedWith.length > 0) {
    summaryParts.push(`Shared with: ${connector.sharedWith.join(", ")}.`);
  }

  if (appRegResult?.configured) {
    summaryParts.push(
      `App registration "${appRegResult.displayName}" configured (App ID: ${appRegResult.appId}).`,
    );
    // Surface admin consent warning if permissions failed despite app reg succeeding
    const steps = appRegResult.steps as Record<string, unknown> | undefined;
    if (steps?.["permissionError"]) {
      const permErr = steps["permissionError"] as Record<string, unknown>;
      const failedScopes = Array.isArray(permErr["scopes"])
        ? (permErr["scopes"] as string[]).join(", ")
        : "";
      summaryParts.push(
        `⚠️ Admin consent could not be granted automatically${failedScopes ? ` for: ${failedScopes}` : ""}. ` +
        `Open Azure portal → Entra ID → App registrations → "${appRegResult.displayName}" → ` +
        `API permissions → Grant admin consent.`,
      );
    }
  } else if (appRegResult?.skipped) {
    summaryParts.push(`App registration: ${appRegResult.skipReason}`);
  } else if (appRegResult && !appRegResult.configured && !appRegResult.skipped) {
    summaryParts.push("App registration configuration failed. See errors for details.");
    if (appRegResult.partialDetail) {
      summaryParts.push(appRegResult.partialDetail.retryGuidance);
    }
  }

  if (errors.length > 0) {
    summaryParts.push(`Errors: ${errors.join("; ")}`);
  }

  summaryParts.push(`(Pipeline completed in ${(totalMs / 1000).toFixed(1)}s)`);

  log("[Deploy Pipeline] ════════════════════════════════════════════════════");
  log(
    `[Deploy Pipeline] Pipeline finished: status=${status}, total=${totalMs}ms, ` +
    `appCreate=${appCreateMs ?? 0}ms, connector=${connectorDeployMs ?? 0}ms, appReg=${appRegistrationMs ?? 0}ms`
  );

  const appRegRetryAvailable = status === "partial" && !!connector && !appRegResult?.skipped;

  return {
    status,
    connector,
    appRegistration: appRegResult,
    errors,
    summary: summaryParts.join(" "),
    timing: { totalMs, appCreateMs, connectorDeployMs, appRegistrationMs },
    ...(appRegRetryAvailable ? { appRegRetryAvailable } : {}),
  };
}

// ─── Standalone App Registration Retry ──────────────────────────────────────

/**
 * Retry ONLY the app registration step using connector details from a previous
 * partial deploy. Allows completing app registration without re-deploying.
 */
export async function retryAppRegistration(
  input: AppRegRetryInput,
  config: AgentConfig,
): Promise<AppRegistrationResult> {
  log("[Deploy Pipeline] ════════════════════════════════════════════════════");
  log("[Deploy Pipeline] Retrying app registration (standalone)…");
  log(`[Deploy Pipeline] Connector: ${input.connectorId}, baseName: ${input.baseName ?? "(none)"}`);

  const araArgs: Record<string, unknown> = {
    connectorOutput: {
      connectorId: input.connectorId,
      federatedIdentitySubject: input.federatedIdentitySubject,
      federatedIdentityIssuer: input.federatedIdentityIssuer,
      federatedIdentityAudience: input.federatedIdentityAudience,
      redirectUri: input.redirectUri,
      clientId: input.clientId,
      graphApiScopes: input.graphApiScopes,
    },
    confirmed: true,
  };

  if (input.baseName) araArgs["baseName"] = input.baseName;

  const start = Date.now();

  try {
    const araResult = await invokeAppregTool("appreg_configureForConnector", araArgs, config);

    const elapsed = Date.now() - start;
    log(`[Deploy Pipeline] App registration retry completed in ${elapsed}ms`);

    if (!araResult.ok) {
      const araData = (araResult.result ?? {}) as Record<string, unknown>;
      const partialDetail = parseAraSteps(araData);
      return { configured: false, skipped: false, partialDetail };
    }

    const araData = araResult.result as Record<string, unknown>;
    const partialDetail = parseAraSteps(araData);
    return {
      configured: (araData["configured"] as boolean) ?? false,
      appId: araData["appId"] as string | undefined,
      objectId: araData["objectId"] as string | undefined,
      displayName: araData["displayName"] as string | undefined,
      skipped: araData["skipped"] as boolean | undefined,
      skipReason: araData["reason"] as string | undefined,
      steps: araData["steps"] as Record<string, unknown> | undefined,
      partialDetail,
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    logError(`[Deploy Pipeline] App registration retry failed after ${elapsed}ms: ${msg}`);
    return {
      configured: false,
      skipped: false,
      partialDetail: {
        appCreated: false,
        ficConfigured: false,
        redirectUriAdded: false,
        servicePrincipalReady: false,
        permissionsGranted: false,
        remainingSteps: ["Full app registration process"],
        retryGuidance: `App registration retry failed: ${msg}`,
      },
    };
  }
}
