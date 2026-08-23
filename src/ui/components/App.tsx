import { useState, useEffect, useCallback } from "react";
import { TaskInput } from "./TaskInput";
import { ExtractedDataPanel } from "./ExtractedDataPanel";
import type { ExtractedData } from "../../core/extraction/page-extractor";
import type { PipelineProgress, PIIReviewField, PipelineResult } from "../../core/pipeline/full-pipeline";
import type { RequiredInput } from "../../core/agent/requirements";
import type { PIIRegion } from "../../core/privacy/pii-detector";
import type { SubTask } from "../../core/agent/task-decomposer";
import { PipelineProgressPanel } from "./PipelineProgressPanel";
import { PipelineSummaryPanel } from "./PipelineSummaryPanel";
import { PIIResultsPanel } from "./PIIResultsPanel";
import { PIIReviewPanel } from "./PIIReviewPanel";
import { NeedsInputPanel } from "./NeedsInputPanel";
import { ReasoningTrace } from "./ReasoningTrace";

import { LearningLog } from "./LearningLog";
import { PrivacyMonitor } from "./PrivacyMonitor";
import { RuntimePanel } from "./RuntimePanel";
import { ProviderSettings } from "./ProviderSettings";
import { Onboarding } from "./Onboarding";
import { useKeyboardShortcuts, SHORTCUTS } from "../hooks/useKeyboardShortcuts";
import type {
  AgentTask,
  ReasoningStep,
  PageState,
  MessageType,
} from "../../types";

type DrawerType = "none" | "ai" | "models" | "learn" | "privacy" | "voice" | "debug";

export function App() {
  const [activeDrawer, setActiveDrawer] = useState<DrawerType>("none");
  const [task, setTask] = useState<AgentTask | null>(null);
  const [extractedData, setExtractedData] = useState<ExtractedData | null>(null);
  const [piiRegions, setPiiRegions] = useState<PIIRegion[] | null>(null);
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [pipelineResult, setPipelineResult] = useState<PipelineResult | null>(null);
  const [subTasks, setSubTasks] = useState<SubTask[] | null>(null);
  const [piiReview, setPiiReview] = useState<PIIReviewField[] | null>(null);
  const [needs, setNeeds] = useState<RequiredInput[] | null>(null);
  const [lastTask, setLastTask] = useState<{ description: string; data?: Record<string, string> } | null>(null);
  const [reasoningTrace, setReasoningTrace] = useState<ReasoningStep[]>([]);
  const [, _setPageState] = useState<PageState | null>(null);
  const [overlayActive, setOverlayActive] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [llmStatus, setLlmStatus] = useState<{ available: boolean; provider?: string; model?: string }>({ available: false });

  // ── Check First Visit & LLM Status ───────────────────────

  useEffect(() => {
    chrome.storage.local.get("onboardingComplete", (result) => {
      if (!result.onboardingComplete) {
        setShowOnboarding(true);
      }
    });

    const checkLLM = async () => {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "CHECK_PROVIDERS",
          source: "sidepanel",
          timestamp: Date.now(),
        });
        if (response?.statuses) {
          const active = response.statuses.find((s: { available: boolean }) => s.available);
          if (active) {
            setLlmStatus({ available: true, provider: active.name, model: active.model });
          } else {
            setLlmStatus({ available: false });
          }
        }
      } catch {
        setLlmStatus({ available: false });
      }
    };
    checkLLM();
  }, []);

  const handleOnboardingComplete = useCallback((openSettings?: boolean) => {
    setShowOnboarding(false);
    chrome.storage.local.set({ onboardingComplete: true });
    if (openSettings) {
      setActiveDrawer("ai");
    }
  }, []);

  // ── Message Handling ─────────────────────────────────────

  useEffect(() => {
    const listener = (message: { type: MessageType; payload: any }) => {
      switch (message.type) {
        case "TASK_STATUS":
          setTask(message.payload);
          break;
        case "TASK_COMPLETE":
          setTask(message.payload.task);
          break;
        case "PIPELINE_PROGRESS":
          setProgress(message.payload);
          break;
        case "PIPELINE_COMPLETE": {
          const result: PipelineResult = message.payload;
          setProgress(null);
          setPipelineResult(result);

          if (result?.piiDetection?.regions) {
            setPiiRegions(result.piiDetection.regions);
          }
          if (result?.piiReview?.length) {
            setPiiReview(result.piiReview);
          }
          if (result?.needs?.length) {
            setNeeds(result.needs);
          }
          if (result?.extractedData) {
            setExtractedData(result.extractedData);
          }

          setTask((prev) => {
            const description = prev?.description || result.planResult?.reasoning || "Pipeline task";
            const totalSteps = result.plan?.length ?? 0;

            return {
              id: prev?.id || `pipeline-${Date.now()}`,
              description,
              status: result.success ? "completed" : "failed",
              plan: {
                steps: result.plan || [],
                estimatedTime: result.latency?.total || 0,
                riskLevel: "low",
                requiresConfirmation: false,
                dataMappings: [],
              },
              currentStep: totalSteps,
              totalSteps,
              startTime: prev?.startTime || Date.now(),
              endTime: Date.now(),
              result: result.success
                ? `Completed ${totalSteps} steps — ${result.piiDetection?.summary?.totalRegions || 0} PII detected, ${result.redactionSummary?.redacted || 0} redacted (${result.latency?.total ? result.latency.total.toFixed(0) : 0}ms)`
                : result.error || "Pipeline failed",
              error: result.success ? undefined : result.error || "Pipeline failed",
            };
          });
          break;
        }
        case "UPDATE_DEBUG_OVERLAY":
          if (message.payload.reasoningTrace) {
            setReasoningTrace(message.payload.reasoningTrace);
          }
          break;
        case "PAGE_STATE":
          _setPageState(message.payload);
          break;
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // ── Keyboard Shortcuts ───────────────────────────────────

  useKeyboardShortcuts({
    onNewTask: () => setActiveDrawer("none"),
    onCancelTask: () => {
      chrome.runtime.sendMessage({
        type: "CANCEL_TASK",
        source: "sidepanel",
        timestamp: Date.now(),
      });
      setTask(null);
      setProgress(null);
    },
    onToggleOverlay: async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        await chrome.tabs.sendMessage(tab.id, {
          type: "TOGGLE_OVERLAY",
          payload: { active: true },
        });
      }
    },
    onUndo: () => {},
    onRedo: () => {},
    onScanPage: async () => {
      const response = await chrome.runtime.sendMessage({
        type: "PERCEIVE_PAGE",
        source: "sidepanel",
        timestamp: Date.now(),
      });
      _setPageState(response);
    },
    onFocusInput: () => {
      setActiveDrawer("none");
    },
  });

  // ── Actions ──────────────────────────────────────────────

  const startTask = useCallback(async (description: string, data?: Record<string, string>) => {
    setExtractedData(null);
    setPiiRegions(null);
    setSubTasks(null);
    setPiiReview(null);
    setNeeds(null);
    setPipelineResult(null);
    setLastTask({ description, data });
    setProgress({ currentPhase: "capture", steps: [], elapsedMs: 0 });
    setTask({
      id: `pipeline-${Date.now()}`,
      description,
      status: "analyzing",
      plan: { steps: [], estimatedTime: 0, riskLevel: "low", requiresConfirmation: false, dataMappings: [] },
      currentStep: 0,
      totalSteps: 0,
      startTime: Date.now(),
    });

    try {
      const response = await chrome.runtime.sendMessage({
        type: "EXECUTE_PIPELINE",
        payload: { description, data },
        source: "sidepanel",
        timestamp: Date.now(),
      });

      if (response?.piiDetection?.regions) setPiiRegions(response.piiDetection.regions);
      if (response?.piiReview?.length) setPiiReview(response.piiReview);
      if (response?.needs?.length) setNeeds(response.needs);
      if (response?.extractedData) setExtractedData(response.extractedData);
      if (response?.subTasks?.length > 1) setSubTasks(response.subTasks);
    } catch {
      setTask({
        id: `pipeline-${Date.now()}`,
        description,
        status: "failed",
        plan: { steps: [], estimatedTime: 0, riskLevel: "low", requiresConfirmation: false, dataMappings: [] },
        currentStep: 0,
        totalSteps: 0,
        startTime: Date.now(),
        error: "Extension context disconnected. Reload the page.",
      });
    }
  }, []);

  const cancelTask = useCallback(() => {
    chrome.runtime.sendMessage({
      type: "CANCEL_TASK",
      source: "sidepanel",
      timestamp: Date.now(),
    });
    setTask(null);
    setProgress(null);
  }, []);

  const toggleOverlay = useCallback(async () => {
    const nextState = !overlayActive;
    setOverlayActive(nextState);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, {
        type: "TOGGLE_OVERLAY",
        payload: { active: nextState },
      });
    }
  }, [overlayActive]);

  if (showOnboarding) {
    return <Onboarding onComplete={handleOnboardingComplete} />;
  }

  return (
    <div className="flex flex-col h-screen bg-[var(--color-paper)] text-[var(--color-ink)] font-sans relative overflow-hidden select-none">
      {/* ── Top Masthead Header ──────────────────────────────────── */}
      <header className="relative z-20 flex items-center justify-between px-4 py-2 bg-[var(--color-paper)] border-b-2 border-[var(--color-ink)]">
        {/* Brand mark */}
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 bg-[var(--color-ink)] text-[var(--color-paper)] flex items-center justify-center font-display-poster text-xs font-bold">
            V
          </div>
          <span className="font-display-poster text-base tracking-wide text-[var(--color-ink)] uppercase">VLESS</span>
          <span className="text-[9px] font-mono-press uppercase px-1.5 py-0.5 bg-[var(--color-accent)] text-[var(--color-paper)] font-bold">
            0 KB EGRESS
          </span>
        </div>

        {/* Action SVG icons */}
        <div className="flex items-center gap-1">
          <button
            onClick={toggleOverlay}
            className={`p-1.5 rounded-none text-xs transition-all ${
              overlayActive ? "bg-[var(--color-accent)] text-[var(--color-paper)]" : "hallmark-button"
            }`}
            title="Toggle Visual Overlay"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          </button>
          <button
            onClick={() => setActiveDrawer(activeDrawer === "ai" ? "none" : "ai")}
            className={`p-1.5 rounded-none text-xs transition-all ${
              activeDrawer === "ai" ? "bg-[var(--color-accent)] text-[var(--color-paper)]" : "hallmark-button"
            }`}
            title="AI Providers"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
            </svg>
          </button>
          <button
            onClick={() => setActiveDrawer(activeDrawer === "models" ? "none" : "models")}
            className={`p-1.5 rounded-none text-xs transition-all ${
              activeDrawer === "models" ? "bg-[var(--color-accent)] text-[var(--color-paper)]" : "hallmark-button"
            }`}
            title="Vision Models"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
            </svg>
          </button>
          <button
            onClick={() => setActiveDrawer(activeDrawer === "privacy" ? "none" : "privacy")}
            className={`p-1.5 rounded-none text-xs transition-all ${
              activeDrawer === "privacy" ? "bg-[var(--color-accent)] text-[var(--color-paper)]" : "hallmark-button"
            }`}
            title="Privacy Ledger"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          </button>
          <button
            onClick={() => setShowShortcuts(!showShortcuts)}
            className="p-1.5 rounded-none hallmark-button transition-all"
            title="Shortcuts"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </button>
        </div>
      </header>

      {/* Shortcuts Overlay Modal */}
      {showShortcuts && (
        <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />
      )}

      {/* LLM Status Banner */}
      {!llmStatus.available && (
        <div className="px-4 py-2 bg-[var(--color-accent)] text-[var(--color-paper)] text-[11px] font-mono-press font-semibold flex items-center justify-between border-b-2 border-[var(--color-ink)]">
          <span className="flex items-center gap-1.5 uppercase">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            No AI Provider Connected
          </span>
          <button
            onClick={() => setActiveDrawer("ai")}
            className="text-[10px] px-2 py-0.5 bg-[var(--color-paper)] text-[var(--color-ink)] font-bold uppercase tracking-wider border border-[var(--color-ink)]"
          >
            Setup →
          </button>
        </div>
      )}

      {/* ── Main View (Workspace) ────────────────────────────────── */}
      <main className="flex-1 overflow-hidden relative z-10">
        <TaskInput onStartTask={startTask} onCancelTask={cancelTask} task={task}>
          {progress && <PipelineProgressPanel progress={progress} />}
          {!progress && pipelineResult && <PipelineSummaryPanel result={pipelineResult} />}
          {!progress && subTasks && (
            <div className="hallmark-card p-3 space-y-1.5 animate-fade-in font-mono-press">
              <p className="text-[10px] uppercase tracking-widest font-semibold text-[var(--color-ink-mute)]">
                {subTasks.length} Sub-Tasks Decomposed
              </p>
              <div className="space-y-1">
                {subTasks.map((st, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-[var(--color-ink)] font-body-editorial">
                    <span className="w-1.5 h-1.5 bg-[var(--color-ink)]" />
                    <span className="flex-1">{st.description}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {!progress && needs && needs.length > 0 && (
            <NeedsInputPanel
              needs={needs}
              onRetry={
                lastTask
                  ? () => void startTask(lastTask.description, lastTask.data)
                  : undefined
              }
            />
          )}
          {!progress && piiReview && piiReview.length > 0 && (
            <PIIReviewPanel fields={piiReview} />
          )}
          {extractedData && <ExtractedDataPanel data={extractedData} />}
          {!progress && piiRegions && piiRegions.length > 0 && (
            <PIIResultsPanel regions={piiRegions} />
          )}
        </TaskInput>
      </main>

      {/* ── Slide-Over Modals ────────────────────────────────────── */}
      {activeDrawer !== "none" && (
        <div className="absolute inset-0 z-30 flex flex-col bg-[var(--color-paper)] animate-fade-in border-l-2 border-[var(--color-ink)]">
          <div className="flex items-center justify-between px-4 py-2.5 bg-[var(--color-paper-2)] border-b-2 border-[var(--color-ink)]">
            <span className="text-sm font-display-poster uppercase tracking-wider text-[var(--color-ink)]">
              {activeDrawer === "ai" && "AI Provider Setup"}
              {activeDrawer === "models" && "Runtime & Vision Models"}
              {activeDrawer === "privacy" && "Privacy Ledger"}
              {activeDrawer === "learn" && "Learning Log"}
              {activeDrawer === "debug" && "Reasoning Trace"}
            </span>
            <button
              onClick={() => setActiveDrawer("none")}
              className="text-xs px-2 py-0.5 hallmark-button font-mono-press uppercase"
            >
              Close ✕
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
            {activeDrawer === "ai" && <ProviderSettings />}
            {activeDrawer === "models" && <RuntimePanel />}
            {activeDrawer === "privacy" && <PrivacyMonitor />}
            {activeDrawer === "learn" && <LearningLog />}
            {activeDrawer === "debug" && <ReasoningTrace steps={reasoningTrace} task={task} />}
          </div>
        </div>
      )}

      {/* ── Footer Bar ───────────────────────────────────────────── */}
      <footer className="relative z-20 flex items-center justify-between px-4 py-2 bg-[var(--color-paper-2)] border-t-2 border-[var(--color-ink)] text-[10px] font-mono-press font-semibold uppercase">
        <span>{task ? `${task.status.toUpperCase()} • STEP ${task.currentStep}/${task.totalSteps}` : "VLESS READY"}</span>
        <div className="flex items-center gap-3">
          <button onClick={() => setActiveDrawer("learn")} className="hover:text-[var(--color-accent)] transition-colors">
            Log
          </button>
          <button onClick={() => setActiveDrawer("debug")} className="hover:text-[var(--color-accent)] transition-colors">
            Debug
          </button>
          <span className="w-2 h-2 rounded-full bg-[var(--color-teal)]" />
        </div>
      </footer>
    </div>
  );
}

function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(40,35,29,0.8)]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="hallmark-card p-5 max-w-xs w-full mx-4 animate-fade-in space-y-3">
        <h3 className="text-lg font-display-poster uppercase text-[var(--color-ink)] border-b-2 border-[var(--color-ink)] pb-1">
          Shortcuts
        </h3>
        <div className="space-y-2 font-mono-press text-xs">
          {Object.entries(SHORTCUTS).map(([key, desc]) => (
            <div key={key} className="flex items-center justify-between">
              <span className="text-[var(--color-ink-2)]">{desc}</span>
              <kbd className="text-[10px] bg-[var(--color-paper-2)] border border-[var(--color-ink)] px-2 py-0.5 font-bold text-[var(--color-ink)]">
                {key}
              </kbd>
            </div>
          ))}
        </div>
        <button
          onClick={onClose}
          className="w-full hallmark-button text-xs py-1.5 font-mono-press uppercase"
        >
          Close (Esc)
        </button>
      </div>
    </div>
  );
}
