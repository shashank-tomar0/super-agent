import { useState, useEffect, useCallback } from "react";
import {
  loadProviderConfigs,
  saveProviderConfigs,
} from "../../core/agent/llm-providers";

// ── Types ────────────────────────────────────────────────────

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

// ── Provider Defaults ────────────────────────────────────────

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
    description: "Free, runs on your machine. No API key needed.",
    defaultModel: "qwen2.5:1.5b",
    needsKey: false,
    setupUrl: "https://ollama.ai/download",
    models: ["qwen2.5:1.5b", "qwen2.5:3b", "gemma2:2b", "phi3.5-mini", "llama3.2:1b"],
  },
  claude: {
    name: "Claude (Anthropic)",
    description: "Best reasoning. Pay per token.",
    defaultModel: "claude-3-5-haiku-20241022",
    needsKey: true,
    setupUrl: "https://console.anthropic.com/settings/keys",
    models: ["claude-3-5-haiku-20241022", "claude-3-haiku-20240307", "claude-3-opus-20240229"],
  },
  openai: {
    name: "OpenAI (GPT)",
    description: "Fast, widely supported. Pay per token.",
    defaultModel: "gpt-4o-mini",
    needsKey: true,
    setupUrl: "https://platform.openai.com/api-keys",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"],
  },
  openrouter: {
    name: "OpenRouter",
    description: "Access 100+ models via one API key.",
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

// ── Component ────────────────────────────────────────────────

export function ProviderSettings() {
  const [configs, setConfigs] = useState<Record<ProviderID, ProviderConfig> | null>(null);
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [expandedId, setExpandedId] = useState<ProviderID | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  // Load configs.
  // Goes through the shared loader so keys are decrypted from local
  // storage with the device key — the component must not read raw
  // storage, or it would resurrect the plaintext path.
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

  // Check providers
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
      // Fallback: check Ollama directly
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
            error: "Not running — start Ollama",
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

  // Save config
  const saveConfig = useCallback(
    async (id: ProviderID, updates: Partial<ProviderConfig>) => {
      if (!configs) return;
      setSaving(id);
      const newConfigs = {
        ...configs,
        [id]: { ...configs[id], ...updates },
      };
      setConfigs(newConfigs);
      // Shared saver: encrypts apiKey with the device key before writing.
      await saveProviderConfigs(newConfigs);
      // Re-check after saving
      setTimeout(() => checkProviders(), 500);
      setSaving(null);
    },
    [configs, checkProviders]
  );

  if (!configs) {
    return (
      <div className="p-4 text-center text-gray-500 text-sm">Loading...</div>
    );
  }

  // Find active provider
  const activeProvider = statuses.find((s) => s.available);

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white">AI Providers</h2>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Configure which LLM powers the agent
          </p>
        </div>
        <button
          onClick={checkProviders}
          disabled={checking}
          className="text-[11px] px-2 py-1 bg-gray-800 text-gray-400 hover:bg-gray-700 rounded transition-colors disabled:opacity-50"
        >
          {checking ? "Checking..." : "Refresh"}
        </button>
      </div>

      {/* Active Provider Badge */}
      {activeProvider && (
        <div className="bg-green-900/30 border border-green-800/50 rounded-lg p-3">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
            <span className="text-xs text-green-300 font-medium">
              Active: {activeProvider.name}
            </span>
            <span className="text-[10px] text-green-500">
              {activeProvider.model}
            </span>
          </div>
        </div>
      )}

      {/* Provider List */}
      <div className="space-y-2">
        {(Object.keys(PROVIDER_INFO) as ProviderID[]).map((id) => {
          const info = PROVIDER_INFO[id];
          const config = configs[id];
          const status = statuses.find((s) => s.id === id);
          const isExpanded = expandedId === id;

          return (
            <div
              key={id}
              className={`border rounded-lg transition-colors ${
                status?.available
                  ? "border-green-800/50 bg-green-950/20"
                  : "border-gray-800 bg-gray-900"
              }`}
            >
              {/* Provider Header */}
              <button
                onClick={() => setExpandedId(isExpanded ? null : id)}
                className="w-full flex items-center justify-between p-3 text-left"
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`w-2 h-2 rounded-full ${
                      status?.available
                        ? "bg-green-400"
                        : config.enabled
                          ? "bg-yellow-400"
                          : "bg-gray-600"
                    }`}
                  />
                  <div>
                    <span className="text-xs font-medium text-white">
                      {info.name}
                    </span>
                    <span className="text-[10px] text-gray-500 ml-2">
                      {config.model || info.defaultModel}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {config.enabled && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-gray-800 text-gray-400 rounded">
                      ON
                    </span>
                  )}
                  <span className="text-gray-500 text-xs">
                    {isExpanded ? "^" : "v"}
                  </span>
                </div>
              </button>

              {/* Expanded Config */}
              {isExpanded && (
                <div className="px-3 pb-3 space-y-3 border-t border-gray-800">
                  <p className="text-[11px] text-gray-500 mt-2">
                    {info.description}
                  </p>

                  {/* Enable Toggle */}
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-gray-400">Enabled</span>
                    <button
                      onClick={() => saveConfig(id, { enabled: !config.enabled })}
                      className={`w-10 h-5 rounded-full transition-colors ${
                        config.enabled ? "bg-green-600" : "bg-gray-700"
                      }`}
                    >
                      <div
                        className={`w-4 h-4 bg-white rounded-full transition-transform ${
                          config.enabled ? "translate-x-5" : "translate-x-0.5"
                        }`}
                      />
                    </button>
                  </div>

                  {/* API Key (for cloud providers) */}
                  {info.needsKey && (
                    <div>
                      <label className="text-[11px] text-gray-400 block mb-1">
                        API Key
                      </label>
                      <div className="flex gap-1">
                        <input
                          type="password"
                          value={config.apiKey || ""}
                          onChange={(e) =>
                            saveConfig(id, { apiKey: e.target.value })
                          }
                          placeholder="sk-..."
                          className="flex-1 text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200 focus:border-blue-500 focus:outline-none"
                        />
                        <a
                          href={info.setupUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] px-2 py-1 bg-gray-800 text-gray-400 hover:text-gray-200 rounded whitespace-nowrap"
                        >
                          Get Key
                        </a>
                      </div>
                    </div>
                  )}

                  {/* Model Selection */}
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">
                      Model
                    </label>
                    <select
                      value={config.model || info.defaultModel}
                      onChange={(e) => saveConfig(id, { model: e.target.value })}
                      className="w-full text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200 focus:border-blue-500 focus:outline-none"
                    >
                      {info.models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Base URL (for custom endpoints) */}
                  {config.baseUrl && (
                    <div>
                      <label className="text-[11px] text-gray-400 block mb-1">
                        Base URL
                      </label>
                      <input
                        type="text"
                        value={config.baseUrl}
                        onChange={(e) => saveConfig(id, { baseUrl: e.target.value })}
                        className="w-full text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200 focus:border-blue-500 focus:outline-none font-mono"
                      />
                    </div>
                  )}

                  {/* Status */}
                  {status && (
                    <div className="text-[10px] text-gray-500">
                      {status.available ? (
                        <span className="text-green-500">
                          Connected ({status.latencyMs.toFixed(0)}ms)
                        </span>
                      ) : (
                        <span className="text-red-400">
                          {status.error || "Not available"}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Setup Instructions for Ollama */}
                  {id === "ollama" && !status?.available && (
                    <div className="bg-gray-800/50 rounded p-2 text-[10px] text-gray-400 space-y-1">
                      <p className="font-medium text-gray-300">Quick setup:</p>
                      <code className="block bg-gray-900 rounded p-1.5 font-mono text-green-400">
                        ollama pull qwen2.5:1.5b
                      </code>
                      <p>
                        Download Ollama:{" "}
                        <a
                          href={info.setupUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:underline"
                        >
                          ollama.ai/download
                        </a>
                      </p>
                    </div>
                  )}

                  {saving === id && (
                    <span className="text-[10px] text-blue-400">Saving...</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Priority Order */}
      <div className="text-[10px] text-gray-600 space-y-1">
        <p>Priority: a configured cloud provider (Claude &gt; OpenAI &gt; OpenRouter) is used first; Ollama (local) is the fallback. With no cloud key set, everything stays local (Ollama first).</p>
        <p>The first available provider is used automatically.</p>
      </div>
    </div>
  );
}
