// ============================================================
// VLESS — Offscreen RPC Bus
// The service worker cannot use DOM / OffscreenCanvas / WebGPU, so
// all ML runs in an offscreen document. This module is the typed,
// correlated request/response bridge between them.
//
// Delivery model: chrome.runtime.sendMessage does NOT deliver to the
// sending context, so an SW→offscreen request is received only by the
// offscreen listener, and its sendResponse resolves the SW's promise.
// ============================================================

import {
  RPC_CHANNEL,
  RPC_PROGRESS_CHANNEL,
  type ModelProgress,
  type OffscreenMethodName,
  type OffscreenMethods,
  type RpcProgressEvent,
  type RpcRequest,
  type RpcResponse,
} from "../../types/runtime";

const OFFSCREEN_URL = "offscreen.html";

// ── Service-worker side ──────────────────────────────────────

let creating: Promise<unknown> | null = null;

/** Create the offscreen document once (idempotent, race-safe). */
export async function ensureOffscreenDocument(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.offscreen) {
    throw new Error("chrome.offscreen API unavailable in this context");
  }

  // hasDocument() is the modern check; fall back to getContexts if needed.
  const has = await chrome.offscreen.hasDocument();
  if (has) return;

  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification:
          "Run on-device ML (OCR, Florence-2 grounding, GLiNER PII, redaction) " +
          "using WebGPU/WASM and OffscreenCanvas, which are unavailable in the service worker.",
      })
      .catch((e: unknown) => {
        // Race: a concurrent call already created it.
        const msg = String((e as Error)?.message ?? e);
        if (!/single offscreen|already/i.test(msg)) throw e;
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

let rpcSeq = 0;
function nextRpcId(): string {
  rpcSeq = (rpcSeq + 1) % Number.MAX_SAFE_INTEGER;
  return `rpc-${Date.now()}-${rpcSeq}`;
}

/** Call an offscreen method from the service worker. Ensures the doc exists. */
export async function callOffscreen<M extends OffscreenMethodName>(
  method: M,
  params: OffscreenMethods[M]["params"],
): Promise<OffscreenMethods[M]["result"]> {
  await ensureOffscreenDocument();
  const req: RpcRequest<M> = { channel: RPC_CHANNEL, id: nextRpcId(), method, params };
  let res = (await chrome.runtime.sendMessage(req)) as RpcResponse<M> | undefined;

  // BUG-08 FIX: undefined response means the offscreen doc listener wasn't
  // ready yet (race on SW restart). Wait briefly and retry once before failing.
  if (!res) {
    await new Promise((r) => setTimeout(r, 500));
    res = (await chrome.runtime.sendMessage(req)) as RpcResponse<M> | undefined;
  }

  if (!res) throw new Error(`offscreen: no response for "${method}" — offscreen doc may not be ready`);
  if (!res.ok) throw new Error(res.error || `offscreen "${method}" failed`);
  return res.result as OffscreenMethods[M]["result"];
}

// ── Offscreen side ───────────────────────────────────────────

type OffscreenHandlers = {
  [M in OffscreenMethodName]?: (
    params: OffscreenMethods[M]["params"],
  ) => Promise<OffscreenMethods[M]["result"]> | OffscreenMethods[M]["result"];
};

/** Register method handlers inside the offscreen document. */
export function serveOffscreen(handlers: OffscreenHandlers): void {
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    const req = msg as Partial<RpcRequest>;
    if (!req || req.channel !== RPC_CHANNEL || !req.method) return; // not ours
    const handler = handlers[req.method as OffscreenMethodName];
    if (!handler) {
      sendResponse({
        channel: RPC_CHANNEL,
        id: req.id!,
        ok: false,
        error: `no handler for "${req.method}"`,
      } satisfies RpcResponse);
      return true;
    }
    Promise.resolve()
      .then(() => (handler as (p: unknown) => unknown)(req.params))
      .then((result) =>
        sendResponse({ channel: RPC_CHANNEL, id: req.id!, ok: true, result } as RpcResponse),
      )
      .catch((e: unknown) =>
        sendResponse({
          channel: RPC_CHANNEL,
          id: req.id!,
          ok: false,
          error: String((e as Error)?.message ?? e),
        } as RpcResponse),
      );
    return true; // async response
  });
}

// ── Progress streaming (offscreen → any listener) ────────────

/** Broadcast a model-load progress event. A missing receiver is fine. */
export function emitModelProgress(progress: ModelProgress): void {
  const ev: RpcProgressEvent = { channel: RPC_PROGRESS_CHANNEL, progress };
  chrome.runtime.sendMessage(ev).catch(() => {
    /* no receiver — ignore */
  });
}

/** Subscribe to model-load progress (sidepanel/background). Returns an unsubscribe. */
export function onModelProgress(cb: (p: ModelProgress) => void): () => void {
  const listener = (msg: unknown) => {
    const ev = msg as Partial<RpcProgressEvent>;
    if (ev && ev.channel === RPC_PROGRESS_CHANNEL && ev.progress) cb(ev.progress);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

/** True if a message is an internal RPC/progress envelope (so other
 *  onMessage listeners can ignore it). */
export function isRuntimeEnvelope(msg: unknown): boolean {
  const m = msg as { channel?: string };
  return !!m && (m.channel === RPC_CHANNEL || m.channel === RPC_PROGRESS_CHANNEL);
}
