// SPDX-License-Identifier: Apache-2.0
/*
 * Cloud's "no organization selected" answer, mapped to a tools/call tool error.
 *
 * A missing organization is not an authentication failure: the caller is
 * signed in and only has to pass organizationId. An HTTP 401 tells an MCP
 * client to sign in again, so on a tools/call the Worker answers HTTP 200
 * with a JSON-RPC result whose isError is true and whose text says what to do.
 *
 * The mapping is keyed on a machine-readable code, never on message text. The
 * code is read from schemas/org-required.json (shape:
 * schemas/org-required.schema.json, held by test/org-required.test.js). That
 * file's code is a PLACEHOLDER (placeholder: true), not Cloud's published
 * name; do not invent or deploy one. Replace it with the vendored
 * meshery/schemas definition once Cloud publishes the code. Until Cloud
 * emits that code on its answer, nothing here fires and Cloud's 401 passes
 * through as it always has. Do not merge this to master or deploy it while
 * the schema still marks the code as a placeholder.
 *
 * Only a tools/call is rewritten, and only a 400, a 401 or a 200 JSON answer
 * is read (bounded). Everything else streams through untouched.
 */
import orgRequired from "../schemas/org-required.json" with { type: "json" };

export const ORG_REQUIRED_CODE = orgRequired.code;
export const ORG_REQUIRED_MESSAGE = orgRequired.message;
/** The most of an answer that is read to look for the code; a larger answer is streamed on unread. */
export const MAX_CLASSIFY_BYTES = 64 * 1024;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The places on one object where Cloud may carry a code: `code`, a string `error`, `error.code`, `data.code`. */
function codesOf(obj) {
  if (!isObject(obj)) return [];
  return [obj.code, obj.error, isObject(obj.error) ? obj.error.code : undefined, isObject(obj.data) ? obj.data.code : undefined];
}

/** Whether a parsed answer body carries the organization-required code, on the body, its JSON-RPC result, or the result's structuredContent. */
export function carriesOrgRequired(doc) {
  if (!isObject(doc)) return false;
  const result = isObject(doc.result) ? doc.result : undefined;
  return [doc, result, result?.structuredContent].some((o) => codesOf(o).some((c) => c === ORG_REQUIRED_CODE));
}

/** The JSON-RPC id of a request message, matched without case like isToolsCall. A missing id is null. */
export function messageId(message) {
  for (const [key, value] of Object.entries(message)) {
    if (key.toLowerCase() === "id" && (typeof value === "string" || typeof value === "number")) return value;
  }
  return null;
}

/** Whether an upstream answer might be the organization-required answer and so must be read: a 400 or 401, or a 200 JSON body. */
export function worthReading(response) {
  const { status } = response;
  if (status === 400 || status === 401) return true;
  return status === 200 && /^application\/json\b/i.test(response.headers.get("Content-Type") ?? "");
}

/**
 * Reads up to `max` bytes of a response body. Resolves to `{ bytes, body }`:
 * `bytes` is the whole body when it fits, else null; `body` is always a
 * stream or buffer carrying the full original body, so the answer can still
 * be returned byte for byte.
 */
export async function peek(response, max = MAX_CLASSIFY_BYTES) {
  if (!response.body) return { bytes: new Uint8Array(0), body: null };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.byteLength;
      }
      return { bytes, body: bytes };
    }
    chunks.push(value);
    size += value.byteLength;
    if (size > max) {
      let i = 0;
      const body = new ReadableStream({
        async pull(controller) {
          if (i < chunks.length) return controller.enqueue(chunks[i++]);
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel: (reason) => reader.cancel(reason),
      });
      return { bytes: null, body };
    }
  }
}

/** Whether the bytes are a JSON document carrying the organization-required code. */
export function bytesCarryOrgRequired(bytes) {
  try {
    return carriesOrgRequired(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    return false;
  }
}

/** The JSON-RPC tools/call result body that tells the caller to pass organizationId. */
export function orgRequiredResult(id) {
  return JSON.stringify({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: ORG_REQUIRED_MESSAGE }] } });
}
