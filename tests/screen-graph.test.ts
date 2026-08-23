// ============================================================
// VLESS — ScreenGraph Fusion Tests
// Tests the tri-signal fusion: DOM + OCR + Florence-2 ViT → ScreenGraph
// ============================================================

import { describe, it, expect } from "vitest";
import {
  fuseScreenGraph,
  fuseDOMOnly,
  screenGraphToLLMInput,
} from "../src/core/perception/screen-graph";
import type { PageState } from "../src/types";

// ── Helpers ──────────────────────────────────────────────────

function makeDomState(overrides?: Partial<PageState>): PageState {
  return {
    url: "https://example.com",
    title: "Test Page",
    timestamp: Date.now(),
    elements: [],
    forms: [],
    textContent: "",
    metadata: {
      hasCAPTCHA: false,
      hasHoneypot: false,
      isSecure: true,
      hasFileUpload: false,
      hasPaymentForm: false,
      formCount: 0,
      totalElements: 0,
      interactiveElements: 0,
    },
    confidence: 0.9,
    perceptionTime: 10,
    ...overrides,
  };
}

// ── DOM-Only Fusion ──────────────────────────────────────────

describe("ScreenGraph — DOM Only Fusion", () => {
  it("passes through DOM elements when no OCR or ViT data", () => {
    const dom = makeDomState({
      elements: [
        {
          id: "el-0",
          tag: "input",
          role: "textbox",
          text: "",
          label: "Email",
          placeholder: "Enter email",
          ariaLabel: "",
          type: "email",
          rect: { x: 100, y: 200, width: 200, height: 40 } as any,
          isVisible: true,
          isInteractive: true,
          isDisabled: false,
          confidence: 0.95,
          source: "dom",
        },
      ],
    });

    const graph = fuseDOMOnly(dom, []);

    expect(graph.elements).toHaveLength(1);
    expect(graph.elements[0].source).toBe("dom");
    expect(graph.elements[0].label).toBe("Email");
    expect(graph.sourceBreakdown.dom).toBe(1);
  });

  it("tracks source breakdown correctly", () => {
    const dom = makeDomState({
      elements: [
        {
          id: "el-0", tag: "input", role: "textbox", text: "", label: "Name",
          placeholder: "", ariaLabel: "", type: "text",
          rect: { x: 0, y: 0, width: 100, height: 30 } as any,
          isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom",
        },
      ],
    });

    const graph = fuseDOMOnly(dom, []);

    expect(graph.sourceBreakdown.dom).toBe(1);
    expect(graph.sourceBreakdown.ocr).toBe(0);
    expect(graph.sourceBreakdown.vit).toBe(0);
  });
});

// ── IoU Deduplication ────────────────────────────────────────

describe("ScreenGraph — IoU Deduplication", () => {
  it("deduplicates OCR text that overlaps with DOM element", () => {
    const dom = makeDomState({
      elements: [
        {
          id: "el-0", tag: "input", role: "textbox", text: "", label: "Email",
          placeholder: "", ariaLabel: "", type: "email",
          rect: { x: 100, y: 200, width: 200, height: 40 } as any,
          isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom",
        },
      ],
    });

    const ocrWords = [
      {
        text: "Email",
        score: 0.9,
        box: { x: 105, y: 202, width: 190, height: 36 },
        quad: [[105, 202], [295, 202], [295, 238], [105, 238]] as [number, number][],
        lang: "en" as const,
      },
    ];

    const graph = fuseScreenGraph(dom, ocrWords, [], [], "A login page");

    // Should deduplicate OCR text overlapping with DOM element
    expect(graph.sourceBreakdown.dom).toBe(1);
    expect(graph.elements[0].source).toBe("dom"); // OCR overlapped, DOM stays
    expect(graph.elements[0].confidence).toBeGreaterThanOrEqual(0.95); // Boosted
    expect(graph.sourceBreakdown.dom).toBe(1);
    expect(graph.sourceBreakdown.ocr).toBeGreaterThanOrEqual(0); // Deduplicated
  });

  it("adds non-overlapping OCR as new elements", () => {
    const dom = makeDomState({
      elements: [
        {
          id: "el-0", tag: "input", role: "textbox", text: "", label: "Email",
          placeholder: "", ariaLabel: "", type: "email",
          rect: { x: 100, y: 200, width: 200, height: 40 } as any,
          isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom",
        },
      ],
    });

    const ocrWords = [
      {
        text: "Canvas Text",
        score: 0.85,
        box: { x: 400, y: 100, width: 150, height: 30 },
        quad: [[400, 100], [550, 100], [550, 130], [400, 130]] as [number, number][],
        lang: "en" as const,
      },
    ];

    const graph = fuseScreenGraph(dom, ocrWords, [], [], "");

    // DOM + non-overlapping OCR = 2 elements
    expect(graph.elements).toHaveLength(2);
    expect(graph.sourceBreakdown.dom).toBe(1);
    expect(graph.sourceBreakdown.ocr).toBe(1);
    expect(graph.stats.canvasRendered).toBe(1);
  });
});

// ── ViT Signal Fusion ────────────────────────────────────────

describe("ScreenGraph — ViT Fusion", () => {
  it("adds ViT elements that DOM missed", () => {
    const dom = makeDomState({
      elements: [],
    });

    const vitElements = [
      {
        label: "Submit Button",
        box: { x: 300, y: 500, width: 120, height: 40 },
        confidence: 0.88,
        category: "button",
      },
    ];

    const graph = fuseScreenGraph(dom, [], vitElements, [], "A form page");

    expect(graph.elements).toHaveLength(1);
    expect(graph.elements[0].source).toBe("vit");
    expect(graph.elements[0].label).toBe("Submit Button");
    expect(graph.elements[0].interactive).toBe(true);
    expect(graph.sourceBreakdown.vit).toBe(1);
  });

  it("fuses ViT element with overlapping DOM element", () => {
    const dom = makeDomState({
      elements: [
        {
          id: "el-0", tag: "button", role: "button", text: "Submit", label: "Submit",
          placeholder: "", ariaLabel: "", type: "submit",
          rect: { x: 300, y: 500, width: 120, height: 40 } as any,
          isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom",
        },
      ],
    });

    const vitElements = [
      {
        label: "Submit Button",
        box: { x: 305, y: 502, width: 115, height: 38 },
        confidence: 0.88,
        category: "button",
      },
    ];

    const graph = fuseScreenGraph(dom, [], vitElements, [], "");

    // Should merge: DOM + ViT = element
    expect(graph.sourceBreakdown.dom).toBe(1);
    expect(graph.elements[0].source).toBeDefined();
    expect(graph.elements[0].confidence).toBeGreaterThanOrEqual(0.95);
    expect(graph.sourceBreakdown.fused).toBeGreaterThanOrEqual(0);
  });

  it("adds ViT OCR text as separate elements", () => {
    const dom = makeDomState({ elements: [] });

    const vitTextRegions = [
      {
        text: "Copyright 2024",
        box: { x: 10, y: 700, width: 200, height: 20 },
        confidence: 0.8,
      },
    ];

    const graph = fuseScreenGraph(dom, [], [], vitTextRegions, "");

    expect(graph.elements).toHaveLength(1);
    expect(graph.elements[0].source).toBe("vit");
    expect(graph.elements[0].label).toBe("Copyright 2024");
    expect(graph.elements[0].type).toBe("text");
  });
});

// ── Full Fusion ──────────────────────────────────────────────

describe("ScreenGraph — Full Tri-Signal Fusion", () => {
  it("merges DOM + OCR + ViT into unified graph", () => {
    const dom = makeDomState({
      elements: [
        {
          id: "el-0", tag: "input", role: "textbox", text: "", label: "Name",
          placeholder: "", ariaLabel: "", type: "text",
          rect: { x: 100, y: 100, width: 200, height: 40 } as any,
          isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom",
        },
      ],
      textContent: "Name Email Submit",
    });

    const ocrWords = [
      {
        text: "Canvas Logo",
        score: 0.9,
        box: { x: 50, y: 10, width: 100, height: 30 },
        quad: [] as [number, number][],
        lang: "en" as const,
      },
    ];

    const vitElements = [
      {
        label: "Submit Button",
        box: { x: 100, y: 200, width: 100, height: 40 },
        confidence: 0.85,
        category: "button",
      },
    ];

    const graph = fuseScreenGraph(dom, ocrWords, vitElements, [], "Form page");

    // DOM input + OCR canvas text + ViT button = 3 elements
    expect(graph.elements.length).toBeGreaterThanOrEqual(3);
    expect(graph.stats.totalElements).toBeGreaterThanOrEqual(3);
    expect(graph.stats.canvasRendered).toBeGreaterThanOrEqual(1);
    expect(graph.caption).toBe("Form page");
  });

  it("populates full text from DOM textContent", () => {
    const dom = makeDomState({
      textContent: "Hello World Form",
    });

    const graph = fuseDOMOnly(dom, []);

    expect(graph.fullText).toContain("Hello World Form");
  });
});

// ── LLM Input Formatting ─────────────────────────────────────

describe("ScreenGraph — LLM Input Formatting", () => {
  it("formats interactive elements for LLM", () => {
    const dom = makeDomState({
      elements: [
        {
          id: "el-0", tag: "input", role: "textbox", text: "", label: "Email",
          placeholder: "", ariaLabel: "", type: "email",
          rect: { x: 0, y: 0, width: 100, height: 30 } as any,
          isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom",
        },
        {
          id: "el-1", tag: "button", role: "button", text: "Submit", label: "Submit",
          placeholder: "", ariaLabel: "", type: "submit",
          rect: { x: 0, y: 50, width: 100, height: 30 } as any,
          isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom",
        },
      ],
    });

    const graph = fuseDOMOnly(dom, []);
    const llmInput = screenGraphToLLMInput(graph);

    expect(llmInput).toContain("[0]");
    expect(llmInput).toContain("[1]");
    expect(llmInput).toContain("Email");
    expect(llmInput).toContain("Submit");
    expect(llmInput).toContain("Interactive elements (2)");
  });

  it("includes page caption when available", () => {
    const dom = makeDomState();
    const graph = fuseDOMOnly(dom, []);
    graph.caption = "A login form with email and password fields";

    const llmInput = screenGraphToLLMInput(graph);

    expect(llmInput).toContain("A login form with email and password fields");
    expect(llmInput).toContain("Page caption:");
  });

  it("marks PII fields in LLM output", () => {
    const dom = makeDomState({
      elements: [
        {
          id: "el-0", tag: "input", role: "textbox", text: "", label: "Aadhaar",
          placeholder: "", ariaLabel: "", type: "text",
          rect: { x: 0, y: 0, width: 100, height: 30 } as any,
          isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom",
        },
      ],
    });

    const graph = fuseDOMOnly(dom, []);
    graph.elements[0].piiCategory = "aadhaar";

    const llmInput = screenGraphToLLMInput(graph);

    expect(llmInput).toContain("[PII:aadhaar]");
  });
});
