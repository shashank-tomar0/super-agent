// ============================================================
// VLESS — Background Service Worker (Production)
// The orchestrator: routes messages, plans, verifies
//
// Architecture:
//   - Background: plans actions, manages task lifecycle, verifies
//   - Content Script: executes actions in page context (DOM is accessible there)
//   - Side Panel: displays status, learning log, privacy monitor
//
// Key design: Background NEVER touches the DOM directly.
// It sends messages to the content script which runs in page context.
// ============================================================

import { defineBackground } from "wxt/utils/define-background";
import type {
  Message,
  AgentTask,
  PageState,
  MessageType,
  AgentAction,
} from "../../types";
import type { PipelineResult } from "../../core/pipeline/full-pipeline";
import type { ModelId, OcrResult } from "../../types/runtime";
import { log } from "../../core/agent/learning-log";
import { startMonitoring, stopMonitoring, isClean, getStats } from "../../core/privacy/network-monitor";
import { getEgressStats, recordPageObservations } from "../../core/privacy/egress-guard";
import { callOffscreen, isRuntimeEnvelope } from "../../core/runtime/messaging";

// ── Lazy imports: HEAVY modules loaded on-demand ──────────
// executeFullPipeline pulls in ONNX runtime, vision pipeline, PII detector
// llm-providers pulls in 4 provider implementations + prompt builder
// Loading these eagerly makes the SW 70MB → crashes on startup.
let _fullPipeline: any = null;
let _llmProviders: any = null;
let _llmBridge: any = null;

async function lazyFullPipeline() { if (!_fullPipeline) _fullPipeline = await import("../../core/pipeline/full-pipeline"); return _fullPipeline; }
async function lazyLLMProviders() { if (!_llmProviders) _llmProviders = await import("../../core/agent/llm-providers"); return _llmProviders; }
async function lazyLLMBridge() { if (!_llmBridge) _llmBridge = await import("../../core/agent/llm-bridge"); return _llmBridge; }

export default defineBackground({
  persistent: false,

  main() {
    // ── Extension Lifecycle ──────────────────────────────
    try {

    chrome.runtime.onInstalled.addListener(async () => {
      console.log("🐾 VLESS installed.");

      chrome.storage.local.set({
        settings: {
          autoPerceive: true,
          confirmHighRisk: true,
          showVisualDebug: true,
          maxRetries: 3,
          stepDelay: 300,
          language: "hi-IN",
        },
      });

      // Check Ollama on install
      const llmStatus = await (await lazyLLMBridge()).checkOllamaAvailability();
      console.log("🐾 LLM:", llmStatus.available ? `Connected (${llmStatus.model})` : "Unavailable");
    });

    // Open side panel when extension icon is clicked
    chrome.action.onClicked.addListener(async (tab) => {
      if (tab.id) {
        try {
          await chrome.sidePanel.open({ tabId: tab.id });
        } catch (err) {
          console.error("[VLESS] Failed to open side panel:", err);
          // Fallback: set side panel to open on next action
          try {
            await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
          } catch {
            // ignore
          }
        }
      }
    });

    // ── Task history ─────────────────────────────────────
    // Short rolling memory so follow-up instructions have context.
    const MAX_RECENT_TASKS = 5;
    const recentTasks: string[] = [];

    // ── SW Keepalive ─────────────────────────────────────
    // MV3 service workers die after ~30s of inactivity.
    // During long tasks, we ping chrome.alarms to keep alive.
    let keepaliveInterval: ReturnType<typeof setInterval> | null = null;

    function startKeepalive() {
      if (keepaliveInterval) return;
      keepaliveInterval = setInterval(() => {
        // BUG-14 FIX: alarm delay (24s) < interval (25s) so there's no gap
        // window where the SW could die between pings.
        chrome.alarms.create("keepalive", { when: Date.now() + 24000 });
      }, 25000);
      // Also fire immediately
      chrome.alarms.create("keepalive", { when: Date.now() + 24000 });
    }

    function stopKeepalive() {
      if (keepaliveInterval) {
        clearInterval(keepaliveInterval);
        keepaliveInterval = null;
      }
      chrome.alarms.clear("keepalive").catch(() => {});
    }

    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === "keepalive") {
        // SW is alive — do nothing, just the alarm keeps us going
      }
    });

    // ── Message Router ───────────────────────────────────

    chrome.runtime.onMessage.addListener(
      (
        message: Message,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response?: any) => void
      ) => {
        // Offscreen RPC requests + model-progress broadcasts ride their own
        // channel; they're handled by the offscreen doc / progress subscribers,
        // never by this router. Ignore them so we don't reply with an error.
        if (isRuntimeEnvelope(message)) return false;

        handleMessage(message, sender)
          .then(sendResponse)
          .catch((error) => {
            console.error("Message handling error:", error);
            sendResponse({ error: error.message });
          });

        return true; // Keep channel open for async response
      }
    );

    async function handleMessage(
      message: Message,
      _sender: chrome.runtime.MessageSender
    ): Promise<unknown> {
      switch (message.type) {
        case "START_TASK":
          return handleStartTask(
            message.payload as { description: string; data?: Record<string, string> }
          );
        case "EXECUTE_PIPELINE":
          return handleExecutePipeline(
            message.payload as { description: string; data?: Record<string, string>; tabId?: number }
          );
        case "CANCEL_TASK":
          if (currentAbortController) {
            currentAbortController.abort();
            currentAbortController = null;
          }
          stopMonitoring();
          return { success: true, message: "Task cancelled" };

        // ── On-device runtime (proxied to the offscreen ML host) ──
        case "GET_BACKEND":
          return callOffscreen("detectBackend", undefined);
        case "GET_MODEL_STATUSES":
          return callOffscreen("getModelStatuses", undefined);
        case "WARM_MODELS":
          return callOffscreen(
            "warmModels",
            (message.payload as { ids: ModelId[] }) ?? { ids: [] }
          );
        case "RUN_OCR":
          return handleRunOcr(
            (message.payload as { lang?: "auto" | "en" | "hi"; maxSide?: number }) ?? {}
          );

        case "PERCEIVE_PAGE":
          return handlePerceivePage();
        case "EXECUTE_ACTION":
          return handleExecuteAction(message.payload as AgentAction);
        case "GET_MEMORY":
          return handleGetMemory(message.payload as { domain: string });
        case "SAVE_MEMORY":
          return handleSaveMemory(message.payload as { domain: string; data: unknown });
        case "TOGGLE_OVERLAY":
          return { success: true };
        case "CHECK_LLM":
          return (await lazyLLMBridge()).checkOllamaAvailability();
        case "GET_LLM_STATUS":
          return (await lazyLLMBridge()).getLLMStatus();
        case "GET_PRIVACY_STATS":
          return getStats();
        case "CHECK_PROVIDERS":
          return handleCheckProviders();
        case "DO_CAPTURE_TAB":
          return handleCaptureTab();
        case "GET_TRIPWIRE_STATS":
          // The background owns the merged ledger: blocked extension
          // egress plus observed page traffic relayed from the MAIN-world
          // tripwire.
          return getEgressStats();
        case "REPORT_PAGE_EGRESS":
          recordPageObservations(message.payload as any);
          return { success: true };
        default:
          return { error: `Unknown message type: ${message.type}` };
      }
    }

    // ══════════════════════════════════════════════════════
    // TASK ORCHESTRATION — The brain of the agent
    // ══════════════════════════════════════════════════════

    // ── Task Abort Controller ──────────────────────────────
    let currentAbortController: AbortController | null = null;

    async function handleStartTask(payload: {
      description: string;
      data?: Record<string, string>;
    }): Promise<AgentTask> {
      console.log(`🐾 Starting task: "${payload.description}"`);

      // Cancel any running task
      if (currentAbortController) {
        currentAbortController.abort();
      }
      currentAbortController = new AbortController();

      // Start privacy monitoring and keepalive
      startMonitoring();
      startKeepalive();
      log("discovery", `Starting task: "${payload.description}"`);

      const task: AgentTask = {
        id: `task-${Date.now()}`,
        description: payload.description,
        status: "analyzing",
        plan: { steps: [], estimatedTime: 0, riskLevel: "low", requiresConfirmation: false, dataMappings: [] },
        currentStep: 0,
        totalSteps: 0,
        startTime: Date.now(),
      };

      broadcast({ type: "TASK_STATUS", payload: task });

      // Early check: is the active tab a restricted URL?
      const activeTab = await getActiveTab();
      if (activeTab?.url && isRestrictedUrl(activeTab.url)) {
        task.status = "failed";
        task.error = "Cannot run on browser pages (chrome://, edge://, etc). Navigate to a website first.";
        task.endTime = Date.now();
        stopKeepalive();
        broadcast({ type: "TASK_COMPLETE", payload: { task, privacyClean: true } });
        return task;
      }

      try {
        // ════════════════════════════════════════════════════════
        // DELEGATE TO FULL PIPELINE
        // The full pipeline handles: DOM + OCR + Florence-2 ViT +
        // ScreenGraph fusion + PII detection + redaction + re-OCR
        // verification + planning (VLM/LLM/deterministic) + execution.
        // This avoids duplicating logic in handleStartTask.
        // ════════════════════════════════════════════════════════

        task.status = "analyzing";
        broadcast({ type: "TASK_STATUS", payload: task });
        log("discovery", "Scanning page with full perception pipeline...");

        const pipeline = await lazyFullPipeline();
        const result = await pipeline.executeFullPipeline({
          taskDescription: payload.description,
          dataContext: payload.data,
        });

        // Map pipeline result back to AgentTask
        task.status = result.success ? "completed" : "failed";
        task.endTime = Date.now();
        task.result = result.success
          ? `Completed ${result.plan.length} steps (${result.planResult.provider}) — ` +
            `${result.piiDetection.summary.totalRegions} PII detected, ` +
            `${result.redactionSummary.redacted} redacted, ` +
            `${result.latency.total.toFixed(0)}ms total`
          : result.error || "Pipeline failed";
        task.totalSteps = result.plan.length;
        task.plan = {
          steps: result.plan,
          estimatedTime: result.latency.total,
          riskLevel: "low",
          requiresConfirmation: false,
          dataMappings: [],
        };

        log(result.success ? "success" : "error", task.result ?? "no result");
        log("success", `Privacy: ${result.privacyProof.sensitiveDataDetected} PII detected, ` +
          `${result.privacyProof.sensitiveDataRedacted} redacted, ` +
          `${result.privacyProof.zeroOutboundPII ? "zero" : "SOME"} PII sent to server`
        );

        const finalStats = stopMonitoring();
        stopKeepalive();
        broadcast({ type: "TASK_COMPLETE", payload: { task, privacyClean: isClean(), privacyStats: finalStats, pipelineResult: result ?? undefined } });
        return task;
      } catch (error) {
        task.status = "failed";
        task.endTime = Date.now();
        task.error = error instanceof Error ? error.message : "Unknown error";
        log("error", `Task failed: ${task.error}`);
        stopMonitoring();
        stopKeepalive();
        broadcast({ type: "TASK_COMPLETE", payload: { task, privacyClean: isClean() } });
        return task;
      }
    }

    // ══════════════════════════════════════════════════════
    // PAGE PERCEPTION — via content script
    // ══════════════════════════════════════════════════════

    async function handlePerceivePage(): Promise<PageState> {
      const tab = await getActiveTab();
      if (!tab?.id) {
        return createEmptyPageState();
      }

      if (isRestrictedUrl(tab.url)) {
        return createEmptyPageState();
      }

      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: "PERCEIVE_PAGE",
          payload: null,
          source: "background",
          timestamp: Date.now(),
        } as Message);

        return response as PageState;
      } catch {
        // Content script not injected yet — inject and retry
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content-scripts/content.js"],
          });
          await sleep(200);

          const response = await chrome.tabs.sendMessage(tab.id, {
            type: "PERCEIVE_PAGE",
            payload: null,
            source: "background",
            timestamp: Date.now(),
          } as Message);

          return response as PageState;
        } catch {
          return createEmptyPageState();
        }
      }
    }

    // ══════════════════════════════════════════════════════
    // ACTION EXECUTION — via content script
    // The content script has direct DOM access.
    // Background sends the action, content script executes it.
    // ══════════════════════════════════════════════════════

    async function handleExecuteAction(
      action: AgentAction
    ): Promise<{ success: boolean; error?: string }> {
      const tab = await getActiveTab();
      if (!tab?.id) {
        return { success: false, error: "No active tab found" };
      }

      if (isRestrictedUrl(tab.url)) {
        return { success: false, error: "Cannot run on browser pages (chrome://, edge://, etc). Navigate to a website first." };
      }

      try {
        // Send action to content script for execution
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: "EXECUTE_ACTION",
          payload: action,
          source: "background",
          timestamp: Date.now(),
        } as Message);

        return response as { success: boolean; error?: string };
      } catch (error) {
        // Content script not ready — inject and retry
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content-scripts/content.js"],
          });
          await sleep(300);

          const response = await chrome.tabs.sendMessage(tab.id, {
            type: "EXECUTE_ACTION",
            payload: action,
            source: "background",
            timestamp: Date.now(),
          } as Message);

          return response as { success: boolean; error?: string };
        } catch (retryError) {
          return {
            success: false,
            error: retryError instanceof Error ? retryError.message : "Failed to execute action",
          };
        }
      }
    }

    // ══════════════════════════════════════════════════════
    // FULL PIPELINE — PII Detection + Redaction + Planning
    // ══════════════════════════════════════════════════════

    async function handleExecutePipeline(payload: {
      description: string;
      data?: Record<string, string>;
      tabId?: number;
    }): Promise<PipelineResult> {
      console.log(`🐾 [Pipeline] Starting: "${payload.description}"`);

      // Early check: is the active tab a restricted URL?
      const tab = await getActiveTab();
      if (tab?.url && isRestrictedUrl(tab.url)) {
        return {
          success: false,
          phase: "error",
          steps: [],
          plan: [],
          piiDetection: { regions: [], summary: { totalRegions: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, byCategory: {} as any, bySource: { dom: 0, vision: 0, combined: 0 }, overallConfidence: 0, detectionTimeMs: 0 }, sanitizedDOMMetadata: { safeElements: [], safeTextContent: "", safeForms: [], pageMetadata: { title: "", url: "", hasForm: false, hasCAPTCHA: false, elementCount: 0 } } },
          redactionSummary: { totalPII: 0, redacted: 0, cssInjected: false, overlayShown: false },
          planResult: { success: false, steps: [], reasoning: "", provider: "none", latencyMs: 0 },
          privacyProof: { sensitiveDataDetected: 0, sensitiveDataRedacted: 0, dataSentToServer: { rawScreenshot: false, formValues: false, piiText: false, faces: false, sanitizedStructure: false, taskDescription: false }, zeroOutboundPII: true, proofDescription: "" },
          reasoningTrace: null,
          latency: { capture: 0, ocr: 0, piiDetection: 0, redaction: 0, verification: 0, planning: 0, execution: 0, total: 0, backend: "error", tier: "error" },
          totalLatencyMs: 0,
          error: "Cannot run on browser pages (chrome://, edge://, etc). Navigate to a website first.",
        };
      }

      startMonitoring();

      const result = await (await lazyFullPipeline()).executeFullPipeline({
        taskDescription: payload.description,
        dataContext: payload.data,
        tabId: payload.tabId,
        // So a follow-up like "submit form" is read as a continuation of the
        // fill that preceded it, rather than a fresh fill request.
        recentTasks: [...recentTasks],
        // Stream each phase to the side panel as it happens.
        onProgress: (update: unknown) => {
          broadcast({ type: "PIPELINE_PROGRESS", payload: update });
        },
      });

      // Log the result
      log("analysis", `Pipeline complete: ${result.steps.length} steps, ` +
        `${result.piiDetection.summary.totalRegions} PII regions detected, ` +
        `${result.redactionSummary.redacted} redacted`
      );

      if (result.extractedData) {
        // Extraction tasks complete with no action plan by design.
        log("success",
          `Extracted ${result.extractedData.summary.fieldCount} fields ` +
          `(${result.extractedData.summary.maskedFieldCount} masked) on-device`
        );
      } else if (result.plan.length > 0) {
        log("success", `Action plan: ${result.plan.length} steps from ${result.planResult.provider}`);
      } else {
        log("warning", "No action plan generated");
      }

      // Remember the task for the next run's context. Descriptions only —
      // they are masked before they reach any provider.
      recentTasks.push(payload.description);
      if (recentTasks.length > MAX_RECENT_TASKS) recentTasks.shift();

      // Broadcast pipeline result to side panel
      broadcast({ type: "PIPELINE_COMPLETE", payload: result });

      return result;
    }

    // ══════════════════════════════════════════════════════
    // MEMORY
    // ══════════════════════════════════════════════════════

    async function handleGetMemory(payload: { domain: string }): Promise<unknown> {
      const r = await chrome.storage.local.get(`memory_${payload.domain}`);
      return r[`memory_${payload.domain}`] || null;
    }

    async function handleSaveMemory(payload: { domain: string; data: unknown }): Promise<void> {
      await chrome.storage.local.set({ [`memory_${payload.domain}`]: payload.data });
    }

    // ══════════════════════════════════════════════════════
    // HELPERS
    // ══════════════════════════════════════════════════════

    function isRestrictedUrl(url?: string): boolean {
      if (!url) return false;
      return /^(chrome-extension:|chrome:|edge:|about:|brave:)/.test(url);
    }

    async function getActiveTab() {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab;
    }

    function broadcast(message: { type: MessageType; payload: unknown }): void {
      chrome.runtime.sendMessage(message).catch(() => {});
    }

    function sleep(ms: number): Promise<void> {
      return new Promise((r) => setTimeout(r, ms));
    }

    // ══════════════════════════════════════════════════════
    // PROVIDER CHECK — Multi-provider LLM status
    // ══════════════════════════════════════════════════════

    async function handleCheckProviders() {
      try {
        const statuses = await (await lazyLLMProviders()).checkProviders();
        return { statuses };
      } catch (error) {
        return { statuses: [], error: error instanceof Error ? error.message : "Check failed" };
      }
    }

    // ══════════════════════════════════════════════════════
    // SCREENSHOT CAPTURE — via chrome.tabCapture
    // Only works from service worker, not content script
    // ══════════════════════════════════════════════════════

    async function handleCaptureTab(): Promise<{
      success: boolean;
      dataUrl?: string;
      width?: number;
      height?: number;
      error?: string;
    }> {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          return { success: false, error: "No active tab" };
        }

        // chrome.tabs.captureVisibleTab works from MV3 service workers
        // Returns a PNG data URL of the visible area — no canvas/video needed
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: "png",
          quality: 80,
        });

        return {
          success: true,
          dataUrl,
          width: tab.width || 1920,
          height: tab.height || 1080,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Capture failed",
        };
      }
    }

    // ══════════════════════════════════════════════════════
    // OCR — capture the visible tab + run PP-OCR in the offscreen host
    // ══════════════════════════════════════════════════════

    async function handleRunOcr(payload: {
      lang?: "auto" | "en" | "hi";
      maxSide?: number;
    }): Promise<{
      success: boolean;
      result?: OcrResult;
      imageDataUrl?: string;
      error?: string;
    }> {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return { success: false, error: "No active tab" };
        if (isRestrictedUrl(tab.url)) {
          return {
            success: false,
            error:
              "Cannot capture browser pages (chrome://, edge://, …). Navigate to a website first.",
          };
        }
        const imageDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: "png",
        });
        const result = await callOffscreen("runOcr", {
          imageDataUrl,
          lang: payload?.lang ?? "auto",
          maxSide: payload?.maxSide,
        });
        return { success: true, result, imageDataUrl };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "OCR failed",
        };
      }
    }

    function createEmptyPageState(): PageState {
      return {
        url: "", title: "", timestamp: Date.now(),
        elements: [], forms: [], textContent: "",
        metadata: {
          hasCAPTCHA: false, hasHoneypot: false, isSecure: true,
          hasFileUpload: false, hasPaymentForm: false,
          formCount: 0, totalElements: 0, interactiveElements: 0,
        },
        confidence: 0, perceptionTime: 0,
      };
    }
    } catch (e) { console.error("[VLESS] Background SW crashed:", e); }
  },
});
