// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Replaces values under secret-named keys before a Cloud answer leaves the
 * gateway.
 *
 * This duplicates, on purpose, the key rule of `_is_secret_key` in the
 * Blowhorn repo's engine/blowhorn/mcp_server/loader.py: the Worker cannot
 * import Python. Keep the two in step. A key splits on non-alphanumerics and
 * camelCase into lowercase segments (GH_TOKEN is gh + token; author is author
 * alone, so it is not one). Some segments name a secret on their own; "key"
 * and "auth" only count beside a qualifier, so idempotency_key and authStatus
 * keep their values. A boolean or null cannot carry a secret, so it is kept.
 */

export const REDACTED = "[redacted]";

const SECRET_SEGMENTS = new Set(["token", "password", "passwd", "secret", "cookie", "credential", "apikey"]);
const SECRET_QUALIFIERS = new Set(["api", "access", "session", "private"]);
const CAMEL_SPLIT = /[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g;

export function isSecretKey(key) {
  const segments = new Set();
  for (const part of String(key).split(/[^A-Za-z0-9]+/)) {
    for (const item of part.match(CAMEL_SPLIT) || []) segments.add(item.toLowerCase());
  }
  const has = (set) => [...segments].some((s) => set.has(s));
  if (has(SECRET_SEGMENTS)) return true;
  if (segments.has("key") && has(SECRET_QUALIFIERS)) return true;
  if (segments.has("auth") && (has(SECRET_SEGMENTS) || has(SECRET_QUALIFIERS))) return true;
  return false;
}

/** A copy of `value` with every value under a secret-named key replaced by REDACTED. */
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key) && item !== null && typeof item !== "boolean" ? REDACTED : redact(item);
  }
  return out;
}
