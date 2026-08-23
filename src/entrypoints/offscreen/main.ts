// ============================================================
// VLESS — Offscreen ML Host (entrypoint)
// The only context allowed to touch WebGPU / OffscreenCanvas / heavy
// WASM. Exposes the ML runtime to the service worker over the RPC bus.
// ============================================================

import { serveOffscreen } from "../../core/runtime/messaging";
import { detectBackend } from "../../core/runtime/backend";
import { getModelStatuses, warmModels } from "../../core/runtime/model-host";
import { runOcr } from "../../core/ocr/ocr-engine";
import { redactScreenshot, verifyRedactionOffscreen, detectVisionPII } from "../../core/privacy/offscreen-redact";
import { perceiveScreen, groundPhrase } from "../../core/perception/florence2-engine";
import { ensureWebLLM, isWebLLMReady } from "../../core/agent/webllm-planner";

serveOffscreen({
  ping: () => ({ pong: true as const, ts: Date.now() }),
  detectBackend: () => detectBackend(),
  getModelStatuses: () => getModelStatuses(),
  warmModels: ({ ids }) => warmModels(ids),
  runOcr: (params) => runOcr(params),
  redactScreenshot: (params) => redactScreenshot(params.imageDataUrl, params.regions),
  verifyRedaction: (params) => verifyRedactionOffscreen(params.imageDataUrl),
  perceiveScreen: (params) => perceiveScreen(params.imageDataUrl),
  groundPhrase: (params) => groundPhrase(params.imageDataUrl, params.phrase),
  // WebLLM: fully offline on-device LLM planning via WebGPU
  ensureWebLLM: () => ensureWebLLM(),
  isWebLLMReady: () => isWebLLMReady(),
  // Vision PII: face + password dot detection on screenshots
  detectVisionPII: (params: { imageDataUrl: string }) => detectVisionPII(params.imageDataUrl),
});

// Announce readiness in the offscreen console (visible via chrome://extensions
// → service worker "inspect views: offscreen.html").
// eslint-disable-next-line no-console
console.info("[VLESS] offscreen ML host ready");
