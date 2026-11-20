#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/*
 * Post-deploy check of one deployment named in schemas/deployments.json:
 *
 *   node scripts/check-deployment.js <production|staging> [--fetch-base URL]
 *
 * Fetches the deployment's public origin (or --fetch-base, for tests) and
 * requires: /healthz 200; the protected resource metadata 200 with `resource`
 * `<publicOrigin>/mcp` and `authorization_servers` exactly [cloudBase]; an
 * unauthenticated POST /mcp 401 whose WWW-Authenticate resource_metadata
 * names this deployment's own metadata URL. Exits 1 and says what differed.
 * The expected values come only from deployments.json.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOSTED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRM_PATH = "/.well-known/oauth-protected-resource";

export async function check(name, fetchBase, fetchImpl = fetch) {
  const { deployments } = JSON.parse(readFileSync(path.join(HOSTED, "schemas", "deployments.json"), "utf8"));
  const want = deployments.find((d) => d.name === name);
  if (!want) return [`unknown deployment ${JSON.stringify(name)}`];
  const base = (fetchBase ?? want.publicOrigin).replace(/\/+$/, "");
  const problems = [];
  const get = (p, init) => fetchImpl(`${base}${p}`, { redirect: "manual", ...init });

  const health = await get("/healthz");
  if (health.status !== 200) problems.push(`/healthz is ${health.status}, want 200`);

  const prm = await get(PRM_PATH);
  if (prm.status !== 200) problems.push(`${PRM_PATH} is ${prm.status}, want 200`);
  else {
    const doc = await prm.json();
    if (doc.resource !== `${want.publicOrigin}/mcp`) problems.push(`resource is ${JSON.stringify(doc.resource)}, want ${want.publicOrigin}/mcp`);
    if (JSON.stringify(doc.authorization_servers) !== JSON.stringify([want.cloudBase])) problems.push(`authorization_servers is ${JSON.stringify(doc.authorization_servers)}, want ${JSON.stringify([want.cloudBase])}`);
  }

  const post = await get("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) });
  if (post.status !== 401) problems.push(`unauthenticated POST /mcp is ${post.status}, want 401`);
  const challenge = post.headers.get("www-authenticate") ?? "";
  const wantUrl = `${want.publicOrigin}${PRM_PATH}/mcp`;
  if (!challenge.includes(`resource_metadata="${wantUrl}"`)) problems.push(`WWW-Authenticate is ${JSON.stringify(challenge)}, want resource_metadata="${wantUrl}"`);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--fetch-base");
  const fetchBase = at >= 0 ? args.splice(at, 2)[1] : undefined;
  const [name] = args;
  if (!name) {
    console.error("usage: check-deployment.js <name> [--fetch-base URL]");
    process.exit(2);
  }
  const problems = await check(name, fetchBase);
  for (const p of problems) console.error(`FAIL ${name}: ${p}`);
  if (problems.length) process.exit(1);
  console.log(`ok ${name}`);
}
