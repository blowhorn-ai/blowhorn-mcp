// SPDX-License-Identifier: Apache-2.0
/*
 * The caller's own Cloud API token, from `Authorization: Bearer <token>`.
 * The gateway keeps no credentials of its own: every call to Cloud carries
 * the caller's token, and nothing else.
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
