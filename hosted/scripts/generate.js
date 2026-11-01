#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/*
 * `make hosted-generate`: writes hosted/src/catalog.generated.json from the
 * vendored meshery/schemas files (scripts/catalog.js). Offline. Never
 * hand-edit the output; `make hosted-check` fails when it drifts.
 *
 *   node scripts/generate.js                     write src/catalog.generated.json
 *   node scripts/generate.js --out FILE          write FILE instead
 *   node scripts/generate.js --api FILE ...      read these api.yml files instead
 *                                                of the pinned three
 */
import fs from "node:fs";
import path from "node:path";
import { CATALOG, CatalogError, buildCatalog, render } from "./catalog.js";

function args(argv) {
  const out = { file: CATALOG, apiFiles: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out.file = path.resolve(argv[++i]);
    else if (argv[i] === "--api") {
      out.apiFiles = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out.apiFiles.push(path.resolve(argv[++i]));
    } else throw new CatalogError(`unknown argument ${argv[i]}`);
  }
  return out;
}

try {
  const { file, apiFiles } = args(process.argv.slice(2));
  const catalog = buildCatalog({ apiFiles });
  fs.writeFileSync(file, render(catalog));
  process.stdout.write(`wrote ${path.relative(process.cwd(), file) || file}: ${catalog.tools.length} tools (${catalog.tools.map((t) => t.name).join(", ")})\n`);
} catch (err) {
  process.stderr.write(`hosted generate: ${err.message}\n`);
  process.exit(1);
}
