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
  observe: { color: "text-sky-400 border-sky-400/30", label: "OBSERVE" },
  think: { color: "text-purple-400 border-purple-400/30", label: "THINK" },
  act: { color: "text-amber-400 border-amber-400/30", label: "ACT" },
  verify: { color: "text-emerald-400 border-emerald-400/30", label: "VERIFY" },
  reflect: { color: "text-orange-400 border-orange-400/30", label: "REFLECT" },
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
      <div className="flex flex-col items-center justify-center h-full text-center px-6 space-y-3 font-sans">
        <div className="w-10 h-10 rounded-full hallmark-card flex items-center justify-center text-white/60 mb-1 border border-white/10">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
        </div>
        <h3 className="text-xs font-medium uppercase tracking-wider text-white/80">
          Agent Reasoning Trace
        </h3>
        <p className="text-[11px] text-white/40 font-light leading-relaxed max-w-xs">
          Start a task to see real-time reasoning steps, confidence scores, and action tree outputs.
        </p>
      </div>
    );
  }

  const avgConfidence = Math.round(
    steps.reduce((sum, s) => sum + s.confidence, 0) / steps.length * 100
  );
  const totalDuration = (steps.reduce((sum, s) => sum + s.duration, 0) / 1000).toFixed(1);

  return (
    <div className="flex flex-col h-full font-sans text-gray-100">
      {/* Header Bar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10 hallmark-card font-mono text-[10px] uppercase">
        <span className="text-gray-400">Steps: <strong className="text-white">{steps.length}</strong></span>
        <span className="text-gray-400">Confidence: <strong className="text-emerald-400">{avgConfidence}%</strong></span>
        <span className="text-gray-400">Latency: <strong className="text-white">{totalDuration}s</strong></span>
      </div>

      {/* Trace Timeline */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar font-mono text-xs">
        {steps.map((step, i) => {
          const config = PHASE_CONFIG[step.phase];
          const time = new Date(step.timestamp).toLocaleTimeString([], { hour12: false, minute: "2-digit", second: "2-digit" });

          return (
            <div key={i} className="hallmark-card p-3 space-y-1.5 border-[#1b1e2a]">
              <div className="flex items-center justify-between">
                <span className={`text-[9px] font-mono px-2 py-0.5 rounded border uppercase ${config.color}`}>
                  {config.label}
                </span>
                <div className="flex items-center gap-2 text-[10px]">
                  <span className="text-gray-500">{time}</span>
                  <ConfidenceBadge confidence={step.confidence} />
                </div>
              </div>

              <p className="text-xs text-gray-200 font-sans font-light leading-relaxed">
                {step.reasoning}
              </p>

              {step.output && (
                <div className="bg-[#090a0f] p-2 rounded text-[10px] text-gray-400 font-mono border border-gray-800 break-all">
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
      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
      : confidence > 0.7
        ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
        : "bg-rose-500/10 text-rose-400 border-rose-500/20";

  return (
    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border uppercase ${color}`}>
      {Math.round(confidence * 100)}%
    </span>
  );
}
