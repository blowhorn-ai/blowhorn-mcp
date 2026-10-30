// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
/*
 * The launcher core the blowhorn-mcp and blowhorn-axi npm launchers share.
 * Its home is the public blowhorn-ai/blowhorn-mcp repo, where blowhorn-mcp's
 * bin requires it as ../lib/launcher-common.js and the npm tarball ships it
 * at that path. The private Blowhorn repo mounts this repo as a git submodule
 * at release/npm/blowhorn-mcp, and its blowhorn-axi launcher requires
 * release/npm/blowhorn-mcp/lib/launcher-common.js.
 *
 * The exported API below is stable: keep every export, its name, signature
 * and behavior exactly as they are. A change here also changes blowhorn-axi
 * once that repo bumps the submodule, so add rather than alter, and test both.
 * It requires nothing but Node's own modules.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const INSTALL_URL = "https://blowhorn.ai/download";

function q(value) {
  const s = String(value);
  return /^[A-Za-z0-9_.\/:@~+-]+$/.test(s) && s !== "" ? s : JSON.stringify(s);
}

/** A TOON record: `fields` as `[key, value]` pairs (an object value nests one level), then help[]. */
function toon(fields, helps) {
  const lines = [];
  for (const [key, value] of fields) {
    if (value && typeof value === "object") {
      lines.push(`${key}:`);
      for (const [k, v] of Object.entries(value)) lines.push(`  ${k}: ${q(v)}`);
    } else {
      lines.push(`${key}: ${q(value)}`);
    }
  }
  lines.push(`help[${helps.length}]:`);
  for (const h of helps) lines.push(`  ${h}`);
  return lines.join("\n") + "\n";
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function realpath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

/**
 * `<dir>/<name>` for each non-empty segment of `env.PATH`, in order. An empty
 * segment (`::`, a leading or trailing `:`) is skipped, never read as the
 * working directory.
 */
function pathCandidates(name, env = process.env) {
  return (env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name));
}

/** The first executable `<dir>/<name>` on `env.PATH` (empty segments skipped), or null. */
function findOnPath(name, env = process.env) {
  return pathCandidates(name, env).find(isExecutable) || null;
}

/**
 * The first of `candidates` that is an executable file and not an npm
 * launcher: never `selfFile` (the calling bin, through any symlink) and never
 * a node script, which is another copy of an npm launcher.
 */
function findInstalledLauncher(candidates, selfFile) {
  const me = realpath(selfFile);
  for (const file of candidates) {
    if (!isExecutable(file)) continue;
    const real = realpath(file);
    if (real === me) continue;
    try {
      const head = fs.readFileSync(real, { encoding: "utf8", flag: "r" }).slice(0, 200);
      if (/^#!.*\bnode\b/.test(head)) continue;
    } catch {}
    return file;
  }
  return null;
}

/**
 * Run `file` with `args` and this process's stdin, stdout and stderr, forward
 * SIGINT and SIGTERM to it, and exit with its exit code (1 when a signal
 * ended it). A child that cannot start calls `onError(err)`, then exits 1.
 */
function passthrough(file, args, { env = process.env, onError } = {}) {
  const child = spawn(file, args, { stdio: "inherit", env });
  child.on("error", (err) => {
    if (onError) onError(err);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
  return child;
}

module.exports = { INSTALL_URL, q, toon, isExecutable, realpath, pathCandidates, findOnPath, findInstalledLauncher, passthrough };
