/**
 * Local, read-only helpers for the M365 access token.
 *
 * The token is a Microsoft-issued JWT. We never validate its signature (we are
 * the bearer, not the audience) and we never send it anywhere except the
 * official substrate.office.com endpoint it was issued for. These helpers only
 * *read* claims locally so we can build the WebSocket URL (`oid`/`tid`) and
 * warn on expiry — no network calls, no credential forwarding.
 */

/**
 * Decode a JWT's payload claims without verifying the signature.
 * @param {string} token
 * @returns {Record<string, unknown>}
 */
export function decodeJwtClaims(token) {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("M365 token is empty");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("M365 token is not a valid JWT (expected three dot-separated segments)");
  }
  try {
    const json = Buffer.from(base64UrlToBase64(parts[1]), "base64").toString("utf8");
    const claims = JSON.parse(json);
    if (claims === null || typeof claims !== "object") throw new Error("claims are not an object");
    return claims;
  } catch (err) {
    throw new Error(`M365 token payload could not be decoded: ${err.message}`);
  }
}

function base64UrlToBase64(input) {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  return padded.replace(/-/g, "+").replace(/_/g, "/");
}

/**
 * Seconds until the token expires (negative if already expired), or null when
 * the token carries no `exp` claim.
 * @param {Record<string, unknown>} claims
 */
export function secondsUntilExpiry(claims, now = Date.now()) {
  const exp = claims?.exp;
  if (typeof exp !== "number") return null;
  return Math.floor(exp - now / 1000);
}

/** True when the token is expired (or within `skewSeconds` of expiring). */
export function isExpired(claims, skewSeconds = 60, now = Date.now()) {
  const remaining = secondsUntilExpiry(claims, now);
  return remaining !== null && remaining <= skewSeconds;
}

/**
 * Remove anything token-shaped from a string before it is logged or surfaced
 * in an error. Redacts `access_token=` query values and bare JWTs.
 * @param {string} text
 */
export function redactSecrets(text) {
  return String(text)
    .replace(/access_token=[^&\s]+/gi, "access_token=REDACTED")
    .replace(/\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "REDACTED_JWT");
}
