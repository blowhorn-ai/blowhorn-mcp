#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/*
 * `make hosted-schemas-refresh`: downloads every vendored schema, each source
 * at one pinned commit, byte for byte into hosted/schemas/vendor/<dir>/,
 * following every relative $ref transitively, and rewrites
 * hosted/schemas/vendor/SOURCES.json with each file's sha256. The only
 * hosted/ script that touches the network; run it by hand, review the diff,
 * then run `make check`. Every vendored file is JSON, so $refs are followed with
 * JSON.parse.
 *
 * blowhorn-ai/blowhorn is private, so its files need a GitHub token in
 * GITHUB_TOKEN or GH_TOKEN (for example `GITHUB_TOKEN=$(gh auth token)`).
 * The token is sent only to raw.githubusercontent.com and never printed.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOSTED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(HOSTED, "schemas", "vendor");

/**
 * Each vendored source: the repo, the pinned commit, the change that pins it,
 * the folder under hosted/schemas/vendor/ it lands in, and the files to start
 * from. Change a pin here, then run `make hosted-schemas-refresh`.
 */
export const SOURCES = [
  {
    repo: "blowhorn-ai/blowhorn",
    ref: "cd3dbf98121066fdc656078f40e886b129e3867a",
    sourcePr: "blowhorn-ai/blowhorn#1672",
    dir: "blowhorn",
    roots: ["schemas/dist/ErrorDefinition.schema.json"],
  },
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

/** The bytes of `file` in `repo` at `ref`, sent with the GitHub token when one is set. */
async function download(repo, ref, file) {
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${file}`;
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const res = await fetch(url, { redirect: "follow", headers: token ? { Authorization: `token ${token}` } : {} });
  if (res.status === 404 && !token) throw new Error(`${url}: HTTP 404; ${repo} may be private: set GITHUB_TOKEN (for example GITHUB_TOKEN=$(gh auth token))`);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Downloads one source into its folder and returns its SOURCES.json entry. */
async function refresh({ repo, ref, sourcePr, dir, roots }) {
  const queue = [...roots];
  const seen = new Set();
  const files = [];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.startsWith("..")) throw new Error(`${repo} ${file}: $ref leaves the repo`);
    const bytes = await download(repo, ref, file);
    const doc = JSON.parse(bytes.toString("utf8"));
    const dest = path.join(VENDOR, dir, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    files.push({ path: file, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
    process.stdout.write(`fetched ${repo} ${file}\n`);
    queue.push(...refTargets(doc, file));
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { repo, ref, sourcePr, dir, files };
}

async function main() {
  const sources = [];
  for (const source of SOURCES) sources.push(await refresh(source));
  fs.writeFileSync(path.join(VENDOR, "SOURCES.json"), JSON.stringify({ sources }, null, 2) + "\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`schemas-refresh: ${err.message}\n`);
    process.exit(1);
  });
}
