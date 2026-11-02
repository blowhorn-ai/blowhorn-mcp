// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Builds the gateway's tool catalog from the vendored meshery/schemas
 * OpenAPI files. Offline and deterministic: scripts/generate.js writes what
 * this returns, scripts/check-drift.js compares it with the checked-in file.
 *
 * Every operation whose x-mcp says expose: true becomes one tool. It must be
 * a GET with an operationId, and its x-mcp must pass the vendored McpOperation
 * schema; anything else is a CatalogError, so a schema change that exposes a
 * write can never slip into this read-only gateway.
 *
 * The catalog also carries an `events` entry: the createEvent path, which must
 * be a POST, and the three schemas the gateway records each tool call with
 * (the createEvent body, the Event fields it persists beyond that body, and
 * MeshkitError), inlined the same way. A missing operation or schema is a
 * CatalogError. src/events.js composes them.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Validator } from "@cfworker/json-schema";
import { load } from "js-yaml";

export const HOSTED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const VENDOR = path.join(HOSTED, "schemas", "vendor");
export const CATALOG = path.join(HOSTED, "src", "catalog.generated.json");
export const EVENT_API = "schemas/constructs/v1beta3/event/api.yml";
export const ERROR_API = "schemas/constructs/v1beta2/core/api.yml";
export const API_FILES = [
  "schemas/constructs/v1beta3/content_item/api.yml",
  EVENT_API,
  "schemas/constructs/v1beta3/connection/api.yml",
];
const MCP_OPERATION = "schemas/extensions/mcp-operation.yaml";
/** The SOURCES.json folder the catalog is built from. */
export const MESHERY = "meshery-schemas";
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/** The header the Cloud API reads the organization from, and the tool argument that carries it. */
export const ORG_HEADER = "X-Current-Orgid";
export const ORG_ARGUMENT = "organizationId";

/** Default bounds for a parameter schema that sets none, so no argument can grow without limit. */
export const DEFAULT_MAX_ITEMS = 50;
export const DEFAULT_MAX_LENGTH = 1000;
export const DEFAULT_MAXIMUM = 1000000;

export const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export class CatalogError extends Error {}

/** hosted/schemas/vendor/SOURCES.json: `{ sources: [{ repo, ref, sourcePr, dir, files }] }`, one entry per pinned repo. */
export function readSources(vendor = VENDOR) {
  return JSON.parse(fs.readFileSync(path.join(vendor, "SOURCES.json"), "utf8"));
}

/** The SOURCES.json entry whose files live in `dir`; a CatalogError when there is none. */
export function source(sources, dir) {
  const found = sources.sources.find((s) => s.dir === dir);
  if (!found) throw new CatalogError(`SOURCES.json: no source with dir ${dir}`);
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

/** Loads YAML files once each, keyed by absolute path. */
function loader() {
  const docs = new Map();
  return (file) => {
    if (!docs.has(file)) {
      if (!fs.existsSync(file)) throw new CatalogError(`${file}: $ref target file does not exist`);
      docs.set(file, load(fs.readFileSync(file, "utf8")));
    }
    return docs.get(file);
  };
}

function pointer(doc, fragment, where) {
  let node = doc;
  if (!fragment) return node;
  if (!fragment.startsWith("/")) throw new CatalogError(`${where}: only JSON pointer fragments are supported`);
  for (const raw of fragment.slice(1).split("/")) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!node || typeof node !== "object" || !Object.prototype.hasOwnProperty.call(node, key)) {
      throw new CatalogError(`${where}: unresolvable $ref`);
    }
    node = node[key];
  }
  return node;
}

/**
 * `node` from `file` with every $ref, local or cross-file, replaced by its
 * target, and every x- key dropped. A ref cycle or a missing target is a
 * CatalogError.
 */
function inline(node, file, load, stack = []) {
  if (Array.isArray(node)) return node.map((item) => inline(item, file, load, stack));
  if (!node || typeof node !== "object") return node;
  if (typeof node.$ref === "string") {
    const [target, fragment = ""] = node.$ref.split("#");
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) throw new CatalogError(`${file}: remote $ref ${node.$ref} is not allowed`);
    const targetFile = target ? path.resolve(path.dirname(file), target) : file;
    const key = `${targetFile}#${fragment}`;
    if (stack.includes(key)) throw new CatalogError(`${file}: $ref cycle at ${node.$ref}`);
    const resolved = inline(pointer(load(targetFile), fragment, `${file}: ${node.$ref}`), targetFile, load, [...stack, key]);
    const { $ref, ...siblings } = node;
    return { ...resolved, ...inline(siblings, file, load, stack) };
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("x-")) continue;
    out[k] = inline(v, file, load, stack);
  }
  return out;
}

/** A copy of `value` with every object's keys sorted, so the output never depends on YAML order. */
export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
  return out;
}

/** A copy of parameter schema `s` with default bounds where it sets none: maxItems, maxLength, maximum. */
function bounded(s) {
  const out = { ...s };
  if (out.type === "array") {
    if (out.maxItems === undefined) out.maxItems = DEFAULT_MAX_ITEMS;
    if (out.items && typeof out.items === "object") out.items = bounded(out.items);
  } else if (out.type === "string") {
    if (out.maxLength === undefined && out.enum === undefined && out.format === undefined && out.pattern === undefined) out.maxLength = DEFAULT_MAX_LENGTH;
  } else if (out.type === "integer" || out.type === "number") {
    if (out.maximum === undefined && out.exclusiveMaximum === undefined) out.maximum = DEFAULT_MAXIMUM;
  }
  return out;
}

function text(s) {
  return typeof s === "string" ? s.trim() : "";
}

/** The tool for one exposed operation. */
function tool(op, method, route, pathItem, file, load) {
  const where = `${path.basename(path.dirname(file))}/${path.basename(file)} ${method.toUpperCase()} ${route}`;
  if (!op.operationId) throw new CatalogError(`${where}: exposed operation has no operationId`);
  if (method !== "get") throw new CatalogError(`${where} (${op.operationId}): exposed operation is not a GET; this gateway is read-only`);
  const xmcp = op["x-mcp"];

  const params = [...(pathItem.parameters || []), ...(op.parameters || [])].map((p) => inline(p, file, load));
  const byLocation = new Map();
  for (const p of params) byLocation.set(`${p.in}:${p.name}`, p); // operation-level overrides path-level
  const properties = {};
  const required = [];
  const wire = {};
  for (const p of byLocation.values()) {
    let arg = p.name;
    if (p.in === "header") {
      if (p.name.toLowerCase() !== ORG_HEADER.toLowerCase()) throw new CatalogError(`${where}: header parameter ${p.name} is not supported`);
      arg = ORG_ARGUMENT;
    } else if (p.in !== "path" && p.in !== "query") {
      throw new CatalogError(`${where}: ${p.in} parameter ${p.name} is not supported`);
    }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(arg)) throw new CatalogError(`${where}: parameter name ${arg} is not a plain identifier`);
    if (properties[arg]) throw new CatalogError(`${where}: two parameters map to the argument ${arg}`);
    if (!p.schema || typeof p.schema !== "object") throw new CatalogError(`${where}: parameter ${p.name} has no schema`);
    const schema = { ...p.schema };
    if (p.in === "header") schema.type = "string";
    if (text(p.description)) schema.description = text(p.description);
    if (p.deprecated) schema.deprecated = true;
    properties[arg] = bounded(schema);
    wire[arg] = { in: p.in, name: p.name };
    if (p.in === "path" || p.required) required.push(arg);
  }

  const templated = [...route.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  for (const name of templated) {
    if (!(wire[name] && wire[name].in === "path")) throw new CatalogError(`${where}: path parameter {${name}} is not declared`);
  }
  for (const [arg, w] of Object.entries(wire)) {
    if (w.in === "path" && !templated.includes(w.name)) throw new CatalogError(`${where}: path parameter ${arg} is not in the path`);
  }

  const inputSchema = { type: "object", properties, additionalProperties: false };
  if (required.length) inputSchema.required = required.sort();
  return {
    name: op.operationId,
    title: text(xmcp.title) || text(op.summary) || op.operationId,
    description: text(op.description) || text(op.summary) || op.operationId,
    scope: xmcp.scope,
    method: "GET",
    path: route,
    inputSchema,
    wire,
    annotations: { ...ANNOTATIONS },
  };
}

/**
 * The named component schema `name` of the vendored file `rel`, with every $ref
 * inlined and every x- key dropped. A CatalogError when the file has no such
 * component.
 */
function component(root, rel, name, load) {
  const file = path.resolve(root, rel);
  const schema = load(file)?.components?.schemas?.[name];
  if (!schema || typeof schema !== "object") throw new CatalogError(`${rel}: components.schemas.${name} is missing`);
  return inline(schema, file, load);
}

/** The path of the createEvent operation. A CatalogError when it is missing or not a POST. */
function createEventPath(root, load) {
  const doc = load(path.resolve(root, EVENT_API));
  for (const [route, pathItem] of Object.entries(doc.paths || {})) {
    for (const method of METHODS) {
      if (pathItem[method]?.operationId !== "createEvent") continue;
      if (method !== "post") throw new CatalogError(`${EVENT_API} ${method.toUpperCase()} ${route} (createEvent): is not a POST`);
      return route;
    }
  }
  throw new CatalogError(`${EVENT_API}: createEvent operation is missing`);
}

/**
 * The event schemas: `path` is where createEvent is posted, `payload` is its
 * body, `event` keeps only the Event properties createEvent persists that the
 * body leaves open, and `error` is MeshkitError, the shape of metadata.error.
 */
function eventSchemas(root, load) {
  const persisted = component(root, EVENT_API, "Event", load).properties ?? {};
  const event = { properties: {} };
  for (const key of ["severity", "operationId", "metadata"]) {
    if (!persisted[key]) throw new CatalogError(`${EVENT_API}: Event has no ${key} property`);
    event.properties[key] = persisted[key];
  }
  return {
    path: createEventPath(root, load),
    payload: component(root, EVENT_API, "EventPayload", load),
    event,
    error: component(root, ERROR_API, "MeshkitError", load),
  };
}

/**
 * The catalog object for `apiFiles` (absolute paths, or paths relative to the
 * vendored meshery-schemas folder). Throws CatalogError on anything that
 * would make the gateway serve something it should not.
 */
export function buildCatalog({ vendor = VENDOR, apiFiles = API_FILES } = {}) {
  const meshery = source(readSources(vendor), MESHERY);
  const root = path.join(vendor, meshery.dir);
  const load = loader();
  const mcpFile = path.join(root, MCP_OPERATION);
  const tools = [];
  for (const api of apiFiles) {
    const file = path.resolve(root, api);
    const doc = load(file);
    for (const [route, pathItem] of Object.entries(doc.paths || {})) {
      for (const method of METHODS) {
        const op = pathItem[method];
        if (!op || op["x-mcp"] === undefined) continue;
        const result = new Validator(load(mcpFile), "7", false).validate(op["x-mcp"]);
        if (!result.valid) {
          const errors = result.errors.map((e) => `${e.instanceLocation} ${e.error}`).join("; ");
          throw new CatalogError(`${op.operationId || `${method.toUpperCase()} ${route}`}: x-mcp fails McpOperation: ${errors}`);
        }
        if (op["x-mcp"].expose !== true) continue;
        tools.push(tool(op, method, route, pathItem, file, load));
      }
    }
  }
  const names = new Set();
  for (const t of tools) {
    if (names.has(t.name)) throw new CatalogError(`${t.name}: two exposed operations share this operationId`);
    names.add(t.name);
  }
  tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sortKeys({
    _generated: `Generated by hosted/scripts/generate.js from ${meshery.repo} at ${meshery.ref}; do not edit; run make hosted-generate.`,
    source: { repo: meshery.repo, ref: meshery.ref },
    tools,
    events: eventSchemas(root, load),
  });
}

/** The catalog file's exact text: 2-space JSON with a trailing newline. */
export function render(catalog) {
  return JSON.stringify(catalog, null, 2) + "\n";
}
