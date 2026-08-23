// ============================================================
// VLESS — Privacy Proof Ledger
// Live dashboard showing:
//   - Outbound requests monitored
//   - PII detected / redacted / verified
//   - Tripwire status (blocking active)
//   - Re-OCR verification result
//   - Privacy score
//
// This is the "DevTools-verifiable" proof that zero PII left the device.
// Judges can open DevTools Network tab and see the same thing.
// ============================================================

import { useState, useEffect } from "react";

interface TripwireEvent {
  id: string;
  timestamp: number;
  url: string;
  method: string;
  blocked: boolean;
  detectedPatterns: Array<{
    category: string;
    matchedText: string;
    position: number;
  }>;
  bytesBlocked: number;
}

interface LedgerData {
  tripwireActive: boolean;
  totalRequests: number;
  blockedRequests: number;
  cleanRequests: number;
  totalBytesInspected: number;
  totalBytesBlocked: number;
  events: TripwireEvent[];
  piiDetected: number;
  piiRedacted: number;
  redactionVerified: boolean;
  privacyScore: number;
}

export function PrivacyLedger({ pipelineResult }: { pipelineResult?: any }) {
  const [data, setData] = useState<LedgerData>({
    tripwireActive: false,
    totalRequests: 0,
    blockedRequests: 0,
    cleanRequests: 0,
    totalBytesInspected: 0,
    totalBytesBlocked: 0,
    events: [],
    piiDetected: 0,
    piiRedacted: 0,
    redactionVerified: false,
    privacyScore: 100,
  });

  const [expanded, setExpanded] = useState(false);

  // Merge pipeline result data into ledger state (the real fix)
  useEffect(() => {
    if (pipelineResult) {
      setData((prev) => ({
        ...prev,
        piiDetected: pipelineResult.piiDetection?.summary?.totalRegions ?? prev.piiDetected,
        piiRedacted: pipelineResult.redactionSummary?.redacted ?? prev.piiRedacted,
        redactionVerified: pipelineResult.privacyProof?.redactionVerified ?? prev.redactionVerified,
      }));
    }
  }, [pipelineResult]);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return;
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: "GET_TRIPWIRE_STATS",
          payload: null,
          source: "sidepanel",
          timestamp: Date.now(),
        });
        if (response) {
          setData((prev) => {
            const blocked = response.blockedRequests || 0;
            const outbound = response.totalRequests - response.cleanRequests;
            // Compute privacy score: 100 if zero PII leaked, -10 per blocked, -20 per outbound
            let score = 100;
            if (blocked > 0) score = Math.max(0, 100 - blocked * 10);
            else if (outbound > 0) score = Math.max(0, 100 - outbound * 20);
            return {
              ...prev,
              tripwireActive: true,
              totalRequests: response.totalRequests || 0,
              blockedRequests: blocked,
              cleanRequests: response.cleanRequests || 0,
              totalBytesInspected: response.totalBytesInspected || 0,
              totalBytesBlocked: response.totalBytesBlocked || 0,
              events: response.events || [],
              privacyScore: score,
            };
          });
        }
      } catch {
        // Content script not ready
      }
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const scoreColor =
    data.privacyScore === 100
      ? "text-green-400"
      : data.privacyScore >= 80
        ? "text-yellow-400"
        : "text-red-400";

  const scoreBg =
    data.privacyScore === 100
      ? "bg-green-900/20 border-green-800/30"
      : data.privacyScore >= 80
        ? "bg-yellow-900/20 border-yellow-800/30"
        : "bg-red-900/20 border-red-800/30";

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-300">🔒 Privacy Ledger</h3>
        <div className="flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full ${
              data.tripwireActive ? "bg-green-400 animate-pulse" : "bg-gray-600"
            }`}
          />
          <span className="text-[10px] text-gray-500">
            {data.tripwireActive ? "Live" : "Inactive"}
          </span>
        </div>
      </div>

      {/* Privacy Score */}
      <div className={`rounded-lg p-3 border ${scoreBg}`}>
        <div className="flex items-center gap-3">
          <div
            className={`w-12 h-12 rounded-full border-2 flex items-center justify-center text-lg font-bold ${scoreColor}`}
            style={{
              borderColor: "currentColor",
            }}
          >
            {data.privacyScore}
          </div>
          <div>
            <div className={`text-sm font-semibold ${scoreColor}`}>
              {data.privacyScore === 100
                ? "Perfect Privacy"
                : data.privacyScore >= 80
                  ? "Good Privacy"
                  : "Privacy Risk"}
            </div>
            <div className="text-[10px] text-gray-500">
              {data.piiDetected} PII detected → {data.piiRedacted} redacted
            </div>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-2">
        <StatCard
          icon="📡"
          label="Requests Monitored"
          value={data.totalRequests}
          detail={`${data.cleanRequests} clean`}
        />
        <StatCard
          icon="🚫"
          label="PII Blocked"
          value={data.blockedRequests}
          detail={
            data.totalBytesBlocked > 0
              ? `${(data.totalBytesBlocked / 1024).toFixed(1)}KB saved`
              : "None detected"
          }
          highlight={data.blockedRequests > 0}
        />
        <StatCard
          icon="🔍"
          label="Bytes Inspected"
          value={formatBytes(data.totalBytesInspected)}
          detail="Outbound payload data"
        />
        <StatCard
          icon={data.redactionVerified ? "✅" : "⏳"}
          label="Re-OCR Verified"
          value={data.redactionVerified ? "PASSED" : "Pending"}
          detail={data.redactionVerified ? "Zero PII in pixels" : "Awaiting verification"}
          highlight={data.redactionVerified}
        />
      </div>

      {/* Tripwire Events */}
      {data.events.length > 0 && (
        <div className="bg-gray-900 rounded-lg border border-gray-800">
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full flex items-center justify-between p-2 text-[11px] text-gray-400 hover:text-gray-300"
          >
            <span>🚨 Blocked Requests ({data.events.length})</span>
            <span>{expanded ? "▲" : "▼"}</span>
          </button>
          {expanded && (
            <div className="px-2 pb-2 space-y-1 max-h-40 overflow-y-auto">
              {data.events.slice(-10).reverse().map((event) => (
                <div
                  key={event.id}
                  className="bg-red-900/20 rounded p-1.5 text-[10px]"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-red-400">BLOCKED</span>
                    <span className="text-gray-500">{event.method}</span>
                    <span className="text-gray-400 truncate">{event.url}</span>
                  </div>
                  <div className="text-gray-600 mt-0.5">
                    PII:{" "}
                    {event.detectedPatterns.map((p) => p.category).join(", ")}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Proof Statement */}
      <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
        <h4 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">
          Privacy Proof
        </h4>
        <div className="space-y-1 text-[11px]">
          <ProofLine
            passed={data.tripwireActive}
            text="Tripwire active — monitoring all outbound requests"
          />
          <ProofLine
            passed={data.blockedRequests === 0 && !pipelineResult?.privacyProof?.dataSentToServer?.piiText && !pipelineResult?.privacyProof?.dataSentToServer?.formValues}
            text={
              data.blockedRequests > 0
                ? `${data.blockedRequests} PII-containing request(s) BLOCKED by tripwire`
                : pipelineResult?.privacyProof?.dataSentToServer?.piiText || pipelineResult?.privacyProof?.dataSentToServer?.formValues
                  ? "WARNING: Some sensitive data may have been transmitted"
                  : "Zero PII sent to any server"
            }
          />
          <ProofLine
            passed={data.redactionVerified}
            text={
              data.redactionVerified
                ? "Re-OCR verified: zero PII text in pixels"
                : "Re-OCR verification pending"
            }
          />
          <ProofLine
            passed={pipelineResult?.planResult?.provider !== "cloud" && pipelineResult?.planResult?.provider !== "ollama"}
            text={pipelineResult?.planResult?.provider
              ? `Planning via ${pipelineResult.planResult.provider}${pipelineResult.planResult.provider.includes('cloud') ? ' (server-side)' : ' (on-device)'}`
              : "All ML inference runs on-device (WebGPU/WASM)"
            }
          />
        </div>
        <p className="text-[9px] text-gray-600 mt-2">
          Verify: Open DevTools → Network tab → Run agent → Zero PII in requests
        </p>
      </div>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────

function StatCard({
  icon,
  label,
  value,
  detail,
  highlight,
}: {
  icon: string;
  label: string;
  value: string | number;
  detail: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg p-2 border ${
        highlight
          ? "bg-blue-900/20 border-blue-800/30"
          : "bg-gray-900 border-gray-800"
      }`}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-sm">{icon}</span>
        <span className="text-[10px] text-gray-500">{label}</span>
      </div>
      <div className="text-sm font-semibold text-gray-300">{value}</div>
      <div className="text-[9px] text-gray-600">{detail}</div>
    </div>
  );
}

function ProofLine({ passed, text }: { passed: boolean; text: string }) {
  return (
    <div className="flex items-center gap-2">
      <span>{passed ? "✅" : "⏳"}</span>
      <span className={passed ? "text-gray-400" : "text-gray-600"}>{text}</span>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
