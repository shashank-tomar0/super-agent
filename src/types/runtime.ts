// ============================================================
// VLESS — Runtime Types
// Shared contracts for the on-device ML runtime: hardware tiers,
// the model registry, and the Service-Worker ↔ Offscreen RPC bus.
// ============================================================

// ── Hardware tiers ───────────────────────────────────────────
// The degradation ladder. Every capability must run at every tier
// (degraded), never hard-fail.
//
//  A = modern GPU (WebGPU): Florence-2 + WebLLM in-browser, full stack
//  B = weak iGPU / WASM-SIMD: Florence-2-base q4 on WASM OR OCR+detector; Ollama planner
//  C = CPU only: PP-OCR mobile int8 + tightened DOM; deterministic/Ollama planner
export type Tier = "A" | "B" | "C";

export interface BackendProfile {
  /** navigator.gpu adapter obtained */
  webgpu: boolean;
  /** WebAssembly SIMD supported */
  wasmSimd: boolean;
  /** WebAssembly threads (SharedArrayBuffer + cross-origin isolation) */
  wasmThreads: boolean;
  /** Reported hardware concurrency */
  cores: number;
  /** Approx device memory in GB (navigator.deviceMemory), 0 if unknown */
  deviceMemoryGb: number;
  /** WebGPU adapter description, when available */
  adapter?: string;
  /** Chosen tier */
  tier: Tier;
  /** Preferred ORT execution providers, best-first */
  executionProviders: Array<"webgpu" | "wasm">;
  /** Human-readable one-liner for the HUD */
  summary: string;
}

// ── Model registry ───────────────────────────────────────────

export type ModelId =
  | "ocr-det"
  | "ocr-rec-en"
  | "ocr-rec-hi"
  | "florence2"
  | "gliner-pii"
  | "face-detector"
  | "planner-webllm";

export type ModelKind =
  | "onnx-local" // bundled in the extension under /models
  | "onnx-remote" // fetched + cached from a URL
  | "transformersjs" // loaded by @huggingface/transformers via repo id
  | "mediapipe" // loaded by @mediapipe/tasks-vision via asset URL
  | "webllm"; // loaded by @mlc-ai/web-llm via model id

export interface ModelEntry {
  id: ModelId;
  name: string;
  kind: ModelKind;
  purpose: string;
  sizeBytes: number;
  /** Lowest tier at which this model is used at all. */
  minTier: Tier;
  /** If false, the pipeline still functions without it (graceful skip). */
  required: boolean;

  // onnx-local
  path?: string;
  // onnx-remote — default (fp32/dynamic) + optional quantized variant
  urls?: { default: string; quantized?: string };
  tokenizerRepo?: string;
  // transformersjs / webllm
  repo?: string;
  task?: string;
  /** transformers.js dtype per tier (e.g. { A: "fp16", B: "q4", C: "q4" }). */
  dtypeByTier?: Partial<Record<Tier, string>>;
  // mediapipe
  assetUrl?: string;
  /** OCR recognition/detection spec (verified from the model graph). */
  ocr?: {
    /** Bundled character dictionary (rec models only). */
    dictPath?: string;
    /** CTC output class count — asserted against the live session. */
    numClasses?: number;
    /** Fixed recognition input height in px (rec models only). */
    recHeight?: number;
  };
}

export type ModelLoadState =
  | "not_loaded"
  | "cached"
  | "downloading"
  | "loading"
  | "ready"
  | "error"
  | "skipped";

export interface ModelStatus {
  id: ModelId;
  name: string;
  kind: ModelKind;
  sizeBytes: number;
  required: boolean;
  state: ModelLoadState;
  /** 0..1 during downloading/loading */
  progress: number;
  error?: string;
}

export interface ModelProgress {
  id: ModelId;
  state: ModelLoadState;
  /** 0..1 */
  progress: number;
  loadedBytes?: number;
  totalBytes?: number;
  error?: string;
}

// ── Offscreen RPC bus ────────────────────────────────────────
// Service worker cannot use DOM / OffscreenCanvas / WebGPU. All ML
// runs in the offscreen document. These envelopes correlate calls.

export const RPC_CHANNEL = "vless.offscreen.rpc" as const;
export const RPC_PROGRESS_CHANNEL = "vless.offscreen.progress" as const;

/** Methods the offscreen document exposes to the service worker. */
export interface OffscreenMethods {
  ping: { params: void; result: { pong: true; ts: number } };
  detectBackend: { params: void; result: BackendProfile };
  getModelStatuses: { params: void; result: ModelStatus[] };
  /** Warm up (download + init) a set of models for the active tier. */
  warmModels: { params: { ids: ModelId[] }; result: ModelStatus[] };
  /** Run PP-OCR (detect → recognize) on a captured screenshot data URL. */
  runOcr: {
    params: { imageDataUrl: string; lang?: OcrLang | "auto"; maxSide?: number };
    result: OcrResult;
  };
  /** Redact a screenshot: blur faces, black-box passwords/PII, pixelate moderate. */
  redactScreenshot: {
    params: {
      imageDataUrl: string;
      regions: Array<{
        x: number; y: number; width: number; height: number;
        strategy: "blur" | "black_box" | "pixelate" | "mask_text";
      }>;
    };
    result: { imageDataUrl: string; regionsRedacted: number };
  };
  /** Verify a redacted screenshot: re-OCR and check for residual PII text. */
  verifyRedaction: {
    params: { imageDataUrl: string };
    result: {
      passed: boolean;
      residualPII: number;
      wordsFound: number;
      ocrTimeMs: number;
    };
  };
  /** Run Florence-2 full screen perception (OD + OCR + caption). */
  perceiveScreen: {
    params: { imageDataUrl: string };
    result: {
      elements: Array<{ label: string; box: { x: number; y: number; w: number; h: number }; confidence: number; category: string }>;
      textRegions: Array<{ text: string; box: { x: number; y: number; w: number; h: number }; confidence: number }>;
      caption: string;
      timings: { total: number; modelLoad: number; od: number; ocr: number; grounding: number };
      tasksRun: string[];
    };
  };
  /** Run Florence-2 phrase grounding: find element matching natural language. */
  groundPhrase: {
    params: { imageDataUrl: string; phrase: string };
    result: { phrase: string; results: Array<{ box: { x: number; y: number; w: number; h: number }; confidence: number }> };
  };
  /** Ensure WebLLM model is loaded (WebGPU, fully offline). */
  ensureWebLLM: { params: void; result: boolean };
  /** Check if WebLLM is ready without triggering a load. */
  isWebLLMReady: { params: void; result: boolean };
  /** Detect vision PII (faces, password dots) from a screenshot. */
  detectVisionPII: {
    params: { imageDataUrl: string };
    result: Array<{
      category: string;
      sensitivity: string;
      boundingBox: { x: number; y: number; width: number; height: number };
      confidence: number;
      detectionMethod: string;
    }>;
  };
}

export type OffscreenMethodName = keyof OffscreenMethods;

export interface RpcRequest<M extends OffscreenMethodName = OffscreenMethodName> {
  channel: typeof RPC_CHANNEL;
  id: string;
  method: M;
  params: OffscreenMethods[M]["params"];
}

export interface RpcResponse<M extends OffscreenMethodName = OffscreenMethodName> {
  channel: typeof RPC_CHANNEL;
  id: string;
  ok: boolean;
  result?: OffscreenMethods[M]["result"];
  error?: string;
}

export interface RpcProgressEvent {
  channel: typeof RPC_PROGRESS_CHANNEL;
  progress: ModelProgress;
}

// ── OCR results ──────────────────────────────────────────────
// Produced by the offscreen OCR engine (PP-OCR det → rec). All
// coordinates are in source-image pixels (the captured screenshot).

export type OcrLang = "en" | "hi";

/** A recognized text region. `quad` is 4 [x,y] points, clockwise from the
 *  top-left corner; `box` is its axis-aligned bounding rect. */
export interface OcrWord {
  text: string;
  /** Recognition confidence, 0..1 (mean per-step softmax of kept tokens). */
  score: number;
  quad: [number, number][];
  box: { x: number; y: number; w: number; h: number };
  lang: OcrLang;
}

export interface OcrResult {
  words: OcrWord[];
  /** Source image dimensions in px. */
  width: number;
  height: number;
  /** Wall-clock timings (ms) for the run. */
  timings: { total: number; detect: number; recognize: number; decode: number };
  regionCount: number;
  tier: Tier;
  backend: "webgpu" | "wasm";
}
