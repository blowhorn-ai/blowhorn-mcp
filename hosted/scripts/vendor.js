// SPDX-License-Identifier: Apache-2.0
/*
 * Reads and checks hosted/schemas/vendor/, the schemas vendored byte for byte
 * at a pinned commit. SOURCES.json lists every vendored file with its sha256.
 * Offline. scripts/registry.js reads the vendored ErrorDefinition construct
 * through here; scripts/check-drift.js runs vendorProblems.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOSTED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const VENDOR = path.join(HOSTED, "schemas", "vendor");

export class VendorError extends Error {}

/** hosted/schemas/vendor/SOURCES.json: `{ sources: [{ repo, ref, sourcePr, dir, files }] }`, one entry per pinned repo. */
export function readSources(vendor = VENDOR) {
  return JSON.parse(fs.readFileSync(path.join(vendor, "SOURCES.json"), "utf8"));
}

/** The SOURCES.json entry whose files live in `dir`; a VendorError when there is none. */
export function source(sources, dir) {
  const found = sources.sources.find((s) => s.dir === dir);
  if (!found) throw new VendorError(`SOURCES.json: no source with dir ${dir}`);
  return found;
}

/** The absolute path of `file`, vendored from the source in `dir`. */
export function vendored(dir, file, vendor = VENDOR) {
  return path.join(vendor, source(readSources(vendor), dir).dir, file);
}

/** Every file under `dir`, as forward-slash paths relative to it. */
function walk(dir, rel = "") {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const name = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? walk(path.join(dir, e.name), name) : [name];
  });
}

/**
 * Problem strings for vendored files whose bytes differ from SOURCES.json's
 * sha256, that SOURCES.json does not list, or that sit outside every
 * source's folder; [] when all match.
 */
export function vendorProblems(vendor = VENDOR) {
  const { sources } = readSources(vendor);
  const problems = [];
  const dirs = new Set(sources.map((s) => s.dir));
  for (const entry of fs.readdirSync(vendor)) {
    if (entry !== "SOURCES.json" && !dirs.has(entry)) problems.push(`  ${entry}: not a source folder in SOURCES.json`);
  }
  for (const { dir, files } of sources) {
    const listed = new Set(files.map((f) => f.path));
    for (const file of walk(path.join(vendor, dir))) {
      if (!listed.has(file)) problems.push(`  ${dir}/${file}: not listed in SOURCES.json`);
    }
    for (const { path: file, sha256 } of files) {
      const full = path.join(vendor, dir, file);
      if (!fs.existsSync(full)) {
        problems.push(`  ${dir}/${file}: missing`);
        continue;
      }
      const have = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      if (have !== sha256) problems.push(`  ${dir}/${file}: sha256 ${have}, SOURCES.json says ${sha256}`);
    }
  }
  return problems;
}
