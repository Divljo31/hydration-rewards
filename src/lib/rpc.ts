// Minimal JSON-RPC client. Batches requests, retries transport failures, and throws on any error or
// missing item: a failed read must stop the snapshot, never turn into a zero.
// Behind an HTTP proxy, run with NODE_USE_ENV_PROXY=1 so fetch uses HTTPS_PROXY.

import type { Rpc, RpcRequest } from "../types.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The `error` member of a JSON-RPC response, as far as this client looks at it.
type RpcErrorBody = { message?: string; code?: number } | null | undefined;

export class RpcError extends Error {
  rpc: RpcErrorBody;

  constructor(method: string, error: RpcErrorBody) {
    super(`${method}: ${error?.message ?? JSON.stringify(error)}`);
    this.rpc = error;
  }
}

export function makeRpc(
  url: string,
  {
    batchSize = 100,
    timeoutMs = 60_000,
    retries = 3,
    retryDelayMs = 500,
  }: { batchSize?: number; timeoutMs?: number; retries?: number; retryDelayMs?: number } = {},
): Rpc & { url: string } {
  let nextId = 1;

  // The body of the response, unchecked: `call` and `batch` look at every field they use.
  async function post(body: unknown): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (error) {
        if (attempt >= retries) {
          const failure = error as { cause?: { code?: string }; message?: string };
          throw new Error(
            `${url} unreachable after ${retries + 1} attempts: ${failure.cause?.code ?? failure.message}`,
            { cause: error },
          );
        }
        await sleep(retryDelayMs * 2 ** attempt);
      }
    }
  }

  async function call(method: string, params: unknown[]): Promise<unknown> {
    const response = await post({ jsonrpc: "2.0", id: nextId++, method, params });
    if (response.error) throw new RpcError(method, response.error);
    if (!("result" in response)) throw new RpcError(method, { message: "response has no result" });
    return response.result;
  }

  // requests: [{ method, params }] -> results in the same order
  async function batch(requests: RpcRequest[]): Promise<unknown[]> {
    const results = new Array<unknown>(requests.length);
    for (let offset = 0; offset < requests.length; offset += batchSize) {
      const chunk = requests.slice(offset, offset + batchSize).map((r, i) => ({
        jsonrpc: "2.0",
        id: nextId++,
        method: r.method,
        params: r.params,
        index: offset + i,
      }));
      const byId = new Map(chunk.map((r) => [r.id, r]));
      const response = await post(chunk.map(({ index, ...r }) => r));
      if (!Array.isArray(response)) throw new RpcError("batch", response?.error ?? { message: "not a batch response" });
      for (const item of response) {
        const req = byId.get(item.id);
        if (!req) throw new RpcError("batch", { message: `unexpected id ${item.id}` });
        if (item.error) throw new RpcError(req.method, item.error);
        if (!("result" in item)) throw new RpcError(req.method, { message: "response has no result" });
        results[req.index] = item.result;
        byId.delete(item.id);
      }
      if (byId.size > 0) throw new RpcError("batch", { message: `${byId.size} requests got no response` });
    }
    return results;
  }

  return { url, call, batch };
}

export const toBlockTag = (n: number): string => `0x${n.toString(16)}`;
