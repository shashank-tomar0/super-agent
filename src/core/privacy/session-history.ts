// ============================================================
// VLESS — On-Device Session History Database
// Stores 100% private, local execution records in chrome.storage.local
// No network transmission — complete audit trail stay in your browser.
// ============================================================

export interface VlessSessionStep {
  stepIndex: number;
  action: string;
  targetId?: string;
  targetSelector?: string;
  sanitizedValue?: string;
  timestamp: number;
}

export interface VlessSessionRecord {
  sessionId: string;
  timestamp: number;
  taskPrompt: string;
  targetUrl: string;
  domain: string;
  status: "completed" | "failed" | "aborted";
  durationMs: number;
  piiSummary: {
    totalDetected: number;
    categories: Record<string, number>;
    egressBlockedBytes: number;
  };
  steps: VlessSessionStep[];
  errorMessage?: string;
}

const STORAGE_KEY = "vless_session_history";
const MAX_SESSIONS = 50;

/** Retrieve all saved session records from local storage (newest first). */
export async function getSessions(limit = 50): Promise<VlessSessionRecord[]> {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      // In non-extension test environments, fallback to memory/mock
      return (globalThis as any).__vless_sessions_memory__ || [];
    }
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const sessions: VlessSessionRecord[] = data[STORAGE_KEY] || [];
    return sessions.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  } catch (err) {
    console.error("[VLESS History] Failed to read sessions:", err);
    return [];
  }
}

/** Save a new session record into local storage. */
export async function saveSessionRecord(record: VlessSessionRecord): Promise<void> {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      if (!(globalThis as any).__vless_sessions_memory__) {
        (globalThis as any).__vless_sessions_memory__ = [];
      }
      (globalThis as any).__vless_sessions_memory__.unshift(record);
      return;
    }

    const current = await getSessions(MAX_SESSIONS);
    // Deduplicate by sessionId if updating
    const filtered = current.filter((s) => s.sessionId !== record.sessionId);
    filtered.unshift(record);

    // Keep max 50 recent sessions to preserve storage space
    const trimmed = filtered.slice(0, MAX_SESSIONS);
    await chrome.storage.local.set({ [STORAGE_KEY]: trimmed });
  } catch (err) {
    console.error("[VLESS History] Failed to save session record:", err);
  }
}

/** Delete a single session by ID. */
export async function deleteSession(sessionId: string): Promise<void> {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      if ((globalThis as any).__vless_sessions_memory__) {
        (globalThis as any).__vless_sessions_memory__ = (
          globalThis as any
        ).__vless_sessions_memory__.filter((s: any) => s.sessionId !== sessionId);
      }
      return;
    }

    const current = await getSessions(MAX_SESSIONS);
    const updated = current.filter((s) => s.sessionId !== sessionId);
    await chrome.storage.local.set({ [STORAGE_KEY]: updated });
  } catch (err) {
    console.error("[VLESS History] Failed to delete session:", err);
  }
}

/** Clear all saved session history. */
export async function clearSessions(): Promise<void> {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      (globalThis as any).__vless_sessions_memory__ = [];
      return;
    }
    await chrome.storage.local.remove(STORAGE_KEY);
  } catch (err) {
    console.error("[VLESS History] Failed to clear sessions:", err);
  }
}

/** Filter sessions by query matching task prompt or domain. */
export async function searchSessions(query: string): Promise<VlessSessionRecord[]> {
  const all = await getSessions(MAX_SESSIONS);
  if (!query.trim()) return all;
  const q = query.toLowerCase().trim();
  return all.filter(
    (s) =>
      s.taskPrompt.toLowerCase().includes(q) ||
      s.domain.toLowerCase().includes(q) ||
      s.targetUrl.toLowerCase().includes(q)
  );
}

/** Export session as formatted JSON string. */
export async function exportSessionAsJson(sessionId: string): Promise<string> {
  const sessions = await getSessions(MAX_SESSIONS);
  const target = sessions.find((s) => s.sessionId === sessionId);
  if (!target) throw new Error(`Session "${sessionId}" not found.`);
  return JSON.stringify(target, null, 2);
}
