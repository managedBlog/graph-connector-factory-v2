export { runWithRequestContext, getRequestContext, updateCallerIdentity } from "./requestContext";
export type { RequestContextData, CallerIdentity } from "./requestContext";

export { validateToken } from "./tokenValidator";
export type { TokenValidationConfig, TokenValidationResult } from "./tokenValidator";

export { decodeTokenClaims } from "./types";
export type { CredentialProvider, TokenResult, TokenClaims } from "./types";

import type { CredentialProvider, TokenResult } from "./types";
import type { BackendAuthConfig } from "../config/types";
import { DefaultAzureCredential, ClientSecretCredential, ClientCertificateCredential } from "@azure/identity";
import { log } from "../logging/logger";
import * as fs from "fs";
import * as path from "path";

/**
 * Create a credential provider based on backend auth config.
 * Wraps @azure/identity credential classes in our CredentialProvider interface.
 */
export function createCredentialProvider(authConfig: BackendAuthConfig): CredentialProvider {
  switch (authConfig.method) {
    case "clientCredential": {
      // Resolve secret: config value → environment variable → absent
      const secret = authConfig.clientSecret || process.env["GCF_CLIENT_SECRET"];
      if (secret) {
        log(authConfig.clientSecret
          ? "clientCredential using inline config secret."
          : "clientCredential using GCF_CLIENT_SECRET environment variable.");
        const cred = new ClientSecretCredential(
          authConfig.tenantId,
          authConfig.clientId,
          secret
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
      // Fall through to DefaultAzureCredential for Key Vault / managed identity
      log("clientCredential without secret — using DefaultAzureCredential.");
      return createDefaultCredentialProvider("clientCredential");
    }

    case "certificate": {
      if (!authConfig.certificatePath) {
        throw new Error(
          "Auth method 'certificate' requires 'certificatePath' in config. " +
          "Provide the path to a PEM file containing the private key and certificate."
        );
      }
      const certFile = path.isAbsolute(authConfig.certificatePath)
        ? authConfig.certificatePath
        : path.resolve(process.cwd(), authConfig.certificatePath);
      if (!fs.existsSync(certFile)) {
        throw new Error(`Certificate file not found: ${certFile}`);
      }
      log(`certificate auth using: ${certFile}`);
      const cred = new ClientCertificateCredential(
        authConfig.tenantId,
        authConfig.clientId,
        certFile
      );
      return {
        method: "certificate",
        async getToken(scope: string): Promise<TokenResult> {
          const result = await cred.getToken(scope);
          return {
            accessToken: result.token,
            expiresOn: result.expiresOnTimestamp / 1000,
          };
        },
      };
    }

    case "managedIdentity":
      log("Using managed identity authentication (DefaultAzureCredential).");
      return createDefaultCredentialProvider("managedIdentity");

    case "appOnly":
    case "delegatedToken":
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
