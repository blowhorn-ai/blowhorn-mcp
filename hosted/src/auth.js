// SPDX-License-Identifier: Apache-2.0
/*
 * The Bearer token in an Authorization header, read for one purpose only: to
 * key the per-caller rate limit by its hash (src/ratelimit.js). The gateway
 * does not validate, interpret or store a token, and it forwards the header
 * to Cloud unchanged whether or not this parses; what a token is, and whether
 * it is valid for this resource, is Cloud's to decide.
 */

export const MAX_TOKEN_LENGTH = 4096;

/** The bearer token in an Authorization header value, or null when it is missing or malformed. */
export function bearerToken(header) {
  if (typeof header !== "string") return null;
  const m = header.match(/^Bearer ([^\s]+)$/i);
  if (!m) return null;
  const token = m[1];
  if (token.length > MAX_TOKEN_LENGTH) return null;
  // Visible ASCII only: no whitespace, no control characters.
  if (!/^[\x21-\x7e]+$/.test(token)) return null;
  return token;
}
