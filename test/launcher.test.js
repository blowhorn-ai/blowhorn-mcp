// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const L = require("../bin/blowhorn-mcp.js");

const BIN = path.join(__dirname, "..", "bin", "blowhorn-mcp.js");

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcp-npm-"));
}

function write(file, text, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
  return file;
}

/** A stand-in interpreter: prints its argv and the two variables the launcher sets, echoes stdin, exits 5. */
function stubPython(file) {
  return write(file, '#!/bin/sh\necho "argv:$*"\necho "PYTHONPATH:$PYTHONPATH"\necho "BLOWHORN_MCP_CLI:${BLOWHORN_MCP_CLI-unset}"\ncat\nexit 5\n', 0o755);
}

/** An engine tree holding the MCP server module. */
function engineTree(root) {
  write(path.join(root, "engine", "blowhorn", "mcp_server", "__main__.py"), "");
  return root;
}

/** engine.json as the app writes it, naming `checkout` and `python`. */
function engineRecord(home, record) {
  write(path.join(home, "Library", "Application Support", "Blowhorn", "engine.json"), JSON.stringify(record));
}

function appBundle(appsDir) {
  const engine = path.join(appsDir, "Blowhorn.app", "Contents", "Resources", "engine");
  stubPython(path.join(engine, "bin", "python"));
  engineTree(engine);
  return engine;
}

/** A PATH that holds no blowhorn command, so the box's own PATH cannot leak in. */
const NO_BLOWHORN_PATH = "/usr/bin:/bin";
assert.ok(!["/usr/bin", "/bin"].some((dir) => fs.existsSync(path.join(dir, "blowhorn"))), "this box has a blowhorn in /usr/bin or /bin");

/** A PATH whose first directory holds an executable `blowhorn`. */
function pathWithBlowhorn() {
  const dir = scratch();
  write(path.join(dir, "blowhorn"), "#!/bin/sh\n", 0o755);
  return `${dir}:${NO_BLOWHORN_PATH}`;
}

function run(args, env, input) {
  return spawnSync(process.execPath, [BIN, ...args], { env: { PATH: NO_BLOWHORN_PATH, ...env }, input, encoding: "utf8" });
}

/** Run what resolveServer chose, the way the launcher would, and capture it. */
function execute(server, input = "") {
  return spawnSync(server.file, server.args, { env: server.env, input, encoding: "utf8" });
}

test("no Blowhorn app: a TOON error with install help naming every place looked, nothing resolved to run", () => {
  const [system, user] = [scratch(), scratch()];
  const server = L.resolveServer([], { env: {}, home: scratch(), applicationsDirs: [system, user] });
  assert.strictEqual(server.file, undefined);
  assert.match(server.error, /^error:\n  code: blowhorn_missing\n/);
  assert.ok(server.error.includes(`${system}/Blowhorn.app or ${user}/Blowhorn.app`), server.error);
  assert.match(server.error, /help\[3\]:\n  Install Blowhorn from https:\/\/blowhorn.ai\/download\n  Open Blowhorn once/);
});

test("no Blowhorn app: the launcher writes its error to stderr only and exits 1", { skip: fs.existsSync("/Applications/Blowhorn.app") && "this machine has /Applications/Blowhorn.app" }, () => {
  const r = run(["--list-tools"], { HOME: scratch() });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout, "");
  assert.match(r.stderr, /code: blowhorn_missing/);
});

test("an app without the MCP server says update or reinstall, naming the bundle found", () => {
  const apps = scratch();
  fs.mkdirSync(path.join(apps, "Blowhorn.app", "Contents", "Resources", "engine", "engine"), { recursive: true });
  const server = L.resolveServer([], { env: {}, home: scratch(), applicationsDirs: [scratch(), apps] });
  assert.match(server.error, /code: blowhorn_mcp_server_missing/);
  assert.ok(server.error.includes(`found ${apps}/Blowhorn.app but`), server.error);
  assert.match(server.error, /Update or reinstall Blowhorn from https:\/\/blowhorn.ai\/download/);
});

test("delegates argv, stdin, stdout and the exit code to the app's blowhorn-mcp launcher", () => {
  const home = scratch();
  write(path.join(home, ".local", "bin", "blowhorn-mcp"), '#!/bin/sh\necho "args:$*"\ncat\nexit 3\n', 0o755);
  const r = run(["--list-tools", "--verbose"], { HOME: home }, '{"jsonrpc":"2.0"}\n');
  assert.strictEqual(r.status, 3);
  assert.strictEqual(r.stdout, 'args:--list-tools --verbose\n{"jsonrpc":"2.0"}\n');
  assert.strictEqual(r.stderr, "");
});

test("engine.json: runs the recorded python with -P -m blowhorn.mcp_server, PYTHONPATH and BLOWHORN_MCP_CLI", () => {
  const home = scratch();
  const checkout = engineTree(scratch());
  const python = stubPython(path.join(checkout, "venv", "bin", "python"));
  engineRecord(home, { version: 1, checkout, python });
  const cli = write(path.join(home, ".local", "bin", "blowhorn"), "#!/bin/sh\n", 0o755);
  const r = run(["--version"], { HOME: home, PYTHONPATH: "/elsewhere" }, "ping\n");
  assert.strictEqual(r.status, 5);
  assert.strictEqual(r.stdout, `argv:-P -m blowhorn.mcp_server --version\nPYTHONPATH:${checkout}/engine:/elsewhere\nBLOWHORN_MCP_CLI:${cli}\nping\n`);
  assert.strictEqual(r.stderr, "");
});

test("engine.json: a BLOWHORN_MCP_CLI the user set is kept", () => {
  const home = scratch();
  const checkout = engineTree(scratch());
  engineRecord(home, { checkout, python: stubPython(path.join(checkout, "python")) });
  write(path.join(home, ".local", "bin", "blowhorn"), "#!/bin/sh\n", 0o755);
  const r = run([], { HOME: home, BLOWHORN_MCP_CLI: "/opt/mine/blowhorn" });
  assert.match(r.stdout, /^argv:-P -m blowhorn.mcp_server\nPYTHONPATH:.*\nBLOWHORN_MCP_CLI:\/opt\/mine\/blowhorn\n/);
});

test("engine.json: blowhorn on PATH starts the server and leaves BLOWHORN_MCP_CLI unset", () => {
  const home = scratch();
  const checkout = engineTree(scratch());
  engineRecord(home, { checkout, python: stubPython(path.join(checkout, "python")) });
  const r = run([], { HOME: home, PATH: pathWithBlowhorn() });
  assert.strictEqual(r.status, 5);
  assert.match(r.stdout, /\nBLOWHORN_MCP_CLI:unset\n/);
});

test("engine.json: the checkout's tools/bin/blowhorn.sh starts the server and leaves BLOWHORN_MCP_CLI unset", () => {
  const home = scratch();
  const checkout = engineTree(scratch());
  write(path.join(checkout, "tools", "bin", "blowhorn.sh"), "#!/bin/sh\n", 0o755);
  engineRecord(home, { checkout, python: stubPython(path.join(checkout, "python")) });
  const r = run([], { HOME: home });
  assert.strictEqual(r.status, 5);
  assert.match(r.stdout, /\nBLOWHORN_MCP_CLI:unset\n/);
});

test("/Applications: the app's own engine when engine.json is missing or unusable", () => {
  const apps = scratch();
  const engine = appBundle(apps);
  const env = { PATH: pathWithBlowhorn() };
  for (const record of [null, { checkout: "/nowhere", python: "/nowhere/python" }, { checkout: scratch() }]) {
    const home = scratch();
    if (record) engineRecord(home, record);
    const server = L.resolveServer(["--list-tools"], { env, home, applicationsDirs: [apps] });
    assert.strictEqual(server.file, path.join(engine, "bin", "python"));
    const r = execute(server);
    assert.strictEqual(r.status, 5);
    assert.strictEqual(r.stdout, `argv:-P -m blowhorn.mcp_server --list-tools\nPYTHONPATH:${engine}/engine\nBLOWHORN_MCP_CLI:unset\n`);
  }
});

test("~/Applications: found when /Applications has no Blowhorn.app", () => {
  const home = scratch();
  const engine = appBundle(path.join(home, "Applications"));
  const server = L.resolveServer([], { env: { PATH: pathWithBlowhorn() }, home, applicationsDirs: [scratch(), path.join(home, "Applications")] });
  assert.strictEqual(server.file, path.join(engine, "bin", "python"));
});

test("/Applications wins when both it and ~/Applications have a Blowhorn.app", () => {
  const home = scratch();
  const system = scratch();
  const engine = appBundle(system);
  appBundle(path.join(home, "Applications"));
  const server = L.resolveServer([], { env: { PATH: pathWithBlowhorn() }, home, applicationsDirs: [system, path.join(home, "Applications")] });
  assert.strictEqual(server.file, path.join(engine, "bin", "python"));
});

test("setup incomplete: the bundle's engine but no blowhorn command anywhere refuses before the server starts", () => {
  const apps = scratch();
  appBundle(apps);
  const home = scratch();
  const server = L.resolveServer([], { env: { PATH: NO_BLOWHORN_PATH }, home, applicationsDirs: [apps] });
  assert.strictEqual(server.file, undefined);
  assert.match(server.error, /^error:\n  code: blowhorn_setup_incomplete\n  detail: .*BLOWHORN_MCP_CLI is unset.*\.local\/bin\/blowhorn.*blowhorn on PATH.*tools\/bin\/blowhorn\.sh/);
  assert.match(server.error, /\nhelp\[2\]:\n  Open Blowhorn once so it can finish setup\n  Then start your MCP client again\n$/);
});

test("setup incomplete: the launcher writes the error to stderr only, exits 1 and never starts the server", { skip: fs.existsSync("/Applications/Blowhorn.app") && "this machine has /Applications/Blowhorn.app" }, () => {
  const home = scratch();
  const engine = path.join(home, "Applications", "Blowhorn.app", "Contents", "Resources", "engine");
  const marker = path.join(home, "server-started");
  write(path.join(engine, "bin", "python"), `#!/bin/sh\ntouch ${marker}\n`, 0o755);
  engineTree(engine);
  // The bundle is in HOME's ~/Applications, the second place the launcher looks.
  const r = run(["--list-tools"], { HOME: home });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout, "");
  assert.match(r.stderr, /code: blowhorn_setup_incomplete/);
  assert.match(r.stderr, /Open Blowhorn once so it can finish setup/);
  assert.ok(!fs.existsSync(marker), "the server was started");
});

test("an empty PATH segment never finds ./blowhorn in the MCP client's working directory", { skip: fs.existsSync("/Applications/Blowhorn.app") && "this machine has /Applications/Blowhorn.app" }, () => {
  const home = scratch();
  const marker = path.join(home, "server-started");
  const engine = path.join(home, "Applications", "Blowhorn.app", "Contents", "Resources", "engine");
  write(path.join(engine, "bin", "python"), `#!/bin/sh\ntouch ${marker}\n`, 0o755);
  engineTree(engine);
  const client = scratch();
  write(path.join(client, "blowhorn"), "#!/bin/sh\n", 0o755);
  for (const PATH of [`::${NO_BLOWHORN_PATH}`, `${NO_BLOWHORN_PATH}:`, `:${NO_BLOWHORN_PATH}`, `/usr/bin::/bin`]) {
    const r = spawnSync(process.execPath, [BIN, "--list-tools"], { cwd: client, env: { PATH, HOME: home }, encoding: "utf8" });
    assert.strictEqual(r.status, 1, `PATH=${PATH}: ${r.stderr}`);
    assert.match(r.stderr, /code: blowhorn_setup_incomplete/);
    assert.ok(!fs.existsSync(marker), `PATH=${PATH}: the server was started`);
  }
});

test("setup incomplete is not reported when the user set BLOWHORN_MCP_CLI: it is trusted as given", () => {
  const apps = scratch();
  const engine = appBundle(apps);
  const server = L.resolveServer([], { env: { PATH: NO_BLOWHORN_PATH, BLOWHORN_MCP_CLI: "/opt/mine/blowhorn" }, home: scratch(), applicationsDirs: [apps] });
  assert.strictEqual(server.file, path.join(engine, "bin", "python"));
  const r = execute(server);
  assert.strictEqual(r.status, 5);
  assert.match(r.stdout, /\nBLOWHORN_MCP_CLI:\/opt\/mine\/blowhorn\n/);
});

test("never runs itself, or any node script, as the app's launcher", () => {
  const home = scratch();
  const bin = path.join(home, ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(BIN, path.join(bin, "blowhorn-mcp"));
  const checkout = engineTree(scratch());
  engineRecord(home, { checkout, python: stubPython(path.join(checkout, "python")) });
  const r = run(["--list-tools"], { HOME: home, PATH: pathWithBlowhorn() });
  assert.strictEqual(r.status, 5);
  assert.match(r.stdout, /^argv:-P -m blowhorn.mcp_server --list-tools\n/);

  const other = scratch();
  write(path.join(other, ".local", "bin", "blowhorn-mcp"), "#!/usr/bin/env node\nprocess.stdout.write('npm copy');\n", 0o755);
  const server = L.resolveServer([], { env: {}, home: other, applicationsDirs: [scratch()] });
  assert.match(server.error, /code: blowhorn_missing/);
});

/** A real Python 3.11+ (the floor for -P) on the caller's PATH, or null. */
function realPython() {
  const r = spawnSync("python3", ["-c", "import sys; print(sys.executable if sys.version_info >= (3, 11) else '')"], { encoding: "utf8" });
  const exe = r.status === 0 && r.stdout.trim();
  return exe || null;
}

test("the MCP client's working directory is not on the server's import path", { skip: !realPython() && "no python3 >= 3.11 on PATH" }, () => {
  const home = scratch();
  const checkout = scratch();
  write(
    path.join(checkout, "engine", "blowhorn", "mcp_server", "__main__.py"),
    "import json, os, sys\nprint(json.dumps({'cwd_on_path': os.getcwd() in sys.path or '' in sys.path}))\n",
  );
  write(path.join(checkout, "tools", "bin", "blowhorn.sh"), "#!/bin/sh\n", 0o755);
  const python = path.join(checkout, "python");
  fs.symlinkSync(realPython(), python);
  engineRecord(home, { checkout, python });
  const client = scratch();
  write(path.join(client, "json.py"), "raise SystemExit('shadowed: the client folder was imported')\n");
  write(path.join(client, "blowhorn", "__init__.py"), "raise SystemExit('shadowed: the client blowhorn package was imported')\n");
  const r = spawnSync(process.execPath, [BIN], { cwd: client, env: { PATH: "/usr/bin:/bin", HOME: home }, encoding: "utf8" });
  assert.strictEqual(r.stderr, "");
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '{"cwd_on_path": false}\n');
});

test("--launcher-version prints the package version", () => {
  const r = run(["--launcher-version"], { HOME: scratch() });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, `${require("../package.json").version}\n`);
});

test("runs from the published tarball's layout: bin/ beside lib/launcher-common.js and package.json", () => {
  const pkg = scratch();
  for (const file of ["package.json", "bin/blowhorn-mcp.js", "lib/launcher-common.js"]) {
    write(path.join(pkg, file), fs.readFileSync(path.join(__dirname, "..", file)), file.startsWith("bin/") ? 0o755 : 0o644);
  }
  const r = spawnSync(process.execPath, [path.join(pkg, "bin", "blowhorn-mcp.js"), "--launcher-version"], { env: { PATH: NO_BLOWHORN_PATH, HOME: scratch() }, encoding: "utf8" });
  assert.strictEqual(r.stderr, "");
  assert.strictEqual(r.stdout, `${require("../package.json").version}\n`);
});
