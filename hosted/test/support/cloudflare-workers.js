// SPDX-License-Identifier: Apache-2.0
/*
 * Stand-in for `cloudflare:workers` when the gateway tests run under Node.
 * test/support/register.js resolves that specifier here. The real runtime
 * class is what makes a Durable Object method visible over RPC; this base
 * only records the constructor arguments the tests pass.
 */
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
