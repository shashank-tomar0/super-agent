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
    <div className="hallmark-card p-3.5 space-y-3 font-sans border-white/10 bg-[#0e111a] animate-fade-in">
      {/* Overall Header Banner */}
      <div className="flex items-center justify-between font-mono">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${
              success ? "bg-emerald-400" : "bg-rose-400"
            }`}
          />
          <span
            className={`text-xs font-semibold uppercase tracking-wider ${
              success ? "text-emerald-300" : "text-rose-300"
            }`}
          >
            {success ? "Pipeline Executed" : "Pipeline Error"}
          </span>
        </div>
        <span className="text-[10px] text-gray-400 font-mono">
          {latency?.total ? `${(latency.total / 1000).toFixed(2)}s` : `${(result.totalLatencyMs / 1000).toFixed(2)}s`}
        </span>
      </div>

      {error && (
        <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/20 p-2 rounded font-mono">
          {error}
        </p>
      )}

      {/* Quick Metrics Bar */}
      <div className="grid grid-cols-3 gap-2 font-mono text-[10px]">
        <div className="bg-[#141722] p-2 rounded border border-[#1e2233]">
          <span className="text-gray-500 uppercase tracking-widest block text-[9px]">PII Regions</span>
          <span className="text-white font-semibold text-xs">{piiDetection?.summary?.totalRegions ?? 0} Detected</span>
        </div>
        <div className="bg-[#141722] p-2 rounded border border-[#1e2233]">
          <span className="text-gray-500 uppercase tracking-widest block text-[9px]">Redaction</span>
          <span className="text-emerald-400 font-semibold text-xs">{redactionSummary?.redacted ?? 0} Shielded</span>
        </div>
        <div className="bg-[#141722] p-2 rounded border border-[#1e2233]">
          <span className="text-gray-500 uppercase tracking-widest block text-[9px]">Egress</span>
          <span className="text-emerald-400 font-semibold text-xs">
            {privacyProof?.zeroOutboundPII ? "0 KB Egress" : "Warning"}
          </span>
        </div>
      </div>

      {/* Plan Provider */}
      {planResult && planResult.provider !== "none" && (
        <div className="flex items-center justify-between text-[10px] font-mono text-gray-400 bg-[#121520] px-2.5 py-1.5 rounded border border-[#1c2030]">
          <span>AI Planner: <strong className="text-white uppercase">{planResult.provider}</strong></span>
          <span>{planResult.steps?.length ?? 0} Action Steps</span>
        </div>
      )}

      {/* Executed Step Trace List */}
      {steps && steps.length > 0 && (
        <div className="space-y-1.5 pt-1">
          <span className="text-[9px] uppercase tracking-widest text-gray-500 font-mono font-medium block">
            Execution Step Breakdown ({steps.length})
          </span>
          <div className="space-y-1 font-mono text-[11px]">
            {steps.map((step, i) => (
              <div
                key={`${step.name}-${i}`}
                className="flex items-center justify-between py-1 px-2 rounded bg-[#12141d] border border-[#191c28]"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      step.status === "complete"
                        ? "bg-emerald-400"
                        : step.status === "error"
                          ? "bg-rose-400"
                          : "bg-gray-500"
                    }`}
                  />
                  <span className="text-gray-300 truncate">
                    {STEP_LABELS[step.name] ?? step.name}
                  </span>
                </div>
                {step.latencyMs > 0 && (
                  <span className="text-[10px] text-gray-500 shrink-0 ml-2">
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
