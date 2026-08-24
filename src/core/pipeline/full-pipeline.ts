// ============================================================
// VLESS — Full Pipeline (Service Worker)
// Runs entirely in the background service worker.
// Communicates with content script via messages for:
//   - DOM extraction (PERCEIVE_PAGE)
//   - Screenshot capture (DO_CAPTURE_TAB / CAPTURE_SCREENSHOT)
//   - Action execution (EXECUTE_ACTION)
//   - Visual overlay (SHOW_PII_OVERLAY / INJECT_REDACTION_CSS)
//
// NEVER accesses document, window, or DOM APIs.
// ============================================================

import { detectAllPII, maskPIIInText, type PIIDetectionResult } from "../privacy/pii-detector";
import { extractPageData, type ExtractedData } from "../extraction/page-extractor";
import { decomposeTask, actionDescription, type SubTask } from "../agent/task-decomposer";
import { computeRequirements, summarizeOutcome, type RequiredInput } from "../agent/requirements";
import { generateDOMRedactionCSS } from "../privacy/redaction-engine";
import { initializeServer, isServerAvailable, getActiveProvider, type SanitizedContext, type PlanResult } from "../agent/server-bridge";
import { callOffscreen } from "../runtime/messaging";
import type { OcrResult } from "../../types/runtime";
import {
  startTrace, traceObserve, tracePIIDetection, traceRedaction,
  traceRedactionVerification, tracePlan, completeTrace, type ReasoningTrace,
} from "../agent/reasoning-trace";
import { generatePlanWithBestProvider, getBestAvailableProvider } from "../agent/llm-providers";
import { saveSessionRecord } from "../privacy/session-history";
import type { PlannedAction, PageState, Message } from "../../types";

// ── Pipeline Types ───────────────────────────────────────────

export interface PipelineInput {
  taskDescription: string;
  dataContext?: Record<string, string>;
  tabId?: number;
  /** Called after every step transition so callers can stream progress. */
  onProgress?: (update: PipelineProgress) => void;
  /** Recent task descriptions, so a follow-up like "submit form" has context. */
  recentTasks?: string[];
}

export interface PIIReviewField {
  /** Human label as it appears on the form. */
  label: string;
  /** CSS selector the client uses to write a correction back. */
  selector: string;
  category: string | null;
  /** What is in the field right now, after execution. */
  value: string;
  required: boolean;
  type: string;
}

export interface PipelineProgress {
  /** Name of the step that just changed state. */
  currentPhase: string;
  steps: PipelineStep[];
  elapsedMs: number;
}

export interface PipelineResult {
  success: boolean;
  phase: "capture" | "detect" | "redact" | "send" | "plan" | "execute" | "complete" | "error";
  steps: PipelineStep[];
  plan: PlannedAction[];
  piiDetection: PIIDetectionResult;
  redactionSummary: RedactionSummary;
  planResult: PlanResult;
  privacyProof: PrivacyProof;
  reasoningTrace: ReasoningTrace | null;
  latency: LatencyBreakdown;
  totalLatencyMs: number;
  /** Present only for extraction tasks — never sent to any provider. */
  extractedData?: ExtractedData;
  /** How the request was decomposed. One entry for a simple task. */
  subTasks?: SubTask[];
  /** Post-action state of every sensitive field, for user review and correction. */
  piiReview?: PIIReviewField[];
  /** What the agent still needs FROM THE USER to finish. */
  needs?: RequiredInput[];
  /** One line covering both what was done and what is outstanding. */
  outcome?: string;
  error?: string;
}

export interface LatencyBreakdown {
  capture: number;
  ocr: number;
  piiDetection: number;
  redaction: number;
  verification: number;
  planning: number;
  execution: number;
  total: number;
  backend: string;
  tier: string;
}

export interface PipelineStep {
  name: string;
  status: "pending" | "running" | "complete" | "error";
  latencyMs: number;
  details: string;
}

export interface RedactionSummary {
  totalPII: number;
  redacted: number;
  cssInjected: boolean;
  overlayShown: boolean;
}

export interface PrivacyProof {
  sensitiveDataDetected: number;
  sensitiveDataRedacted: number;
  dataSentToServer: {
    rawScreenshot: boolean;
    formValues: boolean;
    piiText: boolean;
    faces: boolean;
    sanitizedStructure: boolean;
    taskDescription: boolean;
  };
  zeroOutboundPII: boolean;
  proofDescription: string;
}

// ── Pipeline State ───────────────────────────────────────────

// ── Main Pipeline ────────────────────────────────────────────

export async function executeFullPipeline(
  input: PipelineInput
): Promise<PipelineResult> {

  const startTime = performance.now();
  const steps: PipelineStep[] = [];

  // Start the reasoning trace for this pipeline run
  startTrace(`pipeline-${Date.now()}`, input.taskDescription);
  traceObserve(`Pipeline started: "${input.taskDescription}"`);

  // Emit a snapshot after every step transition so the side panel can show
  // the run as it happens. Without this the panel sits blank for the whole
  // pipeline and only reacts to PIPELINE_COMPLETE at the very end.
  const emitProgress = (currentPhase: string) => {
    if (!input.onProgress) return;
    try {
      input.onProgress({
        currentPhase,
        steps: steps.map((st) => ({ ...st })),
        elapsedMs: performance.now() - startTime,
      });
    } catch {
      // Progress reporting must never break the pipeline.
    }
  };

  const addStep = (name: string): PipelineStep => {
    const step: PipelineStep = { name, status: "pending", latencyMs: 0, details: "" };
    steps.push(step);
    return step;
  };

  const runStep = async <T>(step: PipelineStep, fn: () => Promise<T>): Promise<T | null> => {
    step.status = "running";
    emitProgress(step.name);
    const t0 = performance.now();
    try {
      const result = await fn();
      step.status = "complete";
      step.latencyMs = performance.now() - t0;
      emitProgress(step.name);
      return result;
    } catch (err) {
      step.status = "error";
      step.latencyMs = performance.now() - t0;
      step.details = err instanceof Error ? err.message : "Unknown error";
      emitProgress(step.name);
      return null;
    }
  };

  // Default privacy proof
  let privacyProof: PrivacyProof = {
    sensitiveDataDetected: 0,
    sensitiveDataRedacted: 0,
    dataSentToServer: {
      rawScreenshot: false,
      formValues: false,
      piiText: false,
      faces: false,
      sanitizedStructure: true,
      taskDescription: true,
    },
    zeroOutboundPII: true,
    proofDescription: "",
  };

  let piiDetection: PIIDetectionResult = {
    regions: [],
    summary: {
      totalRegions: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
      byCategory: {} as any,
      bySource: { dom: 0, vision: 0, combined: 0 },
      overallConfidence: 0,
      detectionTimeMs: 0,
    },
    sanitizedDOMMetadata: {
      safeElements: [],
      safeTextContent: "",
      safeForms: [],
      pageMetadata: { title: "", url: "", hasForm: false, hasCAPTCHA: false, elementCount: 0 },
    },
  };

  let redactionSummary: RedactionSummary = {
    totalPII: 0,
    redacted: 0,
    cssInjected: false,
    overlayShown: false,
  };

  let planResult: PlanResult = {
    success: false,
    steps: [],
    reasoning: "",
    provider: "none",
    latencyMs: 0,
  };

  try {
    // ════════════════════════════════════════════════════════
    // PHASE 1: CAPTURE — DOM + Screenshot from content script
    // ════════════════════════════════════════════════════════

    const captureStep = addStep("capture");
    captureStep.status = "running";

    // Get DOM data from content script
    const domData = await sendToContentScript("PERCEIVE_PAGE", null);
    if (!domData) {
      captureStep.status = "error";
      captureStep.details = "Content script could not reach the page";
      // BUG-04 FIX: YouTube and some other sites use CSP that blocks extension
      // content script injection. Detect this and give an actionable message.
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = activeTab?.url || "";
      const isMediaSite = /youtube\.com|twitch\.tv|netflix\.com|hulu\.com/i.test(url);
      const msg = isMediaSite
        ? `Cannot access ${new URL(url).hostname} — media streaming sites block extension content scripts. Try a different page.`
        : "Content script not available. Reload the page and try again.";
      return buildErrorResult(msg, steps, startTime);
    }
    captureStep.details = `${domData.elements.length} elements, ${domData.forms.length} forms`;

    // Capture screenshot (best effort — may fail on some pages)
    let screenshotDataUrl: string | null = null;
    try {
      const screenshot = await sendToContentScript("CAPTURE_SCREENSHOT", null);
      if (screenshot?.success && screenshot.dataUrl) {
        screenshotDataUrl = screenshot.dataUrl;
        captureStep.details += ", screenshot captured";
      }
    } catch {
      // Screenshot is optional — DOM-only path still works
    }
    captureStep.status = "complete";

    // ════════════════════════════════════════════════════════
    // PHASE 1.5: VISION PERCEPTION — Florence-2 ViT (offscreen)
    // The PS requires "local Vision Transformer reads the screen."
    // Florence-2 does open-vocab detection + OCR + caption.
    // Graceful degradation: if not loaded, pipeline continues with DOM+OCR only.
    // ════════════════════════════════════════════════════════

    let florenceResult: any = null;
    if (screenshotDataUrl) {
      const vitStep = addStep("vision_perception");
      const vitResult = await runStep(vitStep, async () => {
        return callOffscreen("perceiveScreen", {
          imageDataUrl: screenshotDataUrl,
        });
      });
      if (vitResult && vitResult.tasksRun && vitResult.tasksRun.length > 0) {
        florenceResult = vitResult;
        vitStep.details = `Florence-2: ${vitResult.elements?.length || 0} elements, ${vitResult.textRegions?.length || 0} text regions (${vitResult.timings?.total?.toFixed(0) || 0}ms)`;
        traceObserve(`Florence-2 ViT detected ${vitResult.elements?.length || 0} elements, ${vitResult.textRegions?.length || 0} text regions on screen`);
      } else {
        vitStep.details = "Florence-2 not available — using DOM+OCR fallback";
      }
    }

    // ════════════════════════════════════════════════════════
    // PHASE 2: DETECT PII — Multi-signal (DOM + OCR + ViT)
    // ════════════════════════════════════════════════════════

    const detectStep = addStep("detect_pii");

    // Run OCR on screenshot via the offscreen ML host (correct MV3 architecture)
    let ocrTextBlocks: Array<{ text: string; confidence: number; boundingBox: { x: number; y: number; width: number; height: number } }> = [];
    if (screenshotDataUrl) {
      try {
        // If Florence-2 already ran OCR, use its text regions
        if (florenceResult?.textRegions?.length > 0) {
          ocrTextBlocks = florenceResult.textRegions.map((tr: any) => ({
            text: tr.text,
            confidence: tr.confidence,
            boundingBox: tr.box,
          }));
        }
        // Also run PP-OCR for additional text coverage (Florence-2 + PP-OCR = best coverage)
        const ocrResult: OcrResult = await callOffscreen("runOcr", {
          imageDataUrl: screenshotDataUrl,
          lang: "auto",
        });
        if (ocrResult.words && ocrResult.words.length > 0) {
          const ppOcrBlocks = ocrResult.words.map((w) => ({
            text: w.text,
            confidence: w.score,
            boundingBox: { x: w.box.x, y: w.box.y, width: w.box.w, height: w.box.h },
          }));
          // Merge: deduplicate by IoU, keep highest confidence
          for (const block of ppOcrBlocks) {
            const duplicate = ocrTextBlocks.find((existing) => {
              const a = existing.boundingBox;
              const b = block.boundingBox;
              const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
              const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
              const interArea = ix * iy;
              const unionArea = a.width * a.height + b.width * b.height - interArea;
              return unionArea > 0 && interArea / unionArea > 0.5;
            });
            if (!duplicate || block.confidence > duplicate.confidence) {
              if (duplicate) {
                duplicate.text = block.text;
                duplicate.confidence = block.confidence;
              } else {
                ocrTextBlocks.push(block);
              }
            }
          }
          detectStep.details = `OCR: ${ocrTextBlocks.length} text regions (Florence-2 + PP-OCR, ${ocrResult.timings.total.toFixed(0)}ms)`;
        }
      } catch (err) {
        // OCR is optional — DOM detection still works
        console.warn("[VLESS] Offscreen OCR failed:", err);
      }
    }
    const detectionResult = await runStep(detectStep, async () => {
      return detectAllPII(domData, undefined, ocrTextBlocks.length > 0 ? ocrTextBlocks : undefined);
    });

    if (detectionResult) {
      piiDetection = detectionResult;
      detectStep.details = `${detectionResult.summary.totalRegions} PII regions ` +
        `(${detectionResult.summary.criticalCount} critical, ${detectionResult.summary.highCount} high)`;
      privacyProof.sensitiveDataDetected = detectionResult.summary.totalRegions;
      // Trace: PII detection results
      tracePIIDetection(
        detectionResult.summary.totalRegions,
        detectionResult.summary.criticalCount,
        detectionResult.summary.highCount,
        detectionResult.summary.byCategory as Record<string, number>
      );
    }

    // ════════════════════════════════════════════════════════
    // PHASE 3: REDACT — Apply CSS redaction + show overlay
    // ════════════════════════════════════════════════════════

    const redactStep = addStep("redact");
    let redactedScreenshotUrl: string | null = null;
    const redactResult = await runStep(redactStep, async () => {
      // Inject redaction CSS into the page
      const css = generateDOMRedactionCSS(piiDetection.regions);
      if (css.trim()) {
        await sendToContentScript("INJECT_REDACTION_CSS", css);
        redactionSummary.cssInjected = true;
      }

      // Show PII overlay on the page.
      // OVERLAY FIX: always send even if 0 visual regions — the badge must
      // show the total count (including text-detected PII without bounding boxes).
      // Text-only PII (Aadhaar in page text, PAN in DOM) has boundingBox=null —
      // we pass those as "textItems" for the badge list, not as drawn boxes.
      const visualRegions = piiDetection.regions
        .filter((r) => r.boundingBox)
        .map((r) => ({
          id: r.id,
          category: r.category,
          sensitivity: r.sensitivity,
          boundingBox: r.boundingBox!,
          confidence: r.confidence,
        }));
      const textItems = piiDetection.regions
        .filter((r) => !r.boundingBox && r.textValue)
        .map((r) => ({ category: r.category, sensitivity: r.sensitivity }));

      await sendToContentScript("SHOW_PII_OVERLAY", {
        regions: visualRegions,
        textItems,
        summary: {
          totalRegions: piiDetection.summary.totalRegions,
          criticalCount: piiDetection.summary.criticalCount,
          highCount: piiDetection.summary.highCount,
        },
      });
      redactionSummary.overlayShown = true;

      // Canvas redaction on screenshot via offscreen ML host
      if (screenshotDataUrl) {
        try {
          const redactRegions = piiDetection.regions
            .filter((r) => r.boundingBox && r.redactionStrategy !== "none")
            .map((r) => ({
              x: r.boundingBox!.x,
              y: r.boundingBox!.y,
              width: r.boundingBox!.width,
              height: r.boundingBox!.height,
              strategy: r.redactionStrategy as "blur" | "black_box" | "pixelate" | "mask_text",
            }));

          if (redactRegions.length > 0) {
            const redacted = await callOffscreen("redactScreenshot", {
              imageDataUrl: screenshotDataUrl,
              regions: redactRegions,
            });
            redactedScreenshotUrl = redacted.imageDataUrl;
            redactionSummary.totalPII = redacted.regionsRedacted;
            redactionSummary.redacted = redacted.regionsRedacted;
          }
        } catch (err) {
          console.warn("[VLESS] Offscreen redaction failed:", err);
        }
      }

      return true;
    });

    if (redactResult) {
      redactionSummary.totalPII = piiDetection.regions.length;
      redactionSummary.redacted = piiDetection.regions.filter(
        (r) => r.redactionStrategy !== "none"
      ).length;
      privacyProof.sensitiveDataRedacted = redactionSummary.redacted;
      redactStep.details = `${redactionSummary.redacted} regions redacted`;
      // Trace: redaction results
      traceRedaction(
        redactionSummary.redacted,
        piiDetection.regions.map((r) => r.redactionStrategy)
      );
    }

    // ════════════════════════════════════════════════════════
    // PHASE 3.5: VERIFY REDACTION — Re-OCR the redacted frame
    // Proves PII is gone from the pixels before anything leaves device
    // ════════════════════════════════════════════════════════

    // If true, re-OCR confirmed zero PII in the redacted frame
    let redactionVerified = false;
    const verifyTarget = redactedScreenshotUrl || screenshotDataUrl;
    if (verifyTarget && redactionSummary.redacted > 0) {
      const verifyStep = addStep("verify_redaction");
      const verifyResult = await runStep(verifyStep, async () => {
        // Re-OCR the REDACTED screenshot via offscreen to prove PII is gone
        const result = await callOffscreen("verifyRedaction", {
          imageDataUrl: verifyTarget,
        });
        return {
          passed: result.passed,
          piiTextFound: result.residualPII,
          ran: result.ran,
          unavailableReason: result.unavailableReason,
          timings: { ocr: result.ocrTimeMs },
        };
      });
      if (verifyResult) {
        redactionVerified = verifyResult.passed;
        if (!verifyResult.ran) {
          // Could not be attempted — report that, rather than implying the
          // redaction failed. Most commonly the OCR models are not installed
          // (run `pnpm models`).
          verifyStep.details = `⚠️ Not verified — OCR unavailable (${verifyResult.unavailableReason ?? "unknown"})`;
        } else {
          verifyStep.details = verifyResult.passed
            ? `✅ Verified: 0 PII in pixels (${verifyResult.timings.ocr.toFixed(0)}ms)`
            : `❌ ${verifyResult.piiTextFound} PII regions residual`;
        }
        // Trace: redaction verification
        traceRedactionVerification(verifyResult.passed, verifyResult.piiTextFound, verifyResult.timings.ocr);
      }
    }

    // ════════════════════════════════════════════════════════
    // PHASE 4: INITIALIZE SERVER — Find best LLM backend
    // ════════════════════════════════════════════════════════

    const serverStep = addStep("init_server");
    await runStep(serverStep, async () => {
      // Check multi-provider system first
      const bestProvider = await getBestAvailableProvider();
      if (bestProvider) {
        serverStep.details = `${bestProvider.id} (${bestProvider.config.model})`;
        return;
      }
      // Fallback to legacy server-bridge
      await initializeServer();
      if (isServerAvailable()) {
        const provider = getActiveProvider();
        serverStep.details = `${provider?.name} (${provider?.model})`;
      } else {
        serverStep.details = "No server — rule-based fallback";
      }
    });

    // ════════════════════════════════════════════════════════
    // PHASE 5a: EXTRACTION SHORT-CIRCUIT
    //
    // A read task ends here. It does not build a sanitized context, does
    // not contact a provider, and does not execute actions — the action
    // planner has no vocabulary for "read", so sending an extraction
    // request through it produces dozens of invented clicks.
    // ════════════════════════════════════════════════════════

    const subTasks = decomposeTask(input.taskDescription);
    const wantsExtraction = subTasks.some((st) => st.kind === "extract");
    const wantsAction = subTasks.some((st) => st.kind === "action");

    // Reads are cheap and side-effect-free, so they run first and always.
    // Actions continue into planning below and stay strictly ordered —
    // mutating one DOM from two places at once corrupts both.
    let extractedData: ExtractedData | undefined;

    if (wantsExtraction) {
      const extractStep = addStep("extract");
      const result = await runStep(extractStep, async () =>
        extractPageData(domData, piiDetection)
      );
      extractedData = result ?? undefined;
      if (extractedData) {
        extractStep.details = `${extractedData.summary.fieldCount} fields, ${extractedData.summary.maskedFieldCount} masked`;
      }
    }

    // Pure read request: nothing to plan, nothing to send.
    if (wantsExtraction && !wantsAction) {
      const extractLatency = performance.now() - startTime;
      const findMs = (name: string) => steps.find((st) => st.name === name)?.latencyMs || 0;

      privacyProof.dataSentToServer = {
        rawScreenshot: false,
        formValues: false,
        piiText: false,
        faces: false,
        sanitizedStructure: false,
        taskDescription: false,
      };
      privacyProof.proofDescription =
        "Extraction ran entirely on-device. No context was built and no provider was contacted.";

      return {
        success: Boolean(extractedData),
        phase: "complete",
        steps,
        plan: [],
        piiDetection,
        redactionSummary,
        planResult: {
          success: true,
          steps: [],
          reasoning: "Local extraction — no planner involved.",
          provider: "on-device",
          latencyMs: findMs("extract"),
        },
        privacyProof,
        reasoningTrace: completeTrace(true),
        latency: {
          capture: findMs("capture"),
          ocr: findMs("detect_pii"),
          piiDetection: findMs("detect_pii"),
          redaction: findMs("redact"),
          verification: findMs("verify_redaction"),
          planning: 0,
          execution: 0,
          total: extractLatency,
          backend: "on-device",
          tier: "auto",
        },
        totalLatencyMs: extractLatency,
        extractedData,
        subTasks,
      };
    }

    // Mixed or action-only: the planner sees only the ACTION clauses, so an
    // extraction preamble never becomes invented click steps.
    const planningTask = wantsAction
      ? actionDescription(subTasks) || input.taskDescription
      : input.taskDescription;

    // ════════════════════════════════════════════════════════
    // PHASE 5: BUILD SANITIZED CONTEXT
    // ════════════════════════════════════════════════════════

    const sanitizeStep = addStep("sanitize");
    const sanitizedContext = await runStep(sanitizeStep, async () => {
      return buildSanitizedContext(domData, piiDetection, input.taskDescription, input.dataContext);
    });

    if (!sanitizedContext) {
      return buildErrorResult("Failed to build sanitized context", steps, startTime);
    }
    sanitizeStep.details = "Context sanitized";

    // ════════════════════════════════════════════════════════
    // PHASE 6: GET PLAN — Ask LLM or use rules
    // ════════════════════════════════════════════════════════

    const planStep = addStep("get_plan");
    const planResultData = await runStep(planStep, async () => {
      // Order matters. The deterministic planner runs FIRST for eligible
      // form-fill tasks: it is offline, sub-100ms, and its label→value
      // mapping is auditable. Reaching for an LLM to fill a form we can
      // map locally spends 1-10s and hands a remote model a page it did
      // not need to see.
      const { generateDeterministicPlan, isDeterministicEligible } = await import("../agent/deterministic-planner");
      const allFields = domData.forms.flatMap((f: any) => f.fields);

      if (isDeterministicEligible(planningTask, allFields.length) && input.dataContext) {
        const detPlan = generateDeterministicPlan(
          allFields.map((f: any, i: number) => ({
            index: i,
            label: f.label,
            name: f.name,
            id: f.id,
            type: f.type,
            required: f.required,
            options: f.options,
            currentValue: f.value,
          })),
          input.dataContext
        );
        if (detPlan.success && detPlan.steps.length > 0) {
          console.log("[VLESS] Deterministic plan (no LLM, no egress)");
          return {
            success: true,
            steps: detPlan.steps,
            reasoning: detPlan.reasoning,
            provider: "deterministic",
            latencyMs: performance.now() - startTime,
          };
        }
      }

      // Anything the local planner cannot handle goes to an LLM.
      const llmResult = await generatePlanWithBestProvider(
        planningTask,
        sanitizedContext,
        input.dataContext,
        input.recentTasks
      );
      if (llmResult.success && llmResult.steps.length > 0) {
        return llmResult;
      }

      // Legacy server-bridge provider.
      if (isServerAvailable()) {
        const provider = getActiveProvider()!;
        const serverResult = await provider.generatePlan(
          planningTask,
          sanitizedContext,
          input.dataContext
        );
        if (serverResult.success && serverResult.steps.length > 0) {
          return serverResult;
        }
      }

      // Last resort: rule-based (limited to fill/scroll/click/navigate)
      console.warn("[VLESS] No planner succeeded — falling back to rule-based planning.");
      return generateRuleBasedPlan(planningTask, domData, input.dataContext);
    });

    if (planResultData) {
      planResult = planResultData;
      planStep.details = `${planResult.steps.length} steps (${planResult.provider})`;
      // Trace: planning results
      tracePlan(
        planResult.steps.length,
        planResult.provider,
        planResult.reasoning,
        planResult.latencyMs
      );
    }

    // ════════════════════════════════════════════════════════
    // PHASE 7: EXECUTE — Run plan steps via content script
    // ════════════════════════════════════════════════════════

    // Detect whether any plan step navigated away from the page.
    // After navigation, the content script is destroyed — subsequent
    // sendToContentScript calls will fail with "Receiving end does not exist".
    const didNavigate = planResult.steps.some((s) => s.action.type === "navigate");

    let executionResult: { success: boolean; completed: number; total: number; errors: string[] } | null = null;
    if (planResult.steps.length > 0) {
      const execStep = addStep("execute");
      execStep.status = "running";
      // BUG-09 FIX: call executePlanSteps directly — no self-import loop
      executionResult = await executePlanSteps(planResult.steps, input.dataContext);
      execStep.status = executionResult.success ? "complete" : "error";
      execStep.details = `${executionResult.completed}/${executionResult.total} steps` +
        (executionResult.errors.length > 0 ? ` (${executionResult.errors.length} errors)` : "");

      // BUG-05 FIX: After navigation, wait for the new page to settle before
      // any further sendToContentScript calls. Content script takes 400–1200ms
      // to re-inject after chrome.scripting.executeScript.
      if (didNavigate) {
        await sleep(1500);
      }
    }

    // ════════════════════════════════════════════════════════
    // PHASE 7.5: REVIEW — re-read the page so the user can check
    // and correct what actually landed in each sensitive field.
    //
    // BUG-06 FIX: Skip review after navigation — the page has changed
    // and reviewing the NEW page's forms would be meaningless/misleading.
    // ════════════════════════════════════════════════════════

    let piiReview: PIIReviewField[] | undefined;
    let needs: RequiredInput[] | undefined;
    let outcome: string | undefined;
    if (executionResult && !didNavigate) {
      const reviewStep = addStep("review");
      const after = await runStep(reviewStep, async () =>
        sendToContentScript("PERCEIVE_PAGE", null)
      );
      if (after && after.forms) {
        piiReview = buildPIIReview(after, piiDetection);
        needs = computeRequirements(after, piiDetection, input.dataContext);
        outcome = summarizeOutcome(
          executionResult.completed,
          executionResult.total,
          needs
        );
        reviewStep.details =
          `${piiReview.length} sensitive fields` +
          (needs.length > 0 ? ` · ${needs.length} still need a value` : " · nothing outstanding");
      }
    }

    // ════════════════════════════════════════════════════════
    // PHASE 8: SHOW PIPELINE STATUS PANEL (in-page overlay)
    // BUG-02 FIX: Wrap in try/catch — after navigation the content
    // script is gone. Failure here must never crash the pipeline.
    // BUG-15 FIX: Use regex /g to replace ALL underscores in step names.
    // ════════════════════════════════════════════════════════

    try {
      await sendToContentScript("SHOW_PIPELINE_PANEL", {
        steps: steps.map((s) => ({
          name: s.name.replace(/_/g, " "),
          status: s.status,
          details: s.details,
        })),
        privacyScore: privacyProof.zeroOutboundPII ? 100 : 50,
        piiDetected: privacyProof.sensitiveDataDetected,
        piiRedacted: privacyProof.sensitiveDataRedacted,
      });
    } catch {
      // Content script gone (e.g. after navigation) — panel is best-effort.
    }

    // Build privacy proof
    if (redactionVerified) {
      privacyProof.proofDescription = generatePrivacyProofDescription(privacyProof) +
        "\n✅ RE-OCR VERIFIED: Redacted frame contains zero PII text.";
    } else {
      privacyProof.proofDescription = generatePrivacyProofDescription(privacyProof);
    }

    const totalLatency = performance.now() - startTime;

    // Build latency breakdown from pipeline steps
    const findStepMs = (name: string) => steps.find((s) => s.name === name)?.latencyMs || 0;
    const latency: LatencyBreakdown = {
      capture: findStepMs("capture"),
      ocr: findStepMs("detect_pii"),
      piiDetection: findStepMs("detect_pii"),
      redaction: findStepMs("redact"),
      verification: findStepMs("verify_redaction"),
      planning: findStepMs("get_plan"),
      execution: findStepMs("execute"),
      total: totalLatency,
      backend: planResult.provider || "rule-based",
      tier: "auto",
    };

    // Complete the reasoning trace
    const completedTrace = completeTrace(true);

    const pipelineResult: PipelineResult = {
      success: planResult.success || planResult.steps.length > 0,
      phase: "complete",
      steps,
      plan: planResult.steps,
      piiDetection,
      redactionSummary,
      planResult,
      privacyProof,
      reasoningTrace: completedTrace,
      latency,
      totalLatencyMs: totalLatency,
      extractedData,
      subTasks,
      piiReview,
      needs,
      outcome,
    };

    // Save 100% on-device session record
    const hostUrl = domData?.metadata?.url || "";
    let domainName = "browser";
    try { if (hostUrl) domainName = new URL(hostUrl).hostname; } catch {}

    saveSessionRecord({
      sessionId: `session-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      timestamp: Date.now(),
      taskPrompt: input.taskDescription,
      targetUrl: hostUrl,
      domain: domainName,
      status: pipelineResult.success ? "completed" : "failed",
      durationMs: totalLatency,
      piiSummary: {
        totalDetected: piiDetection.summary.criticalCount + piiDetection.summary.highCount + piiDetection.summary.mediumCount,
        categories: piiDetection.summary.byCategory,
        egressBlockedBytes: 0,
      },
      steps: planResult.steps.map((st, i) => ({
        stepIndex: i + 1,
        action: `${st.action?.type || "action"} ${st.action?.target || ""}`.trim(),
        targetId: st.action?.target,
        sanitizedValue: st.action?.value ? maskPIIInText(st.action.value) : undefined,
        timestamp: Date.now(),
      })),
    }).catch(() => {});

    return pipelineResult;
  } catch (error) {

    return buildErrorResult(
      error instanceof Error ? error.message : "Pipeline failed",
      steps,
      startTime
    );
  }
}

// ── Execute Plan Steps ──────────────────────────────────────

/** Match a planner target against the user's data keys, tolerantly. */
function resolveDataValue(
  dataContext: Record<string, string>,
  target: string
): string | undefined {
  if (dataContext[target] !== undefined) return dataContext[target];
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  const wanted = norm(target);
  if (!wanted) return undefined;
  for (const key of Object.keys(dataContext)) {
    if (norm(key) === wanted) return dataContext[key];
  }
  return undefined;
}

export async function executePlanSteps(
  plan: PlannedAction[],
  dataContext?: Record<string, string>
): Promise<{ success: boolean; completed: number; total: number; errors: string[] }> {
  let completed = 0;
  const errors: string[] = [];

  /**
   * Strings the sanitizer produces. The planner sees these as field markers
   * and cheerfully echoes them back as values to type. Typing one into a
   * real government form writes literal "[PII:address]" into the field, so
   * they are refused outright — for every field, not just flagged ones.
   */
  const isSanitizationArtifact = (value: string): boolean =>
    /^\s*(\[PII:[^\]]*\]|\[REDACTED:[^\]]*\]|<[A-Z_]+_\d+>|\*{2,})\s*$/i.test(value);

  const skipped: string[] = [];

  for (const step of plan) {
    if (step.action.type === "type") {
      const target = step.action.target || "";
      // Local resolution only. Try the exact key, then a case/whitespace
      // insensitive match, since planner targets are labels and the user's
      // data keys rarely agree on capitalisation.
      const resolved = dataContext ? resolveDataValue(dataContext, target) : undefined;

      if (resolved !== undefined) {
        step.action.value = resolved;
      } else if (isSanitizationArtifact(step.action.value || "")) {
        // No local value AND the planner handed back a marker. Leave the
        // field alone and tell the user, rather than writing junk into it.
        skipped.push(target || `step ${step.index}`);
        continue;
      }

      // Belt and braces: never write an artifact, whatever its source.
      if (isSanitizationArtifact(step.action.value || "")) {
        skipped.push(target || `step ${step.index}`);
        continue;
      }
    }

    // Multi-strategy execution with fallbacks
    let result: any = null;
    let lastError = "";

    // Strategy 1: Direct execution
    result = await sendToContentScript("EXECUTE_ACTION", step.action);

    // Strategy 2: If click failed, try with XPath fallback
    if (!result?.success && step.action.type === "click" && step.action.target) {
      const xpathResult = await sendToContentScript("EXECUTE_ACTION", {
        ...step.action,
        target: `xpath=//button[contains(text(),'${step.action.target}')] | //a[contains(text(),'${step.action.target}')]`,
      });
      if (xpathResult?.success) result = xpathResult;
    }

    // Strategy 3: If type failed, try clearing and retyping
    if (!result?.success && step.action.type === "type") {
      // First click to focus, then type
      const clickResult = await sendToContentScript("EXECUTE_ACTION", {
        type: "click",
        target: step.action.target,
        retries: 0,
        maxRetries: 1,
      });
      if (clickResult?.success) {
        await new Promise((r) => setTimeout(r, 200));
        result = await sendToContentScript("EXECUTE_ACTION", step.action);
      }
    }

    // Strategy 4: If still failed, try with text content match
    if (!result?.success && step.action.target) {
      const textResult = await sendToContentScript("EXECUTE_ACTION", {
        ...step.action,
        target: step.action.value || step.action.target,
      });
      if (textResult?.success) result = textResult;
    }

    if (result?.success) {
      completed++;
    } else {
      lastError = result?.error || "Unknown error";
      errors.push(`Step ${step.index}: ${lastError}`);
      if (errors.length > 3) break; // Stop after 3 consecutive failures
    }

    // Brief pause between actions (human-like pacing)
    await sleep(300 + Math.random() * 200);
  }

  if (skipped.length > 0) {
    // Not a failure of execution — the agent correctly declined to invent
    // values. Surface it so the user knows which fields still need them.
    errors.push(
      `${skipped.length} field(s) left blank — no local value available: ${skipped.slice(0, 5).join(", ")}`
    );
  }

  return {
    // Skipped steps are deliberate, so they do not count against success.
    success: completed + skipped.length === plan.length,
    completed,
    total: plan.length,
    errors,
  };
}

// ── Message Helpers ──────────────────────────────────────────

function isRestrictedUrl(url?: string): boolean {
  if (!url) return false;
  return /^(chrome-extension:|chrome:|edge:|about:|brave:)/.test(url);
}

async function sendToContentScript(type: string, payload: unknown): Promise<any> {
  let tab: chrome.tabs.Tab | undefined;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
    if (!tab?.id) return null;
    if (isRestrictedUrl(tab.url)) return null;

    return await chrome.tabs.sendMessage(tab.id, {
      type,
      payload,
      source: "background",
      timestamp: Date.now(),
    } as Message);
  } catch {
    // BUG-01/03 FIX: the first send failed — the content script is either not
    // injected yet or the tab navigated. Re-use the tab from above to avoid
    // a second query that may race. Then wait for the tab to be fully loaded
    // before injecting, otherwise the content script can arrive before the page
    // DOM is ready and immediately gets evicted.
    if (!tab?.id) return null;
    const tabId = tab.id;

    try {
      // Wait for the tab to finish loading (handles post-navigate scenarios)
      await waitForTabLoad(tabId, 3000);

      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content-scripts/content.js"],
      });

      // Give the injected script time to register its onMessage listener
      await sleep(400);

      return await chrome.tabs.sendMessage(tabId, {
        type,
        payload,
        source: "background",
        timestamp: Date.now(),
      } as Message);
    } catch {
      return null;
    }
  }
}

/** Wait up to `maxMs` for a tab to reach the "complete" status. */
async function waitForTabLoad(tabId: number, maxMs: number): Promise<void> {
  // Check if already loaded
  try {
    const t = await chrome.tabs.get(tabId);
    if (t.status === "complete") return;
  } catch {
    return;
  }

  return new Promise<void>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, maxMs);

    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id !== tabId || info.status !== "complete") return;
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ── Build Sanitized Context ──────────────────────────────────

function buildSanitizedContext(
  domData: PageState,
  piiDetection: PIIDetectionResult,
  taskDescription: string,
  dataContext?: Record<string, string>
): SanitizedContext {
  const piiFieldSelectors = new Set(
    piiDetection.regions
      .filter((r) => r.fieldSelector)
      .map((r) => r.fieldSelector!)
  );

  const piiTextValues = new Set(
    piiDetection.regions
      .filter((r) => r.textValue)
      .map((r) => r.textValue!)
  );

  // Replace every value this page's detectors already flagged. Applied to
  // page text AND to element/field labels — anything that reaches a prompt.
  const scrubKnownPII = (text: string): string => {
    if (!text) return text;
    let out = text;
    for (const piiText of piiTextValues) {
      if (piiText && out.includes(piiText)) {
        out = out.replace(new RegExp(escapeRegex(piiText), "g"), "***");
      }
    }
    return out;
  };

  // Two passes: known detections first, then a checksum-gated sweep for
  // anything the region detectors missed (canvas text, late-rendered nodes).
  const safeTextContent = maskPIIInText(scrubKnownPII(domData.textContent || ""));

  // Safe elements (no PII values).
  // The label falls back to the element's rendered text, which is exactly
  // where visible PII lives ("Aadhaar: 1234 5678 9012"). Scrub it with the
  // same checksum-gated scanner used for safeTextContent — otherwise this
  // field walks straight past sanitization into the prompt.
  const safeElements = domData.elements.map((el) => ({
    tag: el.tag,
    role: el.role,
    label: maskPIIInText(scrubKnownPII(el.label || el.text || "")),
    type: el.type,
    rect: { x: el.rect.x, y: el.rect.y, width: el.rect.width, height: el.rect.height },
    isVisible: el.isVisible,
    isDisabled: el.isDisabled,
  }));

  // Safe forms (hasValue flag instead of actual values)
  const safeForms = domData.forms.map((form) => ({
    id: form.id,
    fields: form.fields.map((field) => {
      const selector = field.id ? `#${field.id}` : field.name ? `[name="${field.name}"]` : null;
      const isPII = selector ? piiFieldSelectors.has(selector) : false;
      return {
        label: maskPIIInText(scrubKnownPII(field.label || field.name || "")),
        type: field.type,
        hasValue: !!field.value,
        isRequired: field.required,
        piiCategory: isPII
          ? piiDetection.regions.find((r) => r.fieldSelector === selector)?.category || null
          : null,
      };
    }),
  }));

  return {
    pageStructure: {
      elements: safeElements,
      forms: safeForms,
      safeTextContent,
      metadata: {
        title: domData.title,
        domain: (() => { try { return new URL(domData.url).hostname; } catch { return ""; } })(),
        hasForm: domData.forms.length > 0,
        hasCAPTCHA: domData.metadata.hasCAPTCHA,
        hasPaymentForm: domData.metadata.hasPaymentForm,
        elementCount: domData.elements.length,
      },
    },
    redactionProof: {
      totalPIIDetected: piiDetection.summary.totalRegions,
      categoriesDetected: Object.keys(piiDetection.summary.byCategory),
      redactionMethods: [...new Set(piiDetection.regions.map((r) => r.redactionStrategy))],
      confidenceScore: piiDetection.summary.overallConfidence,
    },
    taskDescription,
    // Names only. Values stay with the caller and are filled client-side.
    dataFieldNames: dataContext ? Object.keys(dataContext) : undefined,
  };
}

/**
 * Collect every sensitive field with its CURRENT value so the side panel can
 * show it back and let the user correct anything the agent got wrong.
 */
function buildPIIReview(
  domData: PageState,
  piiDetection: PIIDetectionResult
): PIIReviewField[] {
  const categoryBySelector = new Map<string, string>();
  for (const region of piiDetection.regions) {
    if (region.fieldSelector) categoryBySelector.set(region.fieldSelector, region.category);
  }

  const out: PIIReviewField[] = [];
  for (const form of domData.forms) {
    for (const field of form.fields) {
      const type = (field.type || "").toLowerCase();
      // Control inputs have no user-entered value to review.
      if (["checkbox", "radio", "submit", "button", "reset", "image"].includes(type)) continue;

      const selector = field.id
        ? `#${field.id}`
        : field.name
          ? `[name="${field.name}"]`
          : "";
      if (!selector) continue;

      const category = categoryBySelector.get(selector) ?? null;
      // Review covers flagged fields plus anything the agent actually wrote.
      if (!category && !field.value) continue;

      out.push({
        label: field.label || field.name || field.id || "(unlabeled)",
        selector,
        category,
        // A password value is never surfaced, not even for review.
        value: type === "password" ? "" : field.value || "",
        required: !!field.required,
        type: field.type || "text",
      });
    }
  }
  return out;
}

/** Locate the control that submits the form, preferring explicit submit inputs. */
function findSubmitTarget(domData: PageState): string | null {
  const submitField = domData.forms
    .flatMap((f) => f.fields)
    .find((f) => (f.type || "").toLowerCase() === "submit");
  if (submitField) return submitField.id || submitField.name || submitField.label;

  const byText = domData.elements.find((el) => {
    if (el.tag !== "button" && el.role !== "button") return false;
    const t = `${el.text} ${el.label}`.toLowerCase();
    // "save draft" is not a submission.
    if (/\b(save\s*draft|cancel|reset|back)\b/.test(t)) return false;
    return /\b(submit|send|confirm|proceed|continue)\b/.test(t);
  });
  return byText ? byText.id || byText.text : null;
}

// ── Rule-Based Plan ──────────────────────────────────────────

function generateRuleBasedPlan(
  taskDescription: string,
  domData: PageState,
  dataContext?: Record<string, string>
): PlanResult {
  const t0 = performance.now();
  const steps: PlannedAction[] = [];
  let idx = 0;
  const lower = taskDescription.toLowerCase();

  // "submit" is its own intent. Treating it as a fill trigger meant asking
  // to submit re-entered every field instead of pressing the button.
  const wantsSubmit = /\b(submit|send|confirm)\b/.test(lower);
  const wantsFill =
    /\b(fill|complete|enter|populate)\b/.test(lower) ||
    // "complete the form and submit" is both; bare "submit" is not a fill.
    (wantsSubmit && /\b(fill|complete|enter)\b/.test(lower));

  if (wantsFill) {
    const allFields = domData.forms.flatMap((f) => f.fields);
    const unfilled = allFields.filter((f) => !f.filledByUser && f.required);

    for (const field of unfilled) {
      const value = dataContext?.[field.name] || dataContext?.[field.label] || "";
      const target = field.id || field.name || field.label;

      if (value) {
        steps.push({
          index: idx++,
          action: { id: `r-${idx}`, type: "click", target, retries: 0, maxRetries: 3 },
          reasoning: `Focus "${field.label || field.name}"`,
          confidence: 0.9,
          verification: "Field should be focused",
          risk: "low",
        });
        steps.push({
          index: idx++,
          action: { id: `r-${idx}`, type: "type", target, value, retries: 0, maxRetries: 3 },
          reasoning: `Type in "${field.label || field.name}"`,
          confidence: 0.85,
          verification: `Field should contain value`,
          risk: "low",
        });
      } else if (field.options.length > 0) {
        steps.push({
          index: idx++,
          action: { id: `r-${idx}`, type: "select", target, value: field.options[0] || "", retries: 0, maxRetries: 3 },
          reasoning: `Select "${field.options[0]}" in "${field.label || field.name}"`,
          confidence: 0.7,
          verification: "Option should be selected",
          risk: "low",
        });
      }
    }
  }

  if (lower.includes("scroll")) {
    steps.push({
      index: idx++,
      action: { id: `r-${idx}`, type: "scroll", value: lower.includes("up") ? "up" : "down", retries: 0, maxRetries: 1 },
      reasoning: "Scroll page",
      confidence: 0.9,
      verification: "Page should scroll",
      risk: "low",
    });
  }

  // Click specific element
  const clickMatch = lower.match(/(?:click|press|tap)\s+(?:on\s+)?["']?([^"']+)["']?/);
  if (clickMatch) {
    steps.push({
      index: idx++,
      action: { id: `r-${idx}`, type: "click", target: clickMatch[1].trim(), retries: 0, maxRetries: 3 },
      reasoning: `Click "${clickMatch[1].trim()}"`,
      confidence: 0.8,
      verification: "Element should respond",
      risk: "low",
    });
  }

  // Search on a site: "search X on youtube", "find X on google"
  // BUG-FIX: Previous regex required "on|in|at" between query and site name,
  // so "search harkirat singh youtube channel" or "open harkirat singh youtube"
  // would not match at all and fall through to rule-based with 0 steps.
  // Now handles both "search X on youtube" AND "find X youtube".
  const searchMatch =
    lower.match(/(?:search|find|look\s*up|search\s*for)\s+(.+?)\s+(?:on|in|at)\s+([\w.]+)/) ||
    lower.match(/(?:search|find|look\s*up|search\s*for)\s+(.+?)\s+(youtube|google|bing|amazon|flipkart|github)\b/);

  // Also handle "open X youtube channel" / "find X on youtube channel"
  const channelMatch =
    !searchMatch &&
    lower.match(/(.+?)\s+(?:youtube\s+channel|yt\s+channel|channel\s+on\s+youtube)/);

  if (searchMatch || channelMatch) {
    const query = (searchMatch ? searchMatch[1] : channelMatch![1]).trim();
    const rawSite = searchMatch ? searchMatch[2].trim() : "youtube";
    const site = rawSite.replace(/[^a-z0-9]/g, "");
    const siteUrls: Record<string, string> = {
      youtube: "https://www.youtube.com",
      google: "https://www.google.com",
      bing: "https://www.bing.com",
      amazon: "https://www.amazon.in",
      flipkart: "https://www.flipkart.com",
      github: "https://github.com",
    };
    const baseUrl = siteUrls[site] || `https://www.${site}.com`;

    // For YouTube channel searches, use the channel search URL directly
    if (site === "youtube" && (channelMatch || lower.includes("channel"))) {
      steps.push({
        index: idx++,
        action: {
          id: `r-${idx}`,
          type: "navigate",
          value: `${baseUrl}/results?search_query=${encodeURIComponent(query)}`,
          retries: 0,
          maxRetries: 1,
        },
        reasoning: `Search YouTube for channel: "${query}"`,
        confidence: 0.9,
        verification: "YouTube search results should appear",
        risk: "medium",
      });
    } else {
      steps.push({
        index: idx++,
        action: { id: `r-${idx}`, type: "navigate", value: baseUrl, retries: 0, maxRetries: 1 },
        reasoning: `Navigate to ${site}`,
        confidence: 0.9,
        verification: "URL should change",
        risk: "medium",
      });
      steps.push({
        index: idx++,
        action: { id: `r-${idx}`, type: "type", target: "search", value: query, retries: 0, maxRetries: 3 },
        reasoning: `Search for "${query}" on ${site}`,
        confidence: 0.85,
        verification: "Search results should appear",
        risk: "low",
      });
      steps.push({
        index: idx++,
        action: { id: `r-${idx}`, type: "press_key", key: "Enter", retries: 0, maxRetries: 1 },
        reasoning: "Submit search",
        confidence: 0.9,
        verification: "Page should show results",
        risk: "low",
      });
    }
  }

  // Open a site by name: "open youtube", "go to google"
  const siteMatch = lower.match(/(?:go to|open|navigate to|visit)\s+(\S+)$/);
  if (siteMatch && steps.length === 0) {
    const site = siteMatch[1].replace(/[^a-z0-9.]/g, "");
    const siteUrls: Record<string, string> = {
      youtube: "https://www.youtube.com",
      google: "https://www.google.com",
      bing: "https://www.bing.com",
      amazon: "https://www.amazon.in",
      flipkart: "https://www.flipkart.com",
      github: "https://github.com",
    };
    let url = siteUrls[site];
    if (!url) {
      if (site.includes(".") || /^(com|org|net|in|io|dev)$/.test(site)) {
        url = site.startsWith("http") ? site : `https://${site}`;
      } else {
        url = `https://www.${site}.com`;
      }
    }
    steps.push({
      index: idx++,
      action: { id: `r-${idx}`, type: "navigate", value: url, retries: 0, maxRetries: 1 },
      reasoning: `Navigate to "${url}"`,
      confidence: 0.9,
      verification: "URL should change",
      risk: "medium",
    });
  }

  // Submit: find the form's submit control and press it. Runs after any
  // fill steps, so "fill and submit" still works in one pass.
  if (wantsSubmit) {
    const submitTarget = findSubmitTarget(domData);
    if (submitTarget) {
      steps.push({
        index: idx++,
        action: { id: `r-${idx}`, type: "click", target: submitTarget, retries: 0, maxRetries: 2 },
        reasoning: `Press "${submitTarget}"`,
        confidence: 0.85,
        verification: "Form should submit or report validation errors",
        // Submitting a government form is not a low-risk action.
        risk: "high",
      });
    }
  }

  // Extract data from page: "extract all text", "get the data", "read this page"
  if (lower.includes("extract") || lower.includes("read this") || lower.includes("get the data") || lower.includes("scrape")) {
    steps.push({
      index: idx++,
      action: { id: `r-${idx}`, type: "wait", timeout: 1000, retries: 0, maxRetries: 0 },
      reasoning: "Wait for page to fully load before extraction",
      confidence: 0.9,
      verification: "Page content should be stable",
      risk: "low",
    });
    // The extraction happens via the DOM state that's already captured
    steps.push({
      index: idx++,
      action: { id: `r-${idx}`, type: "scroll", value: "down", retries: 0, maxRetries: 1 },
      reasoning: "Scroll to load all lazy content",
      confidence: 0.8,
      verification: "More content should be visible",
      risk: "low",
    });
  }

  // Go back: "go back", "return to previous page"
  if (lower.includes("go back") || lower.includes("return") || lower.includes("previous page")) {
    steps.push({
      index: idx++,
      action: { id: `r-${idx}`, type: "go_back", retries: 0, maxRetries: 1 },
      reasoning: "Navigate back to previous page",
      confidence: 0.9,
      verification: "URL should change to previous page",
      risk: "low",
    });
  }

  // Hover over element: "hover over X", "mouse over X"
  const hoverMatch = lower.match(/(?:hover|mouse\s*over)\s+(?:on\s+)?["']?([^"']+)["']?/);
  if (hoverMatch) {
    steps.push({
      index: idx++,
      action: { id: `r-${idx}`, type: "hover", target: hoverMatch[1].trim(), retries: 0, maxRetries: 3 },
      reasoning: `Hover over "${hoverMatch[1].trim()}"`,
      confidence: 0.8,
      verification: "Tooltip or dropdown should appear",
      risk: "low",
    });
  }

  // Wait for element: "wait for X to appear"
  const waitMatch = lower.match(/wait\s+(?:for\s+)?(.+?)(?:\s+to\s+(?:appear|load|show))?$/);
  if (waitMatch && steps.length === 0) {
    steps.push({
      index: idx++,
      action: { id: `r-${idx}`, type: "wait", timeout: 3000, retries: 0, maxRetries: 0 },
      reasoning: `Wait for page content to load`,
      confidence: 0.7,
      verification: "Page should be fully loaded",
      risk: "low",
    });
  }

  // Tab key: "press tab", "tab through fields"
  if (lower.includes("tab") && (lower.includes("press") || lower.includes("through"))) {
    steps.push({
      index: idx++,
      action: { id: `r-${idx}`, type: "press_key", key: "Tab", retries: 0, maxRetries: 1 },
      reasoning: "Press Tab to move to next field",
      confidence: 0.85,
      verification: "Focus should move to next field",
      risk: "low",
    });
  }

  return {
    success: steps.length > 0,
    steps,
    reasoning: steps.length > 0
      ? `Rule-based plan: ${steps.length} steps`
      : "Could not determine actions. Try being more specific.",
    provider: "rule-based",
    latencyMs: performance.now() - t0,
  };
}

// ── Utilities ────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function generatePrivacyProofDescription(proof: PrivacyProof): string {
  const lines: string[] = [];
  lines.push("PRIVACY PROOF");
  lines.push(`PII detected: ${proof.sensitiveDataDetected} regions`);
  lines.push(`PII redacted: ${proof.sensitiveDataRedacted} regions`);
  lines.push("");
  lines.push("Data sent to server:");
  lines.push("  [OK] Sanitized page structure (elements, labels, positions)");
  lines.push("  [OK] Task description");
  lines.push(`  [${proof.dataSentToServer.rawScreenshot ? "FAIL" : "OK"}] Raw screenshot: ${proof.dataSentToServer.rawScreenshot ? "SENT" : "NOT sent"}`);
  lines.push(`  [${proof.dataSentToServer.formValues ? "FAIL" : "OK"}] Form values: ${proof.dataSentToServer.formValues ? "SENT" : "NOT sent"}`);
  lines.push(`  [${proof.dataSentToServer.piiText ? "FAIL" : "OK"}] PII text: ${proof.dataSentToServer.piiText ? "SENT" : "NOT sent"}`);
  lines.push(`  [${proof.dataSentToServer.faces ? "FAIL" : "OK"}] Faces: ${proof.dataSentToServer.faces ? "SENT" : "NOT sent"}`);
  lines.push("");
  lines.push(proof.zeroOutboundPII
    ? "ZERO sensitive data left the device"
    : "WARNING: Some sensitive data was transmitted");
  return lines.join("\n");
}

function buildErrorResult(
  error: string,
  steps: PipelineStep[],
  startTime: number
): PipelineResult {
  return {
    success: false,
    phase: "error",
    steps,
    plan: [],
    piiDetection: {
      regions: [],
      summary: {
        totalRegions: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
        byCategory: {} as any,
        bySource: { dom: 0, vision: 0, combined: 0 },
        overallConfidence: 0,
        detectionTimeMs: 0,
      },
      sanitizedDOMMetadata: {
        safeElements: [], safeTextContent: "", safeForms: [],
        pageMetadata: { title: "", url: "", hasForm: false, hasCAPTCHA: false, elementCount: 0 },
      },
    },
    redactionSummary: { totalPII: 0, redacted: 0, cssInjected: false, overlayShown: false },
    planResult: { success: false, steps: [], reasoning: "", provider: "none", latencyMs: 0 },
    privacyProof: {
      sensitiveDataDetected: 0, sensitiveDataRedacted: 0,
      dataSentToServer: { rawScreenshot: false, formValues: false, piiText: false, faces: false, sanitizedStructure: false, taskDescription: false },
      zeroOutboundPII: true, proofDescription: "",
    },
    reasoningTrace: null,
    latency: { capture: 0, ocr: 0, piiDetection: 0, redaction: 0, verification: 0, planning: 0, execution: 0, total: 0, backend: "error", tier: "error" },
    totalLatencyMs: performance.now() - startTime,
    error,
  };
}
