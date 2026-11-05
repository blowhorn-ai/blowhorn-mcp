// SPDX-License-Identifier: Apache-2.0
/*
 * Checks hosted/errors/mcp.json, the gateway's error code registry: every
 * definition against the vendored ErrorDefinition construct
 * (schemas/vendor/blowhorn/), plus the gateway's own rules: the component is
 * blowhorn/mcp, codes and monikers are unique, nextErrorCode is one past the
 * highest code, every definition names at least one probable cause and every
 * cause at least one remediation (the construct's description asks the
 * registry check for these; it has no minItems), and every outcome
 * src/errors.js maps has a definition. blowhorn-ai/blowhorn's registry has
 * further rules of its own; they are not copied here, so they cannot drift.
 * Offline. scripts/check-drift.js and test/errors.test.js both run it.
 */
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Validator } from "@cfworker/json-schema";
import { CODES } from "../src/errors.js";
import { HOSTED, VENDOR, vendored } from "./catalog.js";

export const REGISTRY = path.join(HOSTED, "errors", "mcp.json");
export const ERROR_DEFINITION = "schemas/dist/ErrorDefinition.schema.json";
const REGISTRY_KEYS = ["$comment", "component", "definitions", "nextErrorCode"];
const COMPONENT = { type: "blowhorn", name: "mcp" };

export function readRegistry(file = REGISTRY) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** The vendored ErrorDefinition JSON Schema. */
export function errorDefinitionSchema(vendor = VENDOR) {
  return JSON.parse(fs.readFileSync(vendored("blowhorn", ERROR_DEFINITION, vendor), "utf8"));
}

/**
 * The validator for one ErrorDefinition instance: the vendored construct
 * under @cfworker/json-schema, the one every registry and 429 check uses.
 */
export function errorDefinitionValidator(schema = errorDefinitionSchema()) {
  return new Validator(schema, "2020-12", false);
}

/**
 * Problem strings for `registry`, each naming a definition by its index and
 * code, or an outcome of `codes` (src/errors.js CODES) by name; [] when it is
 * sound.
 */
export function registryProblems(registry = readRegistry(), schema = errorDefinitionSchema(), codes = CODES) {
  const problems = [];
  const keys = Object.keys(registry).sort();
  if (!isDeepStrictEqual(keys, REGISTRY_KEYS)) problems.push(`  keys are ${keys.join(", ")}; want ${REGISTRY_KEYS.join(", ")}`);
  const { component, nextErrorCode, definitions } = registry;
  if (!isDeepStrictEqual(component, COMPONENT)) problems.push('  component is not {"type": "blowhorn", "name": "mcp"}');
  if (!Number.isInteger(nextErrorCode)) problems.push("  nextErrorCode is not an integer");
  if (!Array.isArray(definitions) || !definitions.length) return [...problems, "  definitions is not a non-empty list"];

  const validator = errorDefinitionValidator(schema);
  const seen = new Set();
  const monikers = new Set();
  let highest = -Infinity;
  definitions.forEach((d, i) => {
    const where = `  definitions[${i}] ${d?.code ?? "(no code)"}`;
    const { valid, errors } = validator.validate(d);
    if (!valid) {
      for (const e of errors) problems.push(`${where} ${e.instanceLocation.replace(/^#/, "") || "/"}: ${e.error}`);
      return;
    }
    const number = Number(d.code.slice(-4));
    highest = Math.max(highest, number);
    if (!isDeepStrictEqual(d.component, COMPONENT)) problems.push(`${where}: component is not blowhorn/mcp`);
    if (!(number < nextErrorCode)) problems.push(`${where}: number is not below nextErrorCode ${nextErrorCode}`);
    if (seen.has(d.code)) problems.push(`${where}: code is used twice`);
    seen.add(d.code);
    if (monikers.has(d.moniker)) problems.push(`${where}: moniker ${d.moniker} is used twice`);
    monikers.add(d.moniker);
    if (!d.probableCauses.length) problems.push(`${where}: no probable cause`);
    for (const c of d.probableCauses) if (!c.remediations.length) problems.push(`${where}: cause ${c.id} has no remediation`);
  });
  if (Number.isFinite(highest) && Number.isInteger(nextErrorCode) && nextErrorCode !== highest + 1) {
    problems.push(`  nextErrorCode is ${nextErrorCode}; want ${highest + 1}, one past the highest code`);
  }
  for (const [outcome, code] of Object.entries(codes)) {
    if (!seen.has(code)) problems.push(`  outcome ${outcome}: no definition for ${code}`);
  }
  return problems;
}
