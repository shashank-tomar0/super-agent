import { useState, useEffect, useRef } from "react";
import { getEntries, onLogEntry, clearEntries, type LogEntry } from "../../core/agent/learning-log";

const PHASE_COLORS: Record<LogEntry["phase"], string> = {
  discovery: "text-sky-400",
  analysis: "text-purple-400",
  action: "text-amber-400",
  success: "text-emerald-400",
  warning: "text-orange-400",
  error: "text-rose-400",
  learning: "text-teal-400",
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
      <div className="flex flex-col items-center justify-center h-full text-center px-6 space-y-3 font-sans">
        <div className="w-10 h-10 rounded-full hallmark-card flex items-center justify-center text-white/60 mb-1 border border-white/10">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <h3 className="text-xs font-medium uppercase tracking-wider text-white/80">
          Agent Learning Log
        </h3>
        <p className="text-[11px] text-white/40 font-light leading-relaxed max-w-xs">
          Real-time trace of on-device DOM perception, ViT visual grounding, and PII checksum audits.
        </p>
      </div>
    );
  }

  const recentEntries = entries.slice(-100);

  return (
    <div className="flex flex-col h-full font-sans text-gray-100">
      {/* Header Bar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10 hallmark-card">
        <span className="text-[10px] uppercase tracking-wider text-white/50 font-medium">
          {entries.length} Execution Traces
        </span>
        <button
          onClick={() => { clearEntries(); setEntries([]); }}
          className="text-[10px] uppercase tracking-wider text-white/40 hover:text-white transition-colors"
        >
          Clear Log
        </button>
      </div>

      {/* Log Stream */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar font-mono text-[11px]">
        {recentEntries.map((entry) => (
          <div
            key={entry.id}
            className="hallmark-card rounded-xl p-2.5 border border-white/5 space-y-1 transition-all hover:border-white/15"
          >
            <div className="flex items-center justify-between text-[9px] uppercase tracking-wider">
              <span className={`font-medium ${PHASE_COLORS[entry.phase]}`}>
                • {entry.phase}
              </span>
              <span className="text-white/30">
                {new Date(entry.timestamp).toLocaleTimeString([], { hour12: false, minute: "2-digit", second: "2-digit" })}
              </span>
            </div>
            <p className="text-white/80 font-light leading-snug break-words">
              {entry.message}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
