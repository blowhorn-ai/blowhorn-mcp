#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/*
 * OPT-IN LIVE SMOKE TEST of the deployed hosted origin (default
 * https://mcp.blowhorn.ai). It is not a fake-upstream contract test
 * (that is test/oauth-contract.test.js) and it is not run by make check,
 * make hosted-check or CI. It contacts the real origin and the authorization
 * server its metadata names, and each run registers one OAuth client there.
 *
 *   npm run smoke:hosted --prefix hosted [-- --base URL]
 *   make hosted-smoke
 *
 * Checks: protected resource metadata at both paths (held to
 * schemas/protected-resource.schema.json), the issuer's authorization server
 * metadata, /healthz, the unauthenticated 401 challenge on GET and POST /mcp,
 * dynamic client registration, and, only when a token is in the environment,
 * the signed-in MCP path through the official SDK client. A check whose
 * input is missing is skipped with the reason; any failure exits 1.
 *
 * Every request sends User-Agent blowhorn-verify/1.0 (a default one can draw
 * a Cloudflare 1010 challenge) and follows no redirect. Tokens come from the
 * environment only, and every line printed is redacted of them and of any
 * secret the registration answers with.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { Validator } from "@cfworker/json-schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OAuthClientInformationFullSchema, OAuthMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { DEFAULT_BASE, VERSION } from "../src/proxy.js";
import { AUTHORIZATION_SERVER, PRM_PATH, PRM_ROOT, PUBLIC_ORIGIN, protectedResourceMetadata } from "../src/metadata.js";

const HOSTED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRM_SCHEMA = JSON.parse(readFileSync(path.join(HOSTED, "schemas", "protected-resource.schema.json"), "utf8"));

export const USER_AGENT = "blowhorn-verify/1.0";
export const CLIENT_NAME_PREFIX = "blowhorn-mcp-hosted-smoke";
export const REDIRECT_URI = "http://127.0.0.1:8976/oauth/callback";
export const EXPECTED_PROTOCOL_VERSION = "2025-11-25";
/** The read tools Cloud's /mcp serves. Missing or extra tools fail the check. */
export const EXPECTED_TOOLS = Object.freeze(["listContentItems", "getContentItem", "getEvents", "getConnections", "listSchedules", "getScheduleById"]);
/** Tried in order for the one read tools/call. */
const READ_CALLS = ["getEvents", "listContentItems"];
const ACCEPT = "application/json, text/event-stream";

/** Environment names, first set wins. */
export const ENV_NAMES = Object.freeze({
  base: ["SMOKE_HOSTED_BASE"],
  mcpToken: ["SMOKE_HOSTED_TOKEN", "BLOWHORN_MCP_TOKEN"],
  cloudToken: ["BLOWHORN_CLOUD_TOKEN"],
  wrongAudToken: ["SMOKE_HOSTED_WRONG_AUD_TOKEN"],
  organization: ["SMOKE_HOSTED_ORGANIZATION_ID", "BLOWHORN_CLOUD_ORGANIZATION"],
});

function fromEnv(env, key) {
  for (const name of ENV_NAMES[key]) if (env[name]) return { name, value: env[name] };
  return undefined;
}

/** A fetch that always sends the smoke User-Agent and never follows a redirect. */
export function smokeFetch(fetchImpl = globalThis.fetch) {
  return (input, init = {}) => {
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("User-Agent", USER_AGENT);
    return fetchImpl(input, { ...init, headers, redirect: "manual" });
  };
}

/** Replaces every known secret, and any Bearer credential, with [redacted]. */
export function redact(text, secrets) {
  let out = String(text);
  for (const s of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(s).join("[redacted]");
  return out.replace(/\b(Bearer)\s+(?!resource_metadata|error|realm|scope)[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]");
}

/** Normalizes a base URL to its origin-plus-path with no trailing slash. */
export function normalizeBase(raw) {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`base must be http(s): ${raw}`);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * The checked-in PRM schema for `base`. Production is held to it as is; for
 * another base only the pinned resource and issuer constants move.
 */
export function prmSchema(base) {
  if (base === PUBLIC_ORIGIN) return PRM_SCHEMA;
  const schema = structuredClone(PRM_SCHEMA);
  schema.properties.resource.const = `${base}/mcp`;
  delete schema.properties.authorization_servers.items.const;
  return schema;
}

/** Collects one result per check and prints it, redacted, as it lands. */
class Report {
  constructor(write, secrets) {
    this.write = write;
    this.secrets = secrets;
    this.results = [];
  }
  add(status, name, detail) {
    this.results.push({ status, name, detail });
    this.write(redact(`${status.toUpperCase().padEnd(4)} ${name}: ${detail}`, this.secrets));
  }
  pass(name, detail) {
    this.add("pass", name, detail);
  }
  fail(name, detail) {
    this.add("fail", name, detail);
  }
  skip(name, detail) {
    this.add("skip", name, detail);
  }
  note(text) {
    this.write(redact(`     ${text}`, this.secrets));
  }
  get failed() {
    return this.results.filter((r) => r.status === "fail").length;
  }
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function schemaErrors(result) {
  return result.errors.map((e) => `${e.instanceLocation} ${e.error}`).join("; ");
}

function zodErrors(result) {
  return result.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ");
}

/** GET both RFC 9728 paths; returns the issuer to follow, or undefined. */
export async function checkProtectedResource(ctx) {
  const { base, fetch, report } = ctx;
  const validator = new Validator(prmSchema(base));
  const expected = protectedResourceMetadata();
  const docs = [];
  for (const [name, p] of [["prm", PRM_PATH], ["prm-root", PRM_ROOT]]) {
    const res = await fetch(`${base}${p}`, { headers: { Accept: "application/json" } });
    const doc = await readJson(res);
    const problems = [];
    if (res.status !== 200) problems.push("expected 200");
    if (!doc) problems.push("body is not JSON");
    else {
      const result = validator.validate(doc);
      if (!result.valid) problems.push(`schema: ${schemaErrors(result)}`);
      if (doc.resource !== `${base}/mcp`) problems.push(`resource ${doc.resource} is not ${base}/mcp`);
      if (base === PUBLIC_ORIGIN && JSON.stringify(doc.authorization_servers) !== JSON.stringify(expected.authorization_servers)) problems.push(`authorization_servers is not [${AUTHORIZATION_SERVER}]`);
      if (JSON.stringify(doc.bearer_methods_supported) !== JSON.stringify(expected.bearer_methods_supported)) problems.push("bearer_methods_supported is not [header]");
      if (doc.resource_name !== expected.resource_name) problems.push(`resource_name is not ${expected.resource_name}`);
    }
    const detail = `GET ${p} ${res.status}${doc ? ` resource=${doc.resource} authorization_servers=${JSON.stringify(doc.authorization_servers)}` : ""}`;
    if (problems.length) report.fail(name, `${detail} (${problems.join("; ")})`);
    else report.pass(name, detail);
    docs.push(problems.length ? undefined : doc);
  }
  if (docs.some((d) => !d)) return undefined;
  if (JSON.stringify(docs[0]) !== JSON.stringify(docs[1])) {
    report.fail("prm-same", `${PRM_PATH} and ${PRM_ROOT} answer different documents`);
    return undefined;
  }
  report.pass("prm-same", "both paths answer the same document");
  return docs[0].authorization_servers[0];
}

/** GET the issuer's RFC 8414 metadata (issuer path and origin root); returns registration_endpoint. */
export async function checkAuthorizationServer(ctx, issuer) {
  const { fetch, report } = ctx;
  if (!issuer) {
    report.skip("as-metadata", "no issuer: the protected resource metadata check failed");
    return undefined;
  }
  const wantRegistration = issuer === AUTHORIZATION_SERVER ? `${DEFAULT_BASE}/oauth2/register` : undefined;
  const urls = [
    ["as-metadata", `${issuer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`],
    ["as-metadata-root", `${new URL(issuer).origin}/.well-known/oauth-authorization-server`],
  ];
  let registration;
  for (const [name, url] of urls) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const doc = await readJson(res);
    const problems = [];
    if (res.status !== 200) problems.push("expected 200");
    if (!doc) problems.push("body is not JSON");
    else {
      const parsed = OAuthMetadataSchema.safeParse(doc);
      if (!parsed.success) problems.push(`schema: ${zodErrors(parsed)}`);
      if (!doc.registration_endpoint) problems.push("no registration_endpoint");
      else if (wantRegistration && doc.registration_endpoint !== wantRegistration) problems.push(`registration_endpoint is not ${wantRegistration}`);
      else if (registration && doc.registration_endpoint !== registration) problems.push("registration_endpoint differs from the issuer path's");
    }
    const detail = `GET ${url} ${res.status}${doc?.registration_endpoint ? ` registration_endpoint=${doc.registration_endpoint}` : ""}`;
    if (problems.length) report.fail(name, `${detail} (${problems.join("; ")})`);
    else {
      report.pass(name, detail);
      registration ??= doc.registration_endpoint;
    }
  }
  return registration;
}

export async function checkHealth(ctx) {
  const { base, fetch, report } = ctx;
  const res = await fetch(`${base}/healthz`);
  if (res.status === 200) report.pass("healthz", `GET /healthz ${res.status}`);
  else report.fail("healthz", `GET /healthz ${res.status} (expected 200)`);
}

/** An initialize request body for the raw (no SDK) 401 checks. */
function initializeBody() {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: EXPECTED_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: CLIENT_NAME_PREFIX, version: VERSION } } });
}

function postInitialize(ctx, authorization) {
  const headers = { "Content-Type": "application/json", Accept: ACCEPT };
  if (authorization) headers.Authorization = authorization;
  return ctx.fetch(`${ctx.base}/mcp`, { method: "POST", headers, body: initializeBody() });
}

/** GET and POST /mcp with no token: 401 and a Bearer challenge naming this origin's metadata. */
export async function checkUnauthenticated(ctx) {
  const { base, fetch, report } = ctx;
  const wantMetadata = `resource_metadata="${base}${PRM_PATH}"`;
  const tries = [
    ["mcp-get-401", "GET /mcp", () => fetch(`${base}/mcp`, { headers: { Accept: "text/event-stream" } })],
    ["mcp-post-401", "POST /mcp initialize", () => postInitialize(ctx)],
  ];
  for (const [name, label, send] of tries) {
    const res = await send();
    await res.body?.cancel();
    const challenge = res.headers.get("WWW-Authenticate") || "";
    const problems = [];
    if (res.status !== 401) problems.push("expected 401");
    if (!/^Bearer\b/i.test(challenge)) problems.push("WWW-Authenticate is not a Bearer challenge");
    if (!challenge.includes(wantMetadata)) problems.push(`WWW-Authenticate lacks ${wantMetadata}`);
    const detail = `${label} ${res.status} WWW-Authenticate: ${challenge || "(none)"}`;
    if (problems.length) report.fail(name, `${detail} (${problems.join("; ")})`);
    else report.pass(name, detail);
  }
}

/** RFC 7591 registration of a public native client, then RFC 7592 delete when offered. */
export async function checkRegistration(ctx, endpoint) {
  const { fetch, report, secrets, now } = ctx;
  if (!endpoint) {
    report.skip("dcr", "no registration_endpoint: the authorization server metadata check failed");
    return;
  }
  const clientName = `${CLIENT_NAME_PREFIX} ${now().toISOString()}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  });
  const doc = await readJson(res);
  for (const key of ["client_secret", "registration_access_token"]) if (typeof doc?.[key] === "string") secrets.add(doc[key]);
  const problems = [];
  if (res.status !== 201) problems.push("expected 201");
  if (!doc) problems.push("body is not JSON");
  else {
    const parsed = OAuthClientInformationFullSchema.safeParse(doc);
    if (!parsed.success) problems.push(`schema: ${zodErrors(parsed)}`);
    if (!doc.client_id) problems.push("no client_id");
    if (doc.token_endpoint_auth_method !== "none") problems.push(`token_endpoint_auth_method is ${doc.token_endpoint_auth_method}, not none`);
    if (doc.client_secret) problems.push("a client_secret was returned for a public client (redacted)");
  }
  const detail = `POST ${endpoint} ${res.status}${doc?.client_id ? ` client_id=${doc.client_id} token_endpoint_auth_method=${doc.token_endpoint_auth_method}` : ""} client_name="${clientName}"`;
  if (problems.length) report.fail("dcr", `${detail} (${problems.join("; ")})`);
  else report.pass("dcr", detail);
  if (!doc?.client_id) return;

  if (doc.registration_client_uri && doc.registration_access_token) {
    const del = await fetch(doc.registration_client_uri, { method: "DELETE", headers: { Authorization: `Bearer ${doc.registration_access_token}` } });
    await del.body?.cancel();
    if (del.status === 204 || del.status === 200) report.pass("dcr-cleanup", `DELETE registration_client_uri ${del.status}`);
    else report.fail("dcr-cleanup", `DELETE registration_client_uri ${del.status} (expected 204); client "${clientName}" is left in the authorization server`);
  } else {
    report.skip(
      "dcr-cleanup",
      `the registration answer has no registration_client_uri and registration_access_token, so RFC 7592 delete is not available; client "${clientName}" (client_id=${doc.client_id}) is left in the authorization server`,
    );
  }
}

/** The arguments for one read call, or a reason it cannot be made. */
function readCall(tools, organization) {
  for (const name of READ_CALLS) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) continue;
    const required = tool.inputSchema?.required ?? [];
    const unknown = required.filter((r) => r !== "organizationId");
    if (unknown.length) continue;
    if (required.includes("organizationId")) {
      if (!organization) return { skip: `${name} requires organizationId and ${ENV_NAMES.organization.join(" and ")} are unset` };
      return { name, arguments: { organizationId: organization.value } };
    }
    return { name, arguments: {} };
  }
  return { skip: `none of ${READ_CALLS.join(", ")} can be called with only organizationId` };
}

/** initialize, tools/list and one read tools/call through the official SDK client with a static Bearer header. */
export async function checkSignedIn(ctx, label, token) {
  const { base, fetch, report, env } = ctx;
  const client = new Client({ name: CLIENT_NAME_PREFIX, version: VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } }, fetch });
  try {
    try {
      await client.connect(transport);
    } catch (err) {
      report.fail(`${label}-initialize`, `initialize failed: ${err?.message ?? err}`);
      return;
    }
    const version = transport.protocolVersion;
    if (version === EXPECTED_PROTOCOL_VERSION) report.pass(`${label}-initialize`, `initialize 200 protocolVersion=${version} server=${client.getServerVersion()?.name}`);
    else report.fail(`${label}-initialize`, `initialize protocolVersion=${version} (expected ${EXPECTED_PROTOCOL_VERSION})`);

    let tools;
    try {
      ({ tools } = await client.listTools());
    } catch (err) {
      report.fail(`${label}-tools-list`, `tools/list failed: ${err?.message ?? err}`);
      return;
    }
    const names = tools.map((t) => t.name);
    const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
    const extra = names.filter((n) => !EXPECTED_TOOLS.includes(n));
    const detail = `tools/list 200 tools=${names.join(",")}`;
    if (missing.length || extra.length) report.fail(`${label}-tools-list`, `${detail} (${[missing.length && `missing ${missing.join(",")}`, extra.length && `extra ${extra.join(",")}`].filter(Boolean).join("; ")})`);
    else report.pass(`${label}-tools-list`, detail);

    const call = readCall(tools, fromEnv(env, "organization"));
    if (call.skip) {
      report.skip(`${label}-tools-call`, call.skip);
      return;
    }
    try {
      const result = await client.callTool({ name: call.name, arguments: call.arguments });
      if (result.isError) report.fail(`${label}-tools-call`, `tools/call ${call.name} returned isError`);
      else report.pass(`${label}-tools-call`, `tools/call ${call.name} 200`);
    } catch (err) {
      report.fail(`${label}-tools-call`, `tools/call ${call.name} failed: ${err?.message ?? err}`);
    }
  } finally {
    await client.close().catch(() => {});
  }
}

/** A token for another audience must be refused on /mcp. */
export async function checkWrongAudience(ctx, token) {
  const res = await postInitialize(ctx, `Bearer ${token}`);
  await res.body?.cancel();
  const challenge = res.headers.get("WWW-Authenticate") || "";
  const invalid = /error="?invalid_token"?/i.test(challenge);
  const detail = `POST /mcp initialize ${res.status} WWW-Authenticate: ${challenge || "(none)"}`;
  if (res.status !== 401) ctx.report.fail("wrong-audience", `${detail} (expected 401)`);
  else ctx.report.pass("wrong-audience", invalid ? detail : `${detail} (no error="invalid_token")`);
}

/**
 * Runs every check against `base`. Returns the results and the exit code:
 * 1 when any check that ran failed, else 0.
 */
export async function run({ base: rawBase, env = process.env, fetch: fetchImpl = globalThis.fetch, write = (line) => process.stdout.write(`${line}\n`), now = () => new Date() } = {}) {
  const base = normalizeBase(rawBase ?? fromEnv(env, "base")?.value ?? PUBLIC_ORIGIN);
  const mcpToken = fromEnv(env, "mcpToken");
  const cloudToken = fromEnv(env, "cloudToken");
  const wrongAud = fromEnv(env, "wrongAudToken");
  const secrets = new Set([mcpToken, cloudToken, wrongAud].filter(Boolean).map((t) => t.value));
  const report = new Report(write, secrets);
  const ctx = { base, env, fetch: smokeFetch(fetchImpl), report, secrets, now };

  write(`blowhorn-mcp-hosted live smoke against ${base} (User-Agent ${USER_AGENT})`);
  const step = async (name, fn) => {
    try {
      return await fn();
    } catch (err) {
      report.fail(name, `request failed: ${err?.message ?? err}`);
      return undefined;
    }
  };

  const issuer = await step("prm", () => checkProtectedResource(ctx));
  const registration = await step("as-metadata", () => checkAuthorizationServer(ctx, issuer));
  await step("healthz", () => checkHealth(ctx));
  await step("mcp-401", () => checkUnauthenticated(ctx));
  await step("dcr", () => checkRegistration(ctx, registration));

  if (mcpToken) {
    report.note(`MCP OAuth token path: ${mcpToken.name} (a user token whose audience should be ${base}/mcp)`);
    await step("mcp-token", () => checkSignedIn(ctx, "mcp-token", mcpToken.value));
  } else {
    report.skip("mcp-token", `MCP OAuth token path skipped: ${ENV_NAMES.mcpToken.join(" and ")} are unset (need a user token bound to aud ${base}/mcp)`);
  }
  if (cloudToken) {
    report.note(`Cloud API token path: ${cloudToken.name}. This is a legacy Cloud API token, not an MCP OAuth audience-bound token.`);
    await step("cloud-token", () => checkSignedIn(ctx, "cloud-token", cloudToken.value));
  } else {
    report.skip("cloud-token", `Cloud API token path skipped: ${ENV_NAMES.cloudToken.join(" and ")} is unset`);
  }
  if (wrongAud) await step("wrong-audience", () => checkWrongAudience(ctx, wrongAud.value));
  else report.skip("wrong-audience", `${ENV_NAMES.wrongAudToken.join(" and ")} is unset (a token minted for another audience); audience binding not checked`);

  const counts = ["pass", "fail", "skip"].map((s) => `${report.results.filter((r) => r.status === s).length} ${s}`).join(", ");
  write(`${report.failed ? "FAILED" : "OK"}: ${counts}`);
  return { results: report.results, code: report.failed ? 1 : 0 };
}

const USAGE = `usage: node scripts/smoke-hosted.js [--base URL]

Opt-in live smoke test of the deployed hosted origin. Contacts the real
servers and registers one OAuth client named "${CLIENT_NAME_PREFIX} <UTC time>".

  --base URL                     origin to test (default ${PUBLIC_ORIGIN}, or SMOKE_HOSTED_BASE)
  SMOKE_HOSTED_TOKEN             MCP OAuth user token for aud <base>/mcp (or BLOWHORN_MCP_TOKEN)
  BLOWHORN_CLOUD_TOKEN           legacy Cloud API token, checked as its own path
  SMOKE_HOSTED_WRONG_AUD_TOKEN   a token for another audience, must be refused
  SMOKE_HOSTED_ORGANIZATION_ID   organizationId for the read tools/call (or BLOWHORN_CLOUD_ORGANIZATION)

Signed-in checks are skipped when their token is unset. Exits 1 on any failure.`;

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--base") out.base = argv[++i];
    else if (a.startsWith("--base=")) out.base = a.slice("--base=".length);
    else throw new Error(`unknown argument: ${a}`);
  }
  if ("base" in out && !out.base) throw new Error("--base needs a URL");
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  process.exitCode = (await run({ base: args.base })).code;
}
