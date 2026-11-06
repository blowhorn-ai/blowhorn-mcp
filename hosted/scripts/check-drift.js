#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/*
 * Part of `make hosted-check`: fails when a vendored schema's bytes differ
 * from hosted/schemas/vendor/SOURCES.json, or when hosted/errors/mcp.json
 * breaks the vendored ErrorDefinition construct or the gateway's own registry
 * rules (scripts/registry.js). Offline.
 */
import { registryProblems } from "./registry.js";
import { vendorProblems } from "./vendor.js";

function fail(lines) {
  process.stderr.write(`${[].concat(lines).join("\n")}\n`);
  process.exit(1);
}

try {
  const problems = vendorProblems();
  if (problems.length) fail(["Vendored schemas differ from hosted/schemas/vendor/SOURCES.json:", ...problems, "Refresh them only from their pinned commits, never by hand."]);
  const errors = registryProblems();
  if (errors.length) fail(["hosted/errors/mcp.json breaks the vendored ErrorDefinition construct or the gateway's registry rules:", ...errors]);
  process.stdout.write("ok hosted vendored schemas match SOURCES.json\n");
  process.stdout.write("ok hosted error registry validates against ErrorDefinition\n");
} catch (err) {
  fail(`hosted check-drift: ${err.message}`);
}
