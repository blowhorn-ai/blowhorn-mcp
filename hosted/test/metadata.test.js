// SPDX-License-Identifier: Apache-2.0
/*
 * Holds the RFC 9728 document the Worker serves, and the WWW-Authenticate
 * rewrite, to hosted/schemas/protected-resource.schema.json.
 */
import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Validator } from "@cfworker/json-schema";
import {
  AUTHORIZATION_SERVER,
  PUBLIC_RESOURCE,
  PRM_URL,
  protectedResourceMetadata,
  publicChallenge,
} from "../src/metadata.js";

const HOSTED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(path.join(HOSTED, "schemas", "protected-resource.schema.json"), "utf8"));

test("protectedResourceMetadata matches the checked-in schema and the public Worker resource", () => {
  const doc = protectedResourceMetadata();
  const result = new Validator(schema).validate(doc);
  assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
  assert.strictEqual(doc.resource, PUBLIC_RESOURCE);
  assert.strictEqual(doc.resource, "https://mcp.blowhorn.ai/mcp");
  assert.deepStrictEqual(doc.authorization_servers, [AUTHORIZATION_SERVER]);
  assert.deepStrictEqual(doc.authorization_servers, ["https://cloud.blowhorn.ai/hydra"]);
  assert.deepStrictEqual(doc.bearer_methods_supported, ["header"]);
});

test("publicChallenge always names the Worker public PRM URL", () => {
  assert.strictEqual(publicChallenge(""), `Bearer resource_metadata="${PRM_URL}"`);
  assert.strictEqual(publicChallenge(null), `Bearer resource_metadata="${PRM_URL}"`);
  assert.strictEqual(
    publicChallenge('Bearer resource_metadata="https://cloud.layer5.io/.well-known/oauth-protected-resource/mcp"'),
    `Bearer resource_metadata="${PRM_URL}"`,
  );
  assert.strictEqual(
    publicChallenge('Bearer error="invalid_token", resource_metadata="https://example.test/prm"'),
    `Bearer error="invalid_token", resource_metadata="${PRM_URL}"`,
  );
  assert.strictEqual(
    publicChallenge('Bearer realm="mcp"'),
    `Bearer realm="mcp", resource_metadata="${PRM_URL}"`,
  );
  assert.strictEqual(PRM_URL, "https://mcp.blowhorn.ai/.well-known/oauth-protected-resource/mcp");
});
