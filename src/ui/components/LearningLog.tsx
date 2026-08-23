import { useState, useEffect, useRef } from "react";
import { getEntries, onLogEntry, clearEntries, type LogEntry } from "../../core/agent/learning-log";

const PHASE_COLORS: Record<LogEntry["phase"], string> = {
  discovery: "text-[#006669]",
  analysis: "text-[var(--color-ink)]",
  action: "text-[var(--color-ink-mute)]",
  success: "text-[#006669]",
  warning: "text-[var(--color-accent)]",
  error: "text-[var(--color-accent)]",
  learning: "text-[#006669]",
};

export function LearningLog() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEntries(getEntries());
    const unsub = onLogEntry((newEntries) => {
      setEntries([...newEntries]);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries.length]);

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6 space-y-3 font-sans text-[var(--color-ink)]">
        <div className="w-10 h-10 hallmark-card flex items-center justify-center text-[var(--color-ink)] mb-1 border-2 border-[var(--color-ink)] bg-[var(--color-paper-2)]">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <h3 className="text-xs font-mono-press font-bold uppercase tracking-wider text-[var(--color-ink)]">
          Agent Learning Log
        </h3>
        <p className="text-xs font-body-editorial text-[var(--color-ink-2)] leading-relaxed max-w-xs font-medium">
          Real-time trace of on-device DOM perception, ViT visual grounding, and PII checksum audits.
        </p>
      </div>
    );
  }

  const recentEntries = entries.slice(-100);

  return (
    <div className="flex flex-col h-full font-sans text-[var(--color-ink)]">
      {/* Header Bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b-2 border-[var(--color-ink)] hallmark-card bg-[var(--color-paper-2)]">
        <span className="text-[10px] uppercase font-mono-press font-bold tracking-wider text-[var(--color-ink-mute)]">
          {entries.length} Execution Traces
        </span>
        <button
          onClick={() => { clearEntries(); setEntries([]); }}
          className="text-[10px] uppercase font-mono-press font-bold tracking-wider text-[var(--color-accent)] hover:text-[var(--color-ink)] transition-colors"
        >
          Clear Log
        </button>
      </div>

      {/* Log Stream */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2.5 space-y-2 custom-scrollbar font-mono-press text-xs">
        {recentEntries.map((entry) => (
          <div
            key={entry.id}
            className="hallmark-card p-2.5 border-2 border-[var(--color-ink)] bg-[var(--color-paper-2)] space-y-1"
          >
            <div className="flex items-center justify-between text-[9px] uppercase tracking-wider font-mono-press">
              <span className={`font-bold ${PHASE_COLORS[entry.phase]}`}>
                • {entry.phase}
              </span>
              <span className="text-[var(--color-ink-mute)] font-semibold">
                {new Date(entry.timestamp).toLocaleTimeString([], { hour12: false, minute: "2-digit", second: "2-digit" })}
              </span>
            </div>
            <p className="text-[var(--color-ink)] font-body-editorial font-medium text-xs leading-snug break-words">
              {entry.message}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
