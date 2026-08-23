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
    <div className="p-4 space-y-4 font-sans text-gray-100">
      {/* Title Bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          <h2 className="text-xs font-medium uppercase tracking-wider text-white/80">Privacy Monitor</h2>
        </div>
        <span
          className="text-[10px] px-2.5 py-0.5 rounded-full font-medium tracking-wide uppercase"
          style={{ backgroundColor: `${privacyScore.color}15`, color: privacyScore.color, border: `1px solid ${privacyScore.color}30` }}
        >
          {privacyScore.label}
        </span>
      </div>

      {/* Privacy Score Ring */}
      <div className="flex justify-center py-2">
        <div className="relative w-28 h-28">
          <svg className="w-28 h-28 -rotate-90" viewBox="0 0 120 120">
            <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="6" />
            <circle
              cx="60" cy="60" r="52" fill="none"
              stroke={privacyScore.color}
              strokeWidth="6"
              strokeDasharray={`${(privacyScore.score / 100) * 327} 327`}
              strokeLinecap="round"
              className="transition-all duration-1000"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-2xl font-bold tracking-tight" style={{ color: privacyScore.color }}>
              {privacyScore.score}
            </span>
            <span className="text-[9px] uppercase tracking-widest text-white/40 font-medium">Score</span>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-2.5">
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
        <div className="hallmark-card rounded-2xl p-3.5 border border-emerald-500/20 bg-emerald-500/5 text-center space-y-1">
          <div className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-300">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse-dot" />
            Verified Zero Outbound Egress
          </div>
          <p className="text-[10px] text-white/50 font-light leading-relaxed">
            All vision processing, OCR, and PII detection ran locally inside browser WASM.
          </p>
        </div>
      )}

      {/* Outbound Warning */}
      {stats.outboundRequests > 0 && (
        <div className="hallmark-card rounded-2xl p-3.5 border border-rose-500/20 bg-rose-500/5 space-y-2">
          <p className="text-xs font-medium text-rose-300 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-ping" />
            {stats.outboundRequests} Outbound Request(s) Detected
          </p>
          <div className="space-y-1">
            {Array.from(stats.requestsByDomain.entries())
              .filter(([d]) => d !== "localhost" && !d.includes("chrome-extension"))
              .map(([domain, count]) => (
                <div key={domain} className="flex justify-between text-[10px] text-white/60 font-mono">
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
        className="w-full hallmark-button rounded-xl py-2.5 text-xs text-white/80 hover:text-white font-medium flex items-center justify-center gap-2 transition-all"
      >
        <svg className="w-3.5 h-3.5 text-white/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
        </svg>
        {copied ? "Proof Copied to Clipboard!" : "Copy Cryptographic Privacy Proof"}
      </button>
    </div>
  );
}

function StatCard({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className={`hallmark-card rounded-2xl p-3 border transition-all ${alert ? "border-rose-500/30 bg-rose-500/5" : "border-white/10"}`}>
      <span className="text-[9px] uppercase tracking-wider text-white/40 font-medium block mb-1">{label}</span>
      <span className={`text-base font-semibold tracking-tight ${alert ? "text-rose-300" : "text-white"}`}>
        {value}
      </span>
    </div>
  );
}
