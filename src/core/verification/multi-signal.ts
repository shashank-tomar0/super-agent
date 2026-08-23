// ============================================================
// VLESS — Multi-Signal Verification Engine
// After every action, verify it worked using multiple independent signals
// This is what separates us from every other browser agent
// ============================================================

import type {
  AgentAction,
  ActionResult,
  VerificationSignal,
  VerificationResult,
} from "../../types";

// ── Main Verification ────────────────────────────────────────

/**
 * Verify an action succeeded using multiple independent signals.
 * Each signal is checked in parallel. Combined confidence determines pass/fail.
 */
export async function verifyAction(
  action: AgentAction,
  result: ActionResult
): Promise<VerificationResult> {
  const signals: VerificationSignal[] = await Promise.all([
    verifyDOMDiff(action, result),
    verifyURLChange(action, result),
    verifyErrorCheck(action, result),
    verifyAccessibilityTree(action, result),
  ]);

  // Calculate overall confidence
  const passed = calculateOverallConfidence(signals);

  return {
    overallConfidence: passed.confidence,
    passed: passed.success,
    signals,
    unexpectedChanges: detectUnexpectedChanges(result),
  };
}

// ── Signal: DOM Diff ─────────────────────────────────────────

async function verifyDOMDiff(
  action: AgentAction,
  result: ActionResult
): Promise<VerificationSignal> {
  const before = result.pageStateBefore;
  const after = result.pageStateAfter;

  // No DOM data available
  if (!before.url && !after.url) {
    return {
      type: "dom_diff",
      passed: true,
      confidence: 0.5,
      details: "No DOM data available for comparison",
    };
  }

  try {
    // Compare element counts
    const beforeElementCount = before.elements?.length || 0;
    const afterElementCount = after.elements?.length || 0;

    // Compare forms
    const beforeFormCount = before.forms?.length || 0;
    const afterFormCount = after.forms?.length || 0;

    // Compare text content
    const beforeText = before.textContent || "";
    const afterText = after.textContent || "";

    // For click actions: expect page to change
    if (action.type === "click") {
      const pageChanged =
        beforeElementCount !== afterElementCount ||
        beforeFormCount !== afterFormCount ||
        beforeText !== afterText;

      if (pageChanged) {
        return {
          type: "dom_diff",
          passed: true,
          confidence: 0.85,
          details: `Page changed: elements ${beforeElementCount}→${afterElementCount}, ` +
            `forms ${beforeFormCount}→${afterFormCount}`,
        };
      }

      // Page didn't change — might be an error or animation delay
      return {
        type: "dom_diff",
        passed: false,
        confidence: 0.4,
        details: "Page DOM unchanged after click action",
      };
    }

    // For type actions: expect input value to change
    if (action.type === "type") {
      // Check if the target field now has the typed value
      const targetField = after.forms
        ?.flatMap((f) => f.fields)
        .find(
          (f) =>
            f.id === action.target ||
            f.name === action.target
        );

      if (targetField && targetField.value === action.value) {
        return {
          type: "dom_diff",
          passed: true,
          confidence: 0.95,
          details: `Field "${action.target}" now contains "${action.value}"`,
        };
      }

      return {
        type: "dom_diff",
        passed: false,
        confidence: 0.3,
        details: `Field "${action.target}" does not contain expected value`,
      };
    }

    // For navigation: URL should change
    if (action.type === "navigate") {
      return {
        type: "dom_diff",
        passed: before.url !== after.url,
        confidence: before.url !== after.url ? 0.9 : 0.2,
        details: before.url !== after.url
          ? `URL changed: ${before.url} → ${after.url}`
          : "URL unchanged after navigation",
      };
    }

    // Default: assume success if no crash
    return {
      type: "dom_diff",
      passed: true,
      confidence: 0.6,
      details: "DOM diff check passed (default)",
    };
  } catch (error) {
    return {
      type: "dom_diff",
      passed: false,
      confidence: 0.1,
      details: `DOM diff error: ${error}`,
    };
  }
}

// ── Signal: URL Change ───────────────────────────────────────

async function verifyURLChange(
  action: AgentAction,
  result: ActionResult
): Promise<VerificationSignal> {
  const beforeURL = result.pageStateBefore.url;
  const afterURL = result.pageStateAfter.url;

  // Navigation actions should change URL
  if (action.type === "navigate") {
    const urlChanged = beforeURL !== afterURL;
    return {
      type: "url_change",
      passed: urlChanged,
      confidence: urlChanged ? 0.95 : 0.1,
      details: urlChanged
        ? `URL changed from ${beforeURL} to ${afterURL}`
        : "URL did not change after navigation",
    };
  }

  // Click actions might change URL (if it's a link)
  if (action.type === "click") {
    // URL change is optional for clicks
    return {
      type: "url_change",
      passed: true,
      confidence: 0.6,
      details: beforeURL !== afterURL
        ? `URL changed to ${afterURL} (link click)`
        : "URL unchanged (expected for non-link clicks)",
    };
  }

  // Other actions: URL should stay the same
  const urlUnchanged = beforeURL === afterURL;
  return {
    type: "url_change",
    passed: urlUnchanged,
    confidence: urlUnchanged ? 0.7 : 0.3,
    details: urlUnchanged
      ? "URL unchanged as expected"
      : `Unexpected URL change: ${beforeURL} → ${afterURL}`,
  };
}

// ── Signal: Error Check ──────────────────────────────────────

async function verifyErrorCheck(
  _action: AgentAction,
  result: ActionResult
): Promise<VerificationSignal> {
  // Check if action itself returned an error (SW-safe — no document access)
  if (!result.success && result.error) {
    return {
      type: "error_check",
      passed: false,
      confidence: 0.9,
      details: `Action returned error: ${result.error}`,
    };
  }

  // DOM error detection must be done via content script message, not direct document access.
  // For now, return neutral — the content script's executeAction already checks for errors.
  return {
    type: "error_check",
    passed: true,
    confidence: 0.7,
    details: "Error check passed (action returned success)",
  };
}

// ── Signal: Accessibility Tree ───────────────────────────────

async function verifyAccessibilityTree(
  _action: AgentAction,
  _result: ActionResult
): Promise<VerificationSignal> {
  // ARIA live region detection requires DOM access (content script context).
  // This function is designed to be called from the content script, not the SW.
  // When called from SW, return neutral.
  return {
    type: "accessibility_tree",
    passed: true,
    confidence: 0.5,
    details: "Accessibility check deferred to content script",
  };
}

// ── Confidence Calculation ───────────────────────────────────

function calculateOverallConfidence(
  signals: VerificationSignal[]
): { success: boolean; confidence: number } {
  if (signals.length === 0) {
    return { success: false, confidence: 0 };
  }

  // Weighted average — DOM diff and error check are most important
  const weights: Record<string, number> = {
    dom_diff: 0.35,
    url_change: 0.15,
    error_check: 0.3,
    accessibility_tree: 0.15,
    network_request: 0.05,
  };

  let totalWeight = 0;
  let weightedConfidence = 0;

  for (const signal of signals) {
    const weight = weights[signal.type] || 0.1;
    totalWeight += weight;
    weightedConfidence += signal.confidence * weight * (signal.passed ? 1 : 0.3);
  }

  const confidence = totalWeight > 0 ? weightedConfidence / totalWeight : 0;

  // Pass if confidence > 0.6 and at least one key signal passed
  const keySignalsPassed = signals.some(
    (s) =>
      (s.type === "dom_diff" || s.type === "error_check") && s.passed
  );

  return {
    success: confidence > 0.6 && keySignalsPassed,
    confidence,
  };
}

// ── Unexpected Change Detection ──────────────────────────────

function detectUnexpectedChanges(result: ActionResult): string[] {
  const changes: string[] = [];

  // Check for navigation redirects (SW-safe)
  if (result.pageStateBefore.url !== result.pageStateAfter.url) {
    changes.push(
      `Unexpected navigation: ${result.pageStateBefore.url} → ${result.pageStateAfter.url}`
    );
  }

  // DOM-based checks (modals, errors) require content script context.
  // These are handled by the page state comparison in verifyDOMDiff.

  return changes;
}
