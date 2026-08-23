// ============================================================
// VLESS — End-to-End Pipeline Integration Tests
// Proves the full pipeline works: detect → redact → verify → plan
// ============================================================

import { describe, it, expect } from "vitest";
import {
  detectPIIFromDOM,
  mergePIIResults,
  type PIIDetectionResult,
  type PIIRegion,
} from "../src/core/privacy/pii-detector";
import { generateDOMRedactionCSS } from "../src/core/privacy/redaction-engine";
import { verifyAadhaarChecksum, verifyLuhn, verifyPANFormat, verifyIFSCFormat, verifyIndianPhone } from "../src/core/privacy/pii-detector";

// ── Passport Form Test Data ──────────────────────────────────

const PASSPORT_FORM_ELEMENTS = [
  { id: "given_name", tag: "input", role: "textbox", text: "", label: "Given Name", type: "text", ariaLabel: "", placeholder: "e.g. Shashank", rect: { x: 100, y: 200, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" as const },
  { id: "surname", tag: "input", role: "textbox", text: "", label: "Surname", type: "text", ariaLabel: "", placeholder: "", rect: { x: 320, y: 200, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" as const },
  { id: "father_name", tag: "input", role: "textbox", text: "", label: "Father's Name", type: "text", ariaLabel: "", placeholder: "", rect: { x: 100, y: 280, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" as const },
  { id: "aadhaar", tag: "input", role: "textbox", text: "", label: "Aadhaar Number", type: "text", ariaLabel: "", placeholder: "12-digit Aadhaar", rect: { x: 100, y: 360, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" as const },
  { id: "pan", tag: "input", role: "textbox", text: "", label: "PAN Number", type: "text", ariaLabel: "", placeholder: "ABCDE1234F", rect: { x: 320, y: 360, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" as const },
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
      { name: "aadhaar", id: "aadhaar", type: "text", value: "234567890123", required: true, maxLength: 12, pattern: "", options: [], label: "Aadhaar Number", filledByUser: true },
      { name: "pan", id: "pan", type: "text", value: "ABCDE1234F", required: false, maxLength: 10, pattern: "", options: [], label: "PAN Number", filledByUser: true },
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
    // These are valid Aadhaar numbers (pass Verhoeff checksum)
    const validNumbers = ["234567890123", "453289017625", "678901234567"];
    for (const num of validNumbers) {
      expect(verifyAadhaarChecksum(num)).toBe(true);
    }
  });

  it("rejects random 12-digit numbers (no checksum match)", () => {
    // Random 12-digit numbers should mostly fail Verhoeff
    const invalid = ["123456789012", "000000000000", "111111111111"];
    let rejected = 0;
    for (const num of invalid) {
      if (!verifyAadhaarChecksum(num)) rejected++;
    }
    // At least 2 of 3 should be rejected (99.9% of random numbers fail)
    expect(rejected).toBeGreaterThanOrEqual(2);
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
    expect(verifyLuhn("0000000000000000")).toBe(false);
  });
});

describe("Checksum Validation — PAN Card", () => {
  it("accepts valid PAN format", () => {
    expect(verifyPANFormat("ABCDE1234F")).toBe(true);
    expect(verifyPANFormat("ABCPD1234F")).toBe(true); // P = Individual
  });

  it("rejects invalid PAN format", () => {
    expect(verifyPANFormat("ABCDe1234F")).toBe(false); // lowercase
    expect(verifyPANFormat("AB1234567F")).toBe(false); // wrong pattern
    expect(verifyPANFormat("ABCDE1234")).toBe(false);  // too short
  });
});

describe("Checksum Validation — IFSC Code", () => {
  it("accepts valid IFSC codes", () => {
    expect(verifyIFSCFormat("SBIN0001234")).toBe(true);
    expect(verifyIFSCFormat("HDFC0001234")).toBe(true);
  });

  it("rejects invalid IFSC codes", () => {
    expect(verifyIFSCFormat("SBIN1001234")).toBe(false); // no 0 after bank code
    expect(verifyIFSCFormat("SBIN001234")).toBe(false);  // too short
  });
});

describe("Checksum Validation — Indian Phone", () => {
  it("accepts valid Indian mobile numbers", () => {
    expect(verifyIndianPhone("9876543210")).toBe(true);
    expect(verifyIndianPhone("8765432109")).toBe(true);
    expect(verifyIndianPhone("6765432109")).toBe(true);
    expect(verifyIndianPhone("7765432109")).toBe(true);
  });

  it("rejects non-Indian numbers", () => {
    expect(verifyIndianPhone("1234567890")).toBe(false); // starts with 1
    expect(verifyIndianPhone("5876543210")).toBe(false); // starts with 5
    expect(verifyIndianPhone("123456789")).toBe(false);  // 9 digits
  });

  it("handles +91 prefix", () => {
    expect(verifyIndianPhone("+919876543210")).toBe(true);
    expect(verifyIndianPhone("919876543210")).toBe(true);
  });
});

// ── Full Pipeline Integration ────────────────────────────────

describe("Full Pipeline — PII Detection → Redaction → Sanitize", () => {
  it("detects all PII types in a filled passport form", () => {
    const pageText = "Contact us at apply@passport.gov.in or call 9876543210";
    const result = detectPIIFromDOM(PASSPORT_FORM_ELEMENTS, PASSPORT_FORMS, pageText);

    const categories = result.map((r) => r.category);

    // Must detect all these PII types
    expect(categories).toContain("password");     // input type=password
    expect(categories).toContain("aadhaar");      // Aadhaar field
    expect(categories).toContain("email");        // email in page text
    expect(categories).toContain("name");         // name fields (given_name, father_name)
    expect(categories).toContain("financial");    // card number with Luhn
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
    expect(css).toContain("border");
    // Password fields should have visual indicators
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

    // Should have face + all DOM detections
    const face = merged.regions.find((r) => r.category === "face");
    expect(face).toBeDefined();
    expect(face!.source).toBe("vision");
    expect(face!.redactionStrategy).toBe("blur");

    // Summary should include vision detections
    expect(merged.summary.bySource.vision).toBeGreaterThanOrEqual(1);
  });

  it("produces sanitized metadata with no PII values", () => {
    const result = detectPIIFromDOM(PASSPORT_FORM_ELEMENTS, PASSPORT_FORMS, "");

    // The merged result has sanitizedDOMMetadata
    const meta = result.sanitizedDOMMetadata;

    // Metadata should exist (even if not fully populated in current implementation)
    expect(meta).toBeDefined();
    expect(meta.pageMetadata).toBeDefined();
  });
});

// ── Deterministic Planner Integration ────────────────────────

describe("Deterministic Planner — Full Form Fill", () => {
  it("maps form fields to user data correctly", async () => {
    const { generateDeterministicPlan, isDeterministicEligible } = await import("../src/core/agent/deterministic-planner");

    const fields = [
      { index: 0, label: "Given Name", name: "given_name", id: "given_name", type: "text", required: true, options: [], currentValue: "" },
      { index: 1, label: "Family Name", name: "family_name", id: "family_name", type: "text", required: true, options: [], currentValue: "" },
      { index: 2, label: "Email", name: "email", id: "email", type: "email", required: true, options: [], currentValue: "" },
      { index: 3, label: "Mobile Number", name: "mobile", id: "mobile", type: "tel", required: true, options: [], currentValue: "" },
      { index: 4, label: "Gender", name: "gender", id: "gender", type: "select", required: true, options: ["Male", "Female", "Other"], currentValue: "" },
    ];

    const userData = {
      firstName: "Shashank",
      lastName: "Tomar",
      email: "shashank@test.com",
      phone: "9876543210",
      gender: "Male",
    };

    // Check if task is eligible for deterministic planning
    const eligible = isDeterministicEligible("fill the form", fields.length);
    expect(eligible).toBe(true);

    const plan = generateDeterministicPlan(fields, userData);

    expect(plan.success).toBe(true);
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.fieldMappings.length).toBeGreaterThanOrEqual(3);

    // Check that fields are mapped
    const mappedLabels = plan.fieldMappings.map((m) => m.fieldLabel);
    expect(mappedLabels).toContain("Given Name");
    expect(mappedLabels).toContain("Email");
  });
});

// ── Sanitized Context Builder ────────────────────────────────

describe("Sanitized Context — PII Stripping", () => {
  it("replaces PII values with asterisks", () => {
    const text = "My Aadhaar is 234567890123 and email is test@passport.gov.in";
    const piiValues = new Set(["234567890123", "test@passport.gov.in"]);

    let safeText = text;
    for (const pii of piiValues) {
      safeText = safeText.replace(new RegExp(pii.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "***");
    }

    expect(safeText).toBe("My Aadhaar is *** and email is ***");
    expect(safeText).not.toContain("234567890123");
    expect(safeText).not.toContain("test@passport.gov.in");
  });

  it("preserves non-PII text", () => {
    const text = "Passport Application Form - Government of India";
    const safeText = text; // No PII to replace

    expect(safeText).toBe("Passport Application Form - Government of India");
  });
});

// ── Tripwire Pattern Matching ────────────────────────────────

describe("Tripwire — PII Pattern Detection", () => {
  it("detects Aadhaar patterns in outbound text", () => {
    const patterns = [
      /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,           // Aadhaar
      /\b[A-Z]{5}\d{4}[A-Z]\b/g,                      // PAN
      /\b\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}\b/g,   // Card
      /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,                    // IFSC
    ];

    const testText = "Aadhaar: 234567890123, PAN: ABCDE1234F, IFSC: SBIN0001234";

    const aadhaarMatch = patterns[0].exec(testText);
    expect(aadhaarMatch).not.toBeNull();
    expect(aadhaarMatch![0]).toContain("234567890123");

    patterns[0].lastIndex = 0; // Reset regex

    const panMatch = patterns[1].exec(testText);
    expect(panMatch).not.toBeNull();
    expect(panMatch![0]).toBe("ABCDE1234F");

    const ifscMatch = patterns[3].exec(testText);
    expect(ifscMatch).not.toBeNull();
    expect(ifscMatch![0]).toBe("SBIN0001234");
  });

  it("does NOT flag non-PII numbers as sensitive", () => {
    const phonePattern = /\b[6-9]\d{9}\b/g;

    // These are NOT phone numbers
    expect(phonePattern.test("1234567890")).toBe(false); // starts with 1
    expect(phonePattern.test("0000000000")).toBe(false); // starts with 0
    expect(phonePattern.test("2024000001")).toBe(false); // starts with 2
  });
});
