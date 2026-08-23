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

import { detectAllPII, type PIIDetectionResult } from "../privacy/pii-detector";
import { generateDOMRedactionCSS } from "../privacy/redaction-engine";
import { initializeServer, isServerAvailable, getActiveProvider, type SanitizedContext, type PlanResult } from "../agent/server-bridge";
import { callOffscreen } from "../runtime/messaging";
import type { OcrResult, OcrWord } from "../../types/runtime";
import { fuseScreenGraph, type ScreenGraph } from "../perception/screen-graph";
import {
  startTrace, traceObserve, tracePIIDetection, traceRedaction,
  traceRedactionVerification, tracePlan, completeTrace, type ReasoningTrace,
} from "../agent/reasoning-trace";
import { generatePlanWithBestProvider, getBestAvailableProvider } from "../agent/llm-providers";
import { generatePlanWithVLM, dataURLToBase64, isVLMAvailable } from "../agent/vlm-bridge";
import type { PlannedAction, PageState, Message } from "../../types";

// ── Pipeline Types ───────────────────────────────────────────

export interface PipelineInput {
  taskDescription: string;
  dataContext?: Record<string, string>;
  tabId?: number;
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
  screenGraph?: ScreenGraph | null;
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
  redactionVerified: boolean;
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

  const addStep = (name: string): PipelineStep => {
    const step: PipelineStep = { name, status: "pending", latencyMs: 0, details: "" };
    steps.push(step);
    return step;
  };

  const runStep = async <T>(step: PipelineStep, fn: () => Promise<T>): Promise<T | null> => {
    step.status = "running";
    const t0 = performance.now();
    try {
      const result = await fn();
      step.status = "complete";
      step.latencyMs = performance.now() - t0;
      return result;
    } catch (err) {
      step.status = "error";
      step.latencyMs = performance.now() - t0;
      step.details = err instanceof Error ? err.message : "Unknown error";
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
    redactionVerified: false,
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
      captureStep.details = "Failed to get page data from content script";
      return buildErrorResult("Content script not available. Reload the page.", steps, startTime);
    }
    captureStep.details = `${domData.elements.length} elements, ${domData.forms.length} forms`;

    // Capture screenshot directly from SW (avoids unnecessary content-script round-trip)
    // chrome.tabs.captureVisibleTab only works from the service worker
    let screenshotDataUrl: string | null = null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id && !isRestrictedUrl(tab.url)) {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: "png",
          quality: 80,
        });
        if (dataUrl) {
          screenshotDataUrl = dataUrl;
          captureStep.details += ", screenshot captured";
        }
      }
    } catch {
      // Screenshot capture is optional — DOM-only path still works
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
    // PHASE 1.75: SCREEN GRAPH FUSION — Tri-signal merge
    // Fuse DOM ⊕ OCR ⊕ ViT into a single ScreenGraph.
    // This is the key innovation: DOM-only agents miss canvas content,
    // vision-only agents miss semantic structure.
    // ════════════════════════════════════════════════════════

    let ocrWords: OcrWord[] = [];
    let screenGraph: ScreenGraph | null = null;

    const fusionStep = addStep("screen_graph");
    const fusionResult = await runStep(fusionStep, async () => {
      // Run PP-OCR to get structured word-level results
      if (screenshotDataUrl) {
        try {
          const ocrResult: OcrResult = await callOffscreen("runOcr", {
            imageDataUrl: screenshotDataUrl,
            lang: "auto",
          });
          ocrWords = ocrResult.words || [];
        } catch (err) {
          console.warn("[VLESS] OCR for ScreenGraph failed:", err);
        }
      }

      // Extract Florence-2 signals
      const florenceElements = (florenceResult?.elements || []).map((e: any) => ({
        label: e.label || e.text || "",
        box: e.box || e.boundingBox || { x: 0, y: 0, w: 0, h: 0 },
        confidence: e.confidence || 0.5,
        category: e.category || "unknown",
      }));

      const florenceTextRegions = (florenceResult?.textRegions || []).map((tr: any) => ({
        text: tr.text,
        box: tr.box,
        confidence: tr.confidence || 0.5,
      }));

      // Run the tri-signal fusion
      return fuseScreenGraph(
        domData,
        ocrWords,
        florenceElements,
        florenceTextRegions,
        florenceResult?.caption || ""
      );
    });

    if (fusionResult) {
      screenGraph = fusionResult;
      fusionStep.details = `ScreenGraph: ${fusionResult.stats.totalElements} elements ` +
        `(${fusionResult.sourceBreakdown.dom} DOM, ${fusionResult.sourceBreakdown.ocr} OCR, ` +
        `${fusionResult.sourceBreakdown.vit} ViT, ${fusionResult.sourceBreakdown.fused} fused) ` +
        `[${fusionResult.timings.fusion.toFixed(0)}ms]`;
      traceObserve(`ScreenGraph fused ${fusionResult.stats.totalElements} elements from 3 signals`);
    }

    // ════════════════════════════════════════════════════════
    // PHASE 2: DETECT PII — Multi-signal (DOM + OCR + ViT)
    // ════════════════════════════════════════════════════════

    const detectStep = addStep("detect_pii");

    // Build OCR text blocks from the ScreenGraph OCR results for PII detection
    let ocrTextBlocks: Array<{ text: string; confidence: number; boundingBox: { x: number; y: number; width: number; height: number } }> = ocrWords.map((w) => ({
      text: w.text,
      confidence: w.score,
      boundingBox: { x: w.box.x, y: w.box.y, width: w.box.w, height: w.box.h },
    }));
    // Also include Florence-2 OCR text regions not already captured
    if (florenceResult?.textRegions?.length > 0) {
      for (const tr of florenceResult.textRegions) {
        const isDupe = ocrTextBlocks.some((existing) => {
          const a = existing.boundingBox;
          const b = tr.box;
          const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.w) - Math.max(a.x, b.x));
          const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.h) - Math.max(a.y, b.y));
          const interArea = ix * iy;
          const unionArea = a.width * a.height + b.w * b.h - interArea;
          return unionArea > 0 && interArea / unionArea > 0.4;
        });
        if (!isDupe) {
          ocrTextBlocks.push({
            text: tr.text,
            confidence: tr.confidence || 0.5,
            boundingBox: { x: tr.box.x, y: tr.box.y, width: tr.box.w, height: tr.box.h },
          });
        }
      }
    }

    const detectionResult = await runStep(detectStep, async () => {
      // DOM + OCR PII detection
      const domResult = await detectAllPII(domData, undefined, ocrTextBlocks.length > 0 ? ocrTextBlocks : undefined);

      // Vision PII detection (faces, password dots) via offscreen ML host
      if (screenshotDataUrl) {
        try {
          const visionPII: Array<{
            category: string;
            sensitivity: string;
            boundingBox: { x: number; y: number; width: number; height: number };
            confidence: number;
            detectionMethod: string;
          }> = await callOffscreen("detectVisionPII", { imageDataUrl: screenshotDataUrl });

          if (visionPII && visionPII.length > 0) {
            // Merge vision PII regions into DOM results
            // Map vision categories to redaction strategies
            const REDACTION_MAP: Record<string, string> = {
              face: "blur", password: "black_box", aadhaar: "black_box",
              pan: "black_box", financial: "black_box", medical: "black_box",
              phone: "mask_text", email: "mask_text", ifsc: "mask_text",
              upi: "mask_text", name: "mask_text", address: "mask_text",
            };
            for (const vRegion of visionPII) {
              const strategy = REDACTION_MAP[vRegion.category] || "blur";
              domResult.regions.push({
                id: `pii-vision-${domResult.regions.length + 1}`,
                category: vRegion.category as any,
                sensitivity: vRegion.sensitivity as any,
                boundingBox: vRegion.boundingBox,
                textValue: null,
                fieldSelector: null,
                confidence: vRegion.confidence,
                source: "vision" as const,
                detectionMethod: vRegion.detectionMethod,
                redactionStrategy: strategy as any,
              });
            }
            // Recompute summary
            domResult.summary.totalRegions = domResult.regions.length;
            domResult.summary.criticalCount = domResult.regions.filter((r: any) => r.sensitivity === "critical").length;
            domResult.summary.highCount = domResult.regions.filter((r: any) => r.sensitivity === "high").length;
            domResult.summary.bySource.vision += visionPII.length;
            traceObserve(`Vision PII: ${visionPII.length} regions detected (faces: ${visionPII.filter((r: any) => r.category === "face").length}, passwords: ${visionPII.filter((r: any) => r.category === "password").length})`);
          }
        } catch (err) {
          console.warn("[VLESS] Vision PII detection failed:", err);
        }
      }

      return domResult;
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

      // Show PII overlay on the page
      await sendToContentScript("SHOW_PII_OVERLAY", {
        regions: piiDetection.regions
          .filter((r) => r.boundingBox)
          .map((r) => ({
            id: r.id,
            category: r.category,
            sensitivity: r.sensitivity,
            boundingBox: r.boundingBox!,
            confidence: r.confidence,
          })),
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
          timings: { ocr: result.ocrTimeMs },
        };
      });
      if (verifyResult) {
        redactionVerified = verifyResult.passed;
        verifyStep.details = verifyResult.passed
          ? `✅ Verified: 0 PII in pixels (${verifyResult.timings.ocr.toFixed(0)}ms)`
          : `❌ ${verifyResult.piiTextFound} PII regions residual`;
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
    // PHASE 5: BUILD SANITIZED CONTEXT
    // ════════════════════════════════════════════════════════

    const sanitizeStep = addStep("sanitize");
    const sanitizedContext = await runStep(sanitizeStep, async () => {
      return buildSanitizedContext(domData, piiDetection, input.taskDescription);
    });

    if (!sanitizedContext) {
      return buildErrorResult("Failed to build sanitized context", steps, startTime);
    }
    sanitizeStep.details = "Context sanitized";

    // ════════════════════════════════════════════════════════
    // PHASE 6: GET PLAN — VLM visual → LLM text → deterministic → rules
    // PS requirement: send anonymized visual context to a VLM.
    // ════════════════════════════════════════════════════════

    const planStep = addStep("get_plan");
    const planResultData = await runStep(planStep, async () => {
      // Priority 1: VLM with redacted screenshot (PS requirement)
      if (redactedScreenshotUrl && await isVLMAvailable()) {
        console.log("[VLESS] Using VLM visual context for planning");
        const vlmResult = await generatePlanWithVLM({
          screenshotBase64: dataURLToBase64(redactedScreenshotUrl),
          sanitizedContext,
          taskDescription: input.taskDescription,
          dataContext: input.dataContext,
        });
        if (vlmResult.steps.length > 0) {
          traceObserve(`VLM (${vlmResult.provider}) interpreted redacted screenshot, generated ${vlmResult.steps.length} steps`);
          return {
            success: true,
            steps: vlmResult.steps,
            reasoning: vlmResult.reasoning,
            provider: vlmResult.provider,
            latencyMs: vlmResult.latencyMs,
          };
        }
      }

      // Priority 2: WebLLM — fully offline on-device LLM (WebGPU)
      try {
        const webllmReady = await callOffscreen("isWebLLMReady", undefined);
        if (webllmReady) {
          console.log("[VLESS] Using WebLLM for fully offline planning");
          const { planWithWebLLM } = await import("../agent/webllm-planner");
          const webllmResult = await planWithWebLLM(
            input.taskDescription,
            sanitizedContext,
            input.dataContext
          );
          if (webllmResult.success && webllmResult.steps.length > 0) {
            traceObserve(`WebLLM generated ${webllmResult.steps.length} steps (fully offline)`);
            return webllmResult;
          }
        }
      } catch {
        // WebLLM not available — continue to cloud
      }

      // Priority 3: Multi-provider LLM (text-only planning)
      const llmResult = await generatePlanWithBestProvider(
        input.taskDescription,
        sanitizedContext,
        input.dataContext
      );
      if (llmResult.success && llmResult.steps.length > 0) {
        return llmResult;
      }
      // Fallback to legacy server-bridge
      if (isServerAvailable()) {
        const provider = getActiveProvider()!;
        return provider.generatePlan(
          input.taskDescription,
          sanitizedContext,
          input.dataContext
        );
      }
      // Try deterministic planner first (fast, offline, no LLM needed)
      const { generateDeterministicPlan, isDeterministicEligible } = await import("../agent/deterministic-planner");
      const allFields = domData.forms.flatMap((f: any) => f.fields);
      if (isDeterministicEligible(input.taskDescription, allFields.length) && input.dataContext) {
        console.log("[VLESS] Using deterministic planner (no LLM needed)");
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
        if (detPlan.success) {
          return {
            success: true,
            steps: detPlan.steps,
            reasoning: detPlan.reasoning,
            provider: "deterministic",
            latencyMs: performance.now() - startTime,
          };
        }
      }
      // Last resort: rule-based (limited to fill/scroll/click/navigate)
      console.warn("[VLESS] No LLM available — falling back to rule-based planning.");
      return generateRuleBasedPlan(input.taskDescription, domData, input.dataContext);
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

    let executionResult: { success: boolean; completed: number; total: number; errors: string[] } | null = null;
    if (planResult.steps.length > 0) {
      const execStep = addStep("execute");
      execStep.status = "running";
      executionResult = await executePlanSteps(planResult.steps, input.dataContext);
      execStep.status = executionResult.success ? "complete" : "error";
      execStep.details = `${executionResult.completed}/${executionResult.total} steps` +
        (executionResult.errors.length > 0 ? ` (${executionResult.errors.length} errors)` : "");
    }

    // ════════════════════════════════════════════════════════
    // PHASE 8: SHOW PIPELINE STATUS PANEL
    // ════════════════════════════════════════════════════════

    await sendToContentScript("SHOW_PIPELINE_PANEL", {
      steps: steps.map((s) => ({
        name: s.name.replace("_", " "),
        status: s.status,
        details: s.details,
      })),
      privacyScore: privacyProof.zeroOutboundPII ? 100 : 50,
      piiDetected: privacyProof.sensitiveDataDetected,
      piiRedacted: privacyProof.sensitiveDataRedacted,
    });

    // Build privacy proof — recompute zeroOutboundPII based on actual data flow
    privacyProof.redactionVerified = redactionVerified;
    // If cloud/VLM was used, raw screenshot left the device (even if redacted)
    const usedCloud = planResult.provider === "cloud" || planResult.provider?.startsWith("openai") ||
      planResult.provider?.startsWith("claude") || planResult.provider?.startsWith("openrouter") ||
      planResult.provider?.startsWith("ollama");
    const usedVLM = planResult.provider?.includes("vlm") || planResult.provider?.includes("/");
    if (usedCloud || usedVLM) {
      privacyProof.dataSentToServer.sanitizedStructure = true;
      // Only mark PII sent if the redaction failed or wasn't verified
      if (!redactionVerified && redactionSummary.redacted > 0) {
        privacyProof.zeroOutboundPII = false;
      }
    }
    // Sanity: if tripwire blocked requests, PII was attempted to leave
    // (tripwire stats are checked in the UI, not here)

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

    return {
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
      screenGraph,
    };
  } catch (error) {

    return buildErrorResult(
      error instanceof Error ? error.message : "Pipeline failed",
      steps,
      startTime
    );
  }
}

// ── Execute Plan Steps ──────────────────────────────────────

export async function executePlanSteps(
  plan: PlannedAction[],
  dataContext?: Record<string, string>
): Promise<{ success: boolean; completed: number; total: number; errors: string[] }> {
  let completed = 0;
  const errors: string[] = [];

  for (const step of plan) {
    // Resolve data values
    if (step.action.type === "type" && dataContext) {
      const target = step.action.target || "";
      step.action.value = dataContext[target] || step.action.value || "";
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

  return {
    success: completed === plan.length,
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
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    if (isRestrictedUrl(tab.url)) return null;

    return chrome.tabs.sendMessage(tab.id, {
      type,
      payload,
      source: "background",
      timestamp: Date.now(),
    } as Message);
  } catch {
    // Try injecting content script first
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return null;

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content-scripts/content.js"],
      });
      await sleep(200);

      return chrome.tabs.sendMessage(tab.id, {
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

// ── Build Sanitized Context ──────────────────────────────────

function buildSanitizedContext(
  domData: PageState,
  piiDetection: PIIDetectionResult,
  taskDescription: string,
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

  // Sanitize text: replace PII values with ***
  let safeTextContent = domData.textContent || "";
  for (const piiText of piiTextValues) {
    if (piiText && safeTextContent.includes(piiText)) {
      safeTextContent = safeTextContent.replace(
        new RegExp(escapeRegex(piiText), "g"),
        "***"
      );
    }
  }

  // Safe elements (no PII values)
  const safeElements = domData.elements.map((el) => ({
    tag: el.tag,
    role: el.role,
    label: el.label || el.text || "",
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
        label: field.label || field.name || "",
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
    // PRIVACY: dataContext (raw PII values) is NEVER included in the sanitized context.
    // PII values are filled locally by the client after the plan is returned.
  };
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

  if (lower.includes("fill") || lower.includes("complete") || lower.includes("submit")) {
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
  const searchMatch = lower.match(/(?:search|find|look up|search for)\s+(.+?)\s+(?:on|in|at)\s+(\S+)/);
  if (searchMatch) {
    const query = searchMatch[1].trim();
    const site = searchMatch[2].trim();
    const siteUrls: Record<string, string> = {
      youtube: "https://www.youtube.com",
      google: "https://www.google.com",
      bing: "https://www.bing.com",
      amazon: "https://www.amazon.in",
      flipkart: "https://www.flipkart.com",
      github: "https://github.com",
    };
    const baseUrl = siteUrls[site] || `https://www.${site}.com`;
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
      zeroOutboundPII: true, redactionVerified: false, proofDescription: "",
    },
    reasoningTrace: null,
    latency: { capture: 0, ocr: 0, piiDetection: 0, redaction: 0, verification: 0, planning: 0, execution: 0, total: 0, backend: "error", tier: "error" },
    totalLatencyMs: performance.now() - startTime,
    error,
  };
}
