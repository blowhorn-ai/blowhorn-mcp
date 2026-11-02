// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Calls to the Cloud API, built only from the generated catalog. A request's
 * method, path and query keys all come from a catalog entry; the caller only
 * supplies values. dispatch() checks that again right before the fetch, so
 * nothing but a GET to a catalog path on the configured base ever leaves.
 * Tool calls are still only those GETs. The one other request the Worker makes
 * is the createEvent POST in events.js, which records the call.
 */
import pkg from "../package.json" with { type: "json" };
import catalog from "./catalog.generated.json" with { type: "json" };
import { redact } from "./redact.js";

export const VERSION = pkg.version;
export const USER_AGENT = `blowhorn-mcp-hosted/${VERSION}`;
export const DEFAULT_BASE = "https://cloud.blowhorn.ai";
export const TIMEOUT_MS = 20_000;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_URL_BYTES = 8192;
const MESSAGE_LIMIT = 300;

export const TOOLS = new Map(catalog.tools.map((t) => [t.name, t]));

export class GatewayError extends Error {}

/** The only Cloud API bases callers' tokens may ever be sent to. */
const ALLOWED_BASES = [DEFAULT_BASE];

/**
 * The Cloud API base URL from `env.CLOUD_API_BASE`, without a trailing slash,
 * or null when it is not exactly an allowed origin (the gateway then refuses
 * to serve), so a changed variable can never send tokens to another host.
 */
export function cloudBase(env = {}) {
  const raw = String(env.CLOUD_API_BASE || DEFAULT_BASE).replace(/\/+$/, "");
  return ALLOWED_BASES.includes(raw) ? raw : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pathname patterns of every catalog GET path, one segment per {param}. */
const PATTERNS = catalog.tools.map((t) => new RegExp(`^${t.path.split(/\{[^}]+\}/).map(escapeRe).join("[^/]+")}$`));

/** Whether `pathname` (under the base's own path) was produced from a catalog template. */
function catalogPath(pathname) {
  return PATTERNS.some((re) => re.test(pathname));
}

/**
 * The { method, url, headers } for calling `tool` with already validated
 * `args`. Path values are encodeURIComponent'd and may not be a dot segment;
 * only the tool's declared query and header arguments are sent.
 */
export function buildRequest(tool, args, { base, token }) {
  let route = tool.path;
  const query = new URLSearchParams();
  const headers = { Accept: "application/json", "User-Agent": USER_AGENT, Authorization: `Bearer ${token}` };
  for (const [arg, wire] of Object.entries(tool.wire)) {
    if (!Object.prototype.hasOwnProperty.call(args, arg)) continue;
    const value = args[arg];
    if (wire.in === "path") {
      const encoded = encodeURIComponent(String(value));
      if (!encoded || encoded === "." || encoded === "..") throw new GatewayError(`${arg} is not a valid path value`);
      route = route.split(`{${wire.name}}`).join(encoded);
    } else if (wire.in === "query") {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== null && typeof item === "object") throw new GatewayError(`${arg} must be a scalar or a list of scalars`);
        query.append(wire.name, String(item));
      }
    } else if (wire.in === "header") {
      headers[wire.name] = String(value);
    }
  }
  if (/\{[^}]+\}/.test(route)) throw new GatewayError("a path argument is missing");
  const qs = query.toString();
  const url = `${base}${route}${qs ? `?${qs}` : ""}`;
  if (new TextEncoder().encode(url).byteLength > MAX_URL_BYTES) throw new GatewayError(`the request URL would be over ${MAX_URL_BYTES} bytes; send shorter arguments`);
  return { method: tool.method, url, headers };
}

/**
 * Fetches `req` from Cloud, refusing any method but GET, any URL off `base`
 * and any path not produced from a catalog template. Never follows a redirect.
 */
export async function dispatch(req, { base }) {
  if (req.method !== "GET") throw new GatewayError(`refused: method ${req.method} is not GET`);
  const url = new URL(req.url);
  const baseUrl = new URL(base);
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith(`${basePath}/`) || url.hash || url.username || url.password) {
    throw new GatewayError("refused: URL is not on the Cloud API base");
  }
  if (!catalogPath(url.pathname.slice(basePath.length))) throw new GatewayError("refused: path is not from the catalog");
  return fetch(url.toString(), {
    method: "GET",
    headers: req.headers,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** The body of `res` as text, or null when it is over MAX_RESPONSE_BYTES. */
async function readCapped(res) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function errorResult(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

/** `text` with every occurrence of `token` replaced, so the caller's token can never be echoed. */
export function scrub(text, token) {
  return token ? text.split(token).join("[redacted]") : text;
}

/**
 * The MCP tool result for calling `tool` with validated `args` as the owner
 * of `token`, with its `status` (0 when Cloud gave none) and `outcome`: ok,
 * refused, timeout, unreachable, redirect, too_large, not_json, cloud_rejected
 * (a 4xx) or cloud_failed (any other non-2xx). Every failure is a tool result
 * with isError, never a throw.
 */
export async function callCloud(tool, args, { base, token }) {
  try {
    return await cloudResult(await dispatch(buildRequest(tool, args, { base, token }), { base }), token);
  } catch (err) {
    if (err instanceof GatewayError) return { result: errorResult(err.message), status: 0, outcome: "refused" };
    if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return { result: errorResult(`Cloud did not answer within ${TIMEOUT_MS / 1000} seconds.`), status: 0, outcome: "timeout" };
    }
    return { result: errorResult("Could not reach Cloud."), status: 0, outcome: "unreachable" };
  }
}

/** The { result, status, outcome } for Cloud's answer `res`; reading the body may throw. */
async function cloudResult(res, token) {
  const status = res.status;
  if (res.type === "opaqueredirect" || (status >= 300 && status < 400)) {
    await res.body?.cancel();
    return { result: errorResult(`Cloud answered ${status || "a redirect"}; redirects are not followed.`), status, outcome: "redirect" };
  }
  const text = await readCapped(res);
  if (text === null) return { result: errorResult(`Cloud's answer is larger than ${MAX_RESPONSE_BYTES / (1024 * 1024)} MB.`), status, outcome: "too_large" };
  const body = parseJson(text);
  if (status < 200 || status >= 300) {
    let message = `Cloud answered ${status}.`;
    const detail = body.ok && body.value && typeof body.value === "object" ? body.value.message : undefined;
    if (typeof detail === "string" && detail.trim()) {
      const trimmed = detail.trim();
      message += ` ${trimmed.length > MESSAGE_LIMIT ? `${trimmed.slice(0, MESSAGE_LIMIT)}...` : trimmed}`;
    }
    const outcome = status >= 400 && status < 500 ? "cloud_rejected" : "cloud_failed";
    return { result: errorResult(scrub(message, token)), status, outcome };
  }
  if (!body.ok) return { result: errorResult(`Cloud answered ${status} with a body that is not JSON.`), status, outcome: "not_json" };
  const value = redact(body.value);
  const result = { content: [{ type: "text", text: scrub(JSON.stringify(value), token) }] };
  if (value && typeof value === "object" && !Array.isArray(value) && !JSON.stringify(value).includes(token)) {
    result.structuredContent = value;
  }
  return { result, status, outcome: "ok" };
}
