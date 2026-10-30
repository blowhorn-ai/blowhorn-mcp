#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
/*
 * The npm launcher for blowhorn-mcp. The MCP server itself is the Python
 * `blowhorn.mcp_server` module that ships inside the Blowhorn app; this
 * launcher finds it and runs it over stdio, handing every argument, stdin,
 * stdout and the exit code straight through.
 *
 * Where it looks, first match wins:
 *   1. ~/.local/bin/blowhorn-mcp, the launcher the app writes (never this
 *      npm launcher, never a node script);
 *   2. the engine the app recorded in ~/Library/Application Support/Blowhorn/engine.json
 *      (its `python`, with PYTHONPATH <checkout>/engine);
 *   3. the app bundle's own engine: /Applications/Blowhorn.app, then
 *      ~/Applications/Blowhorn.app (the order the app-written shim uses).
 *
 * Routes 2 and 3 run `python -P -m`: plain `-m` puts the MCP client's working
 * directory first on sys.path, so a json.py or blowhorn/ in that folder would
 * shadow the server's own modules. -P needs Python 3.11; the engine's floor is 3.14.
 *
 * Routes 2 and 3 also need the `blowhorn` command every tool call runs. The
 * launcher resolves it the way the server's default_cli does
 * (engine/blowhorn/mcp_server/__main__.py), with ~/.local/bin/blowhorn second,
 * since a GUI MCP client's PATH lacks ~/.local/bin: BLOWHORN_MCP_CLI as given,
 * ~/.local/bin/blowhorn (set as BLOWHORN_MCP_CLI), `blowhorn` on PATH, then
 * the engine's checkout wrapper tools/bin/blowhorn.sh. When none resolves, as
 * on a Mac where the app was never opened, it refuses before the server starts.
 *
 * stdout belongs to the server's JSON-RPC: this launcher writes there only
 * for `--launcher-version`. Its own errors go to stderr as TOON, exit 1.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The shared launcher core, which the private repo's blowhorn-axi launcher uses too.
const { INSTALL_URL, toon, isExecutable, realpath, findOnPath, findInstalledLauncher, passthrough } = require("../lib/launcher-common.js");

const PKG = require("../package.json");
const SERVER_MODULE = "blowhorn.mcp_server";

/** The interpreter and PYTHONPATH of an engine that holds the MCP server, or null. */
function engineAt(python, pythonPath) {
  if (!isExecutable(python)) return null;
  if (!fs.existsSync(path.join(pythonPath, "blowhorn", "mcp_server", "__main__.py"))) return null;
  return { python, pythonPath };
}

/**
 * The engine the app recorded in engine.json (`checkout` and `python`), or null when it cannot be used.
 * A second reader of the record beside the app's own engine-record.sh; the app's engine-record.ts names both.
 */
function recordedEngine(home) {
  const record = path.join(home, "Library", "Application Support", "Blowhorn", "engine.json");
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(record, "utf8"));
  } catch {
    return null;
  }
  if (!doc || typeof doc.checkout !== "string" || typeof doc.python !== "string" || !doc.checkout || !doc.python) return null;
  return engineAt(doc.python, path.join(doc.checkout, "engine"));
}

/** The first Blowhorn.app under `applicationsDirs`, in order, or null. */
function findBundle(applicationsDirs) {
  for (const dir of applicationsDirs) {
    const bundle = path.join(dir, "Blowhorn.app");
    if (fs.existsSync(bundle)) return bundle;
  }
  return null;
}

/**
 * The server's environment, or `{ error }` when no `blowhorn` command resolves
 * for it. Mirrors default_cli in engine/blowhorn/mcp_server/__main__.py, plus
 * ~/.local/bin/blowhorn, which it sets as BLOWHORN_MCP_CLI when that is unset.
 */
function serverEnv(env, pythonPath, home) {
  const out = { ...env, PYTHONPATH: env.PYTHONPATH ? `${pythonPath}${path.delimiter}${env.PYTHONPATH}` : pythonPath };
  if (out.BLOWHORN_MCP_CLI) return { env: out };
  const cli = path.join(home, ".local", "bin", "blowhorn");
  if (isExecutable(cli)) return { env: { ...out, BLOWHORN_MCP_CLI: cli } };
  if (findOnPath("blowhorn", out)) return { env: out };
  // default_cli's checkout wrapper: Path(__file__).resolve().parents[3] / "tools/bin/blowhorn.sh".
  const main = realpath(path.join(pythonPath, "blowhorn", "mcp_server", "__main__.py"));
  const wrapper = path.join(path.dirname(path.dirname(path.dirname(path.dirname(main)))), "tools", "bin", "blowhorn.sh");
  if (fs.existsSync(wrapper)) return { env: out };
  return {
    error: toon(
      [["error", { code: "blowhorn_setup_incomplete", detail: `no blowhorn command found: BLOWHORN_MCP_CLI is unset, and neither ${cli}, blowhorn on PATH nor ${wrapper} exists` }]],
      ["Open Blowhorn once so it can finish setup", "Then start your MCP client again"],
    ),
  };
}

/**
 * What to run for `argv`: `{ file, args, env }`, or `{ error }` (a TOON
 * record for stderr) when no Blowhorn app is found, the one found cannot
 * serve, or its setup has not finished. The roots are parameters so a test
 * can point them anywhere.
 */
function resolveServer(argv, { env = process.env, home = os.homedir(), applicationsDirs = ["/Applications", path.join(home, "Applications")], self = __filename } = {}) {
  const shim = findInstalledLauncher([path.join(home, ".local", "bin", "blowhorn-mcp")], self);
  if (shim) return { file: shim, args: argv, env };
  const bundle = findBundle(applicationsDirs);
  const engineDir = bundle && path.join(bundle, "Contents", "Resources", "engine");
  const engine = recordedEngine(home) || (bundle && engineAt(path.join(engineDir, "bin", "python"), path.join(engineDir, "engine")));
  if (engine) {
    const server = serverEnv(env, engine.pythonPath, home);
    if (server.error) return server;
    return { file: engine.python, args: ["-P", "-m", SERVER_MODULE, ...argv], env: server.env };
  }
  if (bundle) {
    return {
      error: toon(
        [["error", { code: "blowhorn_mcp_server_missing", detail: `found ${bundle} but not the MCP server inside it; this Blowhorn is damaged or predates the MCP server` }]],
        [`Update or reinstall Blowhorn from ${INSTALL_URL}`, "Then open Blowhorn once and start your MCP client again"],
      ),
    };
  }
  const looked = applicationsDirs.map((dir) => path.join(dir, "Blowhorn.app")).join(" or ");
  return {
    error: toon(
      [["error", { code: "blowhorn_missing", detail: `the Blowhorn app was not found (${looked}); blowhorn-mcp runs the MCP server inside it` }]],
      [`Install Blowhorn from ${INSTALL_URL}`, "Open Blowhorn once so it finishes setting up", "Then start your MCP client again"],
    ),
  };
}

function main(argv) {
  if (argv[0] === "--launcher-version") {
    process.stdout.write(`${PKG.version}\n`);
    return;
  }
  const server = resolveServer(argv);
  if (server.error) {
    process.stderr.write(server.error);
    process.exit(1);
  }
  passthrough(server.file, server.args, {
    env: server.env,
    onError: (err) => process.stderr.write(toon([["error", { code: "launch_failed", detail: `${server.file}: ${err.message}` }]], [`Update or reinstall Blowhorn from ${INSTALL_URL}`])),
  });
}

module.exports = { resolveServer };

if (require.main === module) main(process.argv.slice(2));
