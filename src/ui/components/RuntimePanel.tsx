import { useCallback, useEffect, useState } from "react";
import { onModelProgress } from "../../core/runtime/messaging";
import type {
  BackendProfile,
  ModelId,
  ModelProgress,
  ModelStatus,
} from "../../types/runtime";

function send<T = unknown>(type: string, payload?: unknown): Promise<T> {
  return chrome.runtime.sendMessage({
    type,
    payload,
    source: "sidepanel",
    timestamp: Date.now(),
  }) as Promise<T>;
}

function fmtBytes(n: number): string {
  if (!n) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

const TIER_META: Record<string, { label: string; cls: string }> = {
  A: { label: "GPU Accelerated", cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  B: { label: "CPU SIMD", cls: "bg-sky-500/10 text-sky-400 border-sky-500/20" },
  C: { label: "CPU Baseline", cls: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
};

const STATE_META: Record<
  ModelStatus["state"],
  { label: string; dot: string; text: string }
> = {
  ready: { label: "Ready", dot: "bg-emerald-400", text: "text-emerald-400" },
  cached: { label: "Cached", dot: "bg-emerald-400", text: "text-emerald-400" },
  downloading: { label: "Downloading", dot: "bg-sky-400 animate-pulse", text: "text-sky-300" },
  loading: { label: "Loading", dot: "bg-sky-400 animate-pulse", text: "text-sky-300" },
  not_loaded: { label: "Not Loaded", dot: "bg-gray-600", text: "text-gray-500" },
  skipped: { label: "Later Phase", dot: "bg-gray-700", text: "text-gray-600" },
  error: { label: "Error", dot: "bg-rose-500", text: "text-rose-400" },
};

export function RuntimePanel() {
  const [backend, setBackend] = useState<BackendProfile | null>(null);
  const [statuses, setStatuses] = useState<ModelStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [be, st] = await Promise.all([
        send<BackendProfile>("GET_BACKEND"),
        send<ModelStatus[]>("GET_MODEL_STATUSES"),
      ]);
      setBackend(be);
      setStatuses(st);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const off = onModelProgress((p: ModelProgress) => {
      setStatuses((prev) =>
        prev.map((s) =>
          s.id === p.id
            ? { ...s, state: p.state, progress: p.progress, error: p.error }
            : s,
        ),
      );
    });
    return off;
  }, [refresh]);

  const warm = useCallback(async (ids: ModelId[]) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await send<ModelStatus[]>("WARM_MODELS", { ids });
      setStatuses((prev) =>
        prev.map((s) => updated.find((u) => u.id === s.id) ?? s),
      );
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, []);

  const ocrIds = statuses
    .filter((s) => s.id.startsWith("ocr-"))
    .map((s) => s.id);
  const allEligible = statuses
    .filter((s) => s.state !== "skipped")
    .map((s) => s.id);

  return (
    <div className="space-y-4 font-sans">
      {/* Backend Hardware Profile Card */}
      <div className="hallmark-card p-3.5 space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold text-white font-mono uppercase tracking-wider">
            Hardware Execution Profile
          </h2>
          <button
            onClick={() => void refresh()}
            className="hallmark-button text-[10px] px-2 py-0.5 font-mono uppercase text-gray-300"
          >
            Refresh
          </button>
        </div>

        {backend ? (
          <div className="space-y-2 font-mono">
            <div className="flex items-center gap-2">
              <span
                className={`text-[9px] font-mono px-2 py-0.5 rounded border uppercase ${
                  TIER_META[backend.tier]?.cls ?? ""
                }`}
              >
                Tier {backend.tier}
              </span>
              <span className="text-[11px] text-gray-300">
                {TIER_META[backend.tier]?.label}
              </span>
            </div>
            <p className="text-[10px] text-gray-400 leading-relaxed font-light">
              {backend.summary}
            </p>
            <div className="flex flex-wrap gap-1.5 pt-1">
              <Cap on={backend.webgpu} label="WebGPU" />
              <Cap on={backend.wasmSimd} label="WASM SIMD" />
              <Cap on={backend.wasmThreads} label="Threads" />
            </div>
          </div>
        ) : (
          <div className="text-[11px] text-gray-500 font-mono">
            Detecting hardware runtime profile...
          </div>
        )}
      </div>

      {/* Warm-Up Action Buttons */}
      <div className="flex gap-2 font-mono">
        <button
          disabled={busy || ocrIds.length === 0}
          onClick={() => void warm(ocrIds)}
          className="flex-1 hallmark-button-primary text-[10px] py-2 uppercase disabled:opacity-40"
        >
          {busy ? "Warming..." : "Warm OCR Engine"}
        </button>
        <button
          disabled={busy || allEligible.length === 0}
          onClick={() => void warm(allEligible)}
          className="flex-1 hallmark-button text-[10px] py-2 uppercase text-gray-300 hover:text-white disabled:opacity-40"
        >
          Warm All Eligible
        </button>
      </div>

      {error && (
        <div className="hallmark-card p-2.5 border-rose-500/30 bg-rose-500/5 text-xs text-rose-300 font-mono">
          {error}
        </div>
      )}

      {/* ONNX Models Inventory */}
      <div className="space-y-2 font-mono">
        <span className="text-[10px] text-gray-500 uppercase tracking-widest block font-medium">On-Device Vision Models</span>
        {statuses.map((s) => (
          <ModelRow key={s.id} s={s} />
        ))}
      </div>
    </div>
  );
}

function Cap({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={`text-[9px] font-mono px-2 py-0.5 rounded border uppercase ${
        on
          ? "border-emerald-500/20 text-emerald-400 bg-emerald-500/10"
          : "border-gray-800 text-gray-600 bg-[#12141d]"
      }`}
    >
      {on ? "PASS" : "OFF"} {label}
    </span>
  );
}

function ModelRow({ s }: { s: ModelStatus }) {
  const meta = STATE_META[s.state];
  const pct = Math.round((s.progress ?? 0) * 100);
  const showBar = s.state === "downloading" || s.state === "loading";

  return (
    <div className="hallmark-card p-2.5 space-y-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${meta.dot}`} />
          <span className="text-xs text-gray-200 truncate font-semibold">{s.name}</span>
        </div>
        <span className={`text-[10px] font-mono shrink-0 uppercase ${meta.text}`}>{meta.label}</span>
      </div>
      <div className="flex items-center justify-between text-[10px] text-gray-500 font-mono">
        <span>{fmtBytes(s.sizeBytes)}</span>
        {s.required && <span className="uppercase text-gray-400">Required</span>}
      </div>
      {showBar && (
        <div className="h-1 bg-[#181b28] rounded overflow-hidden border border-[#25293c]">
          <div
            className="h-full bg-sky-400 transition-all duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {s.error && (
        <p className="text-[10px] text-rose-400 truncate" title={s.error}>
          {s.error}
        </p>
      )}
    </div>
  );
}
