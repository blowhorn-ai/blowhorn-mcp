// SPDX-License-Identifier: AGPL-3.0-only
/*
 * blowhorn-mcp-hosted: an INTERIM, READ-ONLY MCP gateway, served at
 * https://mcp.blowhorn.ai/mcp until Blowhorn Cloud serves /mcp itself
 * (blowhorn-ai/blowhorn#1509, U3). Retire this Worker then.
 *
 * Stateless Streamable HTTP: every POST /mcp builds a fresh MCP server whose
 * tools are the generated catalog (src/catalog.generated.json), every one a
 * GET on the Cloud API. Each call forwards the caller's own Cloud API token,
 * sent as a Bearer header, and nothing is stored. Every request must carry a
 * Bearer token; Cloud validates it on each tool call. There is no SSE stream,
 * no session and no JSON-RPC batch.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { readRequestBody, requestBodyTooLargeMessage } from "@modelcontextprotocol/sdk/server/requestBody.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { Validator } from "@cfworker/json-schema";
import { bearerToken } from "./auth.js";
import { TOOLS, VERSION, callCloud, cloudBase } from "./cloud.js";

// Module-private: Workers treat every named export of the main module as an entrypoint.
const NAME = "blowhorn-mcp-hosted";
const MAX_REQUEST_BYTES = 1024 * 1024;

const INSTRUCTIONS =
  "Interim read-only gateway to the Blowhorn Cloud API. Every tool is a read: it lists or gets content items, events and connections of your organization and never changes anything. " +
  "Each call runs as the owner of the Cloud API token sent as the Bearer header. Pass organizationId to act in an organization other than your selected one.";

const VALIDATORS = new Map([...TOOLS.values()].map((t) => [t.name, new Validator(t.inputSchema, "2020-12", false)]));

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function rpcError(status, code, message, headers) {
  return json(status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

/** The allowed origins from `env.ALLOWED_ORIGINS`, a comma-separated list; never a wildcard. */
function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s !== "*");
}

function corsHeaders(origin) {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": "Mcp-Protocol-Version, WWW-Authenticate",
    Vary: "Origin",
  };
}

function log(fields) {
  console.log(JSON.stringify(fields));
}

/** Validation messages for `args` against `tool`'s input schema; they name locations, never values. */
function validationErrors(tool, args) {
  const { valid, errors } = VALIDATORS.get(tool.name).validate(args);
  if (valid) return [];
  return errors.filter((e) => !["properties", "items", "false"].includes(e.keyword)).map((e) => `${e.instanceLocation.replace(/^#/, "") || "/"}: ${e.error}`);
}

function buildServer(base) {
  const server = new Server({ name: NAME, version: VERSION }, {
    capabilities: { tools: {} },
    instructions: INSTRUCTIONS,
    // The SDK's default, Ajv, compiles with new Function, which Workers forbid.
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...TOOLS.values()].map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = TOOLS.get(request.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, "Unknown tool.");
    const args = request.params.arguments ?? {};
    const started = Date.now();
    const errors = validationErrors(tool, args);
    if (errors.length) {
      log({ method: "tools/call", tool: tool.name, status: "invalid", ms: Date.now() - started });
      return { isError: true, content: [{ type: "text", text: `Invalid arguments for ${tool.name}:\n${errors.join("\n")}` }] };
    }
    const { result, status } = await callCloud(tool, args, { base, token: extra.authInfo.token });
    log({ method: "tools/call", tool: tool.name, status, ms: Date.now() - started });
    return result;
  });
  return server;
}

async function mcp(request, env, origin) {
  const cors = corsHeaders(origin);
  if (request.method === "OPTIONS") {
    if (!origin) return rpcError(403, -32000, "Forbidden: preflight needs an allowed Origin.");
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version",
        "Access-Control-Max-Age": "600",
      },
    });
  }
  if (request.method !== "POST") return rpcError(405, -32000, "Method not allowed: this stateless gateway answers POST only.", { Allow: "POST", ...cors });

  const header = request.headers.get("Authorization");
  const token = bearerToken(header);
  if (!token) {
    // RFC 6750 3.1: no error code when the request carried no credentials at all.
    const challenge = header === null ? 'Bearer realm="blowhorn-mcp"' : 'Bearer realm="blowhorn-mcp", error="invalid_token"';
    return rpcError(
      401,
      -32001,
      "Unauthorized: send your own Blowhorn Cloud API token as an Authorization: Bearer <token> header.",
      { "WWW-Authenticate": challenge, ...cors },
    );
  }

  const base = cloudBase(env);
  if (!base) return rpcError(500, -32603, "Gateway misconfigured: CLOUD_API_BASE is not an https URL.", cors);

  // Parsed here, not by the SDK, so a JSON-RPC batch (an array) is refused before
  // it can fan out into many Cloud calls at once.
  let parsedBody;
  try {
    const body = await readRequestBody(request, MAX_REQUEST_BYTES);
    if (body.tooLarge) return rpcError(413, -32000, requestBodyTooLargeMessage(MAX_REQUEST_BYTES), cors);
    parsedBody = JSON.parse(body.text);
  } catch {
    return rpcError(400, -32700, "Parse error: Invalid JSON", cors);
  }
  if (Array.isArray(parsedBody)) return rpcError(400, -32600, "Invalid Request: JSON-RPC batches are not supported; send one message per POST.", cors);

  const server = buildServer(base);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_REQUEST_BYTES,
  });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(request, { parsedBody, authInfo: { token, clientId: "bearer", scopes: [] } });
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  } finally {
    await server.close();
  }
}

export default {
  async fetch(request, env = {}, ctx) {
    void ctx;
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method not allowed" }, { Allow: "GET, HEAD" });
      const ok = cloudBase(env) !== null;
      return json(ok ? 200 : 500, { ok, name: NAME, version: VERSION, tools: TOOLS.size, interim: true });
    }
    if (url.pathname !== "/mcp") return json(404, { error: "not found" });

    const origin = request.headers.get("Origin");
    if (origin !== null && !allowedOrigins(env).includes(origin)) return rpcError(403, -32000, "Forbidden: this Origin is not allowed.");
    return mcp(request, env, origin);
  },
};
