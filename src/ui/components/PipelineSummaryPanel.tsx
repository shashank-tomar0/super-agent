import type { PipelineResult } from "../../core/pipeline/full-pipeline";

interface Props {
  result: PipelineResult;
}

const STEP_LABELS: Record<string, string> = {
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

export function PipelineSummaryPanel({ result }: Props) {
  const { success, steps, piiDetection, redactionSummary, planResult, privacyProof, latency, error } = result;

  return (
    <div className="hallmark-card p-3.5 space-y-3 font-sans border-2 border-[var(--color-ink)] bg-[var(--color-paper)]">
      {/* Header Banner */}
      <div className="flex items-center justify-between font-mono-press">
        <div className="flex items-center gap-2">
          <span
            className={`w-2.5 h-2.5 rounded-full ${
              success ? "bg-[var(--color-teal)]" : "bg-[var(--color-accent)]"
            }`}
          />
          <span
            className={`text-xs font-bold uppercase tracking-wider ${
              success ? "text-[var(--color-teal)]" : "text-[var(--color-accent)]"
            }`}
          >
            {success ? "Pipeline Executed" : "Pipeline Error"}
          </span>
        </div>
        <span className="text-[10px] text-[var(--color-ink-mute)] font-mono-press">
          {latency?.total ? `${(latency.total / 1000).toFixed(2)}s` : `${(result.totalLatencyMs / 1000).toFixed(2)}s`}
        </span>
      </div>

      {error && (
        <p className="text-xs text-[var(--color-accent)] bg-[#faebe8] border border-[var(--color-accent)] p-2 font-mono-press">
          {error}
        </p>
      )}

      {/* Quick Metrics Grid */}
      <div className="grid grid-cols-3 gap-2 font-mono-press text-[10px]">
        <div className="bg-[var(--color-paper-2)] p-2 border border-[var(--color-ink)]">
          <span className="text-[var(--color-ink-mute)] uppercase tracking-widest block text-[9px]">PII Regions</span>
          <span className="text-[var(--color-ink)] font-bold text-xs">{piiDetection?.summary?.totalRegions ?? 0} Detected</span>
        </div>
        <div className="bg-[var(--color-paper-2)] p-2 border border-[var(--color-ink)]">
          <span className="text-[var(--color-ink-mute)] uppercase tracking-widest block text-[9px]">Redaction</span>
          <span className="text-[var(--color-teal)] font-bold text-xs">{redactionSummary?.redacted ?? 0} Shielded</span>
        </div>
        <div className="bg-[var(--color-paper-2)] p-2 border border-[var(--color-ink)]">
          <span className="text-[var(--color-ink-mute)] uppercase tracking-widest block text-[9px]">Egress</span>
          <span className="text-[var(--color-teal)] font-bold text-xs">
            {privacyProof?.zeroOutboundPII ? "0 KB Egress" : "Warning"}
          </span>
        </div>
      </div>

      {/* Plan Provider */}
      {planResult && planResult.provider !== "none" && (
        <div className="flex items-center justify-between text-[10px] font-mono-press uppercase text-[var(--color-ink)] bg-[var(--color-paper-2)] px-2.5 py-1.5 border border-[var(--color-ink)]">
          <span>AI Planner: <strong className="text-[var(--color-accent)]">{planResult.provider}</strong></span>
          <span>{planResult.steps?.length ?? 0} Action Steps</span>
        </div>
      )}

      {/* Executed Step Trace List */}
      {steps && steps.length > 0 && (
        <div className="space-y-1.5 pt-1">
          <span className="text-[9px] uppercase tracking-widest text-[var(--color-ink-mute)] font-mono-press font-semibold block">
            Execution Step Breakdown ({steps.length})
          </span>
          <div className="space-y-1 font-mono-press text-[11px]">
            {steps.map((step, i) => (
              <div
                key={`${step.name}-${i}`}
                className="flex items-center justify-between py-1 px-2 bg-[var(--color-paper-2)] border border-[var(--color-hairline)]"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      step.status === "complete"
                        ? "bg-[var(--color-teal)]"
                        : step.status === "error"
                          ? "bg-[var(--color-accent)]"
                          : "bg-[var(--color-ink-mute)]"
                    }`}
                  />
                  <span className="text-[var(--color-ink)] truncate font-medium">
                    {STEP_LABELS[step.name] ?? step.name}
                  </span>
                </div>
                {step.latencyMs > 0 && (
                  <span className="text-[10px] text-[var(--color-ink-mute)] shrink-0 ml-2">
                    {step.latencyMs.toFixed(0)}ms
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
