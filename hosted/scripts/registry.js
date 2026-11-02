// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Checks hosted/errors/mcp.json, the gateway's error code registry: every
 * definition against the vendored ErrorDefinition construct
 * (schemas/vendor/blowhorn/), plus the gateway's own rules: the component is
 * blowhorn/mcp, codes are unique and below nextErrorCode, and every outcome
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

  const validator = new Validator(schema, "2020-12", false);
  const seen = new Set();
  definitions.forEach((d, i) => {
    const where = `  definitions[${i}] ${d?.code ?? "(no code)"}`;
    const { valid, errors } = validator.validate(d);
    if (!valid) {
      for (const e of errors) problems.push(`${where} ${e.instanceLocation.replace(/^#/, "") || "/"}: ${e.error}`);
      return;
    }
    if (!isDeepStrictEqual(d.component, COMPONENT)) problems.push(`${where}: component is not blowhorn/mcp`);
    if (!(Number(d.code.slice(-4)) < nextErrorCode)) problems.push(`${where}: number is not below nextErrorCode ${nextErrorCode}`);
    if (seen.has(d.code)) problems.push(`${where}: code is used twice`);
    seen.add(d.code);
  });
  for (const [outcome, code] of Object.entries(codes)) {
    if (!seen.has(code)) problems.push(`  outcome ${outcome}: no definition for ${code}`);
  }
  return problems;
}
