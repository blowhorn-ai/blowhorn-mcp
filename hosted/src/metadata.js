// SPDX-License-Identifier: Apache-2.0
/*
 * RFC 9728 protected resource metadata for the public Worker origin, and the
 * WWW-Authenticate rewrite that points clients at it.
 *
 * Audience / resource note (design vs public edge):
 * internal/design/hosted-mcp-server.md makes Cloud's canonical resource and
 * token audience https://cloud.blowhorn.ai/mcp when clients talk to Cloud
 * directly. This Worker is the interim public edge at
 * https://mcp.blowhorn.ai/mcp: the official MCP OAuth client requires the
 * metadata `resource` to match the URL (or origin) it connected to, so the
 * document's `resource` is https://mcp.blowhorn.ai/mcp. The Worker still
 * forwards every Bearer token to Cloud's /mcp unchanged; Cloud must accept
 * that audience on the proxied path (cutover gate in hosted/README.md).
 * authorization_servers always names Cloud's Blowhorn issuer.
 *
 * The document is pinned by hosted/schemas/protected-resource.schema.json and
 * held by test/metadata.test.js.
 */
import { DEFAULT_BASE } from "./proxy.js";

/** Public origin clients connect to (custom domain on this Worker). */
export const PUBLIC_ORIGIN = "https://mcp.blowhorn.ai";
/** Protected resource identifier for clients of this Worker (MCP SDK match). */
export const PUBLIC_RESOURCE = `${PUBLIC_ORIGIN}/mcp`;
/** Cloud's /mcp path the Worker forwards to (design canonical deployment). */
export const CLOUD_MCP_PATH = `${DEFAULT_BASE}/mcp`;
/** Cloud's authorization server issuer on the Blowhorn host. */
export const AUTHORIZATION_SERVER = `${DEFAULT_BASE}/hydra`;
/** Path-inserted and root RFC 9728 paths this Worker serves. */
export const PRM_PATH = "/.well-known/oauth-protected-resource/mcp";
export const PRM_ROOT = "/.well-known/oauth-protected-resource";
/** Absolute metadata URL named in WWW-Authenticate. */
export const PRM_URL = `${PUBLIC_ORIGIN}${PRM_PATH}`;

/**
 * The protected resource metadata document. `resource` is the public Worker
 * URL clients connect to; `authorization_servers` is Cloud's Blowhorn issuer.
 */
export function protectedResourceMetadata() {
  return Object.freeze({
    resource: PUBLIC_RESOURCE,
    authorization_servers: Object.freeze([AUTHORIZATION_SERVER]),
    bearer_methods_supported: Object.freeze(["header"]),
    resource_name: "Blowhorn MCP",
  });
}

/**
 * Rewrite a Cloud `WWW-Authenticate` value so `resource_metadata` names this
 * Worker's public RFC 9728 document. Other Bearer params (error, scope, realm)
 * are kept. When the header is missing or not a Bearer challenge, returns a
 * fresh challenge that only names the metadata URL.
 */
export function publicChallenge(wwwAuthenticate) {
  const value = String(wwwAuthenticate || "").trim();
  if (!value || !/^Bearer\b/i.test(value)) {
    return `Bearer resource_metadata="${PRM_URL}"`;
  }
  if (/resource_metadata\s*=/i.test(value)) {
    return value.replace(
      /resource_metadata\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,]+)/i,
      `resource_metadata="${PRM_URL}"`,
    );
  }
  return `${value}, resource_metadata="${PRM_URL}"`;
}
