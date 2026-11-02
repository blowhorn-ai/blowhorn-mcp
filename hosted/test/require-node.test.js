// SPDX-License-Identifier: AGPL-3.0-only
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOSTED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(HOSTED, "scripts", "require-node.js");

function requireNode(args, nvmrcText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blowhorn-hosted-"));
  try {
    const extra = [];
    if (nvmrcText !== undefined) {
      const nvmrc = path.join(dir, ".nvmrc");
      fs.writeFileSync(nvmrc, nvmrcText);
      extra.push("--nvmrc", nvmrc);
    }
    return spawnSync(process.execPath, [SCRIPT, ...extra, ...args], { encoding: "utf8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the checked-in .nvmrc asks for Node 22, and Node 20 is refused with one sentence naming it", () => {
  const run = requireNode(["--node", "20.19.6"]);
  assert.strictEqual(run.status, 1);
  assert.strictEqual(run.stdout, "");
  assert.strictEqual(run.stderr, "hosted-require-node: wrangler needs Node 22 or later (hosted/.nvmrc), but this is Node 20.19.6.\n");
});

test("Node 22 and later pass, with no output", () => {
  for (const node of ["22.0.0", "22.12.0", "24.3.1", "v23.1.0"]) {
    const run = requireNode(["--node", node]);
    assert.strictEqual(run.status, 0, `${node}: ${run.stderr}`);
    assert.strictEqual(run.stderr, "", node);
    assert.strictEqual(run.stdout, "", node);
  }
});

test("the major comes from .nvmrc, not a constant", () => {
  assert.strictEqual(requireNode(["--node", "22.12.0"], "24\n").status, 1);
  assert.strictEqual(requireNode(["--node", "20.19.6"], "18\n").status, 0);
});

test("a malformed .nvmrc fails, whatever the Node version", () => {
  for (const text of ["", "\n", "lts/jod\n", "22.12.0\n", "v22\n", "abc"]) {
    const run = requireNode(["--node", "24.3.1"], text);
    assert.strictEqual(run.status, 1, JSON.stringify(text));
    assert.strictEqual(run.stderr, "hosted-require-node: hosted/.nvmrc must hold one Node major version, like 22.\n", JSON.stringify(text));
  }
});

test("a missing .nvmrc or an unreadable Node version fails with a named cause", () => {
  const missing = spawnSync(process.execPath, [SCRIPT, "--nvmrc", path.join(os.tmpdir(), "blowhorn-no-such-nvmrc"), "--node", "24.3.1"], { encoding: "utf8" });
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stderr, /^hosted-require-node: cannot read hosted\/\.nvmrc \(ENOENT\)\.\n$/);
  const bad = requireNode(["--node", "latest"]);
  assert.strictEqual(bad.status, 1);
  assert.strictEqual(bad.stderr, 'hosted-require-node: cannot read the Node version "latest".\n');
});

test("with no flags it checks the Node running it", () => {
  const run = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  if (Number(process.versions.node.split(".")[0]) >= 22) {
    assert.strictEqual(run.status, 0, run.stderr);
  } else {
    assert.strictEqual(run.status, 1);
    assert.strictEqual(run.stderr, `hosted-require-node: wrangler needs Node 22 or later (hosted/.nvmrc), but this is Node ${process.versions.node}.\n`);
  }
});
