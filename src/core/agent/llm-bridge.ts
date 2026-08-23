// ============================================================
// VLESS — LLM Bridge
// Connects to local Ollama instance via WebSocket for real reasoning
// Falls back to rule-based planning when Ollama is unavailable
// ============================================================

import type { PageState, PlannedAction, AgentAction } from "../../types";

// ── Configuration ────────────────────────────────────────────

const OLLAMA_HOST = "http://localhost:11434";
const DEFAULT_MODEL = "qwen2.5:1.5b";
const REQUEST_TIMEOUT = 30_000; // 30 seconds

// ── Connection State ─────────────────────────────────────────

interface LLMState {
  connected: boolean;
  available: boolean;
  model: string | null;
  ollamaVersion: string | null;
  lastError: string | null;
}

const state: LLMState = {
  connected: false,
  available: false,
  model: null,
  ollamaVersion: null,
  lastError: null,
};

// ── Public API ───────────────────────────────────────────────

/**
 * Check if Ollama is available and responsive.
 */
export async function checkOllamaAvailability(): Promise<{
  available: boolean;
  model: string | null;
  version: string | null;
  error: string | null;
}> {
  try {
    const response = await fetch(`${OLLAMA_HOST}/api/version`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      state.available = false;
      state.lastError = `Ollama returned ${response.status}`;
      return { available: false, model: null, version: null, error: state.lastError };
    }

    const data = await response.json();
    state.available = true;
    state.connected = true;
    state.ollamaVersion = data.version || "unknown";
    state.lastError = null;

    // Check which model is available
    const modelsResponse = await fetch(`${OLLAMA_HOST}/api/tags`);
    if (modelsResponse.ok) {
      const modelsData = await modelsResponse.json();
      const models = modelsData.models || [];
      const modelNames = models.map((m: { name: string }) => m.name);

      // Prefer qwen2.5:1.5b, then any qwen, then any model
      if (modelNames.some((n: string) => n.includes("qwen2.5:1.5b"))) {
        state.model = "qwen2.5:1.5b";
      } else if (modelNames.some((n: string) => n.includes("qwen2.5:1.5b"))) {
        state.model = "qwen2.5:1.5b";
      } else if (modelNames.length > 0) {
        state.model = modelNames[0];
      }
    }

    return {
      available: true,
      model: state.model,
      version: state.ollamaVersion,
      error: null,
    };
  } catch (error) {
    state.available = false;
    state.connected = false;
    state.lastError = error instanceof Error ? error.message : "Ollama not reachable";
    return {
      available: false,
      model: null,
      version: null,
      error: state.lastError,
    };
  }
}

/**
 * Get current LLM status.
 */
export function getLLMStatus(): LLMState {
  return { ...state };
}

/**
 * Is the LLM available for use?
 */
export function isLLMAvailable(): boolean {
  return state.available && state.model !== null;
}

// ── Plan Generation with LLM ─────────────────────────────────

/**
 * Generate an action plan using the local LLM.
 * Falls back to rule-based planning if LLM is unavailable.
 */
export async function generatePlanWithLLM(
  taskDescription: string,
  pageState: PageState,
  dataContext?: Record<string, string>
): Promise<{
  steps: PlannedAction[];
  reasoning: string;
  usedLLM: boolean;
}> {
  if (!isLLMAvailable()) {
    return {
      steps: [],
      reasoning: "LLM unavailable — falling back to rule-based planning",
      usedLLM: false,
    };
  }

  try {
    const prompt = buildPlanningPrompt(taskDescription, pageState, dataContext);
    const response = await callOllama(prompt);
    const parsed = parsePlanResponse(response, pageState);

    return {
      steps: parsed.steps,
      reasoning: parsed.reasoning,
      usedLLM: true,
    };
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : "LLM call failed";
    return {
      steps: [],
      reasoning: `LLM error: ${state.lastError} — falling back to rule-based`,
      usedLLM: false,
    };
  }
}

/**
 * Generate a natural language explanation of the current page state.
 */
export async function explainPageState(pageState: PageState): Promise<string> {
  if (!isLLMAvailable()) {
    return generateSimplePageSummary(pageState);
  }

  const prompt = `You are a browser automation agent. Briefly describe what you see on this webpage.
URL: ${pageState.url}
Title: ${pageState.title}
Interactive elements: ${pageState.elements.length}
Forms: ${pageState.forms.length}
${pageState.metadata.hasCAPTCHA ? "⚠️ CAPTCHA detected" : ""}
${pageState.metadata.hasPaymentForm ? "💳 Payment form detected" : ""}
Key elements: ${pageState.elements.slice(0, 10).map(e => `${e.tag}("${e.label || e.text}")`).join(", ")}

Describe the page in 2-3 sentences.`;

  try {
    return await callOllama(prompt);
  } catch {
    return generateSimplePageSummary(pageState);
  }
}

/**
 * Analyze why an action failed and suggest recovery strategies.
 */
export async function analyzeFailure(
  action: AgentAction,
  error: string,
  pageState: PageState
): Promise<{
  analysis: string;
  suggestedAction: AgentAction | null;
  confidence: number;
}> {
  if (!isLLMAvailable()) {
    return {
      analysis: `Action ${action.type} failed: ${error}`,
      suggestedAction: null,
      confidence: 0.3,
    };
  }

  const prompt = `A browser action failed. Analyze the error and suggest recovery.

Action: ${action.type} on target "${action.target || "unknown"}"
Error: ${error}
Page URL: ${pageState.url}
Available elements: ${pageState.elements.length}

Respond in JSON:
{
  "analysis": "Why it failed",
  "suggestion": { "type": "click|type|scroll|navigate|wait", "target": "alternative target if any", "value": "if typing" },
  "confidence": 0.0-1.0
}`;

  try {
    const response = await callOllama(prompt, true);
    const parsed = JSON.parse(response);
    return {
      analysis: parsed.analysis || "Unknown failure",
      suggestedAction: parsed.suggestion ? {
        id: `recovery-${Date.now()}`,
        type: parsed.suggestion.type || action.type,
        target: parsed.suggestion.target,
        value: parsed.suggestion.value,
        retries: 0,
        maxRetries: 2,
      } : null,
      confidence: parsed.confidence || 0.3,
    };
  } catch {
    return {
      analysis: `Action ${action.type} failed: ${error}`,
      suggestedAction: null,
      confidence: 0.3,
    };
  }
}

// ── Ollama API Client ────────────────────────────────────────

async function callOllama(
  prompt: string,
  jsonMode = false
): Promise<string> {
  const model = state.model || DEFAULT_MODEL;

  const body: Record<string, unknown> = {
    model,
    prompt,
    stream: false,
    options: {
      temperature: 0.3,
      num_predict: 2048,
      top_p: 0.9,
    },
  };

  if (jsonMode) {
    body.format = "json";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    return data.response || "";
  } finally {
    clearTimeout(timeout);
  }
}

// ── Prompt Engineering ───────────────────────────────────────

function buildPlanningPrompt(
  taskDescription: string,
  pageState: PageState,
  dataContext?: Record<string, string>
): string {
  const elements = pageState.elements.slice(0, 30).map((e, i) => {
    const desc = `[${i}] <${e.tag}> role="${e.role}" text="${(e.text || e.label || "").slice(0, 50)}" type="${e.type}" ${e.isDisabled ? "DISABLED" : ""}`;
    return desc;
  }).join("\n");

  const forms = pageState.forms.map(f => {
    const fields = f.fields.map(ff => {
      const val = ff.value ? "FILLED" : "EMPTY";
      const req = ff.required ? "REQUIRED" : "";
      return `  - ${ff.label || ff.name || ff.id}: ${ff.type} ${val} ${req}`;
    }).join("\n");
    return `Form ${f.id} (${f.fields.length} fields):\n${fields}`;
  }).join("\n");

  // PRIVACY: Never send dataContext values to the LLM.
  // The LLM only sees that PII fields exist (marked [PII:category]).
  // Actual values are filled locally by the client after the plan is returned.
  const piiFieldCount = dataContext ? Object.keys(dataContext).length : 0;
  const dataContextStr = piiFieldCount > 0
    ? `\nNote: ${piiFieldCount} fields require PII data (Aadhaar, phone, name, etc).\nThe client has these values locally and will fill them by index after planning.`
    : "";

  return `You are a browser automation agent. Plan actions to complete the task.

TASK: "${taskDescription}"

PAGE STATE:
URL: ${pageState.url}
Title: ${pageState.title}
Interactive elements (${pageState.elements.length} total):
${elements}

${forms ? `FORMS:\n${forms}` : "No forms detected."}
${dataContextStr}

${pageState.metadata.hasCAPTCHA ? "⚠️ CAPTCHA detected — may need user intervention." : ""}
${pageState.metadata.hasPaymentForm ? "💳 Payment form — handle with extreme caution." : ""}

Respond with a JSON action plan:
{
  "reasoning": "Your analysis of the page and approach",
  "steps": [
    {
      "index": 0,
      "action": { "type": "click|type|scroll|navigate|select|wait", "target": "element identifier", "value": "if typing or selecting" },
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
- Be precise about element targets (use IDs, labels, or text)
- For form filling, use Tab to move between fields
- Add verification for each step
- Mark high-risk actions (submit, payment, delete) for user confirmation
- Keep total steps under 20`;
}

// ── Response Parsing ─────────────────────────────────────────

function parsePlanResponse(
  response: string,
  _pageState: PageState
): { steps: PlannedAction[]; reasoning: string } {
  // Try to extract JSON from the response
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("No JSON found in LLM response");
  }

  const parsed = JSON.parse(jsonMatch[0]);

  const steps: PlannedAction[] = (parsed.steps || []).map((step: Record<string, unknown>, i: number) => {
    const action = step.action as Record<string, unknown> | undefined;
    return {
      index: i,
      action: {
        id: `llm-action-${i}`,
        type: (action?.type as string) || "wait",
        target: action?.target as string | undefined,
        value: action?.value as string | undefined,
        retries: 0,
        maxRetries: 3,
      } as AgentAction,
      reasoning: (step.reasoning as string) || "LLM planned step",
      confidence: (step.confidence as number) || 0.7,
      verification: (step.verification as string) || "Check page state",
      risk: (step.risk as "low" | "medium" | "high") || "low",
    };
  });

  return {
    steps,
    reasoning: parsed.reasoning || `LLM generated ${steps.length} steps`,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function generateSimplePageSummary(pageState: PageState): string {
  const parts = [
    `Page: ${pageState.title || "untitled"}`,
    `${pageState.elements.length} interactive elements`,
    `${pageState.forms.length} form(s)`,
  ];

  if (pageState.metadata.hasCAPTCHA) parts.push("CAPTCHA detected");
  if (pageState.metadata.hasPaymentForm) parts.push("Payment form detected");
  if (pageState.metadata.hasHoneypot) parts.push("Honeypot fields detected");

  return parts.join(". ") + ".";
}
