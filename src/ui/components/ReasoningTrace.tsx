import { useRef, useEffect } from "react";
import type { AgentTask, ReasoningStep } from "../../types";

interface ReasoningTraceProps {
  steps: ReasoningStep[];
  task: AgentTask | null;
}

const PHASE_CONFIG: Record<
  ReasoningStep["phase"],
  { color: string; label: string }
> = {
  observe: { color: "text-[#006669] border-[#006669]", label: "OBSERVE" },
  think: { color: "text-[var(--color-ink)] border-[var(--color-ink)]", label: "THINK" },
  act: { color: "text-[var(--color-accent)] border-[var(--color-accent)]", label: "ACT" },
  verify: { color: "text-[#006669] border-[#006669]", label: "VERIFY" },
  reflect: { color: "text-[var(--color-ink-mute)] border-[var(--color-ink-mute)]", label: "REFLECT" },
};

export function ReasoningTrace({ steps, task: _task }: ReasoningTraceProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [steps.length]);

  if (steps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6 space-y-3 font-sans text-[var(--color-ink)]">
        <div className="w-10 h-10 hallmark-card flex items-center justify-center text-[var(--color-ink)] mb-1 border-2 border-[var(--color-ink)] bg-[var(--color-paper-2)]">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
        </div>
        <h3 className="text-xs font-mono-press font-bold uppercase tracking-wider text-[var(--color-ink)]">
          Agent Reasoning Trace
        </h3>
        <p className="text-xs font-body-editorial text-[var(--color-ink-2)] leading-relaxed max-w-xs font-medium">
          Start a task to see real-time reasoning steps, confidence scores, and action tree outputs.
        </p>
      </div>
    );
  }

  const avgConfidence = Math.round(
    (steps.reduce((sum, s) => sum + s.confidence, 0) / steps.length) * 100
  );
  const totalDuration = (steps.reduce((sum, s) => sum + s.duration, 0) / 1000).toFixed(1);

  return (
    <div className="flex flex-col h-full font-sans text-[var(--color-ink)]">
      {/* Header Bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b-2 border-[var(--color-ink)] hallmark-card font-mono-press text-[10px] uppercase bg-[var(--color-paper-2)]">
        <span className="text-[var(--color-ink-mute)] font-bold">Steps: <strong className="text-[var(--color-ink)]">{steps.length}</strong></span>
        <span className="text-[var(--color-ink-mute)] font-bold">Confidence: <strong className="text-[#006669]">{avgConfidence}%</strong></span>
        <span className="text-[var(--color-ink-mute)] font-bold">Latency: <strong className="text-[var(--color-ink)]">{totalDuration}s</strong></span>
      </div>

      {/* Trace Timeline */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2.5 custom-scrollbar font-mono-press text-xs">
        {steps.map((step, i) => {
          const config = PHASE_CONFIG[step.phase];
          const time = new Date(step.timestamp).toLocaleTimeString([], { hour12: false, minute: "2-digit", second: "2-digit" });

          return (
            <div key={i} className="hallmark-card p-3 space-y-1.5 border-2 border-[var(--color-ink)] bg-[var(--color-paper-2)]">
              <div className="flex items-center justify-between">
                <span className={`text-[9px] font-mono-press font-bold px-2 py-0.5 border uppercase ${config.color}`}>
                  {config.label}
                </span>
                <div className="flex items-center gap-2 text-[10px] font-mono-press font-semibold">
                  <span className="text-[var(--color-ink-mute)]">{time}</span>
                  <ConfidenceBadge confidence={step.confidence} />
                </div>
              </div>

              <p className="text-xs text-[var(--color-ink)] font-body-editorial font-medium leading-relaxed">
                {step.reasoning}
              </p>

              {step.output && (
                <div className="bg-[var(--color-paper-3)] p-2 text-[10px] text-[var(--color-ink)] font-mono-press border border-[var(--color-ink)] break-all font-semibold">
                  → {step.output}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const color =
    confidence > 0.9
      ? "bg-[#006669] text-[var(--color-paper)]"
      : confidence > 0.7
        ? "bg-[var(--color-ink)] text-[var(--color-paper)]"
        : "bg-[var(--color-accent)] text-[var(--color-paper)]";

  return (
    <span className={`text-[9px] font-mono-press font-bold px-1.5 py-0.5 uppercase border border-[var(--color-ink)] ${color}`}>
      {Math.round(confidence * 100)}%
    </span>
  );
}
