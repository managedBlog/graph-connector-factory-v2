/**
 * Per-request context for HTTP requests.
 * Carries bearer token and validated caller identity through async execution.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface CallerIdentity {
  readonly oid?: string | undefined;
  readonly upn?: string | undefined;
  readonly tid?: string | undefined;
  readonly name?: string | undefined;
  readonly appId?: string | undefined;
}

export interface RequestContextData {
  readonly bearerToken?: string | undefined;
  caller?: CallerIdentity | undefined;
}

const storage = new AsyncLocalStorage<RequestContextData>();

export function runWithRequestContext<T>(
  ctx: RequestContextData,
  fn: () => T | Promise<T>
): T | Promise<T> {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContextData | undefined {
  return storage.getStore();
}

export function updateCallerIdentity(caller: CallerIdentity): void {
  const ctx = storage.getStore();
  if (ctx) {
    ctx.caller = caller;
  }
}
