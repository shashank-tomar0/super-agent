import { useState } from "react";
import type React from "react";
import type { AgentTask } from "../../types";

interface TaskInputProps {
  onStartTask: (description: string, data?: Record<string, string>) => void;
  onCancelTask: () => void;
  task: AgentTask | null;
  children?: React.ReactNode;
}

const QUICK_TASKS = [
  {
    label: "Fill Form",
    prompt: "Fill the current form with my saved data",
    iconPath: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z",
  },
  {
    label: "Extract Data",
    prompt: "Extract all visible data from this page into structured format",
    iconPath: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z",
  },
  {
    label: "Scan PII",
    prompt: "Scan page for sensitive PII, Aadhaar, PAN, and faces",
    iconPath: "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z",
  },
  {
    label: "Click Target",
    prompt: "Find and click the login or submit button",
    iconPath: "M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122",
  },
];

const SYNTHETIC_PRESETS: Record<string, Record<string, string>> = {
  Aadhaar: {
    fullName: "Rohan Sharma",
    aadhaarNumber: "100000000004",
    dob: "1994-08-15",
    gender: "Male",
  },
  PAN: {
    fullName: "Priya Patel",
    panNumber: "ABCPD1234F",
    income: "750000",
  },
  Contact: {
    email: "rohan.sharma@example.com",
    phone: "9876543210",
    city: "New Delhi",
    pincode: "110001",
  },
};

export function TaskInput({ onStartTask, onCancelTask, task, children }: TaskInputProps) {
  const [input, setInput] = useState("");
  const [dataFields, setDataFields] = useState<Record<string, string>>({});
  const [activePreset, setActivePreset] = useState<string | null>(null);

  const handleSubmit = () => {
    if (!input.trim()) return;
    onStartTask(input, Object.keys(dataFields).length > 0 ? dataFields : undefined);
    setInput("");
  };

  const handleQuickTask = (prompt: string) => {
    setInput("");
    onStartTask(prompt, Object.keys(dataFields).length > 0 ? dataFields : undefined);
  };

  const applyPreset = (name: string) => {
    if (activePreset === name) {
      setActivePreset(null);
      setDataFields({});
    } else {
      setActivePreset(name);
      setDataFields(SYNTHETIC_PRESETS[name] || {});
    }
  };

  const isRunning =
    task?.status === "executing" ||
    task?.status === "analyzing" ||
    task?.status === "planning" ||
    task?.status === "verifying";

  return (
    <div className="flex flex-col h-full overflow-y-auto custom-scrollbar px-4 py-4 space-y-5">
      {/* ── Hallmark Hero Header ────────────────────────────────── */}
      <div className="text-center pt-2 pb-1 space-y-1.5 animate-fade-in">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full hallmark-card text-[10px] tracking-wider uppercase text-white/70 font-medium mb-1">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse-dot" />
          On-Device Visual Perception
        </div>
        <h1 className="text-4xl md:text-5xl text-white font-serif-title tracking-tight leading-none">
          Built for the curious
        </h1>
        <p className="text-xs text-white/50 max-w-xs mx-auto font-light leading-relaxed">
          Zero screenshot leaks. Local ViT & OCR run entirely inside your browser.
        </p>
      </div>

      {/* ── Active Task Status Card ──────────────────────────────── */}
      {task && isRunning && (
        <div className="hallmark-card rounded-2xl p-4 animate-slide-up border border-white/10">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-white/90 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
              {task.status === "analyzing" && "Scanning screen & DOM..."}
              {task.status === "planning" && "Generating local plan..."}
              {task.status === "executing" && `Step ${task.currentStep + 1} of ${task.totalSteps}`}
              {task.status === "verifying" && "Verifying action result..."}
            </span>
            <button
              onClick={onCancelTask}
              className="text-[10px] text-red-400 hover:text-red-300 px-2.5 py-1 rounded-full hallmark-card hover:bg-red-500/10 transition-colors"
            >
              Cancel
            </button>
          </div>
          <p className="text-xs text-white/70 mb-3 font-light leading-snug">{task.description}</p>

          {/* Progress bar */}
          <div className="w-full bg-white/5 rounded-full h-1.5 overflow-hidden p-0.5 border border-white/10">
            <div
              className="bg-gradient-to-r from-emerald-400 via-teal-300 to-cyan-400 h-full rounded-full transition-all duration-500"
              style={{
                width: `${task.totalSteps > 0 ? Math.max(5, (task.currentStep / task.totalSteps) * 100) : 10}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* ── Completed Task Card ──────────────────────────────────── */}
      {task?.status === "completed" && (
        <div className="hallmark-card rounded-2xl p-4 animate-slide-up bg-emerald-500/5 border border-emerald-500/20">
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="text-xs font-semibold text-emerald-300">Task Complete</span>
          </div>
          <p className="text-xs text-white/80 font-light">{task.result}</p>
        </div>
      )}

      {/* ── Failed Task Card ─────────────────────────────────────── */}
      {task?.status === "failed" && (
        <div className="hallmark-card rounded-2xl p-4 animate-slide-up bg-rose-500/5 border border-rose-500/20">
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2 h-2 rounded-full bg-rose-400" />
            <span className="text-xs font-semibold text-rose-300">Execution Error</span>
          </div>
          <p className="text-xs text-white/80 font-light">{task.error || "Action could not be verified"}</p>
        </div>
      )}

      {/* ── Rendered Children Panels (Progress, Extracted Data, PII) ── */}
      {children}

      {/* ── Hallmark Command Bar Input ──────────────────────────── */}
      <div className="space-y-3 pt-2">
        {/* Preset Data Tags */}
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-white/40 uppercase tracking-widest text-[9px] font-medium">Context Data</span>
          <div className="flex items-center gap-1.5">
            {Object.keys(SYNTHETIC_PRESETS).map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => applyPreset(name)}
                className={`text-[10px] px-2.5 py-0.5 rounded-full transition-all ${
                  activePreset === name
                    ? "bg-white text-black font-medium shadow-sm"
                    : "hallmark-card text-white/70 hover:text-white"
                }`}
              >
                + {name}
              </button>
            ))}
          </div>
        </div>

        {/* Input Bar */}
        <div className="hallmark-input rounded-3xl p-2.5 flex items-center gap-3 transition-all focus-within:ring-1 focus-within:ring-white/30">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder="Ask agent to fill form, extract data..."
            rows={1}
            className="flex-1 bg-transparent text-xs text-white placeholder:text-white/35 resize-none focus:outline-none px-2 py-1 font-light leading-relaxed"
          />

          <button
            onClick={handleSubmit}
            disabled={!input.trim() || isRunning}
            className={`w-9 h-9 rounded-full flex items-center justify-center transition-all ${
              input.trim() && !isRunning
                ? "bg-white text-black hover:scale-105 active:scale-95 shadow-lg"
                : "bg-white/10 text-white/30 cursor-not-allowed"
            }`}
            title="Execute Agent Task"
          >
            {isRunning ? (
              <span className="w-3.5 h-3.5 border-2 border-black/30 border-t-black rounded-full animate-spin" />
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* ── Quick Action Chips ───────────────────────────────────── */}
      <div className="space-y-2 pt-1">
        <div className="flex items-center justify-between text-[10px] text-white/40 uppercase tracking-widest font-medium">
          <span>Quick Commands</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {QUICK_TASKS.map((qt) => (
            <button
              key={qt.label}
              onClick={() => handleQuickTask(qt.prompt)}
              className="hallmark-button rounded-2xl p-3 flex items-center gap-2.5 text-left group"
            >
              <svg className="w-4 h-4 text-white/70 group-hover:text-white transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d={qt.iconPath} />
              </svg>
              <span className="text-xs text-white/80 font-light group-hover:text-white transition-colors">
                {qt.label}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Bottom Footer Note */}
      <div className="text-center pt-2 pb-1">
        <p className="text-[10px] text-white/30 font-light">
          Encrypted on-device memory • DevTools verifiable
        </p>
      </div>
    </div>
  );
}
