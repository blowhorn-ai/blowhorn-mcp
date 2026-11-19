// SPDX-License-Identifier: Apache-2.0
/*
 * OpenAI apps domain verification: GET/HEAD /.well-known/openai-apps-challenge
 * returns the OPENAI_APPS_CHALLENGE secret as text/plain, or the same 404 as
 * an unknown path when the secret is unset. It never calls Cloud.
 */
import test from "node:test";
import assert from "node:assert";
import worker from "../src/index.js";
import { RATE_LIMITER_BINDING } from "../src/ratelimit.js";
import { ENV, MCP_ORIGIN, mockFetch } from "./support/harness.js";

const PATH = "/.well-known/openai-apps-challenge";
const URL = `${MCP_ORIGIN}${PATH}`;
const TOKEN = "openai-apps-challenge-test-token";

function envWith(challenge, extra = {}) {
  const env = { ...ENV, ...extra };
  if (challenge === undefined) delete env.OPENAI_APPS_CHALLENGE;
  else env.OPENAI_APPS_CHALLENGE = challenge;
  return env;
}

async function call(method, env, headers = {}) {
  const res = await worker.fetch(new Request(URL, { method, headers }), env, {});
  const text = await res.text();
  return { res, text };
}

test("GET returns the trimmed secret as text/plain and never calls Cloud", async (t) => {
  const calls = mockFetch(t, () => assert.fail("Cloud was called"));
  const { res, text } = await call("GET", envWith(`  ${TOKEN}\n`));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(text, TOKEN);
  assert.strictEqual(res.headers.get("Content-Type"), "text/plain; charset=utf-8");
  assert.strictEqual(res.headers.get("Cache-Control"), "no-store");
  assert.strictEqual(calls.length, 0);
});

test("a foreign Origin is still answered, and a bad CLOUD_API_BASE does not block it", async (t) => {
  const calls = mockFetch(t, () => assert.fail("Cloud was called"));
  const foreign = await call("GET", envWith(TOKEN), { Origin: "https://evil.example.test" });
  assert.strictEqual(foreign.res.status, 200);
  assert.strictEqual(foreign.text, TOKEN);
  assert.strictEqual(foreign.res.headers.get("Access-Control-Allow-Origin"), null);
  const bad = await call("GET", envWith(TOKEN, { CLOUD_API_BASE: "https://evil.example.test" }));
  assert.strictEqual(bad.res.status, 200);
  assert.strictEqual(bad.text, TOKEN);
  const missing = await call("GET", envWith(TOKEN, { CLOUD_API_BASE: "" }));
  assert.strictEqual(missing.res.status, 200);
  assert.strictEqual(calls.length, 0);
});

test("HEAD has no body and the same headers", async (t) => {
  mockFetch(t, () => assert.fail("Cloud was called"));
  const { res, text } = await call("HEAD", envWith(TOKEN));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(text, "");
  assert.strictEqual(res.headers.get("Content-Type"), "text/plain; charset=utf-8");
  assert.strictEqual(res.headers.get("Cache-Control"), "no-store");
});

test("unset or blank is the same 404 JSON as an unknown path, and Cloud is never called", async (t) => {
  const calls = mockFetch(t, () => assert.fail("Cloud was called"));
  const unknown = await worker.fetch(new Request(`${MCP_ORIGIN}/no-such-path`), ENV, {});
  const unknownText = await unknown.text();
  for (const challenge of [undefined, "", "   ", "\n\t"]) {
    const { res, text } = await call("GET", envWith(challenge));
    assert.strictEqual(res.status, 404, JSON.stringify(challenge));
    assert.strictEqual(text, unknownText);
    assert.deepStrictEqual(JSON.parse(text), { error: "not found" });
    assert.strictEqual(res.headers.get("Content-Type"), unknown.headers.get("Content-Type"));
  }
  assert.strictEqual(calls.length, 0);
});

test("POST is 405 with Allow GET, HEAD, and Cloud is never called", async (t) => {
  const calls = mockFetch(t, () => assert.fail("Cloud was called"));
  for (const challenge of [TOKEN, undefined]) {
    const res = await worker.fetch(new Request(URL, { method: "POST", body: "{}" }), envWith(challenge), {});
    assert.strictEqual(res.status, 405);
    assert.strictEqual(res.headers.get("Allow"), "GET, HEAD");
    await res.text();
  }
  assert.strictEqual(calls.length, 0);
});

test("the challenge spends the address limit and fails closed when the limiter is down", async (t) => {
  const calls = mockFetch(t, () => assert.fail("Cloud was called"));
  const keys = [];
  const ns = {
    idFromName: (name) => name,
    get(id) {
      return {
        limit: async () => {
          keys.push(id);
          return { success: false, retryAfter: 17 };
        },
      };
    },
  };
  const limited = await call("GET", envWith(TOKEN, { [RATE_LIMITER_BINDING]: ns }), { "CF-Connecting-IP": "203.0.113.9" });
  assert.strictEqual(limited.res.status, 429);
  assert.strictEqual(limited.res.headers.get("Retry-After"), "17");
  assert.deepStrictEqual(keys, ["address:203.0.113.9"]);
  const down = {
    idFromName: (name) => name,
    get: () => ({
      limit: async () => {
        throw new TypeError("limiter down");
      },
    }),
  };
  const unavailable = await call("GET", envWith(TOKEN, { [RATE_LIMITER_BINDING]: down }));
  assert.strictEqual(unavailable.res.status, 503);
  assert.strictEqual(calls.length, 0);
});
