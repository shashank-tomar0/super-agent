import { useCallback, useEffect, useState } from "react";
import type { ProviderConfig, ProviderID } from "../../core/agent/llm-providers";

function send<T = unknown>(type: string, payload?: unknown): Promise<T> {
  return chrome.runtime.sendMessage({
    type,
    payload,
    source: "sidepanel",
    timestamp: Date.now(),
  }) as Promise<T>;
}

export function ProviderSettings() {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Form state per provider
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [models, setModels] = useState<Record<string, string>>({});
  const [baseUrls, setBaseUrls] = useState<Record<string, string>>({});

  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; latencyMs?: number; error?: string }>
  >({});

  const reload = useCallback(async () => {
    try {
      const [list, act] = await Promise.all([
        send<ProviderConfig[]>("GET_PROVIDERS"),
        send<string | null>("GET_ACTIVE_PROVIDER"),
      ]);
      setProviders(list || []);
      setActive(act);

      const kMap: Record<string, string> = {};
      const mMap: Record<string, string> = {};
      const uMap: Record<string, string> = {};

      if (list) {
        for (const p of list) {
          kMap[p.id] = p.apiKey ?? "";
          mMap[p.id] = p.model ?? p.defaultModel ?? "";
          uMap[p.id] = p.baseUrl ?? p.defaultBaseUrl ?? "";
        }
      }
      setKeys(kMap);
      setModels(mMap);
      setBaseUrls(uMap);
    } catch (e) {
      console.error("Failed to load providers:", e);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleSave = async (id: ProviderID) => {
    const p = providers.find((pr) => pr.id === id);
    if (!p) return;

    const updatePayload: ProviderConfig = {
      ...p,
      enabled: p.enabled,
      apiKey: keys[id] || undefined,
      model: models[id] || p.defaultModel,
      baseUrl: baseUrls[id] || p.defaultBaseUrl,
    };

    await send("SAVE_PROVIDER", updatePayload);
    await reload();
  };

  const handleToggle = async (id: ProviderID, currentEnabled: boolean) => {
    const p = providers.find((pr) => pr.id === id);
    if (!p) return;

    await send("SAVE_PROVIDER", { ...p, enabled: !currentEnabled });
    await reload();
  };

  const handleSetActive = async (id: ProviderID) => {
    await send("SET_ACTIVE_PROVIDER", { name: id });
    setActive(id);
  };

  const handleTestAll = async () => {
    setTesting(true);
    setTestResults({});
    try {
      const results = await send<
        Record<string, { ok: boolean; latencyMs?: number; error?: string }>
      >("TEST_PROVIDERS");
      setTestResults(results || {});
    } catch {
      // Ignore
    } finally {
      setTesting(false);
    }
  };

  const activeProvider = providers.find((p) => p.id === active);

  return (
    <div className="space-y-4 font-sans text-[var(--color-ink)]">
      {/* Title Bar */}
      <div className="flex items-center justify-between border-b-2 border-[var(--color-ink)] pb-2">
        <div>
          <h2 className="text-xs font-mono-press font-bold uppercase tracking-wider text-[var(--color-ink)]">
            AI Providers
          </h2>
          <p className="text-[11px] font-body-editorial text-[var(--color-ink-2)] font-medium">
            Configure LLM planners for browser automation.
          </p>
        </div>
        <button
          onClick={() => void handleTestAll()}
          disabled={testing}
          className="hallmark-button text-[10px] px-2.5 py-1 font-mono-press uppercase disabled:opacity-40"
        >
          {testing ? "Testing..." : "Test Providers"}
        </button>
      </div>

      {/* Active Planner Summary */}
      <div className="hallmark-card p-3 space-y-1 bg-[var(--color-paper-2)] border-2 border-[var(--color-ink)]">
        <div className="flex items-center justify-between">
          <span className="text-[9px] uppercase tracking-widest text-[var(--color-ink-mute)] font-mono-press font-bold">
            Active Planner
          </span>
          {activeProvider && (
            <span className="text-[10px] font-mono-press uppercase font-bold px-2 py-0.5 bg-[#006669] text-[var(--color-paper)] border border-[var(--color-ink)]">
              {activeProvider.name}
            </span>
          )}
        </div>
        {activeProvider ? (
          <p className="text-xs font-mono-press font-semibold text-[var(--color-ink)]">
            Model: {models[activeProvider.id] || activeProvider.defaultModel || activeProvider.model}
            {testResults[activeProvider.id]?.latencyMs && (
              <span className="text-[var(--color-ink-mute)] ml-2">
                ({testResults[activeProvider.id].latencyMs}ms)
              </span>
            )}
          </p>
        ) : (
          <p className="text-xs font-mono-press text-[var(--color-accent)] font-bold">
            No active provider selected. Select one below.
          </p>
        )}
      </div>

      {/* Provider List */}
      <div className="space-y-2 font-mono-press">
        {providers.map((p) => {
          const isAct = active === p.id;
          const isExp = expanded === p.id;
          const res = testResults[p.id];

          return (
            <div
              key={p.id}
              className={`hallmark-card border-2 transition-all bg-[var(--color-paper-2)] ${
                isAct ? "border-[var(--color-accent)] shadow-md" : "border-[var(--color-ink)]"
              }`}
            >
              {/* Card Header */}
              <div className="p-3 flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    onClick={() => void handleSetActive(p.id)}
                    title={isAct ? "Active planner" : "Set as active"}
                    className={`w-4 h-4 rounded-full border-2 border-[var(--color-ink)] transition-colors ${
                      isAct ? "bg-[var(--color-accent)]" : "bg-[var(--color-paper)]"
                    }`}
                  />
                  <span className="text-xs font-bold text-[var(--color-ink)] truncate font-mono-press">
                    {p.name}
                  </span>
                  <span className="text-[10px] text-[var(--color-ink-mute)] truncate font-semibold">
                    {models[p.id] || p.defaultModel || p.model}
                  </span>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {res && (
                    <span
                      className={`text-[9px] font-mono-press font-bold uppercase px-1.5 py-0.5 ${
                        res.ok ? "text-[#006669]" : "text-[var(--color-accent)]"
                      }`}
                    >
                      {res.ok ? `${res.latencyMs}ms` : "Failed"}
                    </span>
                  )}

                  <button
                    onClick={() => void handleToggle(p.id, p.enabled)}
                    className={`text-[9px] font-mono-press font-bold uppercase px-2 py-0.5 border border-[var(--color-ink)] ${
                      p.enabled
                        ? "bg-[var(--color-ink)] text-[var(--color-paper)]"
                        : "bg-[var(--color-paper-3)] text-[var(--color-ink-mute)]"
                    }`}
                  >
                    {p.enabled ? "Enabled" : "Disabled"}
                  </button>

                  <button
                    onClick={() => setExpanded(isExp ? null : p.id)}
                    className="text-[10px] text-[var(--color-ink)] hover:text-[var(--color-accent)] font-bold px-1"
                  >
                    {isExp ? "▲" : "▼"}
                  </button>
                </div>
              </div>

              {/* Expanded Config Form */}
              {isExp && (
                <div className="px-3 pb-3 pt-1 border-t-2 border-[var(--color-hairline)] space-y-3 font-mono-press bg-[var(--color-paper-2)]">
                  {p.requiresApiKey && (
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-[var(--color-ink)] uppercase block">
                        API Key
                      </label>
                      <input
                        type="password"
                        value={keys[p.id] ?? ""}
                        onChange={(e) =>
                          setKeys((prev) => ({ ...prev, [p.id]: e.target.value }))
                        }
                        placeholder={p.id === "ollama" ? "Not required" : "sk-..."}
                        className="w-full hallmark-input px-2.5 py-1.5 text-xs text-[var(--color-ink)] font-mono-press font-semibold"
                      />
                    </div>
                  )}

                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-[var(--color-ink)] uppercase block">
                      Model ID
                    </label>
                    {p.availableModels && p.availableModels.length > 0 ? (
                      <select
                        value={models[p.id] ?? p.defaultModel ?? p.model}
                        onChange={(e) =>
                          setModels((prev) => ({ ...prev, [p.id]: e.target.value }))
                        }
                        className="w-full hallmark-input px-2.5 py-1.5 text-xs text-[var(--color-ink)] font-mono-press font-semibold"
                      >
                        {p.availableModels.map((m: string) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={models[p.id] ?? p.defaultModel ?? p.model}
                        onChange={(e) =>
                          setModels((prev) => ({ ...prev, [p.id]: e.target.value }))
                        }
                        className="w-full hallmark-input px-2.5 py-1.5 text-xs text-[var(--color-ink)] font-mono-press font-semibold"
                      />
                    )}
                  </div>

                  {p.id === "ollama" && (
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-[var(--color-ink)] uppercase block">
                        Base URL
                      </label>
                      <input
                        type="text"
                        value={baseUrls[p.id] ?? "http://localhost:11434"}
                        onChange={(e) =>
                          setBaseUrls((prev) => ({ ...prev, [p.id]: e.target.value }))
                        }
                        className="w-full hallmark-input px-2.5 py-1.5 text-xs text-[var(--color-ink)] font-mono-press font-semibold"
                      />
                    </div>
                  )}

                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      onClick={() => void handleSave(p.id)}
                      className="hallmark-button-primary text-[10px] px-3 py-1 uppercase font-bold"
                    >
                      Save Configuration
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
