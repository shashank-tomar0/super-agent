// ============================================================
// VLESS — Server Communication Layer
// Sends sanitized context to LLM/VLM, receives action plan
//
// Supports:
// - Ollama (local, offline, default)
// - Cloud API proxy (Claude, GPT — via local proxy server)
// - Fallback chain: Ollama → Cloud → Rule-based
//
// The server NEVER sees raw screenshots or PII.
// Only sanitized structural metadata is transmitted.
// ============================================================

import type { PlannedAction, AgentAction } from "../../types";

// ── Configuration ────────────────────────────────────────────

const OLLAMA_HOST = "http://localhost:11434";
const CLOUD_PROXY_HOST = "http://localhost:3000"; // Optional companion server
const REQUEST_TIMEOUT = 30_000;

// ── Server Provider Interface ────────────────────────────────

export interface ServerProvider {
  name: string;
  available: boolean;
  model: string | null;
  check(): Promise<boolean>;
  generatePlan(
    taskDescription: string,
    sanitizedContext: SanitizedContext,
    dataContext?: Record<string, string>
  ): Promise<PlanResult>;
  explainPage(context: SanitizedContext): Promise<string>;
}

export interface SanitizedContext {
  // What we send (ALL safe — no PII, no raw screenshots)
  pageStructure: {
    elements: Array<{
      tag: string;
      role: string;
      label: string;
      type: string;
      rect: { x: number; y: number; width: number; height: number };
      isVisible: boolean;
      isDisabled: boolean;
    }>;
    forms: Array<{
      id: string;
      fields: Array<{
        label: string;
        type: string;
        hasValue: boolean;
        isRequired: boolean;
        piiCategory: string | null;
      }>;
    }>;
    safeTextContent: string; // PII values replaced with ***
    metadata: {
      title: string;
      domain: string; // Domain only, no path/query
      hasForm: boolean;
      hasCAPTCHA: boolean;
      hasPaymentForm: boolean;
      elementCount: number;
    };
  };
  // Redaction proof (for privacy audit)
  redactionProof: {
    totalPIIDetected: number;
    categoriesDetected: string[];
    redactionMethods: string[];
    confidenceScore: number;
  };
  // Task context
  taskDescription: string;
  // NOTE: dataContext (raw PII values) is NEVER included here.
  // PII values are filled locally by the client after the plan is returned.
}

export interface PlanResult {
  success: boolean;
  steps: PlannedAction[];
  reasoning: string;
  provider: string;
  latencyMs: number;
  error?: string;
}

// ── Ollama Provider ──────────────────────────────────────────

class OllamaProvider implements ServerProvider {
  name = "ollama";
  available = false;
  model: string | null = null;

  async check(): Promise<boolean> {
    try {
      const response = await fetch(`${OLLAMA_HOST}/api/version`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return false;

      await response.json();
      this.available = true;

      // Detect available model
      const modelsResponse = await fetch(`${OLLAMA_HOST}/api/tags`);
      if (modelsResponse.ok) {
        const modelsData = await modelsResponse.json();
        const modelNames = (modelsData.models || []).map((m: { name: string }) => m.name);

        if (modelNames.some((n: string) => n.includes("qwen2.5:1.5b"))) {
          this.model = "qwen2.5:1.5b";
        } else if (modelNames.some((n: string) => n.includes("qwen2.5"))) {
          this.model = modelNames.find((n: string) => n.includes("qwen2.5"));
        } else if (modelNames.length > 0) {
          this.model = modelNames[0];
        }
      }

      return true;
    } catch {
      this.available = false;
      return false;
    }
  }

  async generatePlan(
    taskDescription: string,
    sanitizedContext: SanitizedContext,
    _dataContext?: Record<string, string> // PRIVACY: not sent to server; filled locally by client
  ): Promise<PlanResult> {
    const startTime = performance.now();

    if (!this.available || !this.model) {
      return {
        success: false,
        steps: [],
        reasoning: "Ollama not available",
        provider: this.name,
        latencyMs: 0,
        error: "Ollama not running or no model loaded",
      };
    }

    try {
      const prompt = buildPlanningPrompt(taskDescription, sanitizedContext, _dataContext);
      const response = await this.callOllama(prompt, false);
      const parsed = parsePlanResponse(response);

      return {
        success: true,
        steps: parsed.steps,
        reasoning: parsed.reasoning,
        provider: this.name,
        latencyMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        steps: [],
        reasoning: "",
        provider: this.name,
        latencyMs: performance.now() - startTime,
        error: error instanceof Error ? error.message : "Ollama call failed",
      };
    }
  }

  async explainPage(context: SanitizedContext): Promise<string> {
    if (!this.available || !this.model) return "";

    const prompt = `Describe this webpage briefly in 2-3 sentences.
URL domain: ${context.pageStructure.metadata.domain}
Title: ${context.pageStructure.metadata.title}
Elements: ${context.pageStructure.metadata.elementCount}
Forms: ${context.pageStructure.forms.length}
${context.pageStructure.metadata.hasCAPTCHA ? "CAPTCHA detected." : ""}`;

    try {
      return await this.callOllama(prompt, false);
    } catch {
      return "";
    }
  }

  private async callOllama(prompt: string, _jsonMode = false): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          options: {
            temperature: 0.3,
            num_predict: 2048,
            top_p: 0.9,
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`Ollama ${response.status}`);
      const data = await response.json();
      return data.response || "";
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── Cloud Proxy Provider ─────────────────────────────────────

class CloudProxyProvider implements ServerProvider {
  name = "cloud";
  available = false;
  model: string | null = null;

  async check(): Promise<boolean> {
    try {
      const response = await fetch(`${CLOUD_PROXY_HOST}/api/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        const data = await response.json();
        this.available = true;
        this.model = data.model || "unknown";
        return true;
      }
    } catch {
      // Cloud proxy not running
    }
    this.available = false;
    return false;
  }

  async generatePlan(
    taskDescription: string,
    sanitizedContext: SanitizedContext,
    _dataContext?: Record<string, string> // PRIVACY: not sent to server; filled locally by client
  ): Promise<PlanResult> {
    const startTime = performance.now();

    if (!this.available) {
      return {
        success: false,
        steps: [],
        reasoning: "Cloud proxy not available",
        provider: this.name,
        latencyMs: 0,
        error: "Cloud proxy server not running",
      };
    }

    try {
      const response = await fetch(`${CLOUD_PROXY_HOST}/api/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: taskDescription,
          context: sanitizedContext,
          // PRIVACY: Never send dataContext (PII values) to any server.
          // PII is filled locally by the client after the plan is returned.
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });

      if (!response.ok) throw new Error(`Cloud ${response.status}`);
      const data = await response.json();

      return {
        success: true,
        steps: data.steps || [],
        reasoning: data.reasoning || "",
        provider: this.name,
        latencyMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        steps: [],
        reasoning: "",
        provider: this.name,
        latencyMs: performance.now() - startTime,
        error: error instanceof Error ? error.message : "Cloud call failed",
      };
    }
  }

  async explainPage(_context: SanitizedContext): Promise<string> {
    // Cloud provider can explain pages
    return "";
  }
}

// ── Server Manager ───────────────────────────────────────────

class ServerManager {
  private providers: ServerProvider[] = [
    new OllamaProvider(),
    new CloudProxyProvider(),
  ];
  private activeProvider: ServerProvider | null = null;

  /**
   * Auto-detect the best available provider.
   * Falls back through: Ollama → Cloud → null
   */
  async initialize(): Promise<ServerProvider | null> {
    for (const provider of this.providers) {
      const available = await provider.check();
      if (available) {
        this.activeProvider = provider;
        console.log(`🐾 [ServerManager] Using ${provider.name} (${provider.model})`);
        return provider;
      }
    }
    console.log("🐾 [ServerManager] No server available — using rule-based fallback");
    return null;
  }

  getProvider(): ServerProvider | null {
    return this.activeProvider;
  }

  isAvailable(): boolean {
    return this.activeProvider?.available ?? false;
  }

  /**
   * Generate an action plan using the best available server.
   */
  async generatePlan(
    taskDescription: string,
    sanitizedContext: SanitizedContext,
    _dataContext?: Record<string, string> // PRIVACY: not sent to server; filled locally by client
  ): Promise<PlanResult> {
    if (!this.activeProvider) {
      return {
        success: false,
        steps: [],
        reasoning: "No server available",
        provider: "none",
        latencyMs: 0,
        error: "No LLM server detected. Install Ollama or start cloud proxy.",
      };
    }

    return this.activeProvider.generatePlan(taskDescription, sanitizedContext, _dataContext);
  }
}

// ── Prompt Engineering ───────────────────────────────────────

function buildPlanningPrompt(
  taskDescription: string,
  context: SanitizedContext,
  dataContext?: Record<string, string>
): string {
  const ps = context.pageStructure;

  const elements = ps.elements.slice(0, 30).map((e, i) => {
    return `[${i}] <${e.tag}> role="${e.role}" label="${e.label}" type="${e.type}" ${e.isDisabled ? "DISABLED" : ""}`;
  }).join("\n");

  const forms = ps.forms.map((f) => {
    const fields = f.fields.map((ff) => {
      const val = ff.hasValue ? "FILLED" : "EMPTY";
      const req = ff.isRequired ? "REQUIRED" : "";
      const pii = ff.piiCategory ? `[PII:${ff.piiCategory}]` : "";
      return `  - ${ff.label}: ${ff.type} ${val} ${req} ${pii}`;
    }).join("\n");
    return `Form ${f.id}:\n${fields}`;
  }).join("\n\n");

  // PRIVACY: Never send dataContext values to the LLM.
  // The LLM only sees that PII fields exist (marked [PII:category]).
  // Actual values are filled locally by the client after the plan is returned.
  const piiFieldCount = dataContext ? Object.keys(dataContext).length : 0;
  const dataStr = piiFieldCount > 0
    ? `\nNote: ${piiFieldCount} fields require user data (filled client-side, not in prompt).\nFields marked [PII:category] have values available locally — use their index for type actions.`
    : "";

  return `You are a browser automation agent. Plan actions to complete the task.

TASK: "${taskDescription}"

PAGE STATE (sanitized — no PII):
Domain: ${ps.metadata.domain}
Title: ${ps.metadata.title}
Elements (${ps.metadata.elementCount} total):
${elements}

${forms ? `FORMS:\n${forms}` : "No forms detected."}
${dataStr}

${ps.metadata.hasCAPTCHA ? "WARNING: CAPTCHA detected — may need user intervention." : ""}
${ps.metadata.hasPaymentForm ? "WARNING: Payment form — handle with extreme caution." : ""}

Privacy note: This page has ${context.redactionProof.totalPIIDetected} PII regions detected and redacted.
Sensitive fields are marked [PII:category] — do NOT ask for their values.

Respond with a JSON action plan:
{
  "reasoning": "Your analysis of the page and approach",
  "steps": [
    {
      "index": 0,
      "action": { "type": "click|type|scroll|navigate|select|wait", "target": "element label or identifier", "value": "if typing or selecting" },
      "reasoning": "Why this step",
      "confidence": 0.0-1.0,
      "risk": "low|medium|high",
      "verification": "How to verify this worked"
    }
  ],
  "riskLevel": "low|medium|high",
  "requiresConfirmation": false
}

Rules:
- Be precise about element targets (use labels, text, or IDs)
- For form filling, use Tab to move between fields
- Mark high-risk actions (submit, payment, delete) for user confirmation
- Don't ask for PII values — the client has them locally
- Keep total steps under 20`;
}

// ── Response Parsing ─────────────────────────────────────────

function parsePlanResponse(response: string): {
  steps: PlannedAction[];
  reasoning: string;
} {
  // Try to extract JSON from the response
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { steps: [], reasoning: "No JSON found in response" };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    const steps: PlannedAction[] = (parsed.steps || []).map(
      (step: Record<string, unknown>, i: number) => {
        const action = step.action as Record<string, unknown> | undefined;
        return {
          index: i,
          action: {
            id: `server-action-${i}`,
            type: (action?.type as string) || "wait",
            target: action?.target as string | undefined,
            value: action?.value as string | undefined,
            retries: 0,
            maxRetries: 3,
          } as AgentAction,
          reasoning: (step.reasoning as string) || "Server-planned step",
          confidence: (step.confidence as number) || 0.7,
          verification: (step.verification as string) || "Check page state",
          risk: (step.risk as "low" | "medium" | "high") || "low",
        };
      }
    );

    return {
      steps,
      reasoning: parsed.reasoning || `Generated ${steps.length} steps`,
    };
  } catch {
    return { steps: [], reasoning: "Failed to parse server response" };
  }
}

// ── Singleton ────────────────────────────────────────────────

let instance: ServerManager | null = null;

export function getServerManager(): ServerManager {
  if (!instance) {
    instance = new ServerManager();
  }
  return instance;
}

/**
 * Initialize server connections. Returns the active provider or null.
 */
export async function initializeServer(): Promise<ServerProvider | null> {
  return getServerManager().initialize();
}

/**
 * Check if any server is available.
 */
export function isServerAvailable(): boolean {
  return getServerManager().isAvailable();
}

/**
 * Get the current server provider.
 */
export function getActiveProvider(): ServerProvider | null {
  return getServerManager().getProvider();
}
