#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Part of `make hosted-check`: fails when a vendored schema's bytes differ
 * from hosted/schemas/vendor/SOURCES.json, or when
 * hosted/src/catalog.generated.json differs from what scripts/generate.js
 * would write now. Offline.
 */
import fs from "node:fs";
import { CATALOG, buildCatalog, render, vendorProblems } from "./catalog.js";

function fail(lines) {
  process.stderr.write(`${[].concat(lines).join("\n")}\n`);
  process.exit(1);
}

try {
  const problems = vendorProblems();
  if (problems.length) fail(["Vendored schemas differ from hosted/schemas/vendor/SOURCES.json:", ...problems, "Refresh them only with `make hosted-schemas-refresh`."]);
  const want = render(buildCatalog());
  const have = fs.existsSync(CATALOG) ? fs.readFileSync(CATALOG, "utf8") : null;
  if (have !== want) fail(["hosted/src/catalog.generated.json is out of date with the vendored schemas.", "Run `make hosted-generate` and commit the result. Never hand-edit it."]);
  process.stdout.write("ok hosted catalog matches the vendored schemas\n");
} catch (err) {
  fail(`hosted check-drift: ${err.message}`);
}
