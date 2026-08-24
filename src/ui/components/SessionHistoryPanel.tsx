import { useState, useEffect } from "react";
import {
  deleteSession,
  clearSessions,
  searchSessions,
  exportSessionAsJson,
  type VlessSessionRecord,
} from "../../core/privacy/session-history";

interface SessionHistoryPanelProps {
  onSelectPrompt?: (prompt: string) => void;
}

export function SessionHistoryPanel({ onSelectPrompt }: SessionHistoryPanelProps) {
  const [sessions, setSessions] = useState<VlessSessionRecord[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadSessions = async (query = "") => {
    setLoading(true);
    try {
      const data = await searchSessions(query);
      setSessions(data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSessions(searchQuery);
  }, [searchQuery]);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await deleteSession(id);
    await loadSessions(searchQuery);
  };

  const handleClearAll = async () => {
    if (confirm("Are you sure you want to clear all on-device session history?")) {
      await clearSessions();
      await loadSessions();
    }
  };

  const handleExport = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      const jsonStr = await exportSessionAsJson(id);
      const blob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `vless-${id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export error:", err);
    }
  };

  return (
    <div className="flex flex-col h-full font-sans text-[var(--color-ink)] bg-[var(--color-paper-1)]">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b-2 border-[var(--color-ink)] hallmark-card bg-[var(--color-paper-2)]">
        <span className="text-[10px] uppercase font-mono-press font-bold tracking-wider text-[var(--color-ink-mute)]">
          {sessions.length} Saved Local Sessions
        </span>
        {sessions.length > 0 && (
          <button
            onClick={handleClearAll}
            className="text-[10px] uppercase font-mono-press font-bold tracking-wider text-[var(--color-accent)] hover:underline"
          >
            Clear History
          </button>
        )}
      </div>

      {/* Search Input */}
      <div className="p-3 border-b border-[var(--color-ink)] bg-[var(--color-paper-2)]">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search task history by prompt or domain..."
          className="w-full text-xs font-mono-press px-2.5 py-1.5 hallmark-input bg-[var(--color-paper-1)] text-[var(--color-ink)] focus:outline-none"
        />
      </div>

      {/* Sessions List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {loading ? (
          <div className="text-center py-8 text-xs font-mono-press text-[var(--color-ink-mute)]">
            Loading private session database...
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-6 space-y-3 font-sans text-[var(--color-ink)] py-12">
            <div className="w-10 h-10 hallmark-card flex items-center justify-center text-[var(--color-ink)] mb-1 border-2 border-[var(--color-ink)] bg-[var(--color-paper-2)]">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h3 className="text-xs font-mono-press font-bold uppercase tracking-wider text-[var(--color-ink)]">
              No History Found
            </h3>
            <p className="text-xs font-body-editorial text-[var(--color-ink-2)] leading-relaxed max-w-xs font-medium">
              Task prompts, PII redactions, and execution traces will be automatically stored 100% on your device here.
            </p>
          </div>
        ) : (
          sessions.map((s) => {
            const isExpanded = expandedId === s.sessionId;
            const formattedDate = new Date(s.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              month: "short",
              day: "numeric",
            });

            return (
              <div
                key={s.sessionId}
                onClick={() => setExpandedId(isExpanded ? null : s.sessionId)}
                className="hallmark-card p-3 cursor-pointer bg-[var(--color-paper-2)] border-2 border-[var(--color-ink)] hover:bg-[var(--color-paper-1)] transition-colors"
              >
                {/* Session Header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={`text-[9px] uppercase font-mono-press font-bold px-1.5 py-0.5 border ${
                          s.status === "completed"
                            ? "bg-[#e8f5e9] text-[#2e7d32] border-[#2e7d32]"
                            : "bg-[#ffebee] text-[var(--color-accent)] border-[var(--color-accent)]"
                        }`}
                      >
                        {s.status}
                      </span>
                      <span className="text-[10px] font-mono-press text-[var(--color-ink-mute)] truncate">
                        {s.domain || "browser"}
                      </span>
                      <span className="text-[10px] font-mono-press text-[var(--color-ink-mute)] ml-auto">
                        {formattedDate}
                      </span>
                    </div>
                    <h4 className="text-xs font-body-editorial font-bold text-[var(--color-ink)] line-clamp-2 leading-tight">
                      {s.taskPrompt}
                    </h4>
                  </div>
                </div>

                {/* Metrics Summary Pill */}
                <div className="flex items-center gap-3 mt-2.5 pt-2 border-t border-dashed border-[var(--color-ink-mute)] text-[10px] font-mono-press text-[var(--color-ink-2)]">
                  <span>Steps: {s.steps.length}</span>
                  <span>PII Redacted: {s.piiSummary.totalDetected}</span>
                  <span>Egress Blocked: 0 KB</span>
                </div>

                {/* Expanded Details */}
                {isExpanded && (
                  <div className="mt-3 pt-3 border-t-2 border-[var(--color-ink)] space-y-2 text-xs" onClick={(e) => e.stopPropagation()}>
                    <div className="space-y-1">
                      <div className="text-[10px] uppercase font-mono-press font-bold text-[var(--color-ink-mute)]">
                        Execution Steps ({s.steps.length})
                      </div>
                      {s.steps.length === 0 ? (
                        <div className="text-[11px] font-mono-press text-[var(--color-ink-mute)] italic">
                          No DOM steps were recorded for this task.
                        </div>
                      ) : (
                        <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                          {s.steps.map((st) => (
                            <div
                              key={st.stepIndex}
                              className="p-1.5 bg-[var(--color-paper-1)] border border-[var(--color-ink)] text-[11px] font-mono-press"
                            >
                              <span className="font-bold text-[var(--color-accent)]">#{st.stepIndex}</span>{" "}
                              <span>{st.action}</span>
                              {st.sanitizedValue && (
                                <span className="text-[var(--color-ink-mute)] block text-[10px]">
                                  Value: {st.sanitizedValue}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Action Bar */}
                    <div className="flex items-center gap-2 pt-2 border-t border-[var(--color-ink-mute)]">
                      {onSelectPrompt && (
                        <button
                          onClick={() => onSelectPrompt(s.taskPrompt)}
                          className="px-2 py-1 text-[10px] font-mono-press font-bold uppercase bg-[var(--color-ink)] text-white hover:bg-[var(--color-ink-mute)] transition-colors"
                        >
                          Re-run Task
                        </button>
                      )}
                      <button
                        onClick={(e) => handleExport(e, s.sessionId)}
                        className="px-2 py-1 text-[10px] font-mono-press font-bold uppercase border border-[var(--color-ink)] text-[var(--color-ink)] hover:bg-[var(--color-paper-1)]"
                      >
                        Export JSON
                      </button>
                      <button
                        onClick={(e) => handleDelete(e, s.sessionId)}
                        className="px-2 py-1 text-[10px] font-mono-press font-bold uppercase border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[#ffebee] ml-auto"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
