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
    <div className="hallmark-card p-3.5 space-y-3 font-sans border-2 border-[var(--color-ink)] bg-[var(--color-paper-2)]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-mono-press text-[11px]">
          <span className="w-2.5 h-2.5 rounded-full bg-[var(--color-accent)] animate-ping" />
          <span className="font-bold text-[var(--color-accent)] uppercase tracking-wider">Perception Pipeline Active</span>
        </div>
        <span className="text-[10px] text-[var(--color-ink-mute)] font-mono-press font-bold">
          {(elapsedMs / 1000).toFixed(1)}s
        </span>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-[var(--color-paper-3)] h-2 overflow-hidden border border-[var(--color-ink)]">
        <div
          className="bg-[var(--color-accent)] h-full transition-all duration-300"
          style={{ width: `${(done / total) * 100}%` }}
        />
      </div>

      {/* Phase list */}
      <div className="space-y-1.5 font-mono-press text-[11px]">
        {steps.map((step, i) => (
          <div key={`${step.name}-${i}`} className="flex items-center justify-between py-1 border-b border-[var(--color-hairline)] last:border-0">
            <div className="flex items-center gap-2 min-w-0">
              {step.status === "complete" && (
                <span className="w-2 h-2 rounded-full bg-[#006669] shrink-0" />
              )}
              {step.status === "running" && (
                <span className="w-2 h-2 rounded-full bg-[var(--color-accent)] animate-ping shrink-0" />
              )}
              {step.status === "error" && (
                <span className="w-2 h-2 rounded-full bg-[var(--color-accent)] shrink-0" />
              )}
              {step.status === "pending" && (
                <span className="w-2 h-2 rounded-full bg-[var(--color-ink-mute)] shrink-0" />
              )}

              <span
                className={`truncate font-bold ${
                  step.status === "running"
                    ? "text-[var(--color-accent)] font-extrabold"
                    : step.status === "error"
                      ? "text-[var(--color-accent)]"
                      : step.status === "complete"
                        ? "text-[var(--color-ink)]"
                        : "text-[var(--color-ink-mute)]"
                }`}
              >
                {PHASE_LABELS[step.name] ?? step.name}
              </span>
            </div>

            {step.details && (
              <span className="text-[10px] text-[var(--color-ink-mute)] truncate max-w-[120px] text-right font-semibold ml-2">
                {step.details}
              </span>
            )}
            {step.status === "complete" && step.latencyMs > 0 && !step.details && (
              <span className="text-[10px] text-[var(--color-ink-mute)] font-mono-press ml-auto shrink-0 font-semibold">
                {step.latencyMs.toFixed(0)}ms
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
