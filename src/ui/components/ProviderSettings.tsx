import { useState, useEffect, useCallback } from "react";
import {
  loadProviderConfigs,
  saveProviderConfigs,
} from "../../core/agent/llm-providers";

type ProviderID = "ollama" | "claude" | "openai" | "openrouter";

interface ProviderConfig {
  id: ProviderID;
  name: string;
  enabled: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

interface ProviderStatus {
  id: ProviderID;
  name: string;
  available: boolean;
  model: string | null;
  latencyMs: number;
  error?: string;
}

const PROVIDER_INFO: Record<
  ProviderID,
  {
    name: string;
    description: string;
    defaultModel: string;
    needsKey: boolean;
    setupUrl: string;
    models: string[];
  }
> = {
  ollama: {
    name: "Ollama (Local)",
    description: "Free local execution. No API key needed.",
    defaultModel: "qwen2.5:1.5b",
    needsKey: false,
    setupUrl: "https://ollama.ai/download",
    models: ["qwen2.5:1.5b", "qwen2.5:3b", "gemma2:2b", "phi3.5-mini", "llama3.2:1b"],
  },
  claude: {
    name: "Claude (Anthropic)",
    description: "High-reasoning cloud planner.",
    defaultModel: "claude-3-5-haiku-20241022",
    needsKey: true,
    setupUrl: "https://console.anthropic.com/settings/keys",
    models: ["claude-3-5-haiku-20241022", "claude-3-haiku-20240307", "claude-3-opus-20240229"],
  },
  openai: {
    name: "OpenAI (GPT)",
    description: "Fast cloud reasoning provider.",
    defaultModel: "gpt-4o-mini",
    needsKey: true,
    setupUrl: "https://platform.openai.com/api-keys",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"],
  },
  openrouter: {
    name: "OpenRouter",
    description: "Universal open-weight model router.",
    defaultModel: "meta-llama/llama-3.2-1b-instruct",
    needsKey: true,
    setupUrl: "https://openrouter.ai/keys",
    models: [
      "meta-llama/llama-3.2-1b-instruct",
      "meta-llama/llama-3.2-3b-instruct",
      "mistralai/mistral-7b-instruct",
      "google/gemma-2-2b-it",
      "microsoft/phi-3.5-mini-instruct",
    ],
  },
};

export function ProviderSettings() {
  const [configs, setConfigs] = useState<Record<ProviderID, ProviderConfig> | null>(null);
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [expandedId, setExpandedId] = useState<ProviderID | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadProviderConfigs()
      .then((loaded) => {
        if (!cancelled) setConfigs(loaded);
      })
      .catch(() => {
        if (!cancelled) setConfigs(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const checkProviders = useCallback(async () => {
    setChecking(true);
    try {
      const response = await chrome.runtime.sendMessage({
        type: "CHECK_PROVIDERS",
        source: "sidepanel",
        timestamp: Date.now(),
      });
      if (response?.statuses) {
        setStatuses(response.statuses);
      }
    } catch {
      try {
        const resp = await fetch("http://localhost:11434/api/tags", {
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          const data = await resp.json();
          const models = (data.models || []).map((m: { name: string }) => m.name);
          setStatuses([
            {
              id: "ollama",
              name: "Ollama (Local)",
              available: models.length > 0,
              model: models[0] || null,
              latencyMs: 0,
              error: models.length === 0 ? "No models pulled" : undefined,
            },
            { id: "claude", name: "Claude", available: false, model: null, latencyMs: 0, error: "Disabled" },
            { id: "openai", name: "OpenAI", available: false, model: null, latencyMs: 0, error: "Disabled" },
            { id: "openrouter", name: "OpenRouter", available: false, model: null, latencyMs: 0, error: "Disabled" },
          ]);
        }
      } catch {
        setStatuses([
          {
            id: "ollama",
            name: "Ollama (Local)",
            available: false,
            model: null,
            latencyMs: 0,
            error: "Not running (start Ollama locally)",
          },
          { id: "claude", name: "Claude", available: false, model: null, latencyMs: 0, error: "Disabled" },
          { id: "openai", name: "OpenAI", available: false, model: null, latencyMs: 0, error: "Disabled" },
          { id: "openrouter", name: "OpenRouter", available: false, model: null, latencyMs: 0, error: "Disabled" },
        ]);
      }
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    checkProviders();
  }, [checkProviders]);

  const saveConfig = async (id: ProviderID, partial: Partial<ProviderConfig>) => {
    if (!configs) return;
    const updated = {
      ...configs,
      [id]: { ...configs[id], ...partial },
    };
    setConfigs(updated);
    setSaving(id);
    try {
      await saveProviderConfigs(updated);
      await checkProviders();
    } catch (err) {
      console.error("Save config failed:", err);
    } finally {
      setSaving(null);
    }
  };

  if (!configs) {
    return <div className="p-4 text-xs font-mono text-gray-500">Loading AI provider configuration...</div>;
  }

  const activeProvider = statuses.find((s) => s.available);

  return (
    <div className="space-y-4 font-sans">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xs font-semibold text-white font-mono uppercase tracking-wider">AI Providers</h2>
          <p className="text-[10px] text-gray-400 font-light">Configure LLM planners for browser automation.</p>
        </div>
        <button
          onClick={checkProviders}
          disabled={checking}
          className="hallmark-button text-[10px] px-2.5 py-1 font-mono uppercase text-gray-300 hover:text-white"
        >
          {checking ? "Testing..." : "Test Providers"}
        </button>
      </div>

      {/* Active Banner */}
      <div className="hallmark-card p-3 border-emerald-500/20 bg-emerald-500/5 font-mono text-xs">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-gray-400 uppercase tracking-widest">Active Planner</span>
          <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-400 text-black font-semibold uppercase">
            {activeProvider ? activeProvider.name : "None Available"}
          </span>
        </div>
        {activeProvider && (
          <p className="text-[10px] text-gray-300 mt-1 font-light">
            Model: <span className="font-mono text-white">{activeProvider.model}</span> ({activeProvider.latencyMs.toFixed(0)}ms)
          </p>
        )}
      </div>

      {/* Providers List */}
      <div className="space-y-2">
        {(Object.keys(PROVIDER_INFO) as ProviderID[]).map((id) => {
          const info = PROVIDER_INFO[id];
          const config = configs[id];
          const status = statuses.find((s) => s.id === id);
          const isExpanded = expandedId === id;

          return (
            <div key={id} className="hallmark-card overflow-hidden">
              <button
                onClick={() => setExpandedId(isExpanded ? null : id)}
                className="w-full flex items-center justify-between p-3 text-left hover:bg-[#141722] transition-colors"
              >
                <div className="flex items-center gap-2 font-mono">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      status?.available
                        ? "bg-emerald-400"
                        : config.enabled
                          ? "bg-amber-400"
                          : "bg-gray-600"
                    }`}
                  />
                  <div>
                    <span className="text-xs font-semibold text-gray-200">{info.name}</span>
                    <span className="text-[10px] text-gray-500 ml-2">
                      {config.model || info.defaultModel}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {config.enabled && (
                    <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700">
                      Enabled
                    </span>
                  )}
                  <span className="text-gray-500 text-xs font-mono">{isExpanded ? "▲" : "▼"}</span>
                </div>
              </button>

              {isExpanded && (
                <div className="p-3 space-y-3 border-t border-[#1e2233] bg-[#0f1118] font-sans">
                  <p className="text-[11px] text-gray-400 font-light">{info.description}</p>

                  <div className="flex items-center justify-between font-mono text-xs">
                    <span className="text-gray-400 uppercase text-[10px]">Enable Provider</span>
                    <button
                      onClick={() => saveConfig(id, { enabled: !config.enabled })}
                      className={`w-9 h-5 rounded-full transition-colors relative ${
                        config.enabled ? "bg-emerald-500" : "bg-gray-700"
                      }`}
                    >
                      <div
                        className={`w-3.5 h-3.5 bg-white rounded-full transition-transform absolute top-0.75 ${
                          config.enabled ? "left-4.5" : "left-0.75"
                        }`}
                      />
                    </button>
                  </div>

                  {info.needsKey && (
                    <div className="space-y-1 font-mono">
                      <label className="text-[10px] text-gray-400 uppercase tracking-widest block">API Key</label>
                      <div className="flex gap-1.5">
                        <input
                          type="password"
                          value={config.apiKey || ""}
                          onChange={(e) => saveConfig(id, { apiKey: e.target.value })}
                          placeholder="sk-..."
                          className="flex-1 text-xs font-mono hallmark-input px-2.5 py-1 text-gray-200 focus:outline-none"
                        />
                        <a
                          href={info.setupUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hallmark-button text-[10px] px-2.5 py-1 text-gray-400 hover:text-white uppercase shrink-0"
                        >
                          Get Key ↗
                        </a>
                      </div>
                    </div>
                  )}

                  <div className="space-y-1 font-mono">
                    <label className="text-[10px] text-gray-400 uppercase tracking-widest block">Model Selection</label>
                    <select
                      value={config.model || info.defaultModel}
                      onChange={(e) => saveConfig(id, { model: e.target.value })}
                      className="w-full text-xs font-mono hallmark-input px-2.5 py-1 text-gray-200 focus:outline-none"
                    >
                      {info.models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>

                  {id === "ollama" && !status?.available && (
                    <div className="hallmark-card p-2.5 text-[10px] font-mono text-gray-400 space-y-1 bg-[#12141d]">
                      <p className="text-gray-300 font-semibold uppercase">Ollama Setup Command:</p>
                      <code className="block bg-[#090a0f] p-2 rounded text-emerald-400 text-xs">
                        ollama pull qwen2.5:1.5b
                      </code>
                    </div>
                  )}

                  {saving === id && (
                    <span className="text-[10px] font-mono text-sky-400">Saving changes...</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
