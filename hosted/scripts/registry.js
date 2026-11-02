// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Checks hosted/errors/mcp.json, the gateway's error code registry: every
 * definition against the vendored ErrorDefinition construct
 * (schemas/vendor/blowhorn/), plus what the construct cannot say and
 * blowhorn-ai/blowhorn's own registry check refuses. Offline.
 * scripts/check-drift.js and test/errors.test.js both run it.
 */
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Validator } from "@cfworker/json-schema";
import { HOSTED, VENDOR, vendored } from "./catalog.js";

export const REGISTRY = path.join(HOSTED, "errors", "mcp.json");
export const ERROR_DEFINITION = "schemas/dist/ErrorDefinition.schema.json";
const REGISTRY_KEYS = ["$comment", "component", "definitions", "nextErrorCode"];
const REFERENCE_URL = "https://blowhorn.ai/docs/reference/error-codes/";

export function readRegistry(file = REGISTRY) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** The vendored ErrorDefinition JSON Schema. */
export function errorDefinitionSchema(vendor = VENDOR) {
  return JSON.parse(fs.readFileSync(vendored("blowhorn", ERROR_DEFINITION, vendor), "utf8"));
}

/** Problem strings for `registry`, each naming a definition by its index and code; [] when it is sound. */
export function registryProblems(registry = readRegistry(), schema = errorDefinitionSchema()) {
  const problems = [];
  const keys = Object.keys(registry).sort();
  if (!isDeepStrictEqual(keys, REGISTRY_KEYS)) problems.push(`  keys are ${keys.join(", ")}; want ${REGISTRY_KEYS.join(", ")}`);
  const { component, nextErrorCode, definitions } = registry;
  if (!isDeepStrictEqual(component, { type: "blowhorn", name: "mcp" })) problems.push('  component is not {"type": "blowhorn", "name": "mcp"}');
  if (!Number.isInteger(nextErrorCode)) problems.push("  nextErrorCode is not an integer");
  if (!Array.isArray(definitions) || !definitions.length) return [...problems, "  definitions is not a non-empty list"];

  const validator = new Validator(schema, "2020-12", false);
  const codes = new Set();
  const monikers = new Set();
  definitions.forEach((d, i) => {
    const where = `  definitions[${i}] ${d?.code ?? "(no code)"}`;
    const { valid, errors } = validator.validate(d);
    if (!valid) {
      for (const e of errors) problems.push(`${where} ${e.instanceLocation.replace(/^#/, "") || "/"}: ${e.error}`);
      return;
    }
    if (!isDeepStrictEqual(d.component, component)) problems.push(`${where}: component differs from the registry's`);
    const prefix = `${component?.type}-${component?.name}-`;
    if (!d.code.startsWith(prefix)) problems.push(`${where}: code does not start with ${prefix}`);
    if (!(Number(d.code.slice(-4)) < nextErrorCode)) problems.push(`${where}: number is not below nextErrorCode ${nextErrorCode}`);
    if (codes.has(d.code)) problems.push(`${where}: code is used twice`);
    if (monikers.has(d.moniker)) problems.push(`${where}: moniker ${d.moniker} is used twice`);
    codes.add(d.code);
    monikers.add(d.moniker);
    if (d.referenceUrl !== `${REFERENCE_URL}${d.code}/`) problems.push(`${where}: referenceUrl is not ${REFERENCE_URL}${d.code}/`);
    if (!d.probableCauses.length) problems.push(`${where}: no probable causes`);
    const causes = new Set();
    const remediations = new Map();
    for (const cause of d.probableCauses) {
      if (causes.has(cause.id)) problems.push(`${where}: cause ${cause.id} is listed twice`);
      causes.add(cause.id);
      if (!cause.remediations.length) problems.push(`${where}: cause ${cause.id} has no remediations`);
      const ids = new Set();
      for (const r of cause.remediations) {
        if (ids.has(r.id)) problems.push(`${where}: cause ${cause.id} lists remediation ${r.id} twice`);
        ids.add(r.id);
        if (r.approvalPolicy !== undefined && r.action === undefined) problems.push(`${where}: remediation ${r.id} has an approvalPolicy but no action`);
        if (remediations.has(r.id) && !isDeepStrictEqual(remediations.get(r.id), r)) problems.push(`${where}: remediation ${r.id} differs between causes`);
        remediations.set(r.id, r);
      }
    }
  });
  return problems;
}
