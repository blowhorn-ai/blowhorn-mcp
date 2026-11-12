// SPDX-License-Identifier: Apache-2.0
/*
 * Drives scripts/smoke-hosted.js (the opt-in live smoke) against a local
 * mock HTTP server. Nothing here contacts mcp.blowhorn.ai or Cloud: the
 * production URLs the script builds are rewritten to the mock, and the CLI
 * run points --base at it.
 */
import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_BASE } from "../src/proxy.js";
import { AUTHORIZATION_SERVER, PRM_PATH, PUBLIC_ORIGIN, protectedResourceMetadata } from "../src/metadata.js";
import { CLIENT_NAME_PREFIX, ENV_NAMES, EXPECTED_TOOLS, REDIRECT_URI, USER_AGENT, run } from "../scripts/smoke-hosted.js";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "smoke-hosted.js");
const GOOD = "mcp-user-token-0123456789abcdef";
const LEGACY = "legacy-cloud-token-0123456789abcdef";
const WRONG = "other-audience-token-0123456789abcdef";
const SECRET = "dcr-client-secret-0123456789abcdef";
const RAT = "registration-access-token-0123456789abcdef";
const EMAIL = "smoke-account@example.test";
const PASSWORD = "test-account-password-0123456789";
const CSRF = "csrf-form-value-0123456789abcdef";
const CSRF_COOKIE = "csrf-cookie-value-0123456789abcdef";
const SESSION = "session-cookie-value-0123456789abcdef";
const CODE = "authorization-code-0123456789abcdef";
const USER = "pkce-user-access-token-0123456789abcdef";
const REFRESH = "pkce-refresh-token-0123456789abcdef";
const ACCOUNT = { BLOWHORN_MCP_TEST_EMAIL: EMAIL, BLOWHORN_MCP_TEST_PASSWORD: PASSWORD };
const LOOPBACK_ORIGIN = new URL(REDIRECT_URI).origin;
const NO_TOKENS = Object.fromEntries(Object.values(ENV_NAMES).flat().map((n) => [n, ""]));

const toolDefs = (names) =>
  names.map((name) => ({ name, inputSchema: { type: "object", properties: { organizationId: { type: "string" } }, required: ["organizationId"] } }));

async function mcpAnswer(req, res, body, tools) {
  const server = new Server({ name: "mock-cloud-mcp", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefs(tools) }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({ content: [{ type: "text", text: JSON.stringify(params) }] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

/**
 * A mock of the deployed origin and the authorization server. `prm` and
 * `issuer` are what the metadata names; options break one thing at a time.
 * The sign-in mock follows Cloud's shape: authorize redirects to /login with
 * a login_challenge, the Cloud-brokered flow API signs in (or, with
 * `unverified`, redirects to /verification), then /consent answers as
 * `consent` says: "form" (a plain HTML form), "widget" (a JavaScript page)
 * or "cloudflare" (a 1010 block).
 */
async function mockOrigin(t, options = {}) {
  const seen = [];
  const state = { deleted: [], calls: [] };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString();
    const url = new URL(req.url, "http://mock");
    seen.push({ method: req.method, path: url.pathname, ua: req.headers["user-agent"], authorization: req.headers.authorization });
    const json = (status, doc, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(doc));
    };
    const { prm, issuer, issuerPath, registration } = state.urls;
    const redirect = (status, location, headers = {}) => {
      res.writeHead(status, { Location: location, ...headers });
      res.end();
    };
    const html = (status, body) => {
      res.writeHead(status, { "Content-Type": "text/html" });
      res.end(body);
    };
    const cookie = req.headers.cookie ?? "";
    const signedIn = cookie.includes(`session_cookie=${SESSION}`);
    const challenge = options.challenge ?? `Bearer resource_metadata="${prm}"`;
    const asPath = options.asAppended ? `${issuerPath}/.well-known/oauth-authorization-server` : `/.well-known/oauth-authorization-server${issuerPath}`;
    const asDoc = { issuer: options.asIssuer ?? issuer, authorization_endpoint: options.authorizeAt ?? `${issuer}/oauth2/auth`, token_endpoint: `${issuer}/oauth2/token`, response_types_supported: ["code"], registration_endpoint: registration };
    switch (`${req.method} ${url.pathname}`) {
      case `GET ${issuerPath}/oauth2/auth`: {
        const q = url.searchParams;
        if (q.has("consent_verifier")) return redirect(302, `${REDIRECT_URI}?code=${CODE}&scope=openid+offline_access&state=${state.authorize.get("state")}`);
        if (q.has("login_verifier")) return signedIn ? redirect(302, `${state.urls.origin}/consent?consent_challenge=consent-1`) : json(401, { error: "no session" });
        state.authorize = q;
        return redirect(302, `${options.loginAt ?? state.urls.origin}/login?login_challenge=login-1`);
      }
      case "GET /api/auth/flow":
        state.flowQuery = url.searchParams;
        return json(200, { id: "flow-1", ui: { nodes: [{ group: "default", attributes: { name: "csrf_token", type: "hidden", value: CSRF } }, { group: "password", attributes: { name: "identifier", type: "text" } }] } }, { "Set-Cookie": `csrf_token_1=${CSRF_COOKIE}; Path=/; HttpOnly` });
      case "POST /api/auth/flow/submit":
        state.login = { query: url.searchParams, form: new URLSearchParams(text), cookie };
        if (options.unverified) return redirect(303, `${state.urls.origin}/verification?flow=verify-1`);
        return redirect(303, `${issuer}/oauth2/auth?login_verifier=verifier-1`, { "Set-Cookie": `session_cookie=${SESSION}; Path=/; HttpOnly; Secure` });
      case "GET /consent":
        if (!signedIn) return json(401, { error: "no session" });
        if (options.consent === "cloudflare") return html(403, "<html><title>Access denied</title>error code: 1010</html>");
        if (options.consent === "widget") return html(200, '<html><div id="root"></div><script src="/app.js"></script></html>');
        return html(200, `<html><form method="post" action="/consent"><input type="hidden" name="consent_challenge" value="${url.searchParams.get("consent_challenge")}"><input type="checkbox" name="grant_scope" value="openid" checked><button type="submit" name="submit" value="deny">Deny</button><button type="submit" name="submit" value="accept">Allow</button></form></html>`);
      case "POST /consent":
        state.consent = new URLSearchParams(text);
        return redirect(302, `${issuer}/oauth2/auth?consent_verifier=consent-verifier-1`);
      case `POST ${issuerPath}/oauth2/token`: {
        const form = new URLSearchParams(text);
        state.token = form;
        const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (form.get("code") !== CODE || challenge !== state.authorize.get("code_challenge")) return json(400, { error: "invalid_grant" });
        return json(200, { access_token: USER, token_type: "bearer", expires_in: 3600, scope: "openid offline_access", refresh_token: REFRESH });
      }
      case `GET ${PRM_PATH}`:
      case "GET /.well-known/oauth-protected-resource":
        return json(200, { ...protectedResourceMetadata(), resource: state.urls.resource, authorization_servers: [issuer], ...options.prm });
      case `GET ${asPath}`:
      case "GET /.well-known/oauth-authorization-server":
        return json(200, asDoc);
      case "GET /healthz":
        return json(200, { ok: true });
      case "POST /oauth2/register": {
        const asked = JSON.parse(text);
        state.registered = asked;
        const extra = options.leakSecrets ? { client_secret: SECRET, registration_access_token: RAT, registration_client_uri: `${state.urls.origin}/oauth2/register/client-1` } : {};
        return json(201, { ...asked, client_id: "client-1", ...extra });
      }
      case "DELETE /oauth2/register/client-1":
        state.deleted.push(req.headers.authorization);
        res.writeHead(204);
        return res.end();
      case "GET /mcp":
      case "POST /mcp": {
        const auth = req.headers.authorization;
        if (!auth) {
          if (options.mcpOpen) return json(200, {});
          return json(401, { error: "unauthorized" }, { "WWW-Authenticate": challenge });
        }
        if (auth === `Bearer ${WRONG}`) return json(401, { error: "invalid_token" }, { "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${prm}"` });
        if (![GOOD, LEGACY, USER].some((t) => auth === `Bearer ${t}`)) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": challenge });
        const body = text ? JSON.parse(text) : undefined;
        if (body?.method === "tools/call") state.calls.push(body.params);
        if (req.method === "GET") return json(405, {});
        return mcpAnswer(req, res, body, options.tools ?? EXPECTED_TOOLS);
      }
      default:
        return json(404, { error: "not found" });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, seen, state, server };
}

/** Production URLs as the script builds them, served by the mock. Records the host each request was for. */
async function production(t, options) {
  const mock = await mockOrigin(t, options);
  mock.state.urls = {
    origin: DEFAULT_BASE,
    resource: `${PUBLIC_ORIGIN}/mcp`,
    prm: `${PUBLIC_ORIGIN}${PRM_PATH}`,
    issuer: AUTHORIZATION_SERVER,
    issuerPath: new URL(AUTHORIZATION_SERVER).pathname,
    registration: `${DEFAULT_BASE}/oauth2/register`,
  };
  mock.hosts = new Set();
  mock.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    mock.hosts.add(url.origin);
    if (url.origin === LOOPBACK_ORIGIN) return fetch(input, init);
    return fetch(`${mock.origin}${url.pathname}${url.search}`, init);
  };
  return mock;
}

async function smoke(mock, env = {}) {
  const lines = [];
  const outcome = await run({ env: { ...NO_TOKENS, ...env }, fetch: mock.fetch, write: (l) => lines.push(l), now: () => new Date("2026-11-12T17:00:00.000Z") });
  return { ...outcome, out: lines.join("\n"), status: Object.fromEntries(outcome.results.map((r) => [r.name, r.status])) };
}

test("no tokens: discovery, the 401 challenge and registration pass, the signed-in checks skip with what is missing, exit 0", async (t) => {
  const mock = await production(t);
  const { code, status, out } = await smoke(mock);
  assert.strictEqual(code, 0, out);
  for (const name of ["prm", "prm-root", "prm-same", "as-metadata", "as-metadata-root", "healthz", "mcp-get-401", "mcp-post-401", "dcr"]) assert.strictEqual(status[name], "pass", `${name}\n${out}`);
  for (const name of ["dcr-cleanup", "mcp-token", "cloud-token", "wrong-audience"]) assert.strictEqual(status[name], "skip", `${name}\n${out}`);
  assert.match(out, /PASS prm: GET \/\.well-known\/oauth-protected-resource\/mcp 200 resource=https:\/\/mcp\.blowhorn\.ai\/mcp/);
  assert.match(out, /PASS mcp-post-401: POST \/mcp initialize 401 WWW-Authenticate: Bearer resource_metadata="https:\/\/mcp\.blowhorn\.ai\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.match(out, /PASS dcr: POST https:\/\/cloud\.blowhorn\.ai\/oauth2\/register 201 client_id=client-1 token_endpoint_auth_method=none/);
  assert.match(out, /RFC 7592 delete is not available; client "blowhorn-mcp-hosted-smoke 2026-11-12T17:00:00\.000Z"/);
  for (const n of [...ENV_NAMES.mcpToken, ...ENV_NAMES.cloudToken, ...ENV_NAMES.wrongAudToken]) assert.ok(out.includes(n), `names ${n}`);
  assert.match(out, /^OK: /m);

  assert.deepStrictEqual([...mock.hosts].sort(), [DEFAULT_BASE, PUBLIC_ORIGIN].sort(), "only the origin and the issuer the metadata named");
  assert.ok(mock.seen.every((s) => s.ua === USER_AGENT), "every request sends the smoke User-Agent");
  assert.ok(mock.seen.every((s) => !s.authorization), "no credential without a token");
  assert.deepStrictEqual(mock.state.registered, {
    client_name: `${CLIENT_NAME_PREFIX} 2026-11-12T17:00:00.000Z`,
    redirect_uris: ["http://127.0.0.1:8976/oauth/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "native",
  });
});

test("a live check that fails exits 1: wrong metadata resource, and an open /mcp", async (t) => {
  const wrong = await smoke(await production(t, { prm: { resource: "https://cloud.blowhorn.ai/mcp" } }));
  assert.strictEqual(wrong.code, 1);
  assert.strictEqual(wrong.status.prm, "fail");
  assert.match(wrong.out, /FAIL prm: .*schema: .*resource/);
  assert.strictEqual(wrong.status["as-metadata"], "skip", "nothing to follow");
  assert.match(wrong.out, /^FAILED: /m);

  const basic = await smoke(await production(t, { challenge: "Basic realm=\"mcp\"" }));
  assert.strictEqual(basic.code, 1);
  assert.match(basic.out, /FAIL mcp-get-401: .*WWW-Authenticate is not a Bearer-scheme challenge;/);

  const open = await smoke(await production(t, { mcpOpen: true }));
  assert.strictEqual(open.code, 1);
  assert.match(open.out, /FAIL mcp-get-401: GET \/mcp 200 WWW-Authenticate: \(none\) \(expected 401; /);
  assert.strictEqual(open.status["mcp-post-401"], "fail");
});

test("authorization server metadata: only the RFC 8414 path-inserted URL passes as-metadata, and its issuer must be the one the metadata named", async (t) => {
  const ok = await smoke(await production(t));
  assert.match(ok.out, /PASS as-metadata: GET https:\/\/cloud\.blowhorn\.ai\/\.well-known\/oauth-authorization-server\/hydra 200/);

  const appended = await smoke(await production(t, { asAppended: true }));
  assert.strictEqual(appended.code, 1);
  assert.match(appended.out, /FAIL as-metadata: GET https:\/\/cloud\.blowhorn\.ai\/\.well-known\/oauth-authorization-server\/hydra 404/);

  const other = await smoke(await production(t, { asIssuer: "https://elsewhere.example/hydra" }));
  assert.strictEqual(other.code, 1);
  assert.strictEqual(other.status["as-metadata"], "fail");
  assert.strictEqual(other.status["as-metadata-root"], "fail");
  assert.match(other.out, /FAIL as-metadata: .*issuer https:\/\/elsewhere\.example\/hydra is not https:\/\/cloud\.blowhorn\.ai\/hydra/);
});

test("with every token: SDK initialize at 2025-11-25, the six read tools, a read call, the legacy path labeled, wrong audience refused, no token printed", async (t) => {
  const mock = await production(t);
  const { code, status, out } = await smoke(mock, { SMOKE_HOSTED_TOKEN: GOOD, BLOWHORN_CLOUD_TOKEN: LEGACY, SMOKE_HOSTED_WRONG_AUD_TOKEN: WRONG, SMOKE_HOSTED_ORGANIZATION_ID: "org-1" });
  assert.strictEqual(code, 0, out);
  for (const p of ["mcp-token", "cloud-token"]) {
    assert.strictEqual(status[`${p}-initialize`], "pass", out);
    assert.strictEqual(status[`${p}-tools-list`], "pass", out);
    assert.strictEqual(status[`${p}-tools-call`], "pass", out);
  }
  assert.strictEqual(status["wrong-audience"], "pass", out);
  assert.match(out, /PASS mcp-token-initialize: initialize 200 protocolVersion=2025-11-25/);
  assert.match(out, new RegExp(`PASS mcp-token-tools-list: tools/list 200 tools=${EXPECTED_TOOLS.join(",")}`));
  assert.match(out, /PASS mcp-token-tools-call: tools\/call getEvents 200/);
  assert.match(out, /legacy Cloud API token, not an MCP OAuth audience-bound token/);
  assert.match(out, /PASS wrong-audience: POST \/mcp initialize 401 WWW-Authenticate: Bearer error="invalid_token"/);
  assert.deepStrictEqual(mock.state.calls, [{ name: "getEvents", arguments: { organizationId: "org-1" } }, { name: "getEvents", arguments: { organizationId: "org-1" } }]);
  assert.ok(mock.seen.every((s) => s.ua === USER_AGENT), "the SDK traffic sends the smoke User-Agent too");
  for (const secret of [GOOD, LEGACY, WRONG]) assert.ok(!out.includes(secret), "no token in the output");
});

test("only the legacy token: that path runs and says the MCP OAuth path was skipped; no organization skips only the call", async (t) => {
  const { code, status, out } = await smoke(await production(t), { BLOWHORN_CLOUD_TOKEN: LEGACY });
  assert.strictEqual(code, 0, out);
  assert.strictEqual(status["mcp-token"], "skip");
  assert.match(out, /SKIP mcp-token: MCP OAuth token path skipped: SMOKE_HOSTED_TOKEN and BLOWHORN_MCP_TOKEN are unset/);
  assert.strictEqual(status["cloud-token-tools-list"], "pass");
  assert.strictEqual(status["cloud-token-tools-call"], "skip");
  assert.match(out, /SKIP cloud-token-tools-call: getEvents requires organizationId and SMOKE_HOSTED_ORGANIZATION_ID and BLOWHORN_CLOUD_ORGANIZATION are unset/);
});

test("an extra or missing tool fails tools/list", async (t) => {
  const { code, out } = await smoke(await production(t, { tools: [...EXPECTED_TOOLS.slice(1), "deleteEverything"] }), { BLOWHORN_MCP_TOKEN: GOOD });
  assert.strictEqual(code, 1);
  assert.match(out, /FAIL mcp-token-tools-list: .*\(missing listContentItems; extra deleteEverything\)/);
});

test("registration secrets are never printed, and RFC 7592 cleanup runs when the answer offers it", async (t) => {
  const mock = await production(t, { leakSecrets: true });
  const { status, out } = await smoke(mock);
  assert.strictEqual(status.dcr, "fail", "a public client must not get a client_secret");
  assert.match(out, /client_secret was returned for a public client \(redacted\)/);
  assert.strictEqual(status["dcr-cleanup"], "pass", out);
  assert.deepStrictEqual(mock.state.deleted, [`Bearer ${RAT}`]);
  assert.ok(!out.includes(SECRET) && !out.includes(RAT), out);
});

test("CLI: --base points every check at that origin, follows the issuer its metadata names, and exits by the results", async (t) => {
  const mock = await mockOrigin(t);
  const origin = mock.origin;
  mock.state.urls = { origin, resource: `${origin}/mcp`, prm: `${origin}${PRM_PATH}`, issuer: `${origin}/auth`, issuerPath: "/auth", registration: `${origin}/oauth2/register` };
  const env = { ...process.env, ...NO_TOKENS };
  const ok = await promisify(execFile)(process.execPath, [SCRIPT, "--base", origin], { env });
  assert.match(ok.stdout, new RegExp(`PASS as-metadata: GET ${origin}/\\.well-known/oauth-authorization-server/auth 200`));
  assert.match(ok.stdout, /^OK: 9 pass, 0 fail, 5 skip$/m);

  mock.state.urls.prm = "https://elsewhere.example/prm";
  await assert.rejects(promisify(execFile)(process.execPath, [SCRIPT, "--base", origin], { env }), (err) => {
    assert.strictEqual(err.code, 1);
    assert.match(err.stdout, /FAIL mcp-post-401: .*lacks resource_metadata=/);
    return true;
  });
  assert.ok(mock.seen.every((s) => s.ua === USER_AGENT));
});

test("test account unset: user-token skips naming both variables, and nothing signs in", async (t) => {
  const mock = await production(t);
  const { code, status, out } = await smoke(mock, { BLOWHORN_MCP_TEST_EMAIL: EMAIL });
  assert.strictEqual(code, 0, out);
  assert.strictEqual(status["user-token"], "skip");
  assert.match(out, /SKIP user-token: test account sign-in skipped: BLOWHORN_MCP_TEST_PASSWORD is unset \(it needs both BLOWHORN_MCP_TEST_EMAIL and BLOWHORN_MCP_TEST_PASSWORD\)/);
  const none = await smoke(mock);
  assert.match(none.out, /SKIP user-token: test account sign-in skipped: BLOWHORN_MCP_TEST_EMAIL and BLOWHORN_MCP_TEST_PASSWORD are unset/);
  assert.ok(!mock.seen.some((s) => s.path.startsWith("/api/auth") || s.path.endsWith("/oauth2/auth")), "no sign-in without the test account");

  const withToken = await smoke(mock, { ...ACCOUNT, SMOKE_HOSTED_TOKEN: GOOD });
  assert.match(withToken.out, /SKIP user-token: test account sign-in not used: SMOKE_HOSTED_TOKEN is set/);
  assert.ok(!mock.seen.some((s) => s.path.startsWith("/api/auth")), "a provided MCP token wins");
});

test("test account unverified: the login redirect to /verification skips the signed-in checks with what a person must do, exit 0", async (t) => {
  const mock = await production(t, { unverified: true });
  const { code, status, out } = await smoke(mock, ACCOUNT);
  assert.strictEqual(code, 0, out);
  assert.strictEqual(status["user-login"], "skip", out);
  assert.match(out, /SKIP user-login: POST https:\/\/cloud\.blowhorn\.ai\/api\/auth\/flow\/submit\?type=login 303 Location: https:\/\/cloud\.blowhorn\.ai\/verification: email verification is required for BLOWHORN_MCP_TEST_EMAIL=smoke-account@example\.test\. A person who can read that inbox must open the verification link/);
  assert.match(out, /then re-run the smoke/);
  assert.ok(!Object.keys(status).some((n) => n.startsWith("user-token-")), "no signed-in check ran");
  assert.strictEqual(mock.state.flowQuery.get("type"), "login");
  assert.strictEqual(mock.state.flowQuery.get("login_challenge"), "login-1");
  for (const secret of [PASSWORD, CSRF, CSRF_COOKIE]) assert.ok(!out.includes(secret), "no password, csrf or cookie in the output");
});

test("test account verified: authorization code + PKCE through login and a plain consent form, code exchanged with the verifier, then initialize and the tools, no secret printed", async (t) => {
  const mock = await production(t, { consent: "form" });
  const { code, status, out } = await smoke(mock, { ...ACCOUNT, SMOKE_HOSTED_ORGANIZATION_ID: "org-1" });
  assert.strictEqual(code, 0, out);
  for (const name of ["user-login", "user-consent", "user-authorize", "user-token", "user-token-initialize", "user-token-tools-list", "user-token-tools-call"]) assert.strictEqual(status[name], "pass", `${name}\n${out}`);
  assert.match(out, /PASS user-token-initialize: initialize 200 protocolVersion=2025-11-25/);
  assert.match(out, new RegExp(`PASS user-token-tools-list: tools/list 200 tools=${EXPECTED_TOOLS.join(",")}`));
  assert.match(out, /PASS user-token: POST https:\/\/cloud\.blowhorn\.ai\/hydra\/oauth2\/token 200 token_type="bearer" expires_in=3600 scope="openid offline_access"/);

  const a = mock.state.authorize;
  assert.deepStrictEqual(
    { response_type: a.get("response_type"), client_id: a.get("client_id"), redirect_uri: a.get("redirect_uri"), scope: a.get("scope"), resource: a.get("resource"), code_challenge_method: a.get("code_challenge_method") },
    { response_type: "code", client_id: "client-1", redirect_uri: REDIRECT_URI, scope: "openid offline_access", resource: "https://mcp.blowhorn.ai/mcp", code_challenge_method: "S256" },
  );
  const login = mock.state.login;
  assert.deepStrictEqual(Object.fromEntries(login.form), { identifier: EMAIL, password: PASSWORD, method: "password", csrf_token: CSRF });
  assert.strictEqual(login.query.get("id"), "flow-1");
  assert.ok(login.cookie.includes(`csrf_token_1=${CSRF_COOKIE}`), "the flow's cookies are forwarded");
  assert.deepStrictEqual(Object.fromEntries(mock.state.consent), { consent_challenge: "consent-1", grant_scope: "openid", submit: "accept" });
  const tok = mock.state.token;
  assert.deepStrictEqual(
    { grant_type: tok.get("grant_type"), code: tok.get("code"), client_id: tok.get("client_id"), redirect_uri: tok.get("redirect_uri"), resource: tok.get("resource") },
    { grant_type: "authorization_code", code: CODE, client_id: "client-1", redirect_uri: REDIRECT_URI, resource: "https://mcp.blowhorn.ai/mcp" },
  );
  assert.ok(mock.hosts.has(new URL(REDIRECT_URI).origin), "the code arrived on the loopback redirect");
  assert.ok(mock.seen.some((s) => s.authorization === `Bearer ${USER}`), "/mcp saw the obtained token");
  assert.ok(mock.seen.every((s) => s.ua === USER_AGENT));
  for (const secret of [PASSWORD, CSRF, CSRF_COOKIE, SESSION, CODE, USER, REFRESH, tok.get("code_verifier")]) assert.ok(!out.includes(secret), `no secret in the output: ${secret.slice(0, 8)}`);
});

test("test account: a consent page that needs a browser, or a Cloudflare challenge, is a skip naming the URL and the step, never a pass", async (t) => {
  const widget = await smoke(await production(t, { consent: "widget" }), ACCOUNT);
  assert.strictEqual(widget.code, 0, widget.out);
  assert.strictEqual(widget.status["user-login"], "pass");
  assert.strictEqual(widget.status["user-consent"], "skip");
  assert.match(widget.out, /SKIP user-consent: GET https:\/\/cloud\.blowhorn\.ai\/consent\?consent_challenge=consent-1 200 is a consent page with no plain HTML form .*a person \(or a browser driver\) must open https:\/\/cloud\.blowhorn\.ai\/hydra\/oauth2\/auth\?/);

  const blocked = await smoke(await production(t, { consent: "cloudflare" }), ACCOUNT);
  assert.strictEqual(blocked.code, 0, blocked.out);
  assert.strictEqual(blocked.status["user-authorize"], "skip");
  assert.match(blocked.out, /SKIP user-authorize: GET https:\/\/cloud\.blowhorn\.ai\/consent\?consent_challenge=consent-1 403 is a Cloudflare challenge/);
  for (const r of [widget, blocked]) {
    assert.ok(!Object.keys(r.status).some((n) => n.startsWith("user-token")), "no token, no signed-in checks");
    for (const secret of [PASSWORD, CSRF, CSRF_COOKIE, SESSION]) assert.ok(!r.out.includes(secret));
  }
});

test("test account pinned to production Cloud: another authorization_endpoint origin, or a redirect off it, skips and never receives the password", async (t) => {
  const staging = await production(t, { authorizeAt: "https://staging.example/hydra/oauth2/auth" });
  const pinned = await smoke(staging, ACCOUNT);
  assert.strictEqual(pinned.code, 0, pinned.out);
  assert.strictEqual(pinned.status["user-token"], "skip", pinned.out);
  assert.match(pinned.out, /SKIP user-token: test account sign-in skipped: the test account is pinned to production Cloud https:\/\/cloud\.blowhorn\.ai, and the authorization_endpoint is at https:\/\/staging\.example; SMOKE_HOSTED_TOKEN or BLOWHORN_MCP_TOKEN can still check this base/);
  assert.ok(!staging.hosts.has("https://staging.example"), "nothing was sent to the other origin");
  assert.ok(!staging.seen.some((s) => s.path.startsWith("/api/auth") || s.path.endsWith("/oauth2/auth")), "no sign-in started");
  assert.strictEqual(staging.state.login, undefined);

  const away = await production(t, { loginAt: "https://elsewhere.example" });
  const off = await smoke(away, ACCOUNT);
  assert.strictEqual(off.code, 0, off.out);
  assert.strictEqual(off.status["user-authorize"], "skip", off.out);
  assert.match(off.out, /SKIP user-authorize: a redirect went to https:\/\/elsewhere\.example\/login, off https:\/\/cloud\.blowhorn\.ai, and is not followed/);
  assert.ok(!away.hosts.has("https://elsewhere.example"), "the redirect off the origin was not followed");
  assert.strictEqual(away.state.login, undefined, "the password was never submitted");
  for (const r of [pinned, off]) assert.ok(!r.out.includes(PASSWORD));
});
