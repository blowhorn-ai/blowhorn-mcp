#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/*
 * `make hosted-require-node`: exits nonzero, with one sentence, unless this
 * Node's major is at least the one in hosted/.nvmrc, which is what the
 * locked wrangler needs. Every target that runs wrangler depends on it.
 *
 * The tests point it at another .nvmrc and Node version:
 *   node scripts/require-node.js [--nvmrc <path>] [--node <X.Y.Z>]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NVMRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".nvmrc");

function fail(message) {
  process.stderr.write(`hosted-require-node: ${message}\n`);
  process.exit(1);
}

function option(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  if (value === undefined) fail(`${name} needs a value.`);
  return value;
}

const nvmrc = option("--nvmrc", NVMRC);
const have = option("--node", process.versions.node);

let text;
try {
  text = fs.readFileSync(nvmrc, "utf8");
} catch (err) {
  fail(`cannot read hosted/.nvmrc (${err.code ?? err.message}).`);
}
const wantText = text.trim();
if (!/^[1-9][0-9]*$/.test(wantText)) fail("hosted/.nvmrc must hold one Node major version, like 22.");
const want = Number(wantText);

const haveMajor = /^v?([0-9]+)\./.exec(have);
if (!haveMajor) fail(`cannot read the Node version "${have}".`);
if (Number(haveMajor[1]) < want) fail(`wrangler needs Node ${want} or later (hosted/.nvmrc), but this is Node ${have.replace(/^v/, "")}.`);
