#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/*
 * `make hosted-schemas-refresh`: downloads the meshery/schemas files the tool
 * catalog is generated from, at one pinned commit, byte for byte into
 * hosted/schemas/vendor/meshery-schemas/, following every relative $ref
 * transitively, and rewrites hosted/schemas/vendor/SOURCES.json with each
 * file's sha256. The only hosted/ script that touches the network; run it by
 * hand, review the diff, then run `make hosted-generate` and `make check`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const HOSTED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(HOSTED, "schemas", "vendor");
const DIR = path.join(VENDOR, "meshery-schemas");

export const REPO = "meshery/schemas";
export const REF = "7582dec49ba1227f34371341103e8374228d4b0d";
export const SOURCE_PR = "meshery/schemas#1326";
export const ROOTS = [
  "schemas/constructs/v1beta3/content_item/api.yml",
  "schemas/constructs/v1beta3/event/api.yml",
  "schemas/constructs/v1beta3/connection/api.yml",
  "schemas/extensions/mcp-operation.yaml",
];

/** Every relative file a parsed document's $refs name, resolved against `from`. */
export function refTargets(doc, from) {
  const out = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") {
        const file = v.split("#")[0];
        if (file && !/^[a-z][a-z0-9+.-]*:/i.test(file)) out.add(path.posix.normalize(path.posix.join(path.posix.dirname(from), file)));
      } else walk(v);
    }
  };
  walk(doc);
  return [...out];
}

async function main() {
  const queue = [...ROOTS];
  const seen = new Set();
  const files = [];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.startsWith("..")) throw new Error(`${file}: $ref leaves the repo`);
    const url = `https://raw.githubusercontent.com/${REPO}/${REF}/${file}`;
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const doc = yaml.load(bytes.toString("utf8"));
    const dest = path.join(DIR, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    files.push({ path: file, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
    process.stdout.write(`fetched ${file}\n`);
    queue.push(...refTargets(doc, file));
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sources = { repo: REPO, ref: REF, sourcePr: SOURCE_PR, dir: "meshery-schemas", files };
  fs.writeFileSync(path.join(VENDOR, "SOURCES.json"), JSON.stringify(sources, null, 2) + "\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`schemas-refresh: ${err.message}\n`);
    process.exit(1);
  });
}
