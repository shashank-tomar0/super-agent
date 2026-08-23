import { useState, useEffect, useCallback } from "react";
import { TaskInput } from "./TaskInput";
import { AgentStatusPanel } from "./AgentStatusPanel";
import { LearningLog } from "./LearningLog";
import { PageInspector } from "./PageInspector";
import { ReasoningTrace } from "./ReasoningTrace";
import { PrivacyLedger } from "./PrivacyLedger";
import { PrivacyMonitor } from "./PrivacyMonitor";
import { RuntimePanel } from "./RuntimePanel";
import { ModelManagerUI } from "./ModelManagerUI";
import { ProviderSettings } from "./ProviderSettings";
import { Onboarding } from "./Onboarding";
import { useKeyboardShortcuts, SHORTCUTS } from "../hooks/useKeyboardShortcuts";
import type {
  AgentTask,
  ReasoningStep,
  PageState,
  MessageType,
} from "../../types";

// ── Tab Configuration ──────────────────────────────────────

type Tab = "dashboard" | "task" | "perception" | "privacy" | "models" | "settings" | "debug";

const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: "dashboard", icon: "\u2302", label: "Home" },
  { id: "task", icon: "\u2699", label: "Task" },
  { id: "perception", icon: "\u25ce", label: "See" },
  { id: "privacy", icon: "\u2744", label: "Privacy" },
  { id: "models", icon: "\u2630", label: "ML" },
  { id: "settings", icon: "\u2261", label: "AI" },
  { id: "debug", icon: "\u2263", label: "Log" },
];

// ── Main App ───────────────────────────────────────────────

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const [task, setTask] = useState<AgentTask | null>(null);
  const [reasoningTrace, setReasoningTrace] = useState<ReasoningStep[]>([]);
  const [pageState, setPageState] = useState<PageState | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [llmStatus, setLlmStatus] = useState<{
    available: boolean;
    provider?: string;
    model?: string;
  }>({ available: false });
  const [pipelineResult, setPipelineResult] = useState<any>(null);

  // ── First-Visit Check & LLM Status ───────────────────────

  useEffect(() => {
    chrome.storage.local.get("onboardingComplete", (result) => {
      if (!result.onboardingComplete) setShowOnboarding(true);
    });

    const checkLLM = async () => {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "CHECK_PROVIDERS",
          source: "sidepanel",
          timestamp: Date.now(),
        });
        if (response?.statuses) {
          const active = response.statuses.find(
            (s: { available: boolean }) => s.available
          );
          if (active) {
            setLlmStatus({
              available: true,
              provider: active.name,
              model: active.model,
            });
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
    if (openSettings) setActiveTab("settings");
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
          if (message.payload.pipelineResult) {
            setPipelineResult(message.payload.pipelineResult);
          }
          break;
        case "PIPELINE_COMPLETE":
          setPipelineResult(message.payload);
          if (message.payload?.plan?.length > 0) {
            setTask({
              id: `pipeline-${Date.now()}`,
              description: message.payload.planResult?.reasoning || "Pipeline task",
              status: "completed",
              plan: {
                steps: message.payload.plan,
                estimatedTime: 0,
                riskLevel: "low",
                requiresConfirmation: false,
                dataMappings: [],
              },
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
          setPageState(message.payload);
          break;
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // ── Keyboard Shortcuts ───────────────────────────────────

  useKeyboardShortcuts({
    onNewTask: () => setActiveTab("task"),
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
      setPageState(response);
    },
    onFocusInput: () => {
      setActiveTab("task");
    },
  });

  // ── Actions ──────────────────────────────────────────────

  const startTask = useCallback(
    async (description: string, data?: Record<string, string>) => {
      const response = await chrome.runtime.sendMessage({
        type: "EXECUTE_PIPELINE",
        payload: { description, data },
        source: "sidepanel",
        timestamp: Date.now(),
      });
      if (response?.plan?.length > 0) {
        setPipelineResult(response);
        setTask({
          id: `pipeline-${Date.now()}`,
          description,
          status: "completed",
          plan: {
            steps: response.plan,
            estimatedTime: 0,
            riskLevel: "low",
            requiresConfirmation: false,
            dataMappings: [],
          },
          currentStep: response.plan.length,
          totalSteps: response.plan.length,
          startTime: Date.now(),
          endTime: Date.now(),
          result: `${response.piiDetection?.summary?.totalRegions || 0} PII detected, ${response.redactionSummary?.redacted || 0} redacted, ${response.plan.length} steps planned`,
        });
      } else {
        const fallbackResponse = await chrome.runtime.sendMessage({
          type: "START_TASK",
          payload: { description, data },
          source: "sidepanel",
          timestamp: Date.now(),
        });
        setTask(fallbackResponse);
      }
    },
    []
  );

  const cancelTask = useCallback(async () => {
    await chrome.runtime.sendMessage({
      type: "CANCEL_TASK",
      source: "sidepanel",
      timestamp: Date.now(),
    });
    setTask(null);
  }, []);

  const refreshPage = useCallback(async () => {
    const response = await chrome.runtime.sendMessage({
      type: "PERCEIVE_PAGE",
      source: "sidepanel",
      timestamp: Date.now(),
    });
    setPageState(response);
  }, []);

  // ── Onboarding Gate ──────────────────────────────────────

  if (showOnboarding) {
    return <Onboarding onComplete={handleOnboardingComplete} />;
  }

  // ── Render ───────────────────────────────────────────────

  const isRunning =
    task?.status === "executing" ||
    task?.status === "analyzing" ||
    task?.status === "planning" ||
    task?.status === "verifying";

  return (
    <div className="h-screen flex flex-col bg-[#0a0a0f] text-gray-100 font-sans select-none">
      {/* ── Header ── */}
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06] bg-white/[0.02] backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-[10px] font-bold text-white">
            V
          </div>
          <h1 className="text-[13px] font-semibold tracking-tight text-white">
            VLESS
          </h1>
          <span className="text-[9px] text-gray-500 bg-white/[0.05] px-1.5 py-0.5 rounded-full font-medium">
            0.1.0
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {llmStatus.available && (
            <span className="text-[9px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded-full border border-emerald-500/20">
              {llmStatus.provider}
            </span>
          )}
          {!llmStatus.available && (
            <button
              onClick={() => setActiveTab("settings")}
              className="text-[9px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded-full border border-amber-500/20 hover:bg-amber-500/20 transition-colors"
            >
              No AI
            </button>
          )}
          <button
            onClick={() => setShowShortcuts(!showShortcuts)}
            className="w-6 h-6 flex items-center justify-center text-gray-500 hover:text-gray-300 hover:bg-white/[0.05] rounded transition-colors text-[11px]"
            title="Keyboard shortcuts"
          >
            \u2328
          </button>
          <div
            className={`w-1.5 h-1.5 rounded-full ${
              isRunning
                ? "bg-emerald-400 animate-pulse"
                : task?.status === "failed"
                  ? "bg-red-400"
                  : task?.status === "completed"
                    ? "bg-emerald-500"
                    : "bg-gray-600"
            }`}
          />
        </div>
      </header>

      {/* ── Shortcuts Overlay ── */}
      {showShortcuts && (
        <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />
      )}

      {/* ── No-AI Warning ── */}
      {!llmStatus.available && !showOnboarding && (
        <div className="px-4 py-2 bg-amber-500/[0.06] border-b border-amber-500/10">
          <div className="flex items-center gap-2">
            <span className="text-amber-400 text-[11px]">\u26a0</span>
            <div className="flex-1">
              <p className="text-[10px] text-amber-300 font-medium">
                No AI provider configured
              </p>
              <p className="text-[9px] text-amber-400/60 mt-0.5">
                Configure an LLM in Settings for full agent capability.
              </p>
            </div>
            <button
              onClick={() => setActiveTab("settings")}
              className="text-[9px] px-2 py-1 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 rounded transition-colors border border-amber-500/20"
            >
              Setup \u2192
            </button>
          </div>
        </div>
      )}

      {/* ── Tab Navigation ── */}
      <nav className="flex border-b border-white/[0.06] bg-white/[0.01]">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 flex flex-col items-center py-2 transition-all duration-150 ${
              activeTab === tab.id
                ? "text-white border-b-2 border-indigo-500 bg-white/[0.03]"
                : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.02]"
            }`}
          >
            <span className="text-[13px] leading-none mb-0.5">{tab.icon}</span>
            <span className="text-[9px] font-medium">{tab.label}</span>
          </button>
        ))}
      </nav>

      {/* ── Content ── */}
      <main className="flex-1 overflow-y-auto">
        {activeTab === "dashboard" && (
          <DashboardTab
            task={task}
            llmStatus={llmStatus}
            pipelineResult={pipelineResult}
            onGoTask={() => setActiveTab("task")}
            onGoSettings={() => setActiveTab("settings")}
          />
        )}
        {activeTab === "task" && (
          <TaskInput
            onStartTask={startTask}
            onCancelTask={cancelTask}
            task={task}
            pipelineResult={pipelineResult}
          />
        )}
        {activeTab === "perception" && (
          <PerceptionTab
            pageState={pageState}
            reasoningTrace={reasoningTrace}
            onRefresh={refreshPage}
            task={task}
          />
        )}
        {activeTab === "privacy" && <PrivacyTab pipelineResult={pipelineResult} />}
        {activeTab === "models" && <ModelsTab />}
        {activeTab === "settings" && <ProviderSettings />}
        {activeTab === "debug" && <LearningLog />}
      </main>

      {/* ── Status Bar ── */}
      <footer className="flex items-center justify-between px-4 py-1.5 border-t border-white/[0.06] bg-white/[0.01]">
        <span className="text-[9px] text-gray-600">
          {task
            ? `${task.status} \u00b7 ${task.currentStep}/${task.totalSteps}`
            : "Ready"}
        </span>
        <div className="flex items-center gap-2">
          {pipelineResult?.latency?.total && (
            <span className="text-[9px] text-gray-600 font-mono">
              {pipelineResult.latency.total.toFixed(0)}ms
            </span>
          )}
          <span className="text-[9px] text-gray-600 flex items-center gap-1">
            <span className={`w-1 h-1 rounded-full inline-block ${
              pipelineResult?.planResult?.provider === 'cloud' ||
              pipelineResult?.planResult?.provider?.startsWith('openai') ||
              pipelineResult?.planResult?.provider?.startsWith('claude') ||
              pipelineResult?.planResult?.provider?.startsWith('openrouter')
                ? 'bg-amber-500' : 'bg-emerald-500'
            }`} />
            {pipelineResult?.planResult?.provider === 'rule-based' || !pipelineResult
              ? 'On-Device'
              : pipelineResult?.planResult?.provider === 'deterministic'
                ? 'On-Device'
                : pipelineResult?.planResult?.provider === 'ollama'
                  ? 'On-Device'
                  : `Via ${pipelineResult?.planResult?.provider?.split('/')[0] || 'server'}`
            }
          </span>
        </div>
      </footer>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// DASHBOARD TAB
// ══════════════════════════════════════════════════════════════

function DashboardTab({
  task,
  llmStatus,
  pipelineResult,
  onGoTask,
  onGoSettings,
}: {
  task: AgentTask | null;
  llmStatus: { available: boolean; provider?: string; model?: string };
  pipelineResult: any;
  onGoTask: () => void;
  onGoSettings: () => void;
}) {
  return (
    <div className="p-4 space-y-4">
      {/* Hero */}
      <div className="text-center py-4">
        <div className="w-14 h-14 mx-auto rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-2xl font-bold text-white shadow-lg shadow-indigo-500/20 mb-3">
          V
        </div>
        <h2 className="text-lg font-bold text-white tracking-tight">VLESS</h2>
        <p className="text-[11px] text-gray-500 mt-1 max-w-[250px] mx-auto leading-relaxed">
          Privacy-preserving on-device browser agent with visual perception.
        </p>
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-2 gap-2">
        <StatusCard
          icon="\ud83d\udd12"
          label="Privacy"
          value={pipelineResult ? `${pipelineResult.redactionSummary?.redacted || 0} redacted` : "Idle"}
          color="emerald"
        />
        <StatusCard
          icon="\ud83e\udde0"
          label="AI"
          value={llmStatus.available ? llmStatus.provider || "Connected" : "Offline"}
          color={llmStatus.available ? "blue" : "gray"}
        />
        <StatusCard
          icon="\ud83d\udcca"
          label="PII Found"
          value={pipelineResult ? `${pipelineResult.piiDetection?.summary?.totalRegions || 0}` : "0"}
          color="amber"
        />
        <StatusCard
          icon="\u26a1"
          label="Latency"
          value={pipelineResult?.latency?.total ? `${pipelineResult.latency.total.toFixed(0)}ms` : "\u2014"}
          color="purple"
        />
      </div>

      {/* Task Status */}
      <AgentStatusPanel task={task} />

      {/* Quick Actions */}
      <div className="space-y-2">
        <button
          onClick={onGoTask}
          className="w-full py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white text-[12px] font-semibold rounded-lg transition-all shadow-lg shadow-indigo-500/10"
        >
          Start New Task
        </button>
        {!llmStatus.available && (
          <button
            onClick={onGoSettings}
            className="w-full py-2 bg-white/[0.05] hover:bg-white/[0.08] text-gray-300 text-[11px] font-medium rounded-lg transition-colors border border-white/[0.06]"
          >
            Configure AI Provider
          </button>
        )}
      </div>

      {/* Privacy Proof (if available) */}
      {pipelineResult?.privacyProof && (
        <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[11px]">\u2714</span>
            <span className="text-[11px] font-medium text-emerald-400">
              Privacy Proof
            </span>
          </div>
          <div className="space-y-1 text-[10px] text-gray-400 font-mono">
            <div>PII detected: {pipelineResult.privacyProof.sensitiveDataDetected}</div>
            <div>PII redacted: {pipelineResult.privacyProof.sensitiveDataRedacted}</div>
            <div>Zero PII sent: {pipelineResult.privacyProof.zeroOutboundPII ? "Yes" : "No"}</div>
            <div>Re-OCR verified: {pipelineResult.privacyProof.redactionVerified ? "Passed" : "Pending"}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusCard({
  icon,
  label,
  value,
  color,
}: {
  icon: string;
  label: string;
  value: string;
  color: string;
}) {
  const colors: Record<string, string> = {
    emerald: "border-emerald-500/20 bg-emerald-500/[0.04]",
    blue: "border-blue-500/20 bg-blue-500/[0.04]",
    amber: "border-amber-500/20 bg-amber-500/[0.04]",
    purple: "border-purple-500/20 bg-purple-500/[0.04]",
    gray: "border-white/[0.06] bg-white/[0.02]",
  };
  return (
    <div className={`rounded-xl p-3 border ${colors[color] || colors.gray}`}>
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-[11px]">{icon}</span>
        <span className="text-[9px] text-gray-500 font-medium">{label}</span>
      </div>
      <span className="text-[13px] font-bold text-gray-200">{value}</span>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// PERCEPTION TAB
// ══════════════════════════════════════════════════════════════

function PerceptionTab({
  pageState,
  reasoningTrace,
  onRefresh,
  task,
}: {
  pageState: PageState | null;
  reasoningTrace: ReasoningStep[];
  onRefresh: () => void;
  task: AgentTask | null;
}) {
  const [subTab, setSubTab] = useState<"inspector" | "trace">("inspector");

  return (
    <div className="flex flex-col h-full">
      <div className="flex border-b border-white/[0.06]">
        <button
          onClick={() => setSubTab("inspector")}
          className={`flex-1 py-2 text-[10px] font-medium transition-colors ${
            subTab === "inspector"
              ? "text-white border-b-2 border-indigo-500"
              : "text-gray-500 hover:text-gray-300"
          }`}
        >
          Page Inspector
        </button>
        <button
          onClick={() => setSubTab("trace")}
          className={`flex-1 py-2 text-[10px] font-medium transition-colors ${
            subTab === "trace"
              ? "text-white border-b-2 border-indigo-500"
              : "text-gray-500 hover:text-gray-300"
          }`}
        >
          Reasoning Trace
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {subTab === "inspector" && (
          <PageInspector pageState={pageState} onRefresh={onRefresh} />
        )}
        {subTab === "trace" && (
          <ReasoningTrace steps={reasoningTrace} task={task} />
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// PRIVACY TAB
// ══════════════════════════════════════════════════════════════

function PrivacyTab({ pipelineResult }: { pipelineResult: any }) {
  const [subTab, setSubTab] = useState<"monitor" | "ledger">("monitor");

  return (
    <div className="flex flex-col h-full">
      <div className="flex border-b border-white/[0.06]">
        <button
          onClick={() => setSubTab("monitor")}
          className={`flex-1 py-2 text-[10px] font-medium transition-colors ${
            subTab === "monitor"
              ? "text-white border-b-2 border-indigo-500"
              : "text-gray-500 hover:text-gray-300"
          }`}
        >
          Network Monitor
        </button>
        <button
          onClick={() => setSubTab("ledger")}
          className={`flex-1 py-2 text-[10px] font-medium transition-colors ${
            subTab === "ledger"
              ? "text-white border-b-2 border-indigo-500"
              : "text-gray-500 hover:text-gray-300"
          }`}
        >
          Privacy Ledger
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {subTab === "monitor" && <PrivacyMonitor />}
        {subTab === "ledger" && <PrivacyLedger pipelineResult={pipelineResult} />}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// MODELS TAB
// ══════════════════════════════════════════════════════════════

function ModelsTab() {
  const [subTab, setSubTab] = useState<"runtime" | "manager">("runtime");

  return (
    <div className="flex flex-col h-full">
      <div className="flex border-b border-white/[0.06]">
        <button
          onClick={() => setSubTab("runtime")}
          className={`flex-1 py-2 text-[10px] font-medium transition-colors ${
            subTab === "runtime"
              ? "text-white border-b-2 border-indigo-500"
              : "text-gray-500 hover:text-gray-300"
          }`}
        >
          Runtime
        </button>
        <button
          onClick={() => setSubTab("manager")}
          className={`flex-1 py-2 text-[10px] font-medium transition-colors ${
            subTab === "manager"
              ? "text-white border-b-2 border-indigo-500"
              : "text-gray-500 hover:text-gray-300"
          }`}
        >
          Model Manager
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {subTab === "runtime" && <RuntimePanel />}
        {subTab === "manager" && <ModelManagerUI />}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS OVERLAY
// ══════════════════════════════════════════════════════════════

function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-[#12121a] border border-white/[0.08] rounded-2xl p-5 max-w-xs w-full mx-4 shadow-2xl">
        <h3 className="text-[13px] font-semibold text-white mb-3">
          Keyboard Shortcuts
        </h3>
        <div className="space-y-2">
          {Object.entries(SHORTCUTS).map(([key, desc]) => (
            <div key={key} className="flex items-center justify-between">
              <span className="text-[11px] text-gray-400">{desc}</span>
              <kbd className="text-[9px] bg-white/[0.05] border border-white/[0.08] rounded px-1.5 py-0.5 text-gray-300 font-mono">
                {key}
              </kbd>
            </div>
          ))}
        </div>
        <button
          onClick={onClose}
          className="mt-4 w-full text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
        >
          Close (Esc)
        </button>
      </div>
    </div>
  );
}
