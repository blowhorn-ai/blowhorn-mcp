// SPDX-License-Identifier: Apache-2.0
/*
 * FAKE UPSTREAM CONTRACT TEST. NOT a real Ory Hydra, NOT a real Ory Kratos,
 * NOT Blowhorn Cloud, NOT Gemini CLI, and NOT an end-to-end test of anything
 * deployed.
 *
 * What it proves: the Worker, as the public edge at https://mcp.blowhorn.ai/mcp,
 * rewrites Cloud's 401 challenge and serves RFC 9728 metadata naming Cloud's
 * Blowhorn issuer and canonical audience, so that the official MCP SDK client
 * (the OAuth client in @modelcontextprotocol/sdk) can discover Cloud's
 * authorization server, register, run the authorization code flow with S256
 * and the canonical `resource`, and then initialize, list
 * tools and call a tool through the Worker with the token it got.
 *
 * What it does not prove: that Cloud (PR 6424 or anything else) really
 * serves this contract, that Hydra or Kratos accept it, that Gemini CLI
 * behaves like the SDK, or anything about production. The fake in
 * test/support/harness.js is only as good as its reading of the contract.
 * The real local-stack run (Hydra, Kratos, Cloud) is a separate gate owned by
 * the Cloud change and must pass before any cutover of this Worker.
 */
import test from "node:test";
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import worker from "../src/index.js";
import { ACCEPT, CANONICAL_RESOURCE, CLOUD, ENV, INIT, ISSUER, MCP, MCP_ORIGIN, PRM, PRM_PATH, fakeCloud, mockFetch } from "./support/harness.js";

const REDIRECT = "http://127.0.0.1:8976/oauth/callback";

/** An OAuthClientProvider that keeps everything in memory and records where the SDK sent the user's browser. */
function provider() {
  const mem = { client: undefined, tokens: undefined, verifier: undefined, authorizationUrl: undefined };
  return {
    mem,
    get redirectUrl() {
      return REDIRECT;
    },
    get clientMetadata() {
      return {
        client_name: "sdk-contract-test",
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    clientInformation: () => mem.client,
    saveClientInformation: (info) => void (mem.client = info),
    tokens: () => mem.tokens,
    saveTokens: (tokens) => void (mem.tokens = tokens),
    redirectToAuthorization: (url) => void (mem.authorizationUrl = url),
    saveCodeVerifier: (v) => void (mem.verifier = v),
    codeVerifier: () => mem.verifier,
  };
}

/** Wraps the Worker with a log of every request the client made to the public origin, and passes the rest to Cloud direct. */
function topology(cloud) {
  const viaWorker = [];
  const fetchFn = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin === MCP_ORIGIN) {
      viaWorker.push(`${req.method} ${url.pathname}`);
      return worker.fetch(req, ENV, {});
    }
    return cloud.handle(req);
  };
  return { viaWorker, fetchFn };
}

function setup(t, cloudOptions) {
  const cloud = fakeCloud(cloudOptions);
  // The Worker's own trips to Cloud.
  mockFetch(t, (url, init) => cloud.handle(url, init));
  return { cloud, ...topology(cloud) };
}

test("official SDK: 401, discovery through the Worker, registration, code S256 with the canonical resource, then tools/list and tools/call", async (t) => {
  const { cloud, viaWorker, fetchFn } = setup(t);
  const p = provider();

  // 1. No token: the SDK is turned away; the Worker rewrites the challenge and serves metadata itself.
  const first = new Client({ name: "sdk-contract-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP), { authProvider: p, fetch: fetchFn });
  await assert.rejects(first.connect(transport), UnauthorizedError);

  // The Worker answered /mcp (proxy) and PRM (local). Discovery and registration go to Cloud's issuer direct.
  assert.deepStrictEqual(viaWorker, ["POST /mcp", `GET ${PRM_PATH}`]);
  assert.ok(!cloud.seen.some((s) => s.url.includes("/.well-known/oauth-protected-resource")), "PRM was not fetched from Cloud");
  assert.ok(cloud.seen.some((s) => s.url === `${CLOUD}/mcp`), "the 401 came from Cloud's /mcp");
  assert.ok(cloud.seen.some((s) => s.url === `${CLOUD}/.well-known/oauth-authorization-server/hydra` || s.url.startsWith(`${ISSUER}/`)), "the SDK followed the issuer in the Worker's metadata");
  assert.ok(cloud.seen.some((s) => s.url === `${ISSUER}/oauth2/register`), "and registered there");
  assert.ok(cloud.seen.filter((s) => s.url.startsWith(CLOUD) && s.url !== `${CLOUD}/mcp` && !s.url.includes("/.well-known/oauth-protected-resource")).every((s) => !s.headers.authorization));
  assert.strictEqual(cloud.clients.size, 1);
  assert.deepStrictEqual(cloud.clients.get("client-1").redirect_uris, [REDIRECT]);

  // 2. The authorization request: Cloud's issuer, PKCE S256, and the canonical Cloud resource byte for byte.
  const authUrl = p.mem.authorizationUrl;
  assert.ok(authUrl, "the SDK asked for the user's browser");
  assert.strictEqual(`${authUrl.origin}${authUrl.pathname}`, `${ISSUER}/oauth2/auth`);
  assert.strictEqual(authUrl.searchParams.get("response_type"), "code");
  assert.strictEqual(authUrl.searchParams.get("code_challenge_method"), "S256");
  assert.strictEqual(authUrl.searchParams.get("client_id"), "client-1");
  assert.strictEqual(authUrl.searchParams.get("redirect_uri"), REDIRECT);
  assert.deepStrictEqual(authUrl.searchParams.getAll("resource"), [CANONICAL_RESOURCE]);

  // 3. The "browser": the fake authorization server approves and redirects back with a code.
  const approved = await cloud.handle(new Request(authUrl, { redirect: "manual" }));
  assert.strictEqual(approved.status, 302);
  const back = new URL(approved.headers.get("Location"));
  assert.strictEqual(`${back.origin}${back.pathname}`, REDIRECT);
  const code = back.searchParams.get("code");
  assert.ok(code);

  // 4. The SDK exchanges the code (S256 verifier, resource again) and keeps the token.
  await transport.finishAuth(code);
  const token = p.mem.tokens?.access_token;
  assert.match(token, /^mcp-opaque-/);
  assert.deepStrictEqual(cloud.tokens.get(token), { resource: CANONICAL_RESOURCE, client_id: "client-1" }, "the token is bound to the canonical resource");

  // 5. A fresh connection with that token: initialize, tools/list, tools/call, all through the Worker.
  const client = new Client({ name: "sdk-contract-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP), { authProvider: p, fetch: fetchFn }));
  t.after(() => client.close());
  assert.strictEqual(client.getServerVersion().name, "fake-cloud-mcp");
  const { tools } = await client.listTools();
  assert.deepStrictEqual(tools.map((x) => x.name), ["getEvents"]);
  const result = await client.callTool({ name: "getEvents", arguments: { limit: 3 } });
  assert.deepStrictEqual(JSON.parse(result.content[0].text), { tool: "getEvents", arguments: { limit: 3 } });

  // The token reached Cloud's /mcp as sent, and only there.
  const withToken = cloud.seen.filter((s) => s.headers.authorization === `Bearer ${token}`);
  assert.ok(withToken.length >= 3);
  assert.ok(withToken.every((s) => s.url === `${CLOUD}/mcp`));
  assert.ok(cloud.seen.filter((s) => s.url.includes("/.well-known/")).every((s) => !s.headers.authorization));
});

test("a static Bearer header (the way Claude Code and other header-token clients connect today) works through the same route", async (t) => {
  const { cloud, fetchFn } = setup(t, { legacyTokens: ["legacy-cloud-token-0123456789"] });
  const client = new Client({ name: "legacy", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { Authorization: "Bearer legacy-cloud-token-0123456789" } }, fetch: fetchFn }));
  t.after(() => client.close());
  assert.strictEqual((await client.listTools()).tools.length, 1);
  assert.ok(!(await client.callTool({ name: "getEvents", arguments: {} })).isError);
  assert.strictEqual(cloud.clients.size, 0, "no registration, no discovery");
});

test("a token minted for another resource is refused by Cloud and its challenge comes back; the Worker adds no second opinion", async (t) => {
  const { cloud } = setup(t);
  cloud.tokens.set("rest-api-token", { resource: CLOUD, client_id: "client-x" });
  const res = await worker.fetch(
    new Request(MCP, { method: "POST", headers: { "Content-Type": "application/json", Accept: ACCEPT, Authorization: "Bearer rest-api-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: INIT }) }),
    ENV,
    {},
  );
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.headers.get("WWW-Authenticate"), `Bearer error="invalid_token", resource_metadata="${PRM}"`);
});

test("forged Host and forwarded-host headers change neither the metadata the SDK reads nor what Cloud sees", async (t) => {
  const { cloud } = setup(t);
  const forged = { Host: "evil.example", "X-Forwarded-Host": "evil.example", Forwarded: "host=evil.example;proto=https", "X-Forwarded-Proto": "https" };
  const plain = await worker.fetch(new Request(PRM), ENV, {});
  const tampered = await worker.fetch(new Request(PRM, { headers: forged }), ENV, {});
  assert.deepStrictEqual(await tampered.json(), await plain.json());
  const challenge = await worker.fetch(
    new Request(MCP, { method: "POST", headers: { "Content-Type": "application/json", Accept: ACCEPT, ...forged }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: INIT }) }),
    ENV,
    {},
  );
  assert.strictEqual(challenge.headers.get("WWW-Authenticate"), `Bearer resource_metadata="${PRM}"`);
  for (const s of cloud.seen) {
    assert.deepStrictEqual(Object.keys(s.headers).filter((k) => /host|forwarded|evil/i.test(k) || /evil/.test(s.headers[k])), [], s.url);
  }
});

test("the fake authorization server is strict, so a Worker that dropped the resource would fail: a wrong or missing resource is refused", async (t) => {
  const { cloud } = setup(t);
  const registered = await cloud.handle(new Request(`${ISSUER}/oauth2/register`, { method: "POST", body: JSON.stringify({ redirect_uris: [REDIRECT] }) }));
  const { client_id } = await registered.json();
  const ask = (params) => cloud.handle(new Request(`${ISSUER}/oauth2/auth?${new URLSearchParams({ client_id, redirect_uri: REDIRECT, response_type: "code", code_challenge_method: "S256", code_challenge: "abc", ...params })}`, { redirect: "manual" }));
  assert.strictEqual((await ask({ resource: CANONICAL_RESOURCE })).status, 302);
  assert.strictEqual((await ask({})).status, 400, "no resource");
  assert.strictEqual((await ask({ resource: `${CANONICAL_RESOURCE}/` })).status, 400, "trailing slash is not the same resource");
  assert.strictEqual((await ask({ resource: `${CLOUD}/mcp` })).status, 400, "Cloud's deployment URL is not this Worker's public resource");
  assert.strictEqual((await ask({ resource: CLOUD })).status, 400, "the Cloud origin is not the resource");
  assert.strictEqual((await ask({ resource: MCP_ORIGIN })).status, 400, "the origin alone is not the resource");
  assert.strictEqual((await ask({ resource: CANONICAL_RESOURCE, code_challenge_method: "plain" })).status, 400, "plain PKCE");
});
