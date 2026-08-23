import { useState } from "react";
import type { PIIRegion } from "../../core/privacy/pii-detector";

interface Props {
  regions: PIIRegion[];
}

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
    <div className="space-y-2 font-sans text-[var(--color-ink)]">
      {/* Header Banner */}
      <div className="hallmark-card p-3 border-2 border-[var(--color-accent)] bg-[#faebe8]">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="w-full flex items-center justify-between font-mono-press"
        >
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-[var(--color-accent)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <span className="text-xs font-bold text-[var(--color-accent)] uppercase tracking-wider">
              {regions.length} PII Regions Protected
            </span>
          </div>
          <span className="text-[10px] text-[var(--color-ink-mute)] font-bold">{expanded ? "▼" : "▶"}</span>
        </button>
        <p className="text-[10px] text-[var(--color-ink-2)] mt-1 font-mono-press font-semibold text-left">
          {criticalCount} critical · {byCategory.size} categories · 0 KB outbound egress
        </p>
      </div>

      {expanded && (
        <>
          {withValues.length > 0 && (
            <button
              onClick={() => setRevealed((r) => !r)}
              className="hallmark-button text-[10px] px-2.5 py-1 font-mono-press uppercase"
            >
              {revealed ? "Mask Values for Sharing" : `Show ${withValues.length} Values`}
            </button>
          )}

          {[...byCategory.entries()].map(([category, items]) => (
            <div key={category} className="hallmark-card border-2 border-[var(--color-ink)] bg-[var(--color-paper-2)] overflow-hidden">
              <div className="px-3 py-1.5 bg-[var(--color-paper-3)] border-b-2 border-[var(--color-ink)] flex items-center justify-between font-mono-press">
                <span className="text-[11px] font-bold text-[var(--color-ink)] uppercase tracking-wider">{category}</span>
                <span className="text-[9px] font-mono-press font-bold px-1.5 py-0.5 uppercase bg-[var(--color-accent)] text-[var(--color-paper)] border border-[var(--color-ink)]">
                  {items[0].sensitivity}
                </span>
              </div>
              <div className="divide-y-2 divide-[var(--color-hairline)] font-mono-press">
                {items.map((region, i) => (
                  <div key={`${region.id}-${i}`} className="px-3 py-2 space-y-0.5">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[11px] text-[var(--color-ink)] font-bold font-mono-press break-all flex-1">
                        {region.textValue
                          ? revealed
                            ? region.textValue
                            : maskValue(region.textValue)
                          : <span className="text-[var(--color-ink-mute)] italic font-normal">Field flagged (no value)</span>}
                      </span>
                      <span className="text-[9px] text-[var(--color-ink-mute)] font-mono-press font-semibold shrink-0">
                        {Math.round(region.confidence * 100)}%
                      </span>
                    </div>
                    <p className="text-[9px] text-[var(--color-ink-mute)] font-mono-press font-semibold">
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
