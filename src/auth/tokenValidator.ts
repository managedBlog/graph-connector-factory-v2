/**
 * JWT token validator for incoming HTTP requests.
 *
 * Validates bearer tokens by fetching tenant JWKS and checking signature,
 * audience, issuer, and standard time claims.
 */

import { createPublicKey, verify } from "node:crypto";
import { CallerIdentity } from "./requestContext";
import { logDebug, logError } from "../logging/logger";

export interface TokenValidationConfig {
  readonly tenantId: string;
  readonly allowedAudience: string;
  readonly issuer?: string | undefined;
  readonly clockSkewSeconds?: number | undefined;
}

interface JwkKey {
  kty: string;
  kid: string;
  n?: string;
  e?: string;
  x5c?: string[];
}

interface JwksResponse {
  keys: JwkKey[];
}

let cachedJwks: JwksResponse | undefined;
let jwksCacheExpiry = 0;
const JWKS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function getJwks(tenantId: string): Promise<JwksResponse> {
  const now = Date.now();
  if (cachedJwks && now < jwksCacheExpiry) {
    return cachedJwks;
  }

  const metadataUrl = `https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`;
  logDebug(`Fetching OIDC metadata from ${metadataUrl}...`);

  const metaResp = await fetch(metadataUrl);
  if (!metaResp.ok) {
    throw new Error(`Failed to fetch OIDC metadata: ${metaResp.status} ${metaResp.statusText}`);
  }

  const meta = (await metaResp.json()) as { jwks_uri: string };
  logDebug(`Fetching JWKS from ${meta.jwks_uri}...`);

  const jwksResp = await fetch(meta.jwks_uri);
  if (!jwksResp.ok) {
    throw new Error(`Failed to fetch JWKS: ${jwksResp.status} ${jwksResp.statusText}`);
  }

  cachedJwks = (await jwksResp.json()) as JwksResponse;
  jwksCacheExpiry = now + JWKS_CACHE_TTL_MS;
  return cachedJwks;
}

interface JwtHeader {
  alg: string;
  kid: string;
  typ?: string;
}

interface JwtPayload {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  oid?: string;
  tid?: string;
  upn?: string;
  preferred_username?: string;
  name?: string;
  azp?: string;
  appid?: string;
  sub?: string;
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

function parseJwtParts(token: string): { header: JwtHeader; payload: JwtPayload; signedContent: string; signature: Buffer } {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT: expected 3 parts.");
  }

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  const header = JSON.parse(base64UrlDecode(headerB64).toString("utf-8")) as JwtHeader;
  const payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf-8")) as JwtPayload;
  const signedContent = `${headerB64}.${payloadB64}`;
  const signature = base64UrlDecode(signatureB64);

  return { header, payload, signedContent, signature };
}

function verifySignature(signedContent: string, signature: Buffer, key: JwkKey): boolean {
  try {
    if (key.x5c && key.x5c.length > 0) {
      const certPem = `-----BEGIN CERTIFICATE-----\n${key.x5c[0]}\n-----END CERTIFICATE-----`;
      const pubKey = createPublicKey(certPem);
      return verify("RSA-SHA256", Buffer.from(signedContent), pubKey, signature);
    }

    if (key.n && key.e) {
      const pubKey = createPublicKey({
        key: { kty: "RSA", n: key.n, e: key.e },
        format: "jwk",
      });
      return verify("RSA-SHA256", Buffer.from(signedContent), pubKey, signature);
    }

    return false;
  } catch (err) {
    logDebug(`Signature verification failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export interface TokenValidationResult {
  readonly valid: boolean;
  readonly identity?: CallerIdentity;
  readonly error?: string;
}

export async function validateToken(
  token: string,
  config: TokenValidationConfig
): Promise<TokenValidationResult> {
  try {
    const { header, payload, signedContent, signature } = parseJwtParts(token);

    const jwks = await getJwks(config.tenantId);
    const key = jwks.keys.find((k) => k.kid === header.kid);
    if (!key) {
      return { valid: false, error: `No matching key found for kid '${header.kid}'.` };
    }

    if (!verifySignature(signedContent, signature, key)) {
      return { valid: false, error: "JWT signature verification failed." };
    }

    const now = Math.floor(Date.now() / 1000);
    const skew = config.clockSkewSeconds ?? 300;

    if (payload.exp && now > payload.exp + skew) {
      return { valid: false, error: "Token has expired." };
    }

    if (payload.nbf && now < payload.nbf - skew) {
      return { valid: false, error: "Token is not yet valid (nbf)." };
    }

    const tokenAud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const expectedAud = config.allowedAudience;
    const bareGuid = expectedAud.replace(/^api:\/\//, "");
    const apiPrefixed = expectedAud.startsWith("api://") ? expectedAud : `api://${expectedAud}`;
    const acceptableAudiences = new Set([expectedAud, bareGuid, apiPrefixed]);
    const audienceMatch = tokenAud.some((a) => a !== undefined && acceptableAudiences.has(a));
    if (!audienceMatch) {
      return {
        valid: false,
        error: `Token audience '${tokenAud.join(",")}' does not match expected '${expectedAud}'.`,
      };
    }

    if (config.issuer) {
      if (payload.iss !== config.issuer) {
        return {
          valid: false,
          error: `Token issuer '${payload.iss}' does not match expected '${config.issuer}'.`,
        };
      }
    } else {
      const v1Issuer = `https://sts.windows.net/${config.tenantId}/`;
      const v2Issuer = `https://login.microsoftonline.com/${config.tenantId}/v2.0`;
      if (payload.iss !== v1Issuer && payload.iss !== v2Issuer) {
        return {
          valid: false,
          error: `Token issuer '${payload.iss}' does not match tenant '${config.tenantId}'.`,
        };
      }
    }

    const identity: CallerIdentity = {
      oid: payload.oid,
      upn: payload.upn ?? payload.preferred_username,
      tid: payload.tid,
      name: payload.name,
      appId: payload.azp ?? payload.appid,
    };

    return { valid: true, identity };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`Token validation error: ${message}`);
    return { valid: false, error: message };
  }
}
