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
    <div className="space-y-3 font-sans">
      {/* Header */}
      <div className="hallmark-card p-3.5 space-y-1">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="w-3.5 h-3.5 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            <span className="text-xs font-semibold text-white font-mono uppercase tracking-wider">Extracted Data</span>
          </div>
          <span className="text-[9px] font-mono uppercase px-2 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">
            On-Device Read
          </span>
        </div>
        <p className="text-[11px] text-gray-400 truncate" title={data.title}>
          {data.title || data.url}
        </p>
        <div className="flex items-center gap-3 text-[10px] text-gray-500 font-mono pt-1">
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
            className="hallmark-button text-[10px] px-2.5 py-1 font-mono uppercase text-gray-300"
          >
            {revealed ? "Mask Sensitivity" : "Show Raw Values"}
          </button>
        )}
        <button
          onClick={() => copyJSON(revealed)}
          className="hallmark-button text-[10px] px-2.5 py-1 font-mono uppercase text-gray-300 flex items-center gap-1.5"
        >
          <svg className="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          {copied ? "Copied to Clipboard" : revealed ? "Copy JSON" : "Copy JSON (Masked)"}
        </button>
      </div>

      {/* Structured Sections Table */}
      {data.sections.map((section, si) => (
        <div key={`${section.title}-${si}`} className="hallmark-card overflow-hidden">
          <div className="px-3 py-2 bg-[#141722] border-b border-[#1e2233] flex items-center justify-between font-mono">
            <span className="text-[11px] font-semibold text-gray-200 uppercase tracking-wider">{section.title}</span>
            <span className="text-[9px] text-gray-500">{section.fields.length} FIELDS</span>
          </div>
          <div className="divide-y divide-[#181b28]">
            {section.fields.map((field, fi) => (
              <div key={`${field.label}-${fi}`} className="px-3 py-2 flex items-start justify-between gap-3 text-xs">
                <span className="text-[11px] text-gray-400 w-1/3 shrink-0 font-light truncate">
                  {field.label}
                </span>
                <span className="text-[11px] text-gray-200 flex-1 font-mono break-all text-right">
                  {field.value === "" ? (
                    <span className="text-gray-600 italic">empty</span>
                  ) : revealed && field.rawValue !== undefined ? (
                    field.rawValue
                  ) : (
                    field.value
                  )}
                </span>
                {field.piiCategory && (
                  <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20 uppercase shrink-0">
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
