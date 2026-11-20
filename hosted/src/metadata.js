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
import { DEFAULT_BASE, PUBLIC_ORIGIN, PUBLIC_RESOURCE, deployment } from "./proxy.js";

export { PUBLIC_ORIGIN, PUBLIC_RESOURCE };
/** Cloud's /mcp path the Worker forwards to (design canonical deployment). */
export const CLOUD_MCP_PATH = `${DEFAULT_BASE}/mcp`;
/** Cloud's authorization server issuer on the Blowhorn host. */
export const AUTHORIZATION_SERVER = DEFAULT_BASE;
/** Path-inserted and root RFC 9728 paths this Worker serves. */
export const PRM_PATH = "/.well-known/oauth-protected-resource/mcp";
export const PRM_ROOT = "/.well-known/oauth-protected-resource";
/** Production's absolute metadata URL named in WWW-Authenticate. */
export const PRM_URL = `${PUBLIC_ORIGIN}${PRM_PATH}`;

/** The env's deployment (src/proxy.js deployment); throws when it is not a known pair, which callers have already refused. */
function resolve(env) {
  const d = deployment(env);
  if (!d) throw new Error("env is not a known deployment");
  return d;
}

/**
 * The protected resource metadata document. `resource` is the public Worker
 * URL clients connect to; `authorization_servers` is Cloud's Blowhorn issuer.
 * Both come from the env's known pair; the default env is production.
 */
export function protectedResourceMetadata(env = {}) {
  const d = resolve(env);
  return Object.freeze({
    resource: d.resource,
    authorization_servers: Object.freeze([d.cloudBase]),
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
export function publicChallenge(wwwAuthenticate, env = {}) {
  const prmUrl = `${resolve(env).publicOrigin}${PRM_PATH}`;
  const value = String(wwwAuthenticate || "").trim();
  if (!value || !/^Bearer\b/i.test(value)) {
    return `Bearer resource_metadata="${prmUrl}"`;
  }
  if (/resource_metadata\s*=/i.test(value)) {
    return value.replace(
      /resource_metadata\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,]+)/i,
      `resource_metadata="${prmUrl}"`,
    );
  }
  return `${value}, resource_metadata="${prmUrl}"`;
}
