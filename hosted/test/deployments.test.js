// SPDX-License-Identifier: Apache-2.0
/*
 * Holds the known (Cloud base, public origin) pairs: schemas/deployments.json
 * to its schema, the code and wrangler.jsonc to that file, the protected
 * resource schema's enums to it, and the Worker's behavior for each pair and
 * for every mismatch (fail closed).
 */
import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Validator } from "@cfworker/json-schema";
import worker from "../src/index.js";
import { DEPLOYMENTS, cloudBase, deployment, forwardHeaders, REQUEST_HEADERS } from "../src/proxy.js";
import { protectedResourceMetadata, publicChallenge } from "../src/metadata.js";
import { RATE_LIMITER_BINDING } from "../src/ratelimit.js";
import { ACCEPT, CONFIG, INIT, UNLIMITED, mockFetch } from "./support/harness.js";
import { readWranglerConfig } from "./support/wrangler.js";

const HOSTED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => JSON.parse(readFileSync(path.join(HOSTED, ...p), "utf8"));
const data = read("schemas", "deployments.json");
const PROD = { CLOUD_API_BASE: "https://cloud.blowhorn.ai", PUBLIC_ORIGIN: "https://mcp.blowhorn.ai" };
const STAGING = { CLOUD_API_BASE: "https://staging-cloud.layer5.io", PUBLIC_ORIGIN: "https://mcp-staging.blowhorn.ai" };
const withLimiter = (env) => ({ ...env, RATE_LIMITS: JSON.stringify(CONFIG), [RATE_LIMITER_BINDING]: UNLIMITED });

test("deployments.json is valid against its schema, with exactly one default (production)", () => {
  const result = new Validator(read("schemas", "deployments.schema.json"), "2020-12", false).validate(data);
  assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
  const defaults = data.deployments.filter((d) => d.default);
  assert.deepStrictEqual(defaults.map((d) => d.name), ["production"]);
  assert.deepStrictEqual(data.deployments.map((d) => d.name).sort(), ["production", "staging"]);
  assert.strictEqual(new Set(data.deployments.map((d) => d.cloudBase)).size, data.deployments.length);
  assert.strictEqual(new Set(data.deployments.map((d) => d.publicOrigin)).size, data.deployments.length);
  assert.strictEqual(DEPLOYMENTS.length, data.deployments.length);
});

test("the schema rejects a path, a trailing slash and a non-https origin", () => {
  const validator = new Validator(read("schemas", "deployments.schema.json"), "2020-12", false);
  for (const bad of ["https://cloud.blowhorn.ai/", "https://cloud.blowhorn.ai/x", "http://cloud.blowhorn.ai"]) {
    const doc = { deployments: [{ name: "production", cloudBase: bad, publicOrigin: "https://mcp.blowhorn.ai" }] };
    assert.strictEqual(validator.validate(doc).valid, false, bad);
  }
});

test("a missing env is production; each known pair resolves to its own origin and resource", () => {
  assert.strictEqual(deployment({}).name, "production");
  assert.strictEqual(deployment({}).resource, "https://mcp.blowhorn.ai/mcp");
  assert.strictEqual(cloudBase({}), "https://cloud.blowhorn.ai");
  assert.strictEqual(deployment(PROD).name, "production");
  assert.strictEqual(deployment(STAGING).name, "staging");
  assert.strictEqual(deployment(STAGING).resource, "https://mcp-staging.blowhorn.ai/mcp");
  assert.strictEqual(deployment({ CLOUD_API_BASE: "https://staging-cloud.layer5.io/", PUBLIC_ORIGIN: "https://mcp-staging.blowhorn.ai/" }).name, "staging");
});

test("a mismatched pair, an unknown base or an unknown origin resolves to nothing", () => {
  const bad = [
    { CLOUD_API_BASE: STAGING.CLOUD_API_BASE, PUBLIC_ORIGIN: PROD.PUBLIC_ORIGIN },
    { CLOUD_API_BASE: PROD.CLOUD_API_BASE, PUBLIC_ORIGIN: STAGING.PUBLIC_ORIGIN },
    { CLOUD_API_BASE: STAGING.CLOUD_API_BASE },
    { PUBLIC_ORIGIN: STAGING.PUBLIC_ORIGIN },
    { CLOUD_API_BASE: "https://evil.example", PUBLIC_ORIGIN: PROD.PUBLIC_ORIGIN },
    { CLOUD_API_BASE: PROD.CLOUD_API_BASE, PUBLIC_ORIGIN: "https://evil.example" },
    { CLOUD_API_BASE: "https://staging-cloud.layer5.io/some/path", PUBLIC_ORIGIN: STAGING.PUBLIC_ORIGIN },
  ];
  for (const env of bad) {
    assert.strictEqual(deployment(env), null, JSON.stringify(env));
    assert.strictEqual(cloudBase(env), null);
    assert.throws(() => protectedResourceMetadata(env));
    assert.throws(() => publicChallenge("", env));
    assert.throws(() => forwardHeaders(new Headers(), REQUEST_HEADERS, env));
  }
});

test("the production and staging documents are both valid against protected-resource.schema.json and name their own pair", () => {
  const schema = read("schemas", "protected-resource.schema.json");
  const validator = new Validator(schema);
  for (const d of data.deployments) {
    const doc = protectedResourceMetadata({ CLOUD_API_BASE: d.cloudBase, PUBLIC_ORIGIN: d.publicOrigin });
    const result = validator.validate(doc);
    assert.strictEqual(result.valid, true, `${d.name}: ${JSON.stringify(result.errors)}`);
    assert.strictEqual(doc.resource, `${d.publicOrigin}/mcp`);
    assert.deepStrictEqual(doc.authorization_servers, [d.cloudBase]);
  }
  assert.deepStrictEqual(schema.properties.resource.enum, data.deployments.map((d) => `${d.publicOrigin}/mcp`));
  assert.deepStrictEqual(schema.properties.authorization_servers.items.enum, data.deployments.map((d) => d.cloudBase));
  const guessed = { ...protectedResourceMetadata(PROD), resource: "https://evil.example/mcp" };
  assert.strictEqual(validator.validate(guessed).valid, false, "an unknown resource is refused");
  assert.strictEqual(validator.validate({ ...protectedResourceMetadata(PROD), authorization_servers: ["https://evil.example"] }).valid, false);
});

test("production document stays exactly the published one", () => {
  const expected = { resource: "https://mcp.blowhorn.ai/mcp", authorization_servers: ["https://cloud.blowhorn.ai"], bearer_methods_supported: ["header"], resource_name: "Blowhorn MCP" };
  assert.deepStrictEqual(JSON.parse(JSON.stringify(protectedResourceMetadata())), expected);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(protectedResourceMetadata(PROD))), expected);
});

test("wrangler.jsonc: top level is production, env.staging is the staging pair, each pair is known", () => {
  const cfg = readWranglerConfig();
  const staging = cfg.env.staging;
  assert.deepStrictEqual(Object.keys(cfg.env), ["staging"]);
  assert.strictEqual(cfg.name, "blowhorn-mcp-hosted");
  assert.strictEqual(staging.name, "blowhorn-mcp-hosted-staging");
  assert.notStrictEqual(staging.name, cfg.name, "staging has its own Durable Object namespace");
  assert.strictEqual(cfg.routes, undefined, "production has no routes block");
  assert.strictEqual(cfg.workers_dev, false);
  assert.strictEqual(staging.workers_dev, false);
  assert.strictEqual(staging.preview_urls, false);
  assert.deepStrictEqual(staging.routes, [{ pattern: new URL(STAGING.PUBLIC_ORIGIN).hostname, custom_domain: true }]);
  assert.strictEqual(deployment(cfg.vars)?.name, "production");
  assert.strictEqual(deployment(staging.vars)?.name, "staging");
  assert.deepStrictEqual({ CLOUD_API_BASE: cfg.vars.CLOUD_API_BASE, PUBLIC_ORIGIN: cfg.vars.PUBLIC_ORIGIN }, PROD);
  assert.deepStrictEqual({ CLOUD_API_BASE: staging.vars.CLOUD_API_BASE, PUBLIC_ORIGIN: staging.vars.PUBLIC_ORIGIN }, STAGING);
  // Not inherited by wrangler, so declared again and held equal to production.
  assert.strictEqual(staging.vars.RATE_LIMITS, cfg.vars.RATE_LIMITS);
  assert.strictEqual(staging.vars.ALLOWED_ORIGINS, cfg.vars.ALLOWED_ORIGINS);
  assert.deepStrictEqual(staging.durable_objects, cfg.durable_objects);
  assert.deepStrictEqual(staging.migrations, cfg.migrations);
});

/** Drives the Worker for one env against a stand-in Cloud; returns the calls it made. */
async function run(t, env, request, respond = () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })) {
  const calls = mockFetch(t, respond);
  return { response: await worker.fetch(request, withLimiter(env), {}), calls };
}

test("healthz is ok for each known pair and not ok for a mismatch", async (t) => {
  for (const [env, ok] of [[{}, true], [PROD, true], [STAGING, true], [{ ...STAGING, PUBLIC_ORIGIN: PROD.PUBLIC_ORIGIN }, false], [{ ...PROD, PUBLIC_ORIGIN: "https://guess.example" }, false]]) {
    const { response } = await run(t, env, new Request("https://x.test/healthz"));
    assert.strictEqual(response.status, ok ? 200 : 500, JSON.stringify(env));
    assert.strictEqual((await response.json()).ok, ok);
  }
});

test("a mismatched pair serves no metadata and sends nothing to Cloud", async (t) => {
  const env = { ...STAGING, PUBLIC_ORIGIN: PROD.PUBLIC_ORIGIN };
  const meta = await run(t, env, new Request("https://mcp.blowhorn.ai/.well-known/oauth-protected-resource"));
  assert.strictEqual(meta.response.status, 500);
  const post = await run(t, env, new Request("https://mcp.blowhorn.ai/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer t" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: INIT }) }));
  assert.strictEqual(post.response.status, 500);
  assert.strictEqual(post.calls.length, 0);
});

test("staging serves its own metadata and ignores the inbound Host", async (t) => {
  for (const url of ["https://mcp-staging.blowhorn.ai/.well-known/oauth-protected-resource", "https://evil.example/.well-known/oauth-protected-resource/mcp"]) {
    const { response } = await run(t, STAGING, new Request(url, { headers: { Host: "evil.example" } }));
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), {
      resource: "https://mcp-staging.blowhorn.ai/mcp",
      authorization_servers: ["https://staging-cloud.layer5.io"],
      bearer_methods_supported: ["header"],
      resource_name: "Blowhorn MCP",
    });
  }
});

test("staging carries /mcp to staging Cloud only, names the staging resource, and rewrites the challenge to the staging PRM", async (t) => {
  const request = new Request("https://mcp-staging.blowhorn.ai/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: ACCEPT, Authorization: "Bearer t" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: INIT }),
  });
  const { response, calls } = await run(t, STAGING, request, () => new Response("{}", { status: 401, headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://staging-cloud.layer5.io/x"' } }));
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(new URL(calls[0].url).origin, "https://staging-cloud.layer5.io");
  assert.strictEqual(new URL(calls[0].url).pathname, "/mcp");
  assert.strictEqual(new Headers(calls[0].init.headers).get("X-Forwarded-Mcp-Resource"), "https://mcp-staging.blowhorn.ai/mcp");
  assert.strictEqual(response.status, 401);
  assert.strictEqual(response.headers.get("WWW-Authenticate"), 'Bearer resource_metadata="https://mcp-staging.blowhorn.ai/.well-known/oauth-protected-resource/mcp"');
  const get = await run(t, STAGING, new Request("https://mcp-staging.blowhorn.ai/mcp"));
  assert.strictEqual(get.response.status, 401);
  assert.strictEqual(get.response.headers.get("WWW-Authenticate"), 'Bearer resource_metadata="https://mcp-staging.blowhorn.ai/.well-known/oauth-protected-resource/mcp"');
  assert.strictEqual(get.calls.length, 0);
});

/** The real Worker for `env`, served on a local port, so the post-deploy check runs as the CLI does. */
async function serve(t, env, cloud) {
  const { createServer } = await import("node:http");
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body });
    const out = await worker.fetch(request, withLimiter(env), {});
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("scripts/check-deployment.js passes for each env against its own deployment and fails across them", async (t) => {
  const { execFile } = await import("node:child_process");
  const cli = (name, base) =>
    new Promise((resolve) => execFile(process.execPath, [path.join(HOSTED, "scripts", "check-deployment.js"), name, "--fetch-base", base], (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })));
  const upstream = () => new Response("{}", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="x"' } });
  mockFetch(t, upstream);
  const prod = await serve(t, PROD);
  const staging = await serve(t, STAGING);
  assert.strictEqual((await cli("production", prod)).code, 0);
  assert.strictEqual((await cli("staging", staging)).code, 0);
  const cross = await cli("production", staging);
  assert.strictEqual(cross.code, 1);
  assert.match(cross.stderr, /resource is "https:\/\/mcp-staging\.blowhorn\.ai\/mcp"/);
  assert.match(cross.stderr, /authorization_servers is \["https:\/\/staging-cloud\.layer5\.io"\]/);
  assert.strictEqual((await cli("staging", prod)).code, 1);
  assert.strictEqual((await cli("nope", prod)).code, 1);
});
