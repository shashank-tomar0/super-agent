import { useState } from "react";
import type { PIIReviewField } from "../../core/pipeline/full-pipeline";

interface Props {
  fields: PIIReviewField[];
}

type SaveState = "idle" | "saving" | "saved" | "error";

export function PIIReviewPanel({ fields }: Props) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [state, setState] = useState<Record<string, SaveState>>({});
  const [revealed, setRevealed] = useState(true);

  const valueOf = (f: PIIReviewField) =>
    edits[f.selector] !== undefined ? edits[f.selector] : f.value;

  const isDirty = (f: PIIReviewField) =>
    edits[f.selector] !== undefined && edits[f.selector] !== f.value;

  const apply = async (f: PIIReviewField) => {
    const value = valueOf(f);
    setState((s) => ({ ...s, [f.selector]: "saving" }));
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("no active tab");
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: "EXECUTE_ACTION",
        payload: {
          id: `review-${Date.now()}`,
          type: "type",
          target: f.selector,
          value,
          retries: 0,
          maxRetries: 1,
        },
        source: "sidepanel",
        timestamp: Date.now(),
      });
      setState((s) => ({ ...s, [f.selector]: res?.success ? "saved" : "error" }));
      setTimeout(() => setState((s) => ({ ...s, [f.selector]: "idle" })), 2000);
    } catch {
      setState((s) => ({ ...s, [f.selector]: "error" }));
      setTimeout(() => setState((s) => ({ ...s, [f.selector]: "idle" })), 2500);
    }
  };

  const empty = fields.filter((f) => !f.value && f.required);

  return (
    <div className="space-y-2.5 font-sans">
      {/* Header Banner */}
      <div className="hallmark-card p-3 border-sky-500/20 bg-sky-500/5">
        <div className="flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          <span className="text-xs font-semibold text-sky-300 font-mono uppercase tracking-wider">
            Review Form Filled Fields
          </span>
        </div>
        <p className="text-[10px] text-gray-400 mt-1 font-light leading-relaxed">
          Post-execution verification read directly from the page DOM. Edits apply immediately.
        </p>
        {empty.length > 0 && (
          <p className="text-[10px] text-amber-400 font-mono mt-1">
            {empty.length} required field{empty.length === 1 ? "" : "s"} empty
          </p>
        )}
      </div>

      {fields.some((f) => f.value) && (
        <button
          onClick={() => setRevealed((r) => !r)}
          className="hallmark-button text-[10px] px-2.5 py-1 font-mono uppercase text-gray-300"
        >
          {revealed ? "Mask Sensitivity" : "Show Values"}
        </button>
      )}

      {/* Field Editor List */}
      <div className="space-y-1.5 font-mono">
        {fields.map((f) => {
          const st = state[f.selector] ?? "idle";
          const dirty = isDirty(f);
          return (
            <div key={f.selector} className="hallmark-card p-2.5 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-gray-400 truncate max-w-[160px]" title={f.label}>
                  {f.label} {f.required && <span className="text-rose-400">*</span>}
                </span>
                {f.category && (
                  <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20 uppercase shrink-0">
                    {f.category}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <input
                  type={revealed ? "text" : "password"}
                  value={valueOf(f)}
                  placeholder={f.value ? "" : "empty — type value"}
                  onChange={(e) =>
                    setEdits((prev) => ({ ...prev, [f.selector]: e.target.value }))
                  }
                  className="flex-1 min-w-0 text-xs font-mono hallmark-input px-2 py-1 text-gray-200 placeholder:text-gray-600 focus:outline-none"
                />
                <button
                  onClick={() => void apply(f)}
                  disabled={!dirty || st === "saving"}
                  className="hallmark-button text-[10px] px-2.5 py-1 uppercase shrink-0 disabled:opacity-40 disabled:cursor-not-allowed text-gray-300 hover:text-white"
                >
                  {st === "saving" ? "..." : st === "saved" ? "Saved" : st === "error" ? "Error" : "Apply"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
