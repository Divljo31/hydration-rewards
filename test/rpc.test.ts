// The JSON-RPC client against a stubbed fetch: a read that fails or goes missing must throw.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { makeRpc, RpcError } from "../src/lib/rpc.ts";

// Replaces global fetch for one test; `respond(body, attempt)` returns the JSON to send back.
// Bodies and answers are JSON of whatever shape the test wants, so they are left untyped.
function stubFetch(t: TestContext, respond: (body: any, attempt: number) => any): any[] {
  const requests: any[] = [];
  const fake = async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const answer = await respond(body, requests.length);
    if (answer instanceof Error) throw answer;
    return { ok: answer.status === undefined, status: answer.status, json: async () => answer };
  };
  t.mock.method(globalThis, "fetch", fake as unknown as typeof fetch);
  return requests;
}

const rpc = (options: Parameters<typeof makeRpc>[1] = {}) =>
  makeRpc("http://node.test", { retryDelayMs: 0, ...options });
const echo = (r: any) => ({ jsonrpc: "2.0", id: r.id, result: r.params[0] });
const calls = (...values: unknown[]) => values.map((v) => ({ method: "eth_call", params: [v] }));

test("a batch returns results in request order, whatever order the node answers in", async (t) => {
  const requests = stubFetch(t, (batch) => batch.map(echo).reverse());
  assert.deepEqual(await rpc({ batchSize: 2 }).batch(calls("a", "b", "c", "d", "e")), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(
    requests.map((b) => b.length),
    [2, 2, 1],
  );
});

test("a batch item with no answer stops the batch", async (t) => {
  stubFetch(t, (batch) => batch.slice(1).map(echo));
  await assert.rejects(rpc().batch(calls("a", "b", "c")), /1 requests got no response/);
});

test("an error, a missing result or an unknown id in a batch stops it", async (t) => {
  stubFetch(t, (batch) =>
    batch.map((r: any, i: number) =>
      i === 1 ? { jsonrpc: "2.0", id: r.id, error: { code: 3, message: "execution reverted" } } : echo(r),
    ),
  );
  await assert.rejects(
    rpc().batch(calls("a", "b")),
    (error) => error instanceof RpcError && /eth_call: execution reverted/.test(error.message),
  );

  t.mock.restoreAll();
  stubFetch(t, (batch) => batch.map((r: any) => ({ jsonrpc: "2.0", id: r.id })));
  await assert.rejects(rpc().batch(calls("a")), /response has no result/);

  t.mock.restoreAll();
  stubFetch(t, (batch) => batch.map((r: any) => ({ ...echo(r), id: r.id + 1000 })));
  await assert.rejects(rpc().batch(calls("a")), /unexpected id/);

  t.mock.restoreAll();
  stubFetch(t, () => ({ jsonrpc: "2.0", id: null, error: { message: "batch too large" } }));
  await assert.rejects(rpc().batch(calls("a")), /batch too large/);
});

test("a single call returns its result and throws on an error or a missing result", async (t) => {
  stubFetch(t, (r) =>
    r.method === "eth_blockNumber"
      ? { jsonrpc: "2.0", id: r.id, result: "0x10" }
      : { jsonrpc: "2.0", id: r.id, error: { message: "nope" } },
  );
  assert.equal(await rpc().call("eth_blockNumber", []), "0x10");
  await assert.rejects(rpc().call("eth_getLogs", [{}]), /eth_getLogs: nope/);

  t.mock.restoreAll();
  stubFetch(t, (r) => ({ jsonrpc: "2.0", id: r.id }));
  await assert.rejects(rpc().call("eth_blockNumber", []), /response has no result/);
});

test("transport failures are retried, then reported", async (t) => {
  const requests = stubFetch(t, (r, attempt) =>
    attempt < 3 ? new Error("socket hang up") : { jsonrpc: "2.0", id: r.id, result: "ok" },
  );
  assert.equal(await rpc().call("eth_chainId", []), "ok");
  assert.equal(requests.length, 3);

  t.mock.restoreAll();
  const failing = stubFetch(t, () => ({ status: 503 }));
  await assert.rejects(rpc({ retries: 2 }).call("eth_chainId", []), /unreachable after 3 attempts: HTTP 503/);
  assert.equal(failing.length, 3);
});
