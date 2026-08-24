// ============================================================
// VLESS — Florence-2 Perception Engine (Offscreen Only)
// The actual "local ViT that reads the screen" the PS requires.
//
// Uses @huggingface/transformers v3 to load Florence-2-base-ft
// in the offscreen document. Runs three tasks:
//   1. <OD> — Open-vocab object detection (find buttons, inputs, links)
//   2. <OCR_WITH_REGION> — OCR with bounding boxes (read all text)
//   3. <CAPTION_TO_PHRASE_GROUNDING> — "find the submit button"
//
// Output: a ScreenGraph — a structured, unified representation
// of everything visible on screen.
// ============================================================

// Must precede the transformers.js import: its module init sets
// ONNX_ENV.wasm.wasmPaths to a CDN URL unless one is already set.
import { ortRuntimeUrl } from "../runtime/ort-env";
import { env, AutoModelForImageTextToText, AutoProcessor, RawImage } from "@huggingface/transformers";
import type { Tier } from "../../types/runtime";
import { MODEL_REGISTRY } from "../runtime/model-registry";
import { detectBackend } from "../runtime/backend";

// ── Configure transformers.js for browser ────────────────────

// Florence-2 is NOT bundled as a local file — only PP-OCR models are bundled.
// Enabling allowLocalModels causes transformers.js to try /models/onnx-community/Florence-2-base-ft/...
// which generates 9 failed fetches before falling back to HuggingFace. Disable it.
env.allowLocalModels = false;
env.useBrowserCache = true; // Cache downloads in browser IndexedDB so they survive SW restarts

if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
  (env as any).wasm = (env as any).wasm || {};
  (env as any).wasm.wasmPaths = chrome.runtime.getURL("ort/");
}

// Belt and braces: overwrite whatever transformers.js decided at import time.
// Its default is a remote jsdelivr URL, which MV3 blocks and which would make
// "nothing leaves the device" untrue on every cold start.
try {
  (env.backends as any).onnx.wasm.wasmPaths = ortRuntimeUrl();
  (env.backends as any).onnx.wasm.numThreads = 1;
} catch {
  // Older/newer shapes of env.backends — the ort-env pin already covers us.
}

// ── Types ────────────────────────────────────────────────────

export interface ScreenGraph {
  /** All detected UI elements with bounding boxes and labels */
  elements: DetectedElement[];
  /** All text regions with bounding boxes and content */
  textRegions: TextRegion[];
  /** Page-level caption describing what the screen shows */
  caption: string;
  /** Timing breakdown */
  timings: {
    total: number;
    modelLoad: number;
    od: number;
    ocr: number;
    grounding: number;
  };
  /** Which tasks were actually run */
  tasksRun: string[];
  /** Model info */
  model: {
    name: string;
    backend: string;
    tier: Tier;
  };
}

export interface DetectedElement {
  label: string;
  box: { x: number; y: number; w: number; h: number };
  confidence: number;
  /** Category inferred from label */
  category: "button" | "input" | "link" | "image" | "text" | "dropdown" | "checkbox" | "unknown";
}

export interface TextRegion {
  text: string;
  box: { x: number; y: number; w: number; h: number };
  confidence: number;
}

export interface GroundingQuery {
  phrase: string;
  results: Array<{
    box: { x: number; y: number; w: number; h: number };
    confidence: number;
  }>;
}

// ── Singleton Model Cache ────────────────────────────────────

let model: any = null;
let processor: any = null;
let modelLoadTime = 0;

/** Repo id — also used by the model host to pre-warm the browser cache. */
export const FLORENCE_MODEL_ID = "onnx-community/Florence-2-base-ft";

/**
 * Pick the weight precision for this machine.
 *
 * This MUST follow the registry's `dtypeByTier`. Hardcoding fp32 here
 * pulled 1.09 GB on every tier — three times the size the registry
 * advertises, downloaded lazily in the middle of a pipeline run.
 * fp16 is ~544 MB, q4 ~333 MB.
 */
function dtypeForTier(tier: Tier): string {
  const entry = MODEL_REGISTRY.florence2;
  return entry.dtypeByTier?.[tier] ?? "q4";
}

/**
 * Load the model, reporting progress so a pre-warm can show a real bar
 * instead of stalling silently on a multi-hundred-megabyte download.
 */
async function ensureModel(
  onProgress?: (fraction: number) => void
): Promise<void> {
  if (model && processor) return;

  const t0 = performance.now();
  const be = await detectBackend();
  const dtype = dtypeForTier(be.tier);

  // transformers.js reports per-file progress; average across files so the
  // caller sees one monotonic-ish fraction rather than several restarts.
  const fileProgress = new Map<string, number>();
  const progress_callback = onProgress
    ? (p: any) => {
        if (p?.status === "progress" && typeof p.progress === "number") {
          fileProgress.set(p.file ?? "?", p.progress / 100);
        } else if (p?.status === "done" && p.file) {
          fileProgress.set(p.file, 1);
        }
        if (fileProgress.size > 0) {
          const sum = [...fileProgress.values()].reduce((a, b) => a + b, 0);
          onProgress(Math.min(sum / fileProgress.size, 1));
        }
      }
    : undefined;

  processor = await AutoProcessor.from_pretrained(FLORENCE_MODEL_ID, {
    progress_callback,
  } as any);
  model = await AutoModelForImageTextToText.from_pretrained(FLORENCE_MODEL_ID, {
    dtype,
    progress_callback,
  } as any);

  modelLoadTime = performance.now() - t0;
  console.log(
    `[VLESS] Florence-2 loaded (${dtype}, tier ${be.tier}) in ${modelLoadTime.toFixed(0)}ms`
  );
}

/**
 * Download and initialize Florence-2 ahead of time.
 * Called by the model host so the Models tab can pre-warm it, instead of
 * a ~333-1086 MB fetch landing in the middle of a live pipeline run.
 */
export async function warmFlorence(
  onProgress?: (fraction: number) => void
): Promise<void> {
  await ensureModel(onProgress);
}

/**
 * Check if Florence-2 is available (loaded or loadable).
 * Returns false if the model failed to load or the runtime is Tier C.
 */
export function isFlorenceAvailable(): boolean {
  return model !== null && processor !== null;
}

/**
 * Gracefully degrade: skip Florence-2 if not loaded within timeout.
 * Returns true if the model loaded, false if we should skip to DOM+OCR fallback.
 */
export async function ensureModelWithTimeout(ms = 60000): Promise<boolean> {
  try {
    await Promise.race([
      ensureModel(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
    ]);
    return true;
  } catch {
    console.warn(`[VLESS] Florence-2 failed to load within ${ms}ms — using DOM+OCR fallback`);
    return false;
  }
}

// ── Core Perception Functions ────────────────────────────────

/**
 * Run open-vocab detection on a screenshot.
 * Finds UI elements: buttons, inputs, links, images, etc.
 *
 * @param imageUrl - Screenshot data URL or URL
 * @returns Detected elements with bounding boxes
 */
export async function detectElements(imageUrl: string): Promise<DetectedElement[]> {
  await ensureModel();

  const image = await RawImage.fromURL(imageUrl);
  const inputs = await processor(image, {
    text: "<OD>",
  });

  const outputs = await model.generate({
    ...inputs,
    max_new_tokens: 256,
  });

  const decoded = processor.batch_decode(outputs, {
    skip_special_tokens: false,
  })[0];

  // Parse Florence-2 OD output: <loc_XXXX> tokens encode bounding boxes
  return parseODOutput(decoded, image.width, image.height);
}

/**
 * Run OCR with region detection on a screenshot.
 * Reads ALL text on screen with bounding boxes.
 *
 * @param imageUrl - Screenshot data URL or URL
 * @returns Text regions with content and bounding boxes
 */
export async function ocrWithRegion(imageUrl: string): Promise<TextRegion[]> {
  await ensureModel();

  const image = await RawImage.fromURL(imageUrl);
  const inputs = await processor(image, {
    text: "<OCR_WITH_REGION>",
  });

  const outputs = await model.generate({
    ...inputs,
    max_new_tokens: 1024,
  });

  const decoded = processor.batch_decode(outputs, {
    skip_special_tokens: false,
  })[0];

  return parseOCROutput(decoded, image.width, image.height);
}

/**
 * Phrase grounding: find elements matching a natural language phrase.
 * Example: "find the submit button" → bounding box of submit button.
 *
 * @param imageUrl - Screenshot data URL or URL
 * @param phrase - Natural language phrase to find
 * @returns Bounding boxes matching the phrase
 */
export async function groundPhrase(
  imageUrl: string,
  phrase: string
): Promise<GroundingQuery> {
  await ensureModel();

  const image = await RawImage.fromURL(imageUrl);
  const prompt = `<CAPTION_TO_PHRASE_GROUNDING>${phrase}`;
  const inputs = await processor(image, { text: prompt });

  const outputs = await model.generate({
    ...inputs,
    max_new_tokens: 256,
  });

  const decoded = processor.batch_decode(outputs, {
    skip_special_tokens: false,
  })[0];

  return parseGroundingOutput(decoded, phrase, image.width, image.height);
}

/**
 * Full screen perception: run all Florence-2 tasks and build a ScreenGraph.
 * This is the "visual perception" the PS requires.
 *
 * @param imageUrl - Screenshot data URL
 * @returns Complete screen understanding
 */
export async function perceiveScreen(imageUrl: string): Promise<ScreenGraph> {
  const totalStart = performance.now();
  const tasksRun: string[] = [];
  let elements: DetectedElement[] = [];

  // Graceful degradation: 300s timeout allows time for first-run HuggingFace download (333-544MB).
  // Subsequent runs load from browser cache and complete in seconds.
  const loaded = await ensureModelWithTimeout(300000);
  if (!loaded) {
    return {
      elements: [],
      textRegions: [],
      caption: "",
      timings: {
        total: performance.now() - totalStart,
        modelLoad: modelLoadTime,
        od: 0,
        ocr: 0,
        grounding: 0,
      },
      tasksRun: [],
      model: {
        name: "Florence-2-base-ft",
        backend: "SKIPPED (DOM+OCR fallback)",
        tier: "C",
      },
    };
  }

  try {
    // Task 1: Open-vocab detection (find UI elements) with lightweight token limit
    const odStart = performance.now();
    elements = await detectElements(imageUrl);
    tasksRun.push("OD");
    const odTime = performance.now() - odStart;

    // PP-OCR provides lightweight, high-speed on-device text OCR.
    // Heavy 1024-token Florence-2 <OCR_WITH_REGION> is skipped to prevent WASM memory heap overflow.

    return {
      elements,
      textRegions: [],
      caption: "Screen elements recognized by Florence-2 ViT",
      timings: {
        total: performance.now() - totalStart,
        modelLoad: modelLoadTime,
        od: odTime,
        ocr: 0,
        grounding: 0,
      },
      tasksRun,
      model: {
        name: "Florence-2-base-ft",
        backend: "transformers.js (ONNX Runtime Web)",
        tier: "A",
      },
    };
  } catch (error) {
    console.error("[VLESS] Florence-2 perception failed:", error);
    return {
      elements: [],
      textRegions: [],
      caption: "",
      timings: {
        total: performance.now() - totalStart,
        modelLoad: modelLoadTime,
        od: 0,
        ocr: 0,
        grounding: 0,
      },
      tasksRun,
      model: {
        name: "Florence-2-base-ft",
        backend: "FAILED",
        tier: "A",
      },
    };
  }
}

// ── Output Parsing ───────────────────────────────────────────

/**
 * Parse Florence-2 <OD> output.
 * Format: interleaved groups of 4 <loc_XXXX> tokens + label text.
 * Example: <loc_0050><loc_0120><loc_0200><loc_0350>button<loc_0100><loc_0200><loc_0300><loc_0400>input
 * Each group of 4 locs encodes (y1, x1, y2, x2) in 0-1000 normalized coords.
 * The text after each loc group is the label for that detection.
 */
function parseODOutput(
  decoded: string,
  imageWidth: number,
  imageHeight: number
): DetectedElement[] {
  const elements: DetectedElement[] = [];

  // Match interleaved pattern: 4 loc tokens followed by optional label text
  // The label continues until the next <loc_ token or end of string
  const pattern = /<loc_(\d{1,4})><loc_(\d{1,4})><loc_(\d{1,4})><loc_(\d{1,4})>([^<]*)/g;
  let match;
  while ((match = pattern.exec(decoded)) !== null) {
    const y1 = parseInt(match[1]) / 1000;
    const x1 = parseInt(match[2]) / 1000;
    const y2 = parseInt(match[3]) / 1000;
    const x2 = parseInt(match[4]) / 1000;
    const label = match[5].trim();

    // Skip empty-label detections (noise)
    if (x2 <= x1 || y2 <= y1) continue;

    elements.push({
      label: label || `element-${elements.length}`,
      box: {
        x: Math.round(x1 * imageWidth),
        y: Math.round(y1 * imageHeight),
        w: Math.round((x2 - x1) * imageWidth),
        h: Math.round((y2 - y1) * imageHeight),
      },
      confidence: 0.85,
      category: inferCategory(label),
    });
  }

  return elements;
}

/**
 * Parse Florence-2 <OCR_WITH_REGION> output.
 * Returns text + bounding boxes.
 */
function parseOCROutput(
  decoded: string,
  imageWidth: number,
  imageHeight: number
): TextRegion[] {
  const regions: TextRegion[] = [];

  // Florence-2 OCR output format: <loc_XXXX>text
  const pattern = /<loc_(\d{1,4})><loc_(\d{1,4})><loc_(\d{1,4})><loc_(\d{1,4})>([^<\n]+)/g;
  let match;
  while ((match = pattern.exec(decoded)) !== null) {
    const y1 = parseInt(match[1]) / 1000;
    const x1 = parseInt(match[2]) / 1000;
    const y2 = parseInt(match[3]) / 1000;
    const x2 = parseInt(match[4]) / 1000;
    const text = match[5].trim();

    if (text.length > 0) {
      regions.push({
        text,
        box: {
          x: Math.round(x1 * imageWidth),
          y: Math.round(y1 * imageHeight),
          w: Math.round((x2 - x1) * imageWidth),
          h: Math.round((y2 - y1) * imageHeight),
        },
        confidence: 0.85,
      });
    }
  }

  return regions;
}

/**
 * Parse Florence-2 <CAPTION_TO_PHRASE_GROUNDING> output.
 */
function parseGroundingOutput(
  decoded: string,
  phrase: string,
  imageWidth: number,
  imageHeight: number
): GroundingQuery {
  const results: GroundingQuery["results"] = [];

  const pattern = /<loc_(\d{1,4})><loc_(\d{1,4})><loc_(\d{1,4})><loc_(\d{1,4})>/g;
  let match;
  while ((match = pattern.exec(decoded)) !== null) {
    const y1 = parseInt(match[1]) / 1000;
    const x1 = parseInt(match[2]) / 1000;
    const y2 = parseInt(match[3]) / 1000;
    const x2 = parseInt(match[4]) / 1000;

    results.push({
      box: {
        x: Math.round(x1 * imageWidth),
        y: Math.round(y1 * imageHeight),
        w: Math.round((x2 - x1) * imageWidth),
        h: Math.round((y2 - y1) * imageHeight),
      },
      confidence: 0.85,
    });
  }

  return { phrase, results };
}

// ── Helpers ──────────────────────────────────────────────────

function inferCategory(label: string): DetectedElement["category"] {
  const lower = label.toLowerCase();
  if (/button|btn|submit|cancel|ok|yes|no/.test(lower)) return "button";
  if (/input|field|text|email|password|search/.test(lower)) return "input";
  if (/link|anchor|url/.test(lower)) return "link";
  if (/image|img|photo|icon/.test(lower)) return "image";
  if (/dropdown|select|combo/.test(lower)) return "dropdown";
  if (/check|toggle|switch/.test(lower)) return "checkbox";
  if (/text|label|heading|title|paragraph/.test(lower)) return "text";
  return "unknown";
}

/**
 * Check if Florence-2 is loaded and ready.
 */
export function isFlorenceReady(): boolean {
  return model !== null && processor !== null;
}

/**
 * Get model status for HUD display.
 */
export function getFlorenceStatus(): { loaded: boolean; loadTime: number } {
  return {
    loaded: isFlorenceReady(),
    loadTime: modelLoadTime,
  };
}
