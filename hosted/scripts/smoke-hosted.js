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
 * dynamic client registration, and, only when a token or the test account
 * is in the environment, the signed-in MCP path through the official SDK
 * client. With the test account (and no MCP token) it signs in headlessly
 * with authorization code + PKCE for the registered client, catching the
 * code on the loopback redirect. A check whose input is missing, or that
 * needs a person (email verification, a Cloudflare challenge, a consent
 * page with no plain form), is skipped with the reason; any failure exits 1.
 *
 * Every request sends User-Agent blowhorn-verify/1.0 (a default one can draw
 * a Cloudflare 1010 challenge) and follows no redirect by itself; the
 * sign-in follows them by hand. Tokens and the test account come from the
 * environment only, and every line printed is redacted of them, of cookie
 * and csrf values, of the code and verifier, and of any secret the
 * registration answers with.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
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
  testEmail: ["BLOWHORN_MCP_TEST_EMAIL"],
  testPassword: ["BLOWHORN_MCP_TEST_PASSWORD"],
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

/** GET the issuer's RFC 8414 metadata (path-inserted and origin root); returns the first valid document. */
export async function checkAuthorizationServer(ctx, issuer) {
  const { fetch, report } = ctx;
  if (!issuer) {
    report.skip("as-metadata", "no issuer: the protected resource metadata check failed");
    return undefined;
  }
  const wantRegistration = issuer === AUTHORIZATION_SERVER ? `${DEFAULT_BASE}/oauth2/register` : undefined;
  const { origin, pathname } = new URL(issuer);
  const urls = [
    ["as-metadata", `${origin}/.well-known/oauth-authorization-server${pathname.replace(/\/+$/, "")}`],
    ["as-metadata-root", `${origin}/.well-known/oauth-authorization-server`],
  ];
  let registration;
  let metadata;
  for (const [name, url] of urls) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const doc = await readJson(res);
    const problems = [];
    if (res.status !== 200) problems.push("expected 200");
    if (!doc) problems.push("body is not JSON");
    else {
      const parsed = OAuthMetadataSchema.safeParse(doc);
      if (!parsed.success) problems.push(`schema: ${zodErrors(parsed)}`);
      if (doc.issuer !== issuer) problems.push(`issuer ${doc.issuer} is not ${issuer}`);
      if (!doc.registration_endpoint) problems.push("no registration_endpoint");
      else if (wantRegistration && doc.registration_endpoint !== wantRegistration) problems.push(`registration_endpoint is not ${wantRegistration}`);
      else if (registration && doc.registration_endpoint !== registration) problems.push("registration_endpoint differs from the path-inserted document's");
    }
    const detail = `GET ${url} ${res.status}${doc?.registration_endpoint ? ` registration_endpoint=${doc.registration_endpoint}` : ""}`;
    if (problems.length) report.fail(name, `${detail} (${problems.join("; ")})`);
    else {
      report.pass(name, detail);
      registration ??= doc.registration_endpoint;
      metadata ??= doc;
    }
  }
  return metadata;
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
    if (!/^Bearer\b/i.test(challenge)) problems.push("WWW-Authenticate is not a Bearer-scheme challenge");
    if (!challenge.includes(wantMetadata)) problems.push(`WWW-Authenticate lacks ${wantMetadata}`);
    const detail = `${label} ${res.status} WWW-Authenticate: ${challenge || "(none)"}`;
    if (problems.length) report.fail(name, `${detail} (${problems.join("; ")})`);
    else report.pass(name, detail);
  }
}

/**
 * RFC 7591 registration of a public native client. Returns its client_id and
 * a cleanup (the RFC 7592 delete when offered) that run() calls once the
 * test account sign-in, which needs the client, is done.
 */
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
  if (!doc?.client_id) return undefined;

  const cleanup = async () => {
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
  };
  return { clientId: doc.client_id, cleanup };
}
/*
 * The test account path: one authorization code + PKCE grant with no
 * browser. The authorize URL goes to the issuer's authorization_endpoint
 * with resource <base>/mcp, so the audience is bound at authorize and consent
 * time (Cloud refuses client credentials by design). Sign-in is the same
 * Cloud-brokered flow the product uses (GET /api/auth/flow, POST
 * /api/auth/flow/submit); nothing here talks to the identity service
 * directly. Any hop that needs a person (email verification, a Cloudflare
 * challenge, a consent page with no plain HTML form) is a skip that names the
 * URL and the step, never a pass.
 */
const MAX_HOPS = 20;
const LOOPBACK = new URL(REDIRECT_URI);

const base64url = (buf) => Buffer.from(buf).toString("base64url");

/** Where to send a person to finish what the smoke could not do headlessly. */
function personStep(flow) {
  return `a person (or a browser driver) must open ${flow.authorize.href}, sign in as ${flow.email.value} and accept consent, then re-run the smoke`;
}

/** Cookies per host. Values go into the redaction set as they arrive; only names are ever printed. */
class CookieJar {
  constructor(ctx) {
    this.ctx = ctx;
    this.hosts = new Map();
  }
  cookies(url) {
    if (!this.hosts.has(url.hostname)) this.hosts.set(url.hostname, new Map());
    return this.hosts.get(url.hostname);
  }
  names(url) {
    return [...this.cookies(url).keys()];
  }
  /** ctx.fetch (smoke User-Agent, no redirect) with this host's cookies, storing what it sets. */
  async fetch(url, init = {}) {
    const jar = this.cookies(url);
    const headers = { ...init.headers };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await this.ctx.fetch(url.href, { ...init, headers });
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const pair = line.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!value || /;\s*max-age=0\b/i.test(line)) jar.delete(name);
      else {
        jar.set(name, value);
        if (value.length >= 6) this.ctx.secrets.add(value);
      }
    }
    return res;
  }
}

/** A Cloudflare challenge or block page, which needs a browser. */
function cloudflareChallenge(res, body) {
  if (res.headers.get("cf-mitigated") === "challenge") return true;
  return [403, 429, 503].includes(res.status) && /error code: 1010|cf-chl|challenge-platform|Just a moment|Attention Required/i.test(body);
}

/**
 * GETs `start` and follows redirects by hand until something needs this
 * script: the loopback callback (fetched, so the listener catches it), a
 * login challenge, the verification page, or a page that answers 200.
 * Never moves to another scheme than the start URL's, except to the loopback.
 */
async function browse(ctx, jar, start) {
  let url = new URL(start);
  const scheme = url.protocol;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (url.origin === LOOPBACK.origin && url.pathname === LOOPBACK.pathname) {
      const res = await ctx.fetch(url.href);
      await res.body?.cancel();
      return { kind: "callback", url };
    }
    if (url.protocol !== scheme) return { kind: "off-scheme", url };
    if (url.searchParams.has("login_challenge")) return { kind: "login", url };
    if (url.pathname.startsWith("/verification")) return { kind: "verification", url };
    const res = await jar.fetch(url, { headers: { Accept: "text/html,application/json" } });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    const body = await res.text();
    if (cloudflareChallenge(res, body)) return { kind: "challenge", url, res };
    if (url.searchParams.has("consent_challenge") && res.status === 200) return { kind: "consent", url, res, body };
    return { kind: "page", url, res, body };
  }
  return { kind: "too-many", url };
}

function parseAttrs(tag) {
  const attrs = {};
  for (const m of tag.matchAll(/([a-zA-Z_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return attrs;
}

/**
 * The fields of a plain HTML consent form (POST, carries consent_challenge,
 * has an accept button), or undefined when the page has none: a JavaScript
 * widget cannot be completed here.
 */
export function consentForm(html, pageUrl) {
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const form = parseAttrs(m[1]);
    if ((form.method ?? "get").toLowerCase() !== "post") continue;
    const fields = new URLSearchParams();
    let accept;
    const controls = [...m[2].matchAll(/<input\b([^>]*)>/gi)].map(([, rest]) => [parseAttrs(rest), "text", ""]);
    for (const [, rest, text] of m[2].matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) controls.push([parseAttrs(rest), "submit", text]);
    for (const [a, fallback, text] of controls) {
      const type = (a.type ?? fallback).toLowerCase();
      if (!a.name) continue;
      if (type === "submit") {
        if (!accept && /accept|allow|approve|authori[sz]e|consent|yes/i.test(`${a.value ?? ""} ${text ?? ""}`)) accept = [a.name, a.value ?? ""];
      } else if (type === "hidden" || type === "text" || (type === "checkbox" && ("checked" in a || a.name === "grant_scope"))) fields.append(a.name, a.value ?? "");
    }
    if (!fields.has("consent_challenge") || !accept) continue;
    fields.append(...accept);
    return { action: new URL(form.action || pageUrl.href, pageUrl), fields };
  }
  return undefined;
}

/** Kratos UI message texts, for a login that was refused. */
function uiMessages(doc) {
  return [...(doc?.ui?.messages ?? []), ...(doc?.ui?.nodes ?? []).flatMap((n) => n.messages ?? [])].map((m) => m.text ?? m.id).filter(Boolean);
}

/** The Cloud-brokered password login. Returns the URL to continue at, or undefined after reporting why not. */
async function signIn(ctx, jar, flow, loginUrl) {
  const { report, secrets } = ctx;
  const flowUrl = new URL("/api/auth/flow", loginUrl.origin);
  flowUrl.searchParams.set("type", "login");
  const challenge = loginUrl.searchParams.get("login_challenge");
  if (challenge) flowUrl.searchParams.set("login_challenge", challenge);
  const res = await jar.fetch(flowUrl, { headers: { Accept: "application/json" } });
  const text = await res.text();
  if (cloudflareChallenge(res, text)) {
    report.skip("user-login", `GET ${flowUrl.origin}${flowUrl.pathname}?type=login ${res.status} is a Cloudflare challenge; ${personStep(flow)}`);
    return undefined;
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {}
  if (res.status !== 200 || !doc?.id) {
    report.fail("user-login", `GET ${flowUrl.origin}${flowUrl.pathname}?type=login ${res.status} (expected 200 and a login flow id)`);
    return undefined;
  }
  const nodes = doc.ui?.nodes ?? [];
  const csrf = nodes.find((n) => n.attributes?.name === "csrf_token")?.attributes?.value ?? doc.csrf_token;
  if (csrf) secrets.add(csrf);
  if (nodes.some((n) => n.group === "captcha" || /captcha|turnstile/i.test(n.attributes?.name ?? ""))) {
    report.skip("user-login", `the login flow at ${loginUrl.origin} has a captcha; ${personStep(flow)}`);
    return undefined;
  }

  const submit = new URL("/api/auth/flow/submit", loginUrl.origin);
  submit.searchParams.set("id", doc.id);
  submit.searchParams.set("type", "login");
  const form = new URLSearchParams({ identifier: flow.email.value, password: flow.password.value, method: "password" });
  if (csrf) form.set("csrf_token", csrf);
  const sub = await jar.fetch(submit, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form.toString() });
  const subText = await sub.text();
  let answer;
  try {
    answer = JSON.parse(subText);
  } catch {}
  const location = sub.headers.get("location") ?? answer?.redirect_browser_to;
  const next = location ? new URL(location, submit) : undefined;
  const detail = `POST ${submit.origin}${submit.pathname}?type=login ${sub.status}${next ? ` Location: ${next.origin}${next.pathname}` : ""}`;
  const messages = uiMessages(answer);
  if (cloudflareChallenge(sub, subText)) {
    report.skip("user-login", `${detail} is a Cloudflare challenge; ${personStep(flow)}`);
    return undefined;
  }
  if (next?.pathname.startsWith("/verification") || answer?.error?.id === "session_verified_address_required" || messages.some((m) => /not (been )?verified|verif(y|ication) (your|the) (email|address)/i.test(m))) {
    report.skip("user-login", `${detail}: email verification is required for ${flow.email.name}=${flow.email.value}. A person who can read that inbox must open the verification link Cloud sent to it, then re-run the smoke; the signed-in user-token checks are skipped until then`);
    return undefined;
  }
  if (sub.status >= 400 || !next) {
    report.fail("user-login", `${detail} (the login was refused${messages.length ? `: ${messages.join("; ")}` : ""})`);
    return undefined;
  }
  const session = jar.names(submit).filter((n) => /session/i.test(n));
  if (!session.length) {
    report.fail("user-login", `${detail} (no session cookie was set; cookies: ${jar.names(submit).join(",") || "(none)"})`);
    return undefined;
  }
  report.pass("user-login", `${detail} session cookie ${session.join(",")} set for ${flow.email.value}`);
  return next;
}

/** Submits a plain consent form. Returns the URL to continue at, or undefined after reporting why not. */
async function giveConsent(ctx, jar, flow, page) {
  const where = `${page.url.origin}${page.url.pathname}`;
  const form = consentForm(page.body, page.url);
  if (!form) {
    ctx.report.skip("user-consent", `GET ${page.url.href} ${page.res.status} is a consent page with no plain HTML form to submit (a JavaScript widget needs a browser); ${personStep(flow)}`);
    return undefined;
  }
  const res = await jar.fetch(form.action, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html,application/json" }, body: form.fields.toString() });
  const text = await res.text();
  const location = res.headers.get("location");
  if (cloudflareChallenge(res, text)) {
    ctx.report.skip("user-consent", `POST ${form.action.origin}${form.action.pathname} ${res.status} is a Cloudflare challenge; ${personStep(flow)}`);
    return undefined;
  }
  if (res.status < 300 || res.status >= 400 || !location) {
    ctx.report.fail("user-consent", `POST ${form.action.origin}${form.action.pathname} ${res.status} (expected a redirect back to the authorization server)`);
    return undefined;
  }
  ctx.report.pass("user-consent", `consent form at ${where} accepted: POST ${res.status}`);
  return new URL(location, form.action);
}

/** Reports a browse() that ended somewhere other than the callback. */
function stopped(ctx, flow, hop, stage) {
  const at = `${hop.url.origin}${hop.url.pathname}`;
  const err = hop.url.searchParams.get("error");
  if (err) return ctx.report.fail(stage, `${at} answered error=${err}${hop.url.searchParams.get("error_description") ? ` error_description=${hop.url.searchParams.get("error_description")}` : ""}`);
  switch (hop.kind) {
    case "challenge":
      return ctx.report.skip(stage, `GET ${hop.url.href} ${hop.res.status} is a Cloudflare challenge; ${personStep(flow)}`);
    case "verification":
      return ctx.report.skip(stage, `redirected to ${at}: email verification is required for ${flow.email.name}=${flow.email.value}. A person who can read that inbox must open the verification link Cloud sent to it, then re-run the smoke`);
    case "off-scheme":
      return ctx.report.fail(stage, `a redirect went to ${hop.url.protocol} (${at}), which is not followed`);
    case "too-many":
      return ctx.report.fail(stage, `more than ${MAX_HOPS} redirects, last at ${at}`);
    case "login":
      return ctx.report.fail(stage, `asked to sign in again at ${at} after signing in`);
    case "consent":
      return ctx.report.fail(stage, `asked for consent again at ${at} after consenting`);
    default:
      if (hop.res.status >= 400) return ctx.report.fail(stage, `GET ${at} ${hop.res.status}`);
      return ctx.report.skip(stage, `GET ${hop.url.href} ${hop.res.status} is a page that needs a browser; ${personStep(flow)}`);
  }
}

/** Listens on the registered loopback redirect and resolves with the callback's query. */
async function listenLoopback() {
  let resolve;
  const callback = new Promise((r) => (resolve = r));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, LOOPBACK.origin);
    if (url.pathname !== LOOPBACK.pathname) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" }).end("blowhorn-mcp-hosted smoke: signed in; this window can be closed.\n");
    resolve(url.searchParams);
  });
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(Number(LOOPBACK.port), LOOPBACK.hostname, ok);
  });
  return {
    callback,
    close: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

/** The `aud` of a JWT access token, or undefined for an opaque one. Decodes only; Cloud validates. */
function jwtAudience(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const aud = JSON.parse(Buffer.from(parts[1], "base64url").toString()).aud;
    return aud === undefined ? undefined : [aud].flat();
  } catch {
    return undefined;
  }
}

/**
 * Signs the test account in with authorization code + PKCE and exchanges the
 * code at the token_endpoint. Returns the access token, or undefined after
 * reporting why there is none.
 */
export async function obtainUserToken(ctx, as, clientId, email, password) {
  const { base, report, secrets } = ctx;
  if (!as?.authorization_endpoint || !as?.token_endpoint) {
    report.skip("user-token", "the authorization server metadata has no authorization_endpoint and token_endpoint");
    return undefined;
  }
  const resource = `${base}/mcp`;
  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(16));
  secrets.add(verifier);
  const authorize = new URL(as.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "openid offline_access",
    resource,
    state,
    code_challenge: base64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  }))
    authorize.searchParams.set(k, v);
  const flow = { authorize, email, password };

  let loopback;
  try {
    loopback = await listenLoopback();
  } catch (err) {
    report.fail("user-token", `cannot listen on ${REDIRECT_URI}: ${err?.message ?? err}`);
    return undefined;
  }
  try {
    report.note(`test account sign-in for ${email.value} (${email.name}): authorization code + PKCE S256, resource ${resource}, client_id ${clientId}`);
    const jar = new CookieJar(ctx);
    let hop = await browse(ctx, jar, authorize);
    let signedIn = false;
    let consented = false;
    while (hop.kind === "login" || hop.kind === "consent") {
      let next;
      if (hop.kind === "login" && !signedIn) {
        signedIn = true;
        next = await signIn(ctx, jar, flow, hop.url);
      } else if (hop.kind === "consent" && !consented) {
        consented = true;
        next = await giveConsent(ctx, jar, flow, hop);
      } else break;
      if (!next) return undefined;
      hop = await browse(ctx, jar, next);
    }
    if (hop.kind !== "callback") {
      stopped(ctx, flow, hop, hop.kind === "verification" ? "user-login" : "user-authorize");
      return undefined;
    }

    const query = await Promise.race([loopback.callback, new Promise((r) => setTimeout(() => r(undefined), 5000).unref())]);
    if (!query) {
      report.fail("user-authorize", `the redirect to ${REDIRECT_URI} did not reach the loopback listener`);
      return undefined;
    }
    const code = query.get("code");
    if (code) secrets.add(code);
    if (query.get("error")) {
      report.fail("user-authorize", `${REDIRECT_URI} error=${query.get("error")}${query.get("error_description") ? ` error_description=${query.get("error_description")}` : ""}`);
      return undefined;
    }
    if (query.get("state") !== state) {
      report.fail("user-authorize", `${REDIRECT_URI} state does not match the one sent`);
      return undefined;
    }
    if (!code) {
      report.fail("user-authorize", `${REDIRECT_URI} has no code`);
      return undefined;
    }
    report.pass("user-authorize", `authorization code caught on ${REDIRECT_URI}`);

    const res = await ctx.fetch(as.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT_URI, resource }).toString(),
    });
    const doc = await readJson(res);
    for (const key of ["access_token", "refresh_token", "id_token"]) if (typeof doc?.[key] === "string") secrets.add(doc[key]);
    const aud = typeof doc?.access_token === "string" ? jwtAudience(doc.access_token) : undefined;
    const problems = [];
    if (res.status !== 200) problems.push(`expected 200${doc?.error ? `; error=${doc.error}${doc.error_description ? ` error_description=${doc.error_description}` : ""}` : ""}`);
    if (typeof doc?.access_token !== "string") problems.push("no access_token");
    if (doc?.token_type && doc.token_type.toLowerCase() !== "bearer") problems.push(`token_type is ${doc.token_type}, not bearer`);
    if (aud && !aud.includes(resource)) problems.push(`aud ${JSON.stringify(aud)} does not include ${resource}`);
    const detail = `POST ${as.token_endpoint} ${res.status}${doc?.token_type ? ` token_type="${doc.token_type}"` : ""}${doc?.expires_in ? ` expires_in=${doc.expires_in}` : ""}${doc?.scope ? ` scope="${doc.scope}"` : ""} aud=${aud ? JSON.stringify(aud) : "(opaque token; /mcp checks it)"}`;
    if (problems.length) {
      report.fail("user-token", `${detail} (${problems.join("; ")})`);
      return undefined;
    }
    report.pass("user-token", detail);
    return doc.access_token;
  } finally {
    await loopback.close();
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
  const email = fromEnv(env, "testEmail");
  const password = fromEnv(env, "testPassword");
  const secrets = new Set([mcpToken, cloudToken, wrongAud, password].filter(Boolean).map((t) => t.value));
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
  const as = await step("as-metadata", () => checkAuthorizationServer(ctx, issuer));
  await step("healthz", () => checkHealth(ctx));
  await step("mcp-401", () => checkUnauthenticated(ctx));
  const registered = await step("dcr", () => checkRegistration(ctx, as?.registration_endpoint));

  if (mcpToken) {
    report.note(`MCP OAuth token path: ${mcpToken.name} (a user token whose audience should be ${base}/mcp)`);
    await step("mcp-token", () => checkSignedIn(ctx, "mcp-token", mcpToken.value));
  } else {
    report.skip("mcp-token", `MCP OAuth token path skipped: ${ENV_NAMES.mcpToken.join(" and ")} are unset (need a user token bound to aud ${base}/mcp)`);
  }
  const account = ENV_NAMES.testEmail.concat(ENV_NAMES.testPassword);
  if (mcpToken) report.skip("user-token", `test account sign-in not used: ${mcpToken.name} is set`);
  else if (!email || !password) {
    const unset = account.filter((n) => !env[n]);
    report.skip("user-token", `test account sign-in skipped: ${unset.join(" and ")} ${unset.length > 1 ? "are" : "is"} unset (it needs both ${account.join(" and ")})`);
  } else if (!registered) report.skip("user-token", "test account sign-in skipped: no client_id, the dcr check failed");
  else {
    const token = await step("user-token", () => obtainUserToken(ctx, as, registered.clientId, email, password));
    if (token) await step("user-token-initialize", () => checkSignedIn(ctx, "user-token", token));
  }
  if (registered) await step("dcr-cleanup", registered.cleanup);

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
  BLOWHORN_MCP_TEST_EMAIL        test account email: with the password and no MCP token,
  BLOWHORN_MCP_TEST_PASSWORD     sign in headlessly (authorization code + PKCE) for a user token

Signed-in checks are skipped when their token (or the test account) is unset,
or when a step needs a person, such as email verification. Exits 1 on any failure.`;

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
