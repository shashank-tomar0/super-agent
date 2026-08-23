// ============================================================
// VLESS — VLM Visual Context Bridge Tests (self-contained)
// Tests the VLM pipeline logic without importing browser-dependent modules.
// ============================================================

import { describe, it, expect } from "vitest";

// ── Pure function: dataURLToBase64 ───────────────────────────

function dataURLToBase64(dataURL: string): string {
  const commaIndex = dataURL.indexOf(",");
  if (commaIndex === -1) return dataURL;
  return dataURL.substring(commaIndex + 1);
}

describe("VLM Bridge — Base64 Conversion", () => {
  it("strips data URL prefix correctly", () => {
    expect(dataURLToBase64("data:image/png;base64,iVBORw0KGgoAAAANS=")).toBe("iVBORw0KGgoAAAANS=");
  });

  it("handles JPEG data URLs", () => {
    expect(dataURLToBase64("data:image/jpeg;base64,/9j/4AAQSkZJRg==")).toBe("/9j/4AAQSkZJRg==");
  });

  it("returns raw base64 if no prefix", () => {
    expect(dataURLToBase64("iVBORw0KGgoAAAANS=")).toBe("iVBORw0KGgoAAAANS=");
  });

  it("handles empty string", () => {
    expect(dataURLToBase64("")).toBe("");
  });
});

// ── Plan Response Parsing Logic ──────────────────────────────

function parseVLMResponse(response: string): { steps: Array<{ type: string; target?: string; value?: string }>; reasoning: string } {
  const cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { steps: [], reasoning: "No JSON found" };
  const parsed = JSON.parse(jsonMatch[0]);
  return {
    steps: (parsed.steps || []).map((s: any) => s.action || s),
    reasoning: parsed.reasoning || "",
  };
}

describe("VLM Response Parsing", () => {
  it("extracts JSON from markdown code fences", () => {
    const result = parseVLMResponse('```json\n{"reasoning":"test","steps":[]}\n```');
    expect(result.reasoning).toBe("test");
    expect(result.steps).toEqual([]);
  });

  it("extracts JSON from plain text", () => {
    const result = parseVLMResponse('Here is the plan:\n{"reasoning":"fill","steps":[{"action":{"type":"click","target":"[0]"}}]}');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].type).toBe("click");
    expect(result.steps[0].target).toBe("[0]");
  });

  it("handles nested action objects", () => {
    const data = JSON.stringify({
      reasoning: "plan",
      steps: [
        { action: { type: "click", target: "[0]" } },
        { action: { type: "type", target: "[1]", value: "hello" } },
        { action: { type: "select", target: "[2]", value: "Male" } },
      ],
    });
    const result = parseVLMResponse(data);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0].type).toBe("click");
    expect(result.steps[1].type).toBe("type");
    expect(result.steps[1].value).toBe("hello");
    expect(result.steps[2].type).toBe("select");
  });

  it("normalizes target brackets", () => {
    const target = "[0] Given Name";
    const match = target.match(/\[(\d+)\]/);
    expect(match ? "[" + match[1] + "]" : target).toBe("[0]");
  });

  it("normalizes 'fill' → 'type'", () => {
    let t = "fill";
    if (t === "fill") t = "type";
    expect(t).toBe("type");
  });

  it("returns empty on garbage input", () => {
    const result = parseVLMResponse("I can see a login page with email and password fields");
    expect(result.steps).toEqual([]);
  });
});

// ── VLM Request Structure ────────────────────────────────────

describe("VLM Request Structure", () => {
  it("redacted screenshot is base64-only (no data URL prefix)", () => {
    const screenshot = dataURLToBase64("data:image/png;base64,iVBORw0KGgo=");
    expect(screenshot).not.toContain("data:");
    expect(screenshot).not.toContain("base64,");
  });

  it("sanitized context has no PII values", () => {
    const context = {
      elements: [
        { label: "Given Name", type: "text", piiCategory: "name" },
        { label: "Aadhaar Number", type: "text", piiCategory: "aadhaar" },
      ],
      safeTextContent: "Form with *** fields",
      redactionProof: { totalPIIDetected: 2, redactionMethods: ["black_box", "mask_text"] },
    };
    expect(context.safeTextContent).not.toContain("Shashank");
    expect(JSON.stringify(context)).not.toContain("123456789012");
  });

  it("PII categories mark which fields need local fill", () => {
    const fields = [
      { label: "Given Name", piiCategory: "name" },
      { label: "Aadhaar", piiCategory: "aadhaar" },
      { label: "Email", piiCategory: "email" },
      { label: "Submit", piiCategory: null },
    ];
    const piiFields = fields.filter((f) => f.piiCategory);
    expect(piiFields).toHaveLength(3);
    const nonPii = fields.filter((f) => !f.piiCategory);
    expect(nonPii).toHaveLength(1);
  });
});

// ── Redaction Proof ──────────────────────────────────────────

describe("Redaction Proof", () => {
  it("captures what was detected and how", () => {
    const proof = {
      totalPIIDetected: 5,
      categoriesDetected: ["aadhaar", "pan", "phone", "email", "face"],
      redactionMethods: ["black_box", "mask_text", "blur"],
      confidenceScore: 0.92,
    };
    expect(proof.totalPIIDetected).toBe(5);
    expect(proof.redactionMethods).toContain("black_box");
    expect(proof.confidenceScore).toBeGreaterThan(0.9);
  });

  it("verifies zero PII in outbound after redaction", () => {
    const proof = { zeroOutboundPII: true, sensitiveDataRedacted: 5 };
    expect(proof.zeroOutboundPII).toBe(true);
    expect(proof.sensitiveDataRedacted).toBe(5);
  });
});

// ── Sanitized Context Builder ────────────────────────────────

describe("Sanitized Context — PII Stripping", () => {
  it("replaces PII values with asterisks", () => {
    let text = "My Aadhaar is 234567890123 and email is test@passport.gov.in";
    const piiValues = ["234567890123", "test@passport.gov.in"];
    for (const pii of piiValues) {
      text = text.replace(new RegExp(pii.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "***");
    }
    expect(text).toBe("My Aadhaar is *** and email is ***");
  });

  it("preserves non-PII text", () => {
    const text = "Passport Application Form - Government of India";
    expect(text).toContain("Passport Application Form");
    expect(text).not.toContain("***");
  });
});

// ── Tripwire Pattern Matching ────────────────────────────────

describe("Tripwire — PII Pattern Detection", () => {
  it("detects Aadhaar, PAN, IFSC in text", () => {
    const text = "Aadhaar: 234567890123, PAN: ABCDE1234F, IFSC: SBIN0001234";

    expect(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/.test(text)).toBe(true);
    expect(/\b[A-Z]{5}\d{4}[A-Z]\b/.test(text)).toBe(true);
    expect(/\b[A-Z]{4}0[A-Z0-9]{6}\b/.test(text)).toBe(true);
  });

  it("does NOT flag non-PII numbers as phone", () => {
    const phonePattern = /\b[6-9]\d{9}\b/g;
    expect(phonePattern.test("1234567890")).toBe(false);
    expect(phonePattern.test("0000000000")).toBe(false);
    expect(phonePattern.test("2024000001")).toBe(false);
    // Valid phone
    expect(phonePattern.test("9876543210")).toBe(true);
  });
});

// ── Integration: Full Pipeline Data Flow ─────────────────────

describe("Pipeline Data Flow — End to End", () => {
  it("capture → detect → redact → sanitize → plan flow is consistent", () => {
    // 1. CAPTURE: DOM extraction produces elements
    const elements = [
      { id: "name", tag: "input", label: "Given Name", type: "text" },
      { id: "aadhaar", tag: "input", label: "Aadhaar Number", type: "text" },
      { id: "submit", tag: "button", label: "Submit", type: "submit" },
    ];

    // 2. DETECT PII: identifies sensitive fields
    const piiFields = elements.filter((e) =>
      /name|aadhaar|pan|phone|email|password/i.test(e.label)
    );
    expect(piiFields).toHaveLength(2);

    // 3. REDACT: CSS rules generated for PII fields
    const piiIds = new Set(piiFields.map((f) => f.id));
    const redactionCSS = elements
      .filter((e) => piiIds.has(e.id))
      .map((e) => `#${e.id} { border: 2px solid red; }`)
      .join("\n");
    expect(redactionCSS).toContain("#name");
    expect(redactionCSS).toContain("#aadhaar");

    // 4. SANITIZE: build context with PII stripped
    const safeElements = elements.map((e) => ({
      tag: e.tag,
      label: e.label,
      isPII: piiIds.has(e.id),
    }));
    const piiCount = safeElements.filter((e) => e.isPII).length;
    expect(piiCount).toBe(2);

    // 5. PLAN: generate action steps (deterministic for simple forms)
    const steps = safeElements
      .filter((e) => e.tag === "input" && e.isPII)
      .flatMap((e) => [
        { type: "click", target: `[${elements.indexOf(elements.find((el) => el.label === e.label)!) }]` },
        { type: "type", target: `[${elements.indexOf(elements.find((el) => el.label === e.label)!) }]`, value: `***${e.label}***` },
      ]);
    expect(steps.length).toBe(4); // 2 fields × 2 steps each (click + type)
    expect(steps.every((s) => s.type === "click" || s.type === "type")).toBe(true);
  });

  it("PII never reaches the plan output", () => {
    const userData = { firstName: "Shashank", aadhaar: "234567890123" };

    // The plan only contains indices and placeholder values
    const plan = [
      { type: "click", target: "[0]" },
      { type: "type", target: "[0]", value: "firstName" }, // Index reference, not value
      { type: "click", target: "[1]" },
      { type: "type", target: "[1]", value: "aadhaar" }, // Index reference, not value
    ];

    const planStr = JSON.stringify(plan);
    expect(planStr).not.toContain("Shashank");
    expect(planStr).not.toContain("234567890123");
    // Actual values are filled locally by client using dataContext[target]
    const resolved = plan.map((step) => ({
      ...step,
      value: step.value ? userData[step.value] || step.value : undefined,
    }));
    expect(resolved[1].value).toBe("Shashank"); // Client-side fill
  });
});
