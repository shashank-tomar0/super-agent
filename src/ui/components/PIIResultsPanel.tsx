import { useState } from "react";
import type { PIIRegion } from "../../core/privacy/pii-detector";

interface Props {
  regions: PIIRegion[];
}

const SENSITIVITY_STYLE: Record<string, string> = {
  critical: "bg-rose-500/10 text-rose-400 border-rose-500/20",
  high: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  medium: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  low: "bg-gray-500/10 text-gray-400 border-gray-500/20",
};

function maskValue(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "*".repeat(value.length);
  return `${value.slice(0, 2)}${"*".repeat(Math.min(value.length - 4, 12))}${value.slice(-2)}`;
}

export function PIIResultsPanel({ regions }: Props) {
  const [revealed, setRevealed] = useState(true);
  const [expanded, setExpanded] = useState(true);

  const byCategory = new Map<string, PIIRegion[]>();
  for (const region of regions) {
    const list = byCategory.get(region.category) ?? [];
    list.push(region);
    byCategory.set(region.category, list);
  }

  const withValues = regions.filter((r) => r.textValue);
  const criticalCount = regions.filter((r) => r.sensitivity === "critical").length;

  return (
    <div className="space-y-2 font-sans">
      {/* Header Banner */}
      <div className="hallmark-card p-3 border-rose-500/20 bg-rose-500/5">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="w-full flex items-center justify-between font-mono"
        >
          <div className="flex items-center gap-2">
            <svg className="w-3.5 h-3.5 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <span className="text-xs font-semibold text-rose-300 uppercase tracking-wider">
              {regions.length} PII Regions Protected
            </span>
          </div>
          <span className="text-[10px] text-gray-500">{expanded ? "▼" : "▶"}</span>
        </button>
        <p className="text-[10px] text-gray-400 mt-1 font-mono text-left">
          {criticalCount} critical · {byCategory.size} categories · 0 KB outbound egress
        </p>
      </div>

      {expanded && (
        <>
          {withValues.length > 0 && (
            <button
              onClick={() => setRevealed((r) => !r)}
              className="hallmark-button text-[10px] px-2.5 py-1 font-mono uppercase text-gray-300"
            >
              {revealed ? "Mask Values for Sharing" : `Show ${withValues.length} Values`}
            </button>
          )}

          {[...byCategory.entries()].map(([category, items]) => (
            <div key={category} className="hallmark-card overflow-hidden">
              <div className="px-3 py-1.5 bg-[#141722] border-b border-[#1e2233] flex items-center justify-between font-mono">
                <span className="text-[11px] font-semibold text-gray-200 uppercase tracking-wider">{category}</span>
                <span
                  className={`text-[9px] font-mono px-1.5 py-0.5 rounded border uppercase ${
                    SENSITIVITY_STYLE[items[0].sensitivity] ?? SENSITIVITY_STYLE.low
                  }`}
                >
                  {items[0].sensitivity}
                </span>
              </div>
              <div className="divide-y divide-[#181b28]">
                {items.map((region, i) => (
                  <div key={`${region.id}-${i}`} className="px-3 py-2 space-y-0.5">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[11px] text-gray-200 font-mono break-all flex-1">
                        {region.textValue
                          ? revealed
                            ? region.textValue
                            : maskValue(region.textValue)
                          : <span className="text-gray-500 italic">Field flagged (no value)</span>}
                      </span>
                      <span className="text-[9px] text-gray-500 font-mono shrink-0">
                        {Math.round(region.confidence * 100)}%
                      </span>
                    </div>
                    <p className="text-[9px] text-gray-500 font-mono">
                      Method: {region.detectionMethod}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
