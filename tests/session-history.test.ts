import { describe, it, expect, beforeEach } from "vitest";
import {
  saveSessionRecord,
  getSessions,
  deleteSession,
  clearSessions,
  searchSessions,
  exportSessionAsJson,
  type VlessSessionRecord,
} from "../src/core/privacy/session-history";

describe("Session History Database", () => {
  beforeEach(async () => {
    await clearSessions();
  });

  it("saves and retrieves session records", async () => {
    const record: VlessSessionRecord = {
      sessionId: "sess-1",
      timestamp: 1000,
      taskPrompt: "Fill Aadhaar form",
      targetUrl: "https://example.gov.in/aadhaar",
      domain: "example.gov.in",
      status: "completed",
      durationMs: 450,
      piiSummary: {
        totalDetected: 1,
        categories: { aadhaar: 1 },
        egressBlockedBytes: 0,
      },
      steps: [
        {
          stepIndex: 1,
          action: "type #aadhaar_no",
          targetId: "aadhaar_no",
          sanitizedValue: "[REDACTED_AADHAAR]",
          timestamp: 1000,
        },
      ],
    };

    await saveSessionRecord(record);
    const sessions = await getSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].sessionId).toBe("sess-1");
    expect(sessions[0].taskPrompt).toBe("Fill Aadhaar form");
  });

  it("filters sessions by search query", async () => {
    const r1: VlessSessionRecord = {
      sessionId: "sess-1",
      timestamp: 1000,
      taskPrompt: "Submit Passport Form",
      targetUrl: "https://passport.gov.in",
      domain: "passport.gov.in",
      status: "completed",
      durationMs: 200,
      piiSummary: { totalDetected: 0, categories: {}, egressBlockedBytes: 0 },
      steps: [],
    };

    const r2: VlessSessionRecord = {
      sessionId: "sess-2",
      timestamp: 2000,
      taskPrompt: "Check Income Tax Status",
      targetUrl: "https://incometax.gov.in",
      domain: "incometax.gov.in",
      status: "completed",
      durationMs: 300,
      piiSummary: { totalDetected: 0, categories: {}, egressBlockedBytes: 0 },
      steps: [],
    };

    await saveSessionRecord(r1);
    await saveSessionRecord(r2);

    const passportMatches = await searchSessions("passport");
    expect(passportMatches.length).toBe(1);
    expect(passportMatches[0].sessionId).toBe("sess-1");

    const taxMatches = await searchSessions("incometax");
    expect(taxMatches.length).toBe(1);
    expect(taxMatches[0].sessionId).toBe("sess-2");
  });

  it("deletes a single session record", async () => {
    const r1: VlessSessionRecord = {
      sessionId: "sess-1",
      timestamp: 1000,
      taskPrompt: "Task 1",
      targetUrl: "https://a.com",
      domain: "a.com",
      status: "completed",
      durationMs: 100,
      piiSummary: { totalDetected: 0, categories: {}, egressBlockedBytes: 0 },
      steps: [],
    };

    await saveSessionRecord(r1);
    expect((await getSessions()).length).toBe(1);

    await deleteSession("sess-1");
    expect((await getSessions()).length).toBe(0);
  });

  it("exports session record as JSON", async () => {
    const r1: VlessSessionRecord = {
      sessionId: "sess-json",
      timestamp: 1000,
      taskPrompt: "Export Test",
      targetUrl: "https://b.com",
      domain: "b.com",
      status: "completed",
      durationMs: 100,
      piiSummary: { totalDetected: 0, categories: {}, egressBlockedBytes: 0 },
      steps: [],
    };

    await saveSessionRecord(r1);
    const jsonStr = await exportSessionAsJson("sess-json");
    expect(jsonStr).toContain("sess-json");
    expect(jsonStr).toContain("Export Test");
  });
});
