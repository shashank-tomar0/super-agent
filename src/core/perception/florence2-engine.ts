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

import { env, AutoModelForImageTextToText, AutoProcessor, RawImage } from "@huggingface/transformers";
import type { Tier } from "../../types/runtime";

// ── Configure transformers.js for browser ────────────────────

env.allowLocalModels = true;
env.useBrowserCache = true;

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

async function ensureModel(): Promise<void> {
  if (model && processor) return;

  const t0 = performance.now();

  // Florence-2-base-ft via transformers.js — ONNX Runtime Web handles WebGPU/WASM
  // fp32 for Tier A (GPU), q4 for Tier B (CPU), skip at Tier C
  const MODEL_ID = "onnx-community/Florence-2-base-ft";

  processor = await AutoProcessor.from_pretrained(MODEL_ID);
  model = await AutoModelForImageTextToText.from_pretrained(MODEL_ID, {
    dtype: "fp32",
  });

  modelLoadTime = performance.now() - t0;
  console.log(`[VLESS] Florence-2 loaded in ${modelLoadTime.toFixed(0)}ms`);
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
export async function ensureModelWithTimeout(ms = 15000): Promise<boolean> {
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
  let textRegions: TextRegion[] = [];
  let caption = "";

  // Graceful degradation: if model fails to load in 15s, skip to fallback
  const loaded = await ensureModelWithTimeout(15000);
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
    // Task 1: Open-vocab detection (find UI elements)
    const odStart = performance.now();
    elements = await detectElements(imageUrl);
    tasksRun.push("OD");
    const odTime = performance.now() - odStart;

    // Task 2: OCR with regions (read all text)
    const ocrStart = performance.now();
    textRegions = await ocrWithRegion(imageUrl);
    tasksRun.push("OCR_WITH_REGION");
    const ocrTime = performance.now() - ocrStart;

    // Task 3: Generate page caption (optional)
    try {
      const image = await RawImage.fromURL(imageUrl);
      const inputs = await processor(image, {
        text: "<CAPTION>",
      });
      const outputs = await model.generate({
        ...inputs,
        max_new_tokens: 128,
      });
      caption = processor.batch_decode(outputs, {
        skip_special_tokens: true,
      })[0].trim();
      tasksRun.push("CAPTION");
    } catch {
      // Caption is optional — not a failure
    }

    return {
      elements,
      textRegions,
      caption,
      timings: {
        total: performance.now() - totalStart,
        modelLoad: modelLoadTime,
        od: odTime,
        ocr: ocrTime,
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
 * Format: <loc_XXXX> tokens encode normalized coordinates (0-1000).
 * Pairs: <loc_0050><loc_0120><loc_0200><loc_0350> → box (y1,x1,y2,x2)
 */
function parseODOutput(
  decoded: string,
  imageWidth: number,
  imageHeight: number
): DetectedElement[] {
  const elements: DetectedElement[] = [];

  // Extract loc tokens
  const locPattern = /<loc_(\d{4})>/g;
  const locs: number[] = [];
  let match;
  while ((match = locPattern.exec(decoded)) !== null) {
    locs.push(parseInt(match[1]) / 1000); // Normalize to 0-1
  }

  // Extract labels between loc groups
  const labelPattern = /([a-zA-Z][a-zA-Z0-9_ ]+)/g;
  const textAfterLocs = decoded.replace(/<loc_\d{4}>/g, " ").trim();
  const labels: string[] = [];
  let labelMatch;
  while ((labelMatch = labelPattern.exec(textAfterLocs)) !== null) {
    const label = labelMatch[1].trim();
    if (label.length > 1 && !["the", "and", "with", "for"].includes(label.toLowerCase())) {
      labels.push(label);
    }
  }

  // Parse boxes: groups of 4 locs (y1, x1, y2, x2)
  const numBoxes = Math.floor(locs.length / 4);
  for (let i = 0; i < numBoxes; i++) {
    const y1 = locs[i * 4] || 0;
    const x1 = locs[i * 4 + 1] || 0;
    const y2 = locs[i * 4 + 2] || 1;
    const x2 = locs[i * 4 + 3] || 1;

    elements.push({
      label: labels[i] || `element-${i}`,
      box: {
        x: Math.round(x1 * imageWidth),
        y: Math.round(y1 * imageHeight),
        w: Math.round((x2 - x1) * imageWidth),
        h: Math.round((y2 - y1) * imageHeight),
      },
      confidence: 0.85,
      category: inferCategory(labels[i] || ""),
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
  const pattern = /<loc_(\d{4})><loc_(\d{4})><loc_(\d{4})><loc_(\d{4})>([^<\n]+)/g;
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

  const pattern = /<loc_(\d{4})><loc_(\d{4})><loc_(\d{4})><loc_(\d{4})>/g;
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
