/**
 * Authentication type definitions for credential providers.
 */

/** A credential provider that can acquire bearer tokens for backend API calls. */
export interface CredentialProvider {
  readonly method: string;
  getToken(scope: string): Promise<TokenResult>;
}

/** Result of a token acquisition. */
export interface TokenResult {
  readonly accessToken: string;
  readonly expiresOn: number;
}

/** Decoded JWT claims relevant to API calls. */
export interface TokenClaims {
  readonly oid?: string;
  readonly tid?: string;
  readonly appid?: string;
  readonly sub?: string;
}

/**
 * Decode JWT claims from an access token (no signature verification).
 * Safe for extracting oid/tid for API path construction — not for auth decisions.
 */
export function decodeTokenClaims(accessToken: string): TokenClaims {
  const parts = accessToken.split(".");
  const payload = parts[1];
  if (!payload) {
    return {};
  }
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf-8");
    return JSON.parse(decoded) as TokenClaims;
  } catch {
    return {};
  }
}
