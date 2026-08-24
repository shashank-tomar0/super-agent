// ============================================================
// VLESS — Model Loader (offscreen only)
// Low-level: resolve a model's URL, stream it with progress, and
// persist it in the Cache API so subsequent loads are offline+instant.
// ============================================================

import type { BackendProfile, ModelEntry, ModelProgress } from "../../types/runtime";
import { MODEL_REGISTRY } from "./model-registry";

const CACHE_NAME = "vless-models-v1";

/** Cache API only supports http(s). Extension-bundled (chrome-extension://)
 *  and other schemes must never be passed to cache.put/match — it throws. */
function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

/** Resolve the concrete URL to fetch for a model at the active tier. */
export function resolveModelUrl(entry: ModelEntry, backend: BackendProfile): string {
  if (entry.kind === "onnx-local") {
    if (!entry.path) throw new Error(`${entry.id}: onnx-local missing path`);
    return chrome.runtime.getURL(entry.path);
  }
  if (entry.kind === "onnx-remote") {
    if (!entry.urls) throw new Error(`${entry.id}: onnx-remote missing urls`);
    // Tier C (and no-GPU B) prefer the quantized variant when present.
    const preferQuantized = backend.tier === "C" || !backend.webgpu;
    return preferQuantized && entry.urls.quantized
      ? entry.urls.quantized
      : entry.urls.default;
  }
  throw new Error(`${entry.id}: kind "${entry.kind}" is not loaded by the URL loader`);
}

async function openCache(): Promise<Cache | null> {
  try {
    if (typeof caches === "undefined") return null;
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

/**
 * Check if there's enough storage quota before attempting a large download.
 * Returns true if quota is available or quota API is unsupported.
 */
async function hasStorageQuota(neededBytes: number): Promise<boolean> {
  try {
    if (!navigator?.storage?.estimate) return true;
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    const available = quota - usage;
    return available > neededBytes * 1.1; // 10% headroom
  } catch {
    return true; // Can't check — try anyway
  }
}

/** Is this URL already persisted on-device? (http(s) only; local files are always present.) */
export async function isUrlCached(url: string): Promise<boolean> {
  if (!isHttpUrl(url)) return false; // extension-bundled: not a Cache API entry
  const cache = await openCache();
  if (!cache) return false;
  const hit = await cache.match(url);
  return !!hit;
}

type ProgressFn = (p: Omit<ModelProgress, "id">) => void;

/**
 * Fetch a URL as an ArrayBuffer, reporting streamed progress, and cache the
 * bytes (http(s) only). A cache hit returns instantly (progress 1). Bytes are
 * stored via a reconstructed Response to avoid opaque cross-origin pitfalls.
 * Extension-bundled models (chrome-extension://) stream from disk and are not
 * routed through the Cache API (which rejects that scheme).
 */
export async function fetchArrayBufferWithProgress(
  url: string,
  onProgress: ProgressFn,
): Promise<ArrayBuffer> {
  const cache = isHttpUrl(url) ? await openCache() : null;

  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      const buf = await hit.arrayBuffer();
      onProgress({ state: "cached", progress: 1, loadedBytes: buf.byteLength, totalBytes: buf.byteLength });
      return buf;
    }
  }

  onProgress({ state: "downloading", progress: 0 });

  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);

  const totalBytes = Number(res.headers.get("content-length")) || 0;

  // Stream when possible so the HUD shows real progress.
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loadedBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loadedBytes += value.byteLength;
        onProgress({
          state: "downloading",
          progress: totalBytes ? Math.min(0.999, loadedBytes / totalBytes) : 0,
          loadedBytes,
          totalBytes: totalBytes || undefined,
        });
      }
    }
    const merged = new Uint8Array(loadedBytes);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.byteLength;
    }
    if (cache) {
      const canCache = await hasStorageQuota(loadedBytes);
      if (canCache) {
        try {
          await cache.put(url, new Response(merged, { headers: { "content-length": String(loadedBytes) } }));
        } catch (cacheErr) {
          // Cache quota exceeded or internal error — model is still usable in-memory this session.
          console.warn("[VLESS] cache.put failed (quota?), continuing without persistent cache:", cacheErr);
        }
      } else {
        console.warn(`[VLESS] Skipping cache.put for ${url} — storage quota too low (${loadedBytes} bytes needed)`);
      }
    }
    onProgress({ state: "cached", progress: 1, loadedBytes, totalBytes: loadedBytes });
    return merged.buffer;
  }

  // No streaming available — fall back to a single buffer read.
  const buf = await res.arrayBuffer();
  if (cache) {
    try {
      await cache.put(url, new Response(buf));
    } catch (cacheErr) {
      console.warn("[VLESS] cache.put failed (quota?), continuing without persistent cache:", cacheErr);
    }
  }
  onProgress({ state: "cached", progress: 1, loadedBytes: buf.byteLength, totalBytes: buf.byteLength });
  return buf;
}

/** Count of remote models persisted in the Cache API (local ones are bundled). */
export async function cachedModelCount(): Promise<number> {
  const cache = await openCache();
  if (!cache) return 0;
  let n = 0;
  for (const entry of Object.values(MODEL_REGISTRY)) {
    if (entry.kind === "onnx-remote" && entry.urls) {
      if (
        (await cache.match(entry.urls.default)) ||
        (entry.urls.quantized && (await cache.match(entry.urls.quantized)))
      ) {
        n++;
      }
    }
  }
  return n;
}
