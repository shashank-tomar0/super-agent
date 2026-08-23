import { useState, useEffect, useCallback } from "react";
import { getStats, onStatsChange, getPrivacyScore, generatePrivacyProof } from "../../core/privacy/network-monitor";
import type { NetworkStats } from "../../core/privacy/network-monitor";

export function PrivacyMonitor() {
  const [stats, setStats] = useState<NetworkStats>(getStats());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const unsub = onStatsChange((newStats) => {
      setStats({ ...newStats });
    });
    return unsub;
  }, []);

  const privacyScore = getPrivacyScore();
  const elapsed = stats.isMonitoring
    ? ((Date.now() - stats.startedAt) / 1000).toFixed(0)
    : "0";

  const copyProof = useCallback(() => {
    navigator.clipboard.writeText(generatePrivacyProof());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  return (
    <div className="p-4 space-y-4 font-sans text-[var(--color-ink)]">
      {/* Title Bar */}
      <div className="flex items-center justify-between border-b-2 border-[var(--color-ink)] pb-2">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-[var(--color-teal)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          <h2 className="text-sm font-display-poster uppercase tracking-wider text-[var(--color-ink)]">Privacy Monitor</h2>
        </div>
        <span className="text-[10px] font-mono-press px-2 py-0.5 uppercase font-bold bg-[var(--color-teal)] text-[var(--color-paper)] border border-[var(--color-ink)]">
          {privacyScore.label}
        </span>
      </div>

      {/* Privacy Score Ring */}
      <div className="flex justify-center py-2">
        <div className="relative w-28 h-28">
          <svg className="w-28 h-28 -rotate-90" viewBox="0 0 120 120">
            <circle cx="60" cy="60" r="52" fill="none" stroke="var(--color-paper-3)" strokeWidth="8" />
            <circle
              cx="60" cy="60" r="52" fill="none"
              stroke="var(--color-teal)"
              strokeWidth="8"
              strokeDasharray={`${(privacyScore.score / 100) * 327} 327`}
              strokeLinecap="butt"
              className="transition-all duration-1000"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center font-mono-press">
            <span className="text-3xl font-bold tracking-tight text-[var(--color-ink)]">
              {privacyScore.score}
            </span>
            <span className="text-[9px] uppercase tracking-widest text-[var(--color-ink-mute)] font-semibold">Score</span>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-2.5 font-mono-press">
        <StatCard label="Monitoring" value={stats.isMonitoring ? `${elapsed}s` : "Off"} />
        <StatCard label="Total Requests" value={String(stats.totalRequests)} />
        <StatCard
          label="Outbound Egress"
          value={String(stats.outboundRequests)}
          alert={stats.outboundRequests > 0}
        />
        <StatCard label="Blocked PII" value={String(stats.blockedRequests.length)} />
      </div>

      {/* Zero Egress Proof Banner */}
      {stats.isMonitoring && stats.outboundRequests === 0 && (
        <div className="hallmark-card p-3 border-2 border-[var(--color-teal)] bg-[#e6f4f4] text-center space-y-1">
          <div className="inline-flex items-center gap-1.5 text-xs font-mono-press font-bold text-[var(--color-teal)] uppercase">
            <span className="w-2 h-2 rounded-full bg-[var(--color-teal)] animate-pulse-dot" />
            Verified Zero Outbound Egress
          </div>
          <p className="text-[10px] font-body-editorial text-[var(--color-ink)] leading-relaxed">
            All vision processing, OCR, and PII detection ran locally inside browser WASM.
          </p>
        </div>
      )}

      {/* Outbound Warning */}
      {stats.outboundRequests > 0 && (
        <div className="hallmark-card p-3 border-2 border-[var(--color-accent)] bg-[#faebe8] space-y-2">
          <p className="text-xs font-mono-press font-bold text-[var(--color-accent)] uppercase flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[var(--color-accent)] animate-ping" />
            {stats.outboundRequests} Outbound Request(s) Detected
          </p>
          <div className="space-y-1">
            {Array.from(stats.requestsByDomain.entries())
              .filter(([d]) => d !== "localhost" && !d.includes("chrome-extension"))
              .map(([domain, count]) => (
                <div key={domain} className="flex justify-between text-[10px] font-mono-press text-[var(--color-ink)]">
                  <span>{domain}</span>
                  <span>{count}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Copy Proof Action */}
      <button
        onClick={copyProof}
        className="w-full hallmark-button-primary py-2.5 text-xs font-mono-press font-bold uppercase tracking-wider flex items-center justify-center gap-2"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
        </svg>
        {copied ? "Proof Copied to Clipboard!" : "Copy Cryptographic Privacy Proof"}
      </button>
    </div>
  );
}

function StatCard({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className={`hallmark-card p-2.5 border-2 ${alert ? "border-[var(--color-accent)] bg-[#faebe8]" : "border-[var(--color-ink)]"}`}>
      <span className="text-[9px] uppercase tracking-wider text-[var(--color-ink-mute)] font-semibold block mb-0.5">{label}</span>
      <span className={`text-base font-bold font-mono-press ${alert ? "text-[var(--color-accent)]" : "text-[var(--color-ink)]"}`}>
        {value}
      </span>
    </div>
  );
}
