import type { PipelineProgress } from "../../core/pipeline/full-pipeline";

interface Props {
  progress: PipelineProgress;
}

const PHASE_LABELS: Record<string, string> = {
  capture: "Capturing page DOM",
  vision_perception: "Florence-2 visual perception",
  detect_pii: "Scanning PII & Checksums",
  redact: "Injecting blackout CSS",
  verify_redaction: "Verifying OCR zero-leak",
  init_server: "Selecting model planner",
  sanitize: "Sanitizing context graph",
  extract: "Extracting structured data",
  get_plan: "Generating action plan",
  execute: "Executing step actions",
  show_status: "Synthesizing report",
};

export function PipelineProgressPanel({ progress }: Props) {
  const { steps, elapsedMs } = progress;
  const done = steps.filter((s) => s.status === "complete").length;
  const total = Math.max(steps.length, 1);

  return (
    <div className="hallmark-card p-3.5 space-y-3 font-sans border-sky-500/20 bg-[#0e111a]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-mono text-[11px]">
          <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse-dot" />
          <span className="font-semibold text-sky-400 uppercase tracking-wider">Perception Pipeline Active</span>
        </div>
        <span className="text-[10px] text-gray-400 font-mono">
          {(elapsedMs / 1000).toFixed(1)}s
        </span>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-[#181b28] rounded h-1 overflow-hidden border border-[#25293c]">
        <div
          className="bg-sky-400 h-full transition-all duration-300"
          style={{ width: `${(done / total) * 100}%` }}
        />
      </div>

      {/* Phase list */}
      <div className="space-y-1.5 font-mono text-[11px]">
        {steps.map((step, i) => (
          <div key={`${step.name}-${i}`} className="flex items-center justify-between py-0.5 border-b border-[#181a26] last:border-0">
            <div className="flex items-center gap-2 min-w-0">
              {step.status === "complete" && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
              )}
              {step.status === "running" && (
                <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-ping shrink-0" />
              )}
              {step.status === "error" && (
                <span className="w-1.5 h-1.5 rounded-full bg-rose-400 shrink-0" />
              )}
              {step.status === "pending" && (
                <span className="w-1.5 h-1.5 rounded-full bg-gray-600 shrink-0" />
              )}

              <span
                className={`truncate ${
                  step.status === "running"
                    ? "text-sky-300 font-medium"
                    : step.status === "error"
                      ? "text-rose-300"
                      : step.status === "complete"
                        ? "text-gray-300"
                        : "text-gray-500"
                }`}
              >
                {PHASE_LABELS[step.name] ?? step.name}
              </span>
            </div>

            {step.details && (
              <span className="text-[10px] text-gray-500 truncate max-w-[120px] text-right font-light ml-2">
                {step.details}
              </span>
            )}
            {step.status === "complete" && step.latencyMs > 0 && !step.details && (
              <span className="text-[10px] text-gray-500 font-mono ml-auto shrink-0">
                {step.latencyMs.toFixed(0)}ms
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
