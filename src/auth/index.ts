export { runWithRequestContext, getRequestContext, updateCallerIdentity } from "./requestContext";
export type { RequestContextData, CallerIdentity } from "./requestContext";

export { validateToken } from "./tokenValidator";
export type { TokenValidationConfig, TokenValidationResult } from "./tokenValidator";

export { decodeTokenClaims } from "./types";
export type { CredentialProvider, TokenResult, TokenClaims } from "./types";

import type { CredentialProvider, TokenResult } from "./types";
import type { BackendAuthConfig } from "../config/types";
import { DefaultAzureCredential, ClientSecretCredential } from "@azure/identity";
import { log } from "../logging/logger";

/**
 * Create a credential provider based on backend auth config.
 * Wraps @azure/identity credential classes in our CredentialProvider interface.
 */
export function createCredentialProvider(authConfig: BackendAuthConfig): CredentialProvider {
  switch (authConfig.method) {
    case "clientCredential": {
      if (authConfig.clientSecret) {
        const cred = new ClientSecretCredential(
          authConfig.tenantId,
          authConfig.clientId,
          authConfig.clientSecret
        );
        return {
          method: "clientCredential",
          async getToken(scope: string): Promise<TokenResult> {
            const result = await cred.getToken(scope);
            return {
              accessToken: result.token,
              expiresOn: result.expiresOnTimestamp / 1000,
            };
          },
        };
      }
      // Fall through to DefaultAzureCredential for Key Vault flow
      log("clientCredential without inline secret — using DefaultAzureCredential for Key Vault access.");
      return createDefaultCredentialProvider("clientCredential");
    }

    case "managedIdentity":
      log("Using managed identity authentication (DefaultAzureCredential).");
      return createDefaultCredentialProvider("managedIdentity");

    case "appOnly":
    case "delegatedToken":
    case "certificate":
    default:
      log(`Auth method '${authConfig.method}' — using DefaultAzureCredential fallback.`);
      return createDefaultCredentialProvider(authConfig.method);
  }
}

function createDefaultCredentialProvider(method: string): CredentialProvider {
  const cred = new DefaultAzureCredential();
  return {
    method,
    async getToken(scope: string): Promise<TokenResult> {
      const result = await cred.getToken(scope);
      return {
        accessToken: result.token,
        expiresOn: result.expiresOnTimestamp / 1000,
      };
    },
  };
}
