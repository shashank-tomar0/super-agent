import { useState } from "react";
import type { RequiredInput } from "../../core/agent/requirements";

interface Props {
  needs: RequiredInput[];
  onRetry?: () => void;
}

type Status = "idle" | "saving" | "saved" | "error";

export function NeedsInputPanel({ needs, onRetry }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [applyingAll, setApplyingAll] = useState(false);

  const answered = needs.filter((n) => (values[n.selector] ?? "").trim() !== "");

  const applyOne = async (need: RequiredInput): Promise<boolean> => {
    const value = (values[need.selector] ?? "").trim();
    if (!value) return false;
    setStatus((s) => ({ ...s, [need.selector]: "saving" }));
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("no active tab");
      const isSelect = (need.type || "").toLowerCase() === "select";
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: "EXECUTE_ACTION",
        payload: {
          id: `need-${Date.now()}`,
          type: isSelect ? "select" : "type",
          target: need.selector,
          value,
          retries: 0,
          maxRetries: 2,
        },
        source: "sidepanel",
        timestamp: Date.now(),
      });
      const ok = !!res?.success;
      setStatus((s) => ({ ...s, [need.selector]: ok ? "saved" : "error" }));
      return ok;
    } catch {
      setStatus((s) => ({ ...s, [need.selector]: "error" }));
      return false;
    }
  };

  const applyAll = async () => {
    setApplyingAll(true);
    for (const need of answered) {
      await applyOne(need);
    }
    setApplyingAll(false);
  };

  const missing = needs.filter((n) => n.reason === "no_local_value").length;

  return (
    <div className="space-y-2.5 font-sans">
      {/* Header Banner */}
      <div className="hallmark-card p-3 border-amber-500/20 bg-amber-500/5 space-y-1">
        <div className="flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="text-xs font-semibold text-amber-300 font-mono uppercase tracking-wider">
            {needs.length} Required Field{needs.length === 1 ? "" : "s"} Missing
          </span>
        </div>
        <p className="text-[10px] text-gray-400 font-light leading-relaxed">
          {missing > 0
            ? "The agent will not guess at these required fields. Supply them below to complete execution."
            : "These required fields remain uncompleted."}
        </p>
      </div>

      {/* Inputs List */}
      <div className="space-y-1.5 font-mono">
        {needs.map((need) => {
          const st = status[need.selector] ?? "idle";
          const value = values[need.selector] ?? "";
          const isSelect = (need.type || "").toLowerCase() === "select";
          return (
            <div key={need.selector} className="hallmark-card p-2.5 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-gray-300 truncate max-w-[160px]" title={need.label}>
                  {need.label} <span className="text-rose-400">*</span>
                </span>
                {need.category && (
                  <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20 uppercase shrink-0">
                    {need.category}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {isSelect && need.options ? (
                  <select
                    value={value}
                    onChange={(e) => setValues((v) => ({ ...v, [need.selector]: e.target.value }))}
                    className="flex-1 min-w-0 text-xs font-mono hallmark-input px-2 py-1 text-gray-200 focus:outline-none"
                  >
                    <option value="">— choose option —</option>
                    {need.options.map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={value}
                    placeholder={need.hint || "Type field value"}
                    onChange={(e) => setValues((v) => ({ ...v, [need.selector]: e.target.value }))}
                    className="flex-1 min-w-0 text-xs font-mono hallmark-input px-2 py-1 text-gray-200 placeholder:text-gray-600 focus:outline-none"
                  />
                )}
                <button
                  onClick={() => void applyOne(need)}
                  disabled={!value.trim() || st === "saving"}
                  className="hallmark-button text-[10px] px-2.5 py-1 uppercase shrink-0 disabled:opacity-40 disabled:cursor-not-allowed text-gray-300 hover:text-white"
                >
                  {st === "saving" ? "..." : st === "saved" ? "Saved" : st === "error" ? "Error" : "Fill"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {answered.length > 1 && (
        <div className="flex gap-2 font-mono">
          <button
            onClick={() => void applyAll()}
            disabled={applyingAll}
            className="hallmark-button-primary text-[10px] px-3 py-1.5 uppercase font-medium"
          >
            {applyingAll ? "Filling..." : `Fill All ${answered.length}`}
          </button>
          {onRetry && (
            <button
              onClick={onRetry}
              className="hallmark-button text-[10px] px-3 py-1.5 uppercase text-gray-300 hover:text-white"
            >
              Re-run Task
            </button>
          )}
        </div>
      )}
    </div>
  );
}
