/**
 * pi-teams — client for the pi-subagents extension RPC (in-process event bus).
 * Contract (pi-subagents src/extension/rpc.ts):
 *   request event:  "subagents:rpc:v1:request"   { version: 1, requestId, method, params?, source? }
 *   reply event:    "subagents:rpc:v1:reply:<requestId>"  { success, data | error }
 *   ready event:    "subagents:rpc:v1:ready"
 * Methods: ping | status | spawn | steer | interrupt | stop | resume
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REQUEST_EVENT = "subagents:rpc:v1:request";
const READY_EVENT = "subagents:rpc:v1:ready";
const REPLY_PREFIX = "subagents:rpc:v1:reply:";
const DEFAULT_TIMEOUT_MS = 60_000;

export const SUBAGENT_RPC_METHODS = [
  "ping",
  "status",
  "spawn",
  "steer",
  "interrupt",
  "stop",
  "resume",
] as const;

export type SubagentRpcMethod = (typeof SUBAGENT_RPC_METHODS)[number];

interface RpcReply {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export interface SubagentRpcClient {
  /** True once pi-subagents announced its bridge in this process. */
  ready: boolean;
  call(method: SubagentRpcMethod, params?: unknown, timeoutMs?: number): Promise<unknown>;
}

function createSubagentRpc(pi: ExtensionAPI): SubagentRpcClient {
  const state = { ready: false };
  try {
    pi.events.on(READY_EVENT, () => {
      state.ready = true;
    });
  } catch {
    // Event bus unavailable (should not happen in a live session).
  }

  return {
    get ready() {
      return state.ready;
    },
    call(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
      return new Promise((resolve, reject) => {
        const requestId = randomUUID();
        let settled = false;
        let off: (() => void) | void;
        const cleanup = () => {
          clearTimeout(timer);
          if (typeof off === "function") off();
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(`pi-subagents RPC ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        try {
          off = pi.events.on(`${REPLY_PREFIX}${requestId}`, (raw) => {
            if (settled) return;
            settled = true;
            cleanup();
            const reply = raw as RpcReply;
            if (reply?.success === true) {
              resolve(reply.data);
            } else {
              const message = reply?.error
                ? `${method}: ${reply.error.code} — ${reply.error.message}`
                : `${method}: RPC failed`;
              reject(new Error(message));
            }
          });
        } catch (err) {
          clearTimeout(timer);
          reject(err);
          return;
        }
        pi.events.emit(REQUEST_EVENT, {
          version: 1,
          requestId,
          method,
          ...(params !== undefined ? { params } : {}),
          source: { extension: "pi-teams" },
        });
      });
    },
  };
}

const clients = new WeakMap<object, SubagentRpcClient>();

/** One RPC client per ExtensionAPI instance (module-scoped cache). */
export function getSubagentRpc(pi: ExtensionAPI): SubagentRpcClient {
  let client = clients.get(pi);
  if (!client) {
    client = createSubagentRpc(pi);
    clients.set(pi, client);
  }
  return client;
}
