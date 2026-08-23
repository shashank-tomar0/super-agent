// ============================================================
// VLESS — Screen Graph Fusion
// Merges three perception signals into a single unified
// representation of what's on screen:
//   1. DOM (fast, structured, accurate for HTML elements)
//   2. OCR (reads text in images, canvas, PDFs)
//   3. Florence-2 ViT (visual grounding, catches what DOM misses)
//
// This tri-signal approach is the key innovation.
// DOM-only agents miss canvas-rendered content.
// Vision-only agents miss semantic structure.
// We combine both.
// ============================================================

import type { PageState } from "../../types";
import type { OcrWord } from "../../types/runtime";

// ── Types ────────────────────────────────────────────────────

export interface ScreenGraphElement {
  /** Unique ID (from DOM index or vision detection) */
  id: string;
  /** Text label or content */
  label: string;
  /** Bounding box in screen coordinates */
  box: { x: number; y: number; w: number; h: number };
  /** Where this element came from */
  source: "dom" | "ocr" | "vit" | "fused";
  /** Element type */
  type: string;
  /** Is it interactive? */
  interactive: boolean;
  /** Confidence score 0-1 */
  confidence: number;
  /** Original DOM element index (for LLM planning) */
  domIndex?: number;
  /** Is this a PII field? */
  piiCategory?: string;
}

export interface ScreenGraph {
  /** All elements on screen, deduplicated and fused */
  elements: ScreenGraphElement[];
  /** Full text content from all sources */
  fullText: string;
  /** Page caption from Florence-2 */
  caption: string;
  /** How many elements came from each source */
  sourceBreakdown: { dom: number; ocr: number; vit: number; fused: number };
  /** Timing */
  timings: {
    dom: number;
    ocr: number;
    vit: number;
    fusion: number;
    total: number;
  };
  /** Stats */
  stats: {
    totalElements: number;
    interactiveElements: number;
    textRegions: number;
    canvasRendered: number;
  };
}

// ── IoU for deduplication ────────────────────────────────────

function iou(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = a.w * a.h;
  const areaB = b.w * b.h;
  const union = areaA + areaB - intersection;
  return union > 0 ? intersection / union : 0;
}

// ── Fusion Algorithm ─────────────────────────────────────────

/**
 * Fuse DOM, OCR, and Florence-2 signals into a ScreenGraph.
 * DOM is the structural backbone. OCR adds canvas/image text.
 * Florence-2 adds visual grounding for elements DOM misses.
 */
export function fuseScreenGraph(
  domState: PageState,
  ocrWords: OcrWord[],
  florenceElements: Array<{
    label: string;
    box: { x: number; y: number; w: number; h: number };
    confidence: number;
    category: string;
  }>,
  florenceTextRegions: Array<{
    text: string;
    box: { x: number; y: number; w: number; h: number };
    confidence: number;
  }>,
  caption: string
): ScreenGraph {
  const t0 = performance.now();
  const elements: ScreenGraphElement[] = [];
  const sourceBreakdown = { dom: 0, ocr: 0, vit: 0, fused: 0 };
  let canvasRendered = 0;

  // ── Step 1: DOM elements (structural backbone) ──
  for (let i = 0; i < domState.elements.length; i++) {
    const el = domState.elements[i];
    elements.push({
      id: `dom-${i}`,
      label: el.label || el.text || "",
      box: { x: el.rect.x, y: el.rect.y, w: el.rect.width, h: el.rect.height },
      source: "dom",
      type: el.tag,
      interactive: el.isInteractive,
      confidence: 0.95,
      domIndex: i,
    });
    sourceBreakdown.dom++;
  }

  // ── Step 2: OCR text regions (adds canvas/image text) ──
  for (const word of ocrWords) {
    const overlappingDom = elements.find(
      (e) => e.source === "dom" && iou(e.box, word.box) > 0.5
    );

    if (overlappingDom) {
      overlappingDom.confidence = Math.min(1.0, overlappingDom.confidence + 0.05);
      if (!overlappingDom.label && word.text) {
        overlappingDom.label = word.text;
      }
    } else {
      elements.push({
        id: `ocr-${elements.length}`,
        label: word.text,
        box: { x: word.box.x, y: word.box.y, w: word.box.w, h: word.box.h },
        source: "ocr",
        type: "text",
        interactive: false,
        confidence: word.score,
      });
      sourceBreakdown.ocr++;
      canvasRendered++;
    }
  }

  // ── Step 3: Florence-2 ViT elements (visual grounding) ──
  for (const vitEl of florenceElements) {
    const overlappingExisting = elements.find(
      (e) => iou(e.box, vitEl.box) > 0.4
    );

    if (overlappingExisting) {
      overlappingExisting.confidence = Math.min(
        1.0,
        Math.max(overlappingExisting.confidence, vitEl.confidence) + 0.1
      );
      if (vitEl.label && vitEl.label.length > (overlappingExisting.label?.length || 0)) {
        overlappingExisting.label = vitEl.label;
      }
      overlappingExisting.source = "fused";
      sourceBreakdown.fused++;
    } else {
      elements.push({
        id: `vit-${elements.length}`,
        label: vitEl.label,
        box: vitEl.box,
        source: "vit",
        type: vitEl.category || "unknown",
        interactive: vitEl.category === "button" || vitEl.category === "input",
        confidence: vitEl.confidence,
      });
      sourceBreakdown.vit++;
    }
  }

  // ── Step 4: Florence-2 OCR text (additional text regions) ──
  for (const textRegion of florenceTextRegions) {
    const overlappingExisting = elements.find(
      (e) => iou(e.box, textRegion.box) > 0.4
    );

    if (!overlappingExisting) {
      elements.push({
        id: `vit-ocr-${elements.length}`,
        label: textRegion.text,
        box: textRegion.box,
        source: "vit",
        type: "text",
        interactive: false,
        confidence: textRegion.confidence,
      });
      sourceBreakdown.vit++;
      canvasRendered++;
    }
  }

  // ── Step 5: Build full text ──
  const fullText = [
    ...elements.map((e) => e.label),
    domState.textContent || "",
  ].filter(Boolean).join(" ");

  const fusionTime = performance.now() - t0;

  return {
    elements,
    fullText,
    caption,
    sourceBreakdown,
    timings: {
      dom: domState.perceptionTime,
      ocr: 0,
      vit: 0,
      fusion: fusionTime,
      total: domState.perceptionTime + fusionTime,
    },
    stats: {
      totalElements: elements.length,
      interactiveElements: elements.filter((e) => e.interactive).length,
      textRegions: elements.filter((e) => e.type === "text").length,
      canvasRendered,
    },
  };
}

/**
 * Build a ScreenGraph from DOM + OCR only (no Florence-2).
 * Used at Tier C when Florence-2 is not available.
 */
export function fuseDOMOnly(
  domState: PageState,
  ocrWords: OcrWord[]
): ScreenGraph {
  return fuseScreenGraph(domState, ocrWords, [], [], "");
}

/**
 * Format ScreenGraph as LLM-readable page description.
 * This is what gets sent to the planner.
 */
export function screenGraphToLLMInput(graph: ScreenGraph): string {
  const lines: string[] = [];

  if (graph.caption) {
    lines.push(`Page caption: ${graph.caption}`);
    lines.push("");
  }

  const interactive = graph.elements.filter((e) => e.interactive);
  if (interactive.length > 0) {
    lines.push(`Interactive elements (${interactive.length}):`);
    for (let i = 0; i < interactive.length; i++) {
      const e = interactive[i];
      lines.push(`  [${e.domIndex ?? i}] <${e.type}> "${e.label}" ${e.piiCategory ? `[PII:${e.piiCategory}]` : ""}`);
    }
    lines.push("");
  }

  if (graph.fullText) {
    lines.push(`Text content: ${graph.fullText.slice(0, 500)}`);
  }

  lines.push("");
  lines.push(`Stats: ${graph.stats.totalElements} elements, ${graph.stats.interactiveElements} interactive, ${graph.stats.canvasRendered} from canvas/images`);

  return lines.join("\n");
}
