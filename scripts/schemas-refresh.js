#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
/*
 * `make schemas-refresh`: downloads every schema listed in
 * schemas/vendor/SOURCES.json from its upstream URL, writes the bytes as
 * served (never reformatted) and rewrites SOURCES.json with their sha256.
 * The only script here that touches the network; review the diff, then run
 * make check.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const VENDOR = path.join(__dirname, "..", "schemas", "vendor");
const SOURCES = path.join(VENDOR, "SOURCES.json");

async function main() {
  const sources = JSON.parse(fs.readFileSync(SOURCES, "utf8"));
  for (const entry of sources.files) {
    const res = await fetch(entry.url, { redirect: "follow" });
    if (!res.ok) throw new Error(`${entry.url}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    JSON.parse(bytes.toString("utf8"));
    fs.writeFileSync(path.join(VENDOR, entry.file), bytes);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    process.stdout.write(`${sha256 === entry.sha256 ? "unchanged" : "updated  "} ${entry.file}\n`);
    entry.sha256 = sha256;
  }
  fs.writeFileSync(SOURCES, JSON.stringify(sources, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`schemas-refresh: ${err.message}\n`);
  process.exit(1);
});
