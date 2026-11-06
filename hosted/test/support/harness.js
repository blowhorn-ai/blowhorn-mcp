// SPDX-License-Identifier: Apache-2.0
/*
 * Shared test harness for the gateway: the Worker is driven in process with
 * worker.fetch, and Cloud is a stand-in behind globalThis.fetch. Nothing
 * leaves the process.
 *
 * mockFetch is the low-level stand-in: the test supplies `respond`, and gets
 * the list of calls the Worker made. fakeCloud is a small, complete fake of
 * the Cloud side of the contract (protected resource metadata, an OAuth
 * authorization server with registration, authorize and token endpoints, and
 * a stateless /mcp). It is a FAKE UPSTREAM CONTRACT: it proves the Worker
 * carries what the contract says, and says nothing about real Ory Hydra or
 * Kratos, nor about Blowhorn Cloud's real implementation.
 */
import { createHash, randomUUID } from "node:crypto";
import { RATE_LIMITER_BINDING } from "../../src/ratelimit.js";

export const MCP = "https://mcp.blowhorn.ai/mcp";
export const MCP_ORIGIN = "https://mcp.blowhorn.ai";
export const CLOUD = "https://cloud.blowhorn.ai";
export const ISSUER = `${CLOUD}/hydra`;
export const PRM_PATH = "/.well-known/oauth-protected-resource/mcp";
export const PRM = `${MCP_ORIGIN}${PRM_PATH}`;
export const ACCEPT = "application/json, text/event-stream";
export const CONFIG = { address: { limit: 1200, period: 60 }, caller: { limit: 60, period: 60 } };
export const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } };

/** A fake RateLimiter namespace that never refuses: tests that are not about limiting want none. */
export const UNLIMITED = Object.freeze({
  idFromName: (name) => name,
  get: () => ({ limit: async () => ({ success: true, retryAfter: 60 }) }),
});

export const ENV = Object.freeze({
  CLOUD_API_BASE: CLOUD,
  ALLOWED_ORIGINS: "https://app.example.test",
  [RATE_LIMITER_BINDING]: UNLIMITED,
  RATE_LIMITS: JSON.stringify(CONFIG),
});

/** Replaces globalThis.fetch for the test; returns the calls the Worker made. */
export function mockFetch(t, respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init, calls.length);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

/** A headers object (Headers, array or plain) as a plain object with lower-case names. */
export function plainHeaders(headers) {
  return Object.fromEntries([...new Headers(headers ?? {})].map(([k, v]) => [k.toLowerCase(), v]));
}

export function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/**
 * A fake Cloud. `handle(url, init)` answers like fetch. `seen` records every
 * request it received (url, method, lower-cased headers, body text).
 *
 * Options:
 *   legacyTokens  Bearer values /mcp accepts as legacy Cloud API tokens.
 *   leaky         Add Set-Cookie, Access-Control-Allow-Origin and X-Cloud-Internal
 *                 to every answer, to show the Worker strips them.
 *   sse           GET /mcp answers an event stream that sends one event, then
 *                 waits for `fake.gate.resolve()` before the second and close.
 */
export function fakeCloud({ legacyTokens = [], leaky = false, sse = false } = {}) {
  const seen = [];
  const clients = new Map();
  const codes = new Map();
  const tokens = new Map();
  const gate = deferred();
  const fake = { seen, clients, codes, tokens, gate, handle };

  const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        ...(leaky ? { "Set-Cookie": "cloud=1; Path=/", "Access-Control-Allow-Origin": "https://evil.example", "X-Cloud-Internal": "secret" } : {}),
        ...headers,
      },
    });

  function challenge(presented) {
    const params = [`resource_metadata="${PRM}"`];
    if (presented) params.unshift('error="invalid_token"');
    return json(401, { error: presented ? "invalid_token" : "unauthorized" }, { "WWW-Authenticate": `Bearer ${params.join(", ")}` });
  }

  function mcpResult(message) {
    const { id, method, params } = message;
    const result = (value) => json(200, { jsonrpc: "2.0", id, result: value }, { "Mcp-Session-Id": "session-from-cloud" });
    if (method === "initialize") {
      return result({ protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-cloud-mcp", version: "1" } });
    }
    if (method === "tools/list") {
      return result({ tools: [{ name: "getEvents", description: "Events.", inputSchema: { type: "object", properties: {} } }] });
    }
    if (method === "tools/call") return result({ content: [{ type: "text", text: JSON.stringify({ tool: params?.name, arguments: params?.arguments ?? {} }) }] });
    if (method === "ping") return result({});
    if (typeof method === "string" && method.startsWith("notifications/")) return new Response(null, { status: 202 });
    return json(200, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }

  async function mcp(req, headers) {
    const auth = headers.authorization;
    const token = /^Bearer (\S+)$/i.exec(auth ?? "")?.[1];
    const grant = token ? tokens.get(token) : undefined;
    const ok = token && (legacyTokens.includes(token) || grant?.resource === MCP);
    if (!ok) return challenge(auth !== undefined);
    if (req.method === "GET") {
      if (!sse) return new Response(null, { status: 405, headers: { Allow: "POST" } });
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          // A real fetch body errors when its request's signal aborts, so a timeout left running would cut this stream.
          req.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
          controller.enqueue(enc.encode('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/first"}\n\n'));
          await gate.promise;
          controller.enqueue(enc.encode('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/second"}\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
    }
    if (req.method === "DELETE") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    let message;
    try {
      message = JSON.parse(seen.at(-1).body);
    } catch {
      return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    return mcpResult(message);
  }

  async function handle(input, init) {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const headers = plainHeaders(req.headers);
    const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
    seen.push({ url: url.href, method: req.method, headers, body });
    const at = `${url.origin}${url.pathname}`;

    if (url.origin !== CLOUD) return new Response("unexpected host", { status: 599 });
    if (url.pathname === "/mcp") return mcp(req, headers);

    if (url.pathname === PRM_PATH || url.pathname === "/.well-known/oauth-protected-resource") {
      return json(200, { resource: MCP, authorization_servers: [ISSUER], bearer_methods_supported: ["header"] }, { "Cache-Control": "public, max-age=300" });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server/hydra") {
      return json(200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth2/auth`,
        token_endpoint: `${ISSUER}/oauth2/token`,
        registration_endpoint: `${ISSUER}/oauth2/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (at === `${ISSUER}/oauth2/register` && req.method === "POST") {
      const meta = JSON.parse(body);
      const client_id = `client-${clients.size + 1}`;
      clients.set(client_id, meta);
      return json(201, { ...meta, client_id });
    }
    if (at === `${ISSUER}/oauth2/auth`) {
      const q = url.searchParams;
      const client = clients.get(q.get("client_id"));
      const problems = [];
      if (!client) problems.push("unknown client_id");
      else if (!client.redirect_uris.includes(q.get("redirect_uri"))) problems.push("redirect_uri not registered");
      if (q.get("response_type") !== "code") problems.push("response_type");
      if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) problems.push("S256 challenge missing");
      if (q.getAll("resource").length !== 1 || q.get("resource") !== MCP) problems.push("resource is not exactly the canonical resource");
      if (problems.length) return json(400, { error: "invalid_request", error_description: problems.join("; ") });
      const code = randomUUID();
      codes.set(code, { client_id: q.get("client_id"), redirect_uri: q.get("redirect_uri"), challenge: q.get("code_challenge"), resource: q.get("resource") });
      const back = new URL(q.get("redirect_uri"));
      back.searchParams.set("code", code);
      if (q.get("state")) back.searchParams.set("state", q.get("state"));
      return new Response(null, { status: 302, headers: { Location: back.href } });
    }
    if (at === `${ISSUER}/oauth2/token` && req.method === "POST") {
      const form = new URLSearchParams(body);
      const grant = codes.get(form.get("code"));
      const fail = (error) => json(400, { error });
      if (form.get("grant_type") !== "authorization_code" || !grant) return fail("invalid_grant");
      codes.delete(form.get("code"));
      if (grant.client_id !== form.get("client_id") || grant.redirect_uri !== form.get("redirect_uri")) return fail("invalid_grant");
      if (b64url(createHash("sha256").update(form.get("code_verifier") ?? "").digest()) !== grant.challenge) return fail("invalid_grant");
      if (form.get("resource") !== MCP || grant.resource !== MCP) return fail("invalid_target");
      const access_token = `mcp-opaque-${randomUUID()}`;
      tokens.set(access_token, { resource: grant.resource, client_id: grant.client_id });
      return json(200, { access_token, token_type: "Bearer", expires_in: 3600 });
    }
    return json(404, { error: "not found" });
  }

  return fake;
}

/**
 * A fetch for a client of the public origin: mcp.blowhorn.ai goes to the
 * Worker, and everything else goes straight to Cloud, as it does in
 * production, where the authorization server is Cloud's own.
 */
export function clientFetch(worker, env, cloud) {
  return async (input, init) => {
    const req = new Request(input, init);
    if (new URL(req.url).origin === MCP_ORIGIN) return worker.fetch(req, env, {});
    return cloud.handle(req);
  };
}
