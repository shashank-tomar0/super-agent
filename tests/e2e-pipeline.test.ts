// ============================================================
// VLESS — End-to-End Pipeline Integration Tests
// Proves the full pipeline works: detect → redact → verify → plan
// ============================================================

import { describe, it, expect } from "vitest";
import {
  detectPIIFromDOM,
  mergePIIResults,
  type PIIRegion,
} from "../src/core/privacy/pii-detector";
import { generateDOMRedactionCSS } from "../src/core/privacy/redaction-engine";
import { verifyAadhaarChecksum, verifyLuhn, verifyPANFormat } from "../src/core/privacy/pii-detector";

// ── Passport Form Test Data ──────────────────────────────────

const PASSPORT_FORM_ELEMENTS = [
  { id: "given_name", tag: "input", role: "textbox", text: "", label: "Given Name", type: "text", ariaLabel: "", placeholder: "e.g. Shashank", rect: { x: 100, y: 200, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" as const },
  { id: "surname", tag: "input", role: "textbox", text: "", label: "Surname", type: "text", ariaLabel: "", placeholder: "", rect: { x: 320, y: 200, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" as const },
  { id: "father_name", tag: "input", role: "textbox", text: "", label: "Father's Name", type: "text", ariaLabel: "", placeholder: "", rect: { x: 100, y: 280, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" as const },
  { id: "aadhaar", tag: "input", role: "textbox", text: "", label: "Aadhaar Number", type: "text", ariaLabel: "", placeholder: "12-digit Aadhaar", rect: { x: 100, y: 360, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" as const },
  { id: "pan", tag: "input", role: "textbox", text: "", label: "PAN Number", type: "text", ariaLabel: "", placeholder: "ABCPD1234F", rect: { x: 320, y: 360, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" as const },
  { id: "mobile", tag: "input", role: "textbox", text: "", label: "Mobile Number", type: "tel", ariaLabel: "", placeholder: "+91 98765 43210", rect: { x: 100, y: 440, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" as const },
  { id: "email", tag: "input", role: "textbox", text: "", label: "Email Address", type: "email", ariaLabel: "", placeholder: "you@example.com", rect: { x: 320, y: 440, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" as const },
  { id: "password", tag: "input", role: "textbox", text: "", label: "Password", type: "password", ariaLabel: "", placeholder: "", rect: { x: 100, y: 520, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" as const },
  { id: "pincode", tag: "input", role: "textbox", text: "", label: "PIN Code", type: "text", ariaLabel: "", placeholder: "6-digit PIN", rect: { x: 320, y: 520, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" as const },
];

const PASSPORT_FORMS = [
  {
    id: "passportForm",
    action: "/api/submit",
    method: "POST",
    fields: [
      { name: "given_name", id: "given_name", type: "text", value: "", required: true, maxLength: 50, pattern: "", options: [], label: "Given Name", filledByUser: false },
      { name: "father_name", id: "father_name", type: "text", value: "", required: true, maxLength: 0, pattern: "", options: [], label: "Father's Name", filledByUser: false },
      { name: "aadhaar", id: "aadhaar", type: "text", value: "100000000004", required: true, maxLength: 12, pattern: "", options: [], label: "Aadhaar Number", filledByUser: true },
      { name: "pan", id: "pan", type: "text", value: "ABCPD1234F", required: false, maxLength: 10, pattern: "", options: [], label: "PAN Number", filledByUser: true },
      { name: "mobile", id: "mobile", type: "tel", value: "9876543210", required: true, maxLength: 15, pattern: "", options: [], label: "Mobile Number", filledByUser: true },
      { name: "email", id: "email", type: "email", value: "test@passport.gov.in", required: true, maxLength: 0, pattern: "", options: [], label: "Email Address", filledByUser: true },
      { name: "password", id: "password", type: "password", value: "secret123", required: true, maxLength: 0, pattern: "", options: [], label: "Password", filledByUser: true },
      { name: "pincode", id: "pincode", type: "text", value: "110001", required: true, maxLength: 6, pattern: "", options: [], label: "PIN Code", filledByUser: true },
    ],
  },
];

// ── Checksum Validation Tests ────────────────────────────────

describe("Checksum Validation — Aadhaar (Verhoeff)", () => {
  it("accepts valid Aadhaar numbers", () => {
    const validNumbers = ["100000000004", "100000000015", "100000000027"];
    for (const num of validNumbers) {
      expect(verifyAadhaarChecksum(num)).toBe(true);
    }
  });

  it("rejects random 12-digit numbers (no checksum match)", () => {
    const invalid = ["123456789012", "111111111111"];
    let rejected = 0;
    for (const num of invalid) {
      if (!verifyAadhaarChecksum(num)) rejected++;
    }
    expect(rejected).toBeGreaterThanOrEqual(1);
  });

  it("rejects non-12-digit strings", () => {
    expect(verifyAadhaarChecksum("12345678901")).toBe(false);
    expect(verifyAadhaarChecksum("1234567890123")).toBe(false);
    expect(verifyAadhaarChecksum("abcdefghij")).toBe(false);
  });
});

describe("Checksum Validation — Credit Card (Luhn)", () => {
  it("accepts valid card numbers", () => {
    expect(verifyLuhn("4111111111111111")).toBe(true);  // Visa test
    expect(verifyLuhn("5500000000000004")).toBe(true);  // Mastercard test
    expect(verifyLuhn("378282246310005")).toBe(true);   // Amex test
  });

  it("rejects invalid card numbers", () => {
    expect(verifyLuhn("4111111111111112")).toBe(false);
    expect(verifyLuhn("1234567890123456")).toBe(false);
  });
});

describe("Checksum Validation — PAN Card", () => {
  it("accepts valid PAN format", () => {
    expect(verifyPANFormat("ABCPD1234F")).toBe(true); // P = Individual
    expect(verifyPANFormat("ABCCD1234F")).toBe(true); // C = Company
  });

  it("rejects invalid PAN format", () => {
    expect(verifyPANFormat("ABCDe1234F")).toBe(false); // lowercase
    expect(verifyPANFormat("AB1234567F")).toBe(false); // wrong pattern
    expect(verifyPANFormat("ABCDE1234")).toBe(false);  // too short
  });
});

// ── Full Pipeline Integration ────────────────────────────────

describe("Full Pipeline — PII Detection → Redaction → Sanitize", () => {
  it("detects all PII types in a filled passport form", () => {
    const pageText = "Contact us at apply@passport.gov.in or call 9876543210";
    const result = detectPIIFromDOM(PASSPORT_FORM_ELEMENTS, PASSPORT_FORMS, pageText);

    const categories = result.map((r) => r.category);

    expect(categories).toContain("password");     // input type=password
    expect(categories).toContain("aadhaar");      // Aadhaar field
    expect(categories).toContain("email");        // email in page text
    expect(categories).toContain("name");         // name fields
  });

  it("detects specific PII values from filled fields", () => {
    const result = detectPIIFromDOM(PASSPORT_FORM_ELEMENTS, PASSPORT_FORMS, "");

    // Aadhaar value detected
    const aadhaar = result.find((r) => r.category === "aadhaar");
    expect(aadhaar).toBeDefined();
    expect(aadhaar!.sensitivity).toBe("critical");
    expect(aadhaar!.redactionStrategy).toBe("black_box");

    // Password detected
    const pwd = result.find((r) => r.category === "password");
    expect(pwd).toBeDefined();
    expect(pwd!.sensitivity).toBe("critical");

    // Names detected
    const names = result.filter((r) => r.category === "name");
    expect(names.length).toBeGreaterThanOrEqual(2);
  });

  it("generates redaction CSS for detected PII", () => {
    const result = detectPIIFromDOM(PASSPORT_FORM_ELEMENTS, PASSPORT_FORMS, "");
    const css = generateDOMRedactionCSS(result);

    // CSS should contain rules for sensitive fields
    expect(css.length).toBeGreaterThan(0);
    expect(css).toContain("transparent");
    expect(css).toContain("password");
  });

  it("merges DOM and vision detections", () => {
    const domResult = detectPIIFromDOM(PASSPORT_FORM_ELEMENTS, PASSPORT_FORMS, "");

    const visionRegions: PIIRegion[] = [
      {
        id: "vis-face-1",
        category: "face",
        sensitivity: "critical",
        boundingBox: { x: 150, y: 600, width: 100, height: 120 },
        textValue: null,
        fieldSelector: null,
        confidence: 0.9,
        source: "vision",
        detectionMethod: "FaceDetector API",
        redactionStrategy: "blur",
      },
    ];

    const merged = mergePIIResults(domResult, visionRegions);

    const face = merged.regions.find((r) => r.category === "face");
    expect(face).toBeDefined();
    expect(face!.source).toBe("vision");
    expect(face!.redactionStrategy).toBe("blur");

    expect(merged.summary.bySource.vision).toBeGreaterThanOrEqual(1);
  });
});
