import { useState, useEffect, useCallback } from "react";
import { TaskInput } from "./TaskInput";
import { ExtractedDataPanel } from "./ExtractedDataPanel";
import type { ExtractedData } from "../../core/extraction/page-extractor";
import type { PipelineProgress, PIIReviewField } from "../../core/pipeline/full-pipeline";
import type { RequiredInput } from "../../core/agent/requirements";
import type { PIIRegion } from "../../core/privacy/pii-detector";
import type { SubTask } from "../../core/agent/task-decomposer";
import { PipelineProgressPanel } from "./PipelineProgressPanel";
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
        case "PIPELINE_COMPLETE":
          setProgress(null);
          if (message.payload?.piiDetection?.regions) {
            setPiiRegions(message.payload.piiDetection.regions);
          }
          if (message.payload?.piiReview?.length) {
            setPiiReview(message.payload.piiReview);
          }
          if (message.payload?.needs?.length) {
            setNeeds(message.payload.needs);
          }
          if (message.payload?.extractedData) {
            setExtractedData(message.payload.extractedData);
            const ex = message.payload.extractedData;
            setTask({
              id: `extract-${Date.now()}`,
              description: "Extract data",
              status: "completed",
              plan: { steps: [], estimatedTime: 0, riskLevel: "low", requiresConfirmation: false, dataMappings: [] },
              currentStep: 0,
              totalSteps: 0,
              startTime: Date.now(),
              endTime: Date.now(),
              result: `Extracted ${ex.summary.fieldCount} fields (${ex.summary.maskedFieldCount} masked) on-device`,
            });
            break;
          }
          setExtractedData(null);
          if (message.payload?.plan?.length > 0) {
            setTask({
              id: `pipeline-${Date.now()}`,
              description: message.payload.planResult?.reasoning || "Pipeline task",
              status: "completed",
              plan: { steps: message.payload.plan, estimatedTime: 0, riskLevel: "low", requiresConfirmation: false, dataMappings: [] },
              currentStep: message.payload.plan.length,
              totalSteps: message.payload.plan.length,
              startTime: Date.now(),
              endTime: Date.now(),
              result: `Pipeline: ${message.payload.piiDetection?.summary?.totalRegions || 0} PII detected, ${message.payload.redactionSummary?.redacted || 0} redacted`,
            });
          }
          break;
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
    <div className="flex flex-col h-screen bg-[#090a0f] text-gray-100 font-sans relative overflow-hidden select-none">
      {/* ── Top Header Bar ───────────────────────────────────────── */}
      <header className="relative z-20 flex items-center justify-between px-4 py-2.5 bg-[#0f1118] border-b border-[#1b1e2a]">
        {/* Brand logo & tagline */}
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded bg-white flex items-center justify-center text-[#090a0f] font-bold text-xs font-mono">
            V
          </div>
          <span className="font-semibold text-sm text-white tracking-tight font-serif-title">VLESS</span>
          <span className="text-[9px] uppercase tracking-widest px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono font-medium">
            0 KB Egress
          </span>
        </div>

        {/* Action SVG icons */}
        <div className="flex items-center gap-1">
          {/* Visual Overlay */}
          <button
            onClick={toggleOverlay}
            className={`p-1.5 rounded text-xs transition-all ${
              overlayActive ? "bg-emerald-500 text-black font-semibold" : "hallmark-button text-gray-300"
            }`}
            title="Toggle Visual Overlay"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          </button>
          {/* AI Setup */}
          <button
            onClick={() => setActiveDrawer(activeDrawer === "ai" ? "none" : "ai")}
            className={`p-1.5 rounded text-xs transition-all ${
              activeDrawer === "ai" ? "bg-white text-black font-semibold" : "hallmark-button text-gray-300"
            }`}
            title="AI Providers"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
            </svg>
          </button>
          {/* Vision Runtime */}
          <button
            onClick={() => setActiveDrawer(activeDrawer === "models" ? "none" : "models")}
            className={`p-1.5 rounded text-xs transition-all ${
              activeDrawer === "models" ? "bg-white text-black font-semibold" : "hallmark-button text-gray-300"
            }`}
            title="Vision Models"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
            </svg>
          </button>
          {/* Privacy Ledger */}
          <button
            onClick={() => setActiveDrawer(activeDrawer === "privacy" ? "none" : "privacy")}
            className={`p-1.5 rounded text-xs transition-all ${
              activeDrawer === "privacy" ? "bg-white text-black font-semibold" : "hallmark-button text-gray-300"
            }`}
            title="Privacy Ledger"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          </button>
          {/* Shortcuts */}
          <button
            onClick={() => setShowShortcuts(!showShortcuts)}
            className="p-1.5 rounded hallmark-button text-gray-300 transition-all"
            title="Shortcuts"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
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
        <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 text-[11px] text-amber-300 flex items-center justify-between font-mono">
          <span className="flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            No AI Provider Connected
          </span>
          <button
            onClick={() => setActiveDrawer("ai")}
            className="text-[10px] px-2 py-0.5 bg-amber-400 text-black font-semibold rounded hover:bg-amber-300 transition-colors uppercase tracking-wider"
          >
            Setup →
          </button>
        </div>
      )}

      {/* ── Main View (Workspace) ────────────────────────────────── */}
      <main className="flex-1 overflow-hidden relative z-10">
        <TaskInput onStartTask={startTask} onCancelTask={cancelTask} task={task}>
          {progress && <PipelineProgressPanel progress={progress} />}
          {!progress && subTasks && (
            <div className="hallmark-card p-3 space-y-1.5 animate-fade-in">
              <p className="text-[10px] text-gray-400 font-mono uppercase tracking-widest font-medium">
                {subTasks.length} Sub-Tasks Decomposed
              </p>
              <div className="space-y-1">
                {subTasks.map((st, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-gray-300">
                    <span className="w-1.5 h-1.5 rounded-full bg-gray-500" />
                    <span className="flex-1 font-light">{st.description}</span>
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
        <div className="absolute inset-0 z-30 flex flex-col bg-[#090a0f] animate-fade-in border-l border-[#1b1e2a]">
          <div className="flex items-center justify-between px-4 py-2.5 bg-[#0f1118] border-b border-[#1b1e2a]">
            <span className="text-xs font-mono uppercase font-semibold text-white tracking-wider">
              {activeDrawer === "ai" && "AI Provider Setup"}
              {activeDrawer === "models" && "Runtime & Vision Models"}
              {activeDrawer === "privacy" && "Privacy Ledger"}
              {activeDrawer === "learn" && "Learning Log"}
              {activeDrawer === "debug" && "Reasoning Trace"}
            </span>
            <button
              onClick={() => setActiveDrawer("none")}
              className="text-xs px-2 py-0.5 rounded hallmark-button text-gray-400 hover:text-white font-mono uppercase"
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
      <footer className="relative z-20 flex items-center justify-between px-4 py-2 bg-[#0f1118] border-t border-[#1b1e2a] text-[10px] text-gray-500 font-mono">
        <span>{task ? `${task.status.toUpperCase()} • STEP ${task.currentStep}/${task.totalSteps}` : "VLESS READY"}</span>
        <div className="flex items-center gap-3">
          <button onClick={() => setActiveDrawer("learn")} className="hover:text-white transition-colors uppercase">
            Log
          </button>
          <button onClick={() => setActiveDrawer("debug")} className="hover:text-white transition-colors uppercase">
            Debug
          </button>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        </div>
      </footer>
    </div>
  );
}

function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="hallmark-card border border-[#252938] rounded-xl p-5 max-w-xs w-full mx-4 animate-fade-in">
        <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2 font-mono uppercase">
          Shortcuts
        </h3>
        <div className="space-y-2">
          {Object.entries(SHORTCUTS).map(([key, desc]) => (
            <div key={key} className="flex items-center justify-between">
              <span className="text-[11px] text-gray-300 font-light">{desc}</span>
              <kbd className="text-[10px] bg-[#1a1d29] border border-[#2c3144] rounded px-2 py-0.5 text-white font-mono">
                {key}
              </kbd>
            </div>
          ))}
        </div>
        <button
          onClick={onClose}
          className="mt-4 w-full text-[11px] text-gray-500 hover:text-white transition-colors text-center font-mono uppercase"
        >
          Close (Esc)
        </button>
      </div>
    </div>
  );
}
