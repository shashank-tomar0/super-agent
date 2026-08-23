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
    <div className="flex flex-col h-full overflow-y-auto custom-scrollbar px-4 py-4 space-y-4 font-sans bg-[var(--color-paper)] relative z-10 text-[var(--color-ink)]">
      {/* ── Broadsheet Masthead Slogan ───────────────────────────── */}
      <div className="pt-2 pb-3 space-y-1.5 border-b-2 border-[var(--color-ink)]">
        <div className="flex items-center justify-between text-[10px] font-mono-press uppercase tracking-widest text-[var(--color-ink-mute)]">
          <span>FREE BROADSHEET • EDITION 04</span>
          <span>PERCEPTION Nº 01</span>
        </div>
        <h1 className="text-4xl font-display-poster text-[var(--color-ink)] tracking-tight uppercase leading-none">
          <span className="text-[var(--color-accent)]">Private</span> Visual Agent
        </h1>
        <p className="text-xs font-body-editorial italic text-[var(--color-ink-2)] leading-relaxed">
          Zero data egress. ViT perception & PII detection run 100% inside your browser.
        </p>
      </div>

      {/* ── Active Task Status Card ──────────────────────────────── */}
      {task && isRunning && (
        <div className="hallmark-card p-3 space-y-2 border-l-4 border-l-[var(--color-accent)]">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono-press uppercase font-semibold text-[var(--color-accent)] flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[var(--color-accent)] animate-ping" />
              {task.status === "analyzing" && "PERCEIVING PAGE DOM & VISION"}
              {task.status === "planning" && "GENERATING ACTION PLAN"}
              {task.status === "executing" && `EXECUTING STEP ${task.currentStep + 1}/${task.totalSteps}`}
              {task.status === "verifying" && "VERIFYING REDACTION & OUTPUT"}
            </span>
            <button
              onClick={onCancelTask}
              className="text-[10px] font-mono-press uppercase text-[var(--color-paper)] bg-[var(--color-ink)] hover:bg-[var(--color-accent)] px-2 py-0.5"
            >
              Cancel
            </button>
          </div>
          <p className="text-xs font-body-editorial font-medium">{task.description}</p>
          <div className="w-full bg-[var(--color-paper-3)] h-1.5 border border-[var(--color-ink)]">
            <div
              className="bg-[var(--color-accent)] h-full transition-all duration-300"
              style={{
                width: `${task.totalSteps > 0 ? Math.max(5, (task.currentStep / task.totalSteps) * 100) : 20}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* ── Completed Task Card ──────────────────────────────────── */}
      {task?.status === "completed" && (
        <div className="hallmark-card p-3 border-l-4 border-l-[var(--color-teal)] space-y-1">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[var(--color-teal)]" />
            <span className="text-xs font-mono-press font-semibold uppercase text-[var(--color-teal)]">Task Completed</span>
          </div>
          <p className="text-xs font-body-editorial text-[var(--color-ink)]">{task.result}</p>
        </div>
      )}

      {/* ── Failed Task Card ─────────────────────────────────────── */}
      {task?.status === "failed" && (
        <div className="hallmark-card p-3 border-l-4 border-l-[var(--color-accent)] bg-[#faebe8] space-y-1">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[var(--color-accent)]" />
            <span className="text-xs font-mono-press font-semibold uppercase text-[var(--color-accent)]">Execution Error</span>
          </div>
          <p className="text-xs font-body-editorial text-[var(--color-ink)]">{task.error || "Action could not be completed"}</p>
        </div>
      )}

      {/* ── Rendered Children Panels ────────────────────────────── */}
      {children}

      {/* ── Command Input ────────────────────────────────────────── */}
      <div className="space-y-2 pt-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono-press uppercase tracking-widest font-semibold text-[var(--color-ink-mute)]">
            Context Presets
          </span>
          <div className="flex items-center gap-1.5">
            {Object.keys(SYNTHETIC_PRESETS).map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => applyPreset(name)}
                className={`text-[10px] px-2 py-0.5 font-mono-press transition-all ${
                  activePreset === name
                    ? "bg-[var(--color-accent)] text-[var(--color-paper)] font-bold border-2 border-[var(--color-ink)]"
                    : "hallmark-button"
                }`}
              >
                + {name}
              </button>
            ))}
          </div>
        </div>

        {/* Input Box */}
        <div className="hallmark-input p-2 flex items-center gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder="Instruct agent (e.g. fill form, scan PII)..."
            rows={2}
            className="flex-1 bg-transparent text-xs text-[var(--color-ink)] placeholder:text-[var(--color-ink-mute)] resize-none focus:outline-none px-1 py-1 font-body-editorial text-sm leading-relaxed"
          />

          <button
            onClick={handleSubmit}
            disabled={!input.trim() || isRunning}
            className={`w-9 h-9 flex items-center justify-center transition-all ${
              input.trim() && !isRunning
                ? "hallmark-button-primary"
                : "bg-[var(--color-paper-3)] border-2 border-[var(--color-ink)] text-[var(--color-ink-mute)] cursor-not-allowed"
            }`}
            title="Run Command"
          >
            {isRunning ? (
              <span className="w-3 h-3 border-2 border-[var(--color-paper)] border-t-[var(--color-ink)] rounded-full animate-spin" />
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* ── Quick Action Cards ───────────────────────────────────── */}
      <div className="space-y-2 pt-2">
        <span className="text-[10px] font-mono-press uppercase tracking-widest font-semibold text-[var(--color-ink-mute)] block">
          Quick Actions
        </span>
        <div className="grid grid-cols-2 gap-2">
          {QUICK_TASKS.map((qt) => (
            <button
              key={qt.label}
              onClick={() => handleQuickTask(qt.prompt)}
              className="hallmark-button p-2.5 flex items-center gap-2 text-left group"
            >
              <svg className="w-4 h-4 text-[var(--color-ink)] group-hover:text-[var(--color-paper)] transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d={qt.iconPath} />
              </svg>
              <span className="text-xs font-mono-press uppercase">
                {qt.label}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
