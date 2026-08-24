import { useCallback, useEffect, useState } from "react";
import { onModelProgress } from "../../core/runtime/messaging";
import type {
  BackendProfile,
  ModelId,
  ModelProgress,
  ModelStatus,
} from "../../types/runtime";

function send<T = unknown>(type: string, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(
        { type, payload, source: "sidepanel", timestamp: Date.now() },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message ?? "SW unavailable"));
          } else {
            resolve(response as T);
          }
        }
      );
    } catch (e) {
      reject(e);
    }
  });
}

function fmtBytes(n: number): string {
  if (!n) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

const TIER_META: Record<string, { label: string; cls: string }> = {
  A: { label: "GPU Accelerated", cls: "bg-[#006669] text-[var(--color-paper)] border-2 border-[var(--color-ink)]" },
  B: { label: "CPU SIMD", cls: "bg-[#006669] text-[var(--color-paper)] border-2 border-[var(--color-ink)]" },
  C: { label: "CPU Baseline", cls: "bg-[var(--color-paper-3)] text-[var(--color-ink)] border-2 border-[var(--color-ink)]" },
};

const STATE_META: Record<
  ModelStatus["state"],
  { label: string; dot: string; text: string }
> = {
  ready: { label: "Ready", dot: "bg-[#006669]", text: "text-[#006669]" },
  cached: { label: "Cached", dot: "bg-[#006669]", text: "text-[#006669]" },
  downloading: { label: "Downloading", dot: "bg-[var(--color-accent)] animate-pulse", text: "text-[var(--color-accent)]" },
  loading: { label: "Loading", dot: "bg-[var(--color-accent)] animate-pulse", text: "text-[var(--color-accent)]" },
  not_loaded: { label: "Not Loaded", dot: "bg-[var(--color-ink-mute)]", text: "text-[var(--color-ink-mute)]" },
  skipped: { label: "Later Phase", dot: "bg-[var(--color-ink-mute)]", text: "text-[var(--color-ink-mute)]" },
  error: { label: "Error", dot: "bg-[var(--color-accent)]", text: "text-[var(--color-accent)]" },
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
    <div className="space-y-4 font-sans text-[var(--color-ink)]">
      {/* Backend Hardware Profile Card */}
      <div className="hallmark-card p-3.5 space-y-2.5 bg-[var(--color-paper-2)]">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-mono-press font-bold uppercase tracking-wider text-[var(--color-ink)]">
            Hardware Execution Profile
          </h2>
          <button
            onClick={() => void refresh()}
            className="hallmark-button text-[10px] px-2 py-0.5 font-mono-press uppercase"
          >
            Refresh
          </button>
        </div>

        {backend ? (
          <div className="space-y-2 font-mono-press">
            <div className="flex items-center gap-2">
              <span
                className={`text-[9px] font-mono-press font-bold px-2 py-0.5 uppercase ${
                  TIER_META[backend.tier]?.cls ?? ""
                }`}
              >
                Tier {backend.tier}
              </span>
              <span className="text-[11px] font-semibold text-[var(--color-ink)]">
                {TIER_META[backend.tier]?.label}
              </span>
            </div>
            <p className="text-[11px] text-[var(--color-ink-2)] leading-relaxed font-body-editorial font-medium">
              {backend.summary}
            </p>
            <div className="flex flex-wrap gap-1.5 pt-1">
              <Cap on={backend.webgpu} label="WebGPU" />
              <Cap on={backend.wasmSimd} label="WASM SIMD" />
              <Cap on={backend.wasmThreads} label="Threads" />
            </div>
          </div>
        ) : (
          <div className="text-[11px] text-[var(--color-ink-mute)] font-mono-press">
            Detecting hardware runtime profile...
          </div>
        )}
      </div>

      {/* Warm-Up Action Buttons */}
      <div className="flex gap-2 font-mono-press">
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
          className="flex-1 hallmark-button text-[10px] py-2 uppercase disabled:opacity-40"
        >
          Warm All Eligible
        </button>
      </div>

      {error && (
        <div className="hallmark-card p-2.5 border-2 border-[var(--color-accent)] bg-[#faebe8] text-xs text-[var(--color-accent)] font-mono-press font-bold">
          {error}
        </div>
      )}

      {/* ONNX Models Inventory */}
      <div className="space-y-2 font-mono-press">
        <span className="text-[10px] text-[var(--color-ink-mute)] font-bold uppercase tracking-widest block">
          On-Device Vision Models
        </span>
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
      className={`text-[9px] font-mono-press font-bold px-2 py-0.5 uppercase border-2 ${
        on
          ? "border-[var(--color-ink)] text-[var(--color-paper)] bg-[#006669]"
          : "border-[var(--color-ink)] text-[var(--color-paper)] bg-[var(--color-ink)]"
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
    <div className="hallmark-card p-3 space-y-1 bg-[var(--color-paper)]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full shrink-0 ${meta.dot}`} />
          <span className="text-xs text-[var(--color-ink)] font-bold font-mono-press truncate">{s.name}</span>
        </div>
        <span className={`text-[10px] font-mono-press font-bold shrink-0 uppercase ${meta.text}`}>{meta.label}</span>
      </div>
      <div className="flex items-center justify-between text-[10px] text-[var(--color-ink-mute)] font-mono-press font-semibold">
        <span>{fmtBytes(s.sizeBytes)}</span>
        {s.required && <span className="uppercase text-[var(--color-accent)] font-bold">Required</span>}
      </div>
      {showBar && (
        <div className="h-2 bg-[var(--color-paper-3)] border border-[var(--color-ink)] overflow-hidden mt-1">
          <div
            className="h-full bg-[var(--color-accent)] transition-all duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {s.error && (
        <p className="text-[10px] text-[var(--color-accent)] font-mono-press font-bold truncate" title={s.error}>
          {s.error}
        </p>
      )}
    </div>
  );
}
