/**
 * Policy enforcement for the unified server.
 * Manages session-scoped autonomy mode and guards for destructive operations.
 */

import { PoliciesConfig } from "../config/types";

let _autonomyMode: "confirm" | "autonomous" = "confirm";

export function initialisePolicyState(policies: PoliciesConfig): void {
  const defaultMode = policies.autonomy?.defaultMode ?? "confirm";
  const allowAutoApprove = policies.autonomy?.allowAutoApprove ?? false;
  _autonomyMode = defaultMode === "autonomous" && allowAutoApprove ? "autonomous" : "confirm";
}

export function getAutonomyMode(): "confirm" | "autonomous" {
  return _autonomyMode;
}

export function setAutonomyMode(
  policies: PoliciesConfig,
  mode: "confirm" | "autonomous"
): "confirm" | "autonomous" {
  const allowAutoApprove = policies.autonomy?.allowAutoApprove ?? false;
  if (mode === "autonomous" && !allowAutoApprove) {
    throw new Error(
      "Autonomous mode is disabled by policy. Set policies.autonomy.allowAutoApprove=true to enable."
    );
  }

  _autonomyMode = mode;
  return _autonomyMode;
}

export function assertDeleteAllowed(policies: PoliciesConfig): void {
  if (!policies.allowDelete) {
    throw new Error("Delete operations are disabled. Set policies.allowDelete=true to enable.");
  }
}

export function assertInlineSecretsAllowed(policies: PoliciesConfig): void {
  if (!policies.secrets.inlineSecretsAllowed) {
    throw new Error(
      "Inline secrets are disabled. Set policies.secrets.inlineSecretsAllowed=true to enable."
    );
  }
}
