import { useState } from "react";
import type { ExtractedData } from "../../core/extraction/page-extractor";
import { extractedDataToJSON } from "../../core/extraction/page-extractor";

interface Props {
  data: ExtractedData;
}

export function ExtractedDataPanel({ data }: Props) {
  const [revealed, setRevealed] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);

  const copyJSON = async (includeRawValues: boolean) => {
    try {
      await navigator.clipboard.writeText(extractedDataToJSON(data, { includeRawValues }));
      setCopied(includeRawValues ? "raw" : "masked");
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied("error");
      setTimeout(() => setCopied(null), 2000);
    }
  };

  const { summary } = data;

  return (
    <div className="space-y-3 font-sans text-[var(--color-ink)]">
      {/* Header */}
      <div className="hallmark-card p-3.5 space-y-1 bg-[var(--color-paper-2)] border-2 border-[var(--color-ink)]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-[#006669]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            <span className="text-xs font-bold text-[var(--color-ink)] font-mono-press uppercase tracking-wider">Extracted Data</span>
          </div>
          <span className="text-[9px] font-mono-press uppercase px-2 py-0.5 bg-[#006669] text-[var(--color-paper)] font-bold border border-[var(--color-ink)]">
            On-Device Read
          </span>
        </div>
        <p className="text-[11px] text-[var(--color-ink-2)] truncate font-mono-press font-semibold" title={data.title}>
          {data.title || data.url}
        </p>
        <div className="flex items-center gap-3 text-[10px] text-[var(--color-ink-mute)] font-mono-press font-bold pt-1">
          <span>{summary.fieldCount} fields</span>
          <span>•</span>
          <span>{summary.filledFieldCount} filled</span>
          <span>•</span>
          <span>{summary.maskedFieldCount} sensitive</span>
        </div>
      </div>

      {/* Control Strip */}
      <div className="flex flex-wrap gap-2">
        {summary.maskedFieldCount > 0 && (
          <button
            onClick={() => setRevealed((r) => !r)}
            className="hallmark-button text-[10px] px-2.5 py-1 font-mono-press uppercase"
          >
            {revealed ? "Mask Sensitivity" : "Show Raw Values"}
          </button>
        )}
        <button
          onClick={() => copyJSON(revealed)}
          className="hallmark-button text-[10px] px-2.5 py-1 font-mono-press uppercase flex items-center gap-1.5"
        >
          <svg className="w-3 h-3 text-[var(--color-ink)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          {copied ? "Copied to Clipboard" : revealed ? "Copy JSON" : "Copy JSON (Masked)"}
        </button>
      </div>

      {/* Structured Sections Table */}
      {data.sections.map((section, si) => (
        <div key={`${section.title}-${si}`} className="hallmark-card border-2 border-[var(--color-ink)] bg-[var(--color-paper-2)] overflow-hidden">
          <div className="px-3 py-2 bg-[var(--color-paper-3)] border-b-2 border-[var(--color-ink)] flex items-center justify-between font-mono-press">
            <span className="text-[11px] font-bold text-[var(--color-ink)] uppercase tracking-wider">{section.title}</span>
            <span className="text-[9px] text-[var(--color-ink-mute)] font-bold">{section.fields.length} FIELDS</span>
          </div>
          <div className="divide-y-2 divide-[var(--color-hairline)] font-mono-press">
            {section.fields.map((field, fi) => (
              <div key={`${field.label}-${fi}`} className="px-3 py-2 flex items-start justify-between gap-3 text-xs">
                <span className="text-[11px] text-[var(--color-ink-2)] w-1/3 shrink-0 font-medium truncate">
                  {field.label}
                </span>
                <span className="text-[11px] text-[var(--color-ink)] flex-1 font-bold break-all text-right font-mono-press">
                  {field.value === "" ? (
                    <span className="text-[var(--color-ink-mute)] italic font-normal">empty</span>
                  ) : revealed && field.rawValue !== undefined ? (
                    field.rawValue
                  ) : (
                    field.value
                  )}
                </span>
                {field.piiCategory && (
                  <span className="text-[9px] font-mono-press font-bold px-1.5 py-0.5 bg-[var(--color-accent)] text-[var(--color-paper)] uppercase shrink-0 border border-[var(--color-ink)]">
                    {field.piiCategory}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
