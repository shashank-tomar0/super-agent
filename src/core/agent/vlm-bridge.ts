// ============================================================
// VLESS — VLM Visual Context Bridge
// Sends REDACTED screenshots to multimodal LLM/VLM providers
// for visual interpretation. The server receives ONLY the sanitized
// (PII-redacted) screenshot — never the original.
//
// This satisfies the PS requirement:
// "transmission of the anonymized visual context to a centralized
// LLM/VLM, which successfully interprets the sanitized data and
// returns actionable commands."
//
// Supported providers:
//   - Ollama (llava, llava-llama3, bakllava — local, free)
//   - OpenAI GPT-4o / GPT-4o-mini (vision-capable)
//   - Claude 3.5 Haiku (vision-capable)
//   - OpenRouter (any vision model)
//
// Data flow:
//   redacted screenshot (data URL) → base64 → VLM prompt →
//   VLM interprets page layout → JSON action plan → execute
// ============================================================

import type { SanitizedContext } from "./server-bridge";
import type { PlannedAction, AgentAction } from "../../types";
import { loadProviderConfigs, type ProviderConfig, type ProviderID } from "./llm-providers";

// ── Types ────────────────────────────────────────────────────

export interface VLMRequest {
  /** Base64-encoded redacted screenshot (JPEG/PNG, no PII) */
  screenshotBase64: string;
  /** Sanitized page structure (DOM elements, forms — no PII values) */
  sanitizedContext: SanitizedContext;
  /** What the user wants to accomplish */
  taskDescription: string;
  /** Optional: user data for client-side PII fill (NEVER sent to VLM) */
  dataContext?: Record<string, string>;
}

export interface VLMResponse {
  /** Action plan from the VLM */
  steps: PlannedAction[];
  /** VLM's reasoning about what it saw */
  reasoning: string;
  /** What provider was used */
  provider: string;
  /** Latency in ms */
  latencyMs: number;
  /** Whether the VLM actually processed visual context */
  usedVisualContext: boolean;
}

// ── Vision-Capable Provider Detection ────────────────────────

/** Check if a provider config supports vision. */
function supportsVision(config: ProviderConfig): boolean {
  if (!config.enabled) return false;

  switch (config.id) {
    case "ollama": {
      // Ollama models that support vision: llava, llava-llama3, bakllava, etc.
      const visionModels = ["llava", "bakllava", "moondream", "minicpm-v", "llama3.2-vision"];
      const model = (config.model || "").toLowerCase();
      return visionModels.some((vm) => model.includes(vm));
    }
    case "openai": {
      // GPT-4o, GPT-4o-mini, GPT-4-vision all support vision
      const visionModels = ["gpt-4o", "gpt-4-vision", "gpt-4-turbo"];
      const model = (config.model || "").toLowerCase();
      return visionModels.some((vm) => model.includes(vm));
    }
    case "claude": {
      // Claude 3.5 Haiku and above support vision
      return true; // All current Claude models support vision
    }
    case "openrouter": {
      // Most models on OpenRouter that support vision pass images through
      return true; // OpenRouter handles vision routing
    }
    default:
      return false;
  }
}

// ── Prompt Construction ──────────────────────────────────────

/**
 * Build the VLM prompt for visual page interpretation.
 * The VLM receives:
 *   1. The redacted screenshot (no PII, faces blurred, passwords blacked out)
 *   2. Sanitized DOM structure (element types/labels/positions — no values)
 *   3. Task description
 *
 * It returns a JSON action plan.
 */
function buildVLMPrompt(
  taskDescription: string,
  context: SanitizedContext
): { system: string; user: string } {
  const ps = context.pageStructure;

  const elements = ps.elements
    .slice(0, 40)
    .map((e, i) => {
      return `[${i}] <${e.tag}> role="${e.role}" label="${e.label}" type="${e.type}" pos=(${Math.round(e.rect.x)},${Math.round(e.rect.y)}) size=${Math.round(e.rect.width)}x${Math.round(e.rect.height)} ${e.isDisabled ? "DISABLED" : ""}`;
    })
    .join("\n");

  const forms = ps.forms
    .map((f) => {
      const fields = f.fields
        .map((ff) => {
          const val = ff.hasValue ? "FILLED" : "EMPTY";
          const req = ff.isRequired ? "REQUIRED" : "";
          const pii = ff.piiCategory ? `[PII:${ff.piiCategory}]` : "";
          return `  - ${ff.label}: ${ff.type} ${val} ${req} ${pii}`;
        })
        .join("\n");
      return `Form ${f.id}:\n${fields}`;
    })
    .join("\n\n");

  const system = `You are VLESS, a vision-enabled browser automation agent. You can SEE the webpage through the provided screenshot.

## Your Task
Analyze the REDACTED screenshot AND the page structure to produce browser actions.

IMPORTANT: The screenshot has been sanitized for privacy:
- Faces are blurred
- Passwords and Aadhaar/PAN numbers are blacked out
- PII is masked with black boxes
You will see the PAGE LAYOUT and UI ELEMENTS but not sensitive data.

## Output Format
Respond with ONLY valid JSON. No markdown, no code fences.

{"reasoning":"<what you see on screen and your plan>","steps":[{"action":{"type":"<action_type>","target":"[<index>]","value":"<optional>"},"reasoning":"<why>","confidence":<0.0-1.0>,"risk":"<low|medium|high>"}]}

## Action Types
- **click**: Click element by index. target="[0]"
- **type**: Type into field. target="[1]", value="text"
- **select**: Choose dropdown. target="[2]", value="option"
- **scroll**: Scroll page. value="up" or "down"
- **navigate**: Go to URL. value="https://..."
- **press_key**: Press key. value="Enter" or "Tab"
- **wait**: Wait for load. value="2000"

## Rules
- Use [0], [1] etc. as targets — these are element indices
- For form filling: click field first, then type
- Fields marked [PII:category] are filled locally — reference by index only
- Use what you SEE in the screenshot to find elements, not just the text list
- Max 20 steps
- If you can't see the element in the screenshot, say so in reasoning`;

  const user = `TASK: "${taskDescription}"

The screenshot below shows the current page state (PII redacted for privacy).

PAGE STRUCTURE:
Domain: ${ps.metadata.domain}
Title: ${ps.metadata.title}
Total elements: ${ps.metadata.elementCount}

ELEMENTS (indexed):
${elements}

${forms ? `FORMS:\n${forms}` : "No forms detected."}

${ps.metadata.hasCAPTCHA ? "WARNING: CAPTCHA detected." : ""}
${ps.metadata.hasPaymentForm ? "WARNING: Payment form detected." : ""}

Privacy: ${context.redactionProof.totalPIIDetected} PII regions redacted.
Sensitive fields [PII:category] have values available locally.

Analyze the screenshot and the page structure, then generate the action plan as JSON.`;

  return { system, user };
}

// ── Provider Callers (Vision) ────────────────────────────────

async function callOllamaVision(
  config: ProviderConfig,
  system: string,
  user: string,
  imageBase64: string
): Promise<string> {
  const baseUrl = config.baseUrl || "http://localhost:11434";

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model || "llava",
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: user,
          images: [imageBase64], // Ollama accepts base64 images directly
        },
      ],
      stream: false,
      options: {
        temperature: config.temperature ?? 0.3,
        num_predict: config.maxTokens ?? 2048,
      },
    }),
    signal: AbortSignal.timeout(60000), // Vision models are slower
  });

  if (!response.ok) throw new Error(`Ollama vision ${response.status}`);
  const data = await response.json();
  return data.message?.content || "";
}

async function callOpenAIVision(
  config: ProviderConfig,
  system: string,
  user: string,
  imageBase64: string
): Promise<string> {
  if (!config.apiKey) throw new Error("OpenAI API key not configured");

  const response = await fetch(`${config.baseUrl || "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || "gpt-4o-mini",
      max_tokens: config.maxTokens || 2048,
      temperature: config.temperature ?? 0.3,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: user },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`,
                detail: "low", // Use low detail to save tokens (sufficient for layout)
              },
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI vision ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

async function callClaudeVision(
  config: ProviderConfig,
  system: string,
  user: string,
  imageBase64: string
): Promise<string> {
  if (!config.apiKey) throw new Error("Claude API key not configured");

  const response = await fetch(`${config.baseUrl || "https://api.anthropic.com"}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: config.model || "claude-3-5-haiku-20241022",
      max_tokens: config.maxTokens || 2048,
      temperature: config.temperature ?? 0.3,
      system,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: imageBase64,
              },
            },
            { type: "text", text: user },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude vision ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.content?.[0]?.text || "";
}

async function callOpenRouterVision(
  config: ProviderConfig,
  system: string,
  user: string,
  imageBase64: string
): Promise<string> {
  if (!config.apiKey) throw new Error("OpenRouter API key not configured");

  const response = await fetch(`${config.baseUrl || "https://openrouter.ai/api/v1"}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      "HTTP-Referer": "https://github.com/shashank-tomar0/super-agent",
      "X-Title": "VLESS Browser Agent",
    },
    body: JSON.stringify({
      model: config.model || "meta-llama/llama-3.2-11b-vision-instruct",
      max_tokens: config.maxTokens || 2048,
      temperature: config.temperature ?? 0.3,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: user },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`,
              },
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter vision ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

// ── Response Parsing ─────────────────────────────────────────

function parseVLMPlanResponse(response: string): {
  steps: PlannedAction[];
  reasoning: string;
} {
  const cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { steps: [], reasoning: "No JSON found in VLM response" };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const rawSteps = parsed.steps || parsed.actions || [];
    const steps: PlannedAction[] = rawSteps.map(
      (step: Record<string, unknown>, i: number) => {
        const action = (step.action || step) as Record<string, unknown>;
        let target = (action.target || action.element || "") as string;
        const bracketMatch = target.match(/\[(\d+)\]/);
        if (bracketMatch) {
          target = "[" + bracketMatch[1] + "]";
        }
        let actionType = (action.type || "wait") as string;
        if (actionType === "fill") actionType = "type";
        if (actionType === "input") actionType = "type";

        return {
          index: i,
          action: {
            id: `vlm-action-${i}`,
            type: actionType,
            target,
            value: action.value,
            retries: 0,
            maxRetries: 3,
          } as AgentAction,
          reasoning: step.reasoning || "VLM-planned step",
          confidence: (step.confidence as number) || 0.8,
          verification: "Check page state after action",
          risk: (step.risk as "low" | "medium" | "high") || "low",
        };
      }
    );
    return {
      steps,
      reasoning: parsed.reasoning || `VLM generated ${steps.length} steps`,
    };
  } catch {
    return { steps: [], reasoning: "Failed to parse VLM response" };
  }
}

// ── Main API ─────────────────────────────────────────────────

/**
 * Send a redacted screenshot to the best available VLM for visual interpretation.
 *
 * Flow:
 *   1. Find best vision-capable provider
 *   2. Send redacted screenshot + sanitized DOM context
 *   3. VLM interprets the visual layout
 *   4. Parse response into action plan
 *   5. Return plan (PII values filled locally by client)
 *
 * Privacy guarantee: Only the REDACTED screenshot leaves the device.
 * Original screenshot, PII values, faces, passwords never leave.
 */
export async function generatePlanWithVLM(
  request: VLMRequest
): Promise<VLMResponse> {
  const startTime = performance.now();
  const configs = await loadProviderConfigs();

  // Try providers in priority order (cloud first for best vision quality)
  const priority: ProviderID[] = ["openai", "claude", "openrouter", "ollama"];

  for (const id of priority) {
    const config = configs[id];
    if (!supportsVision(config)) continue;

    try {
      const { system, user } = buildVLMPrompt(
        request.taskDescription,
        request.sanitizedContext
      );

      let response: string;
      switch (id) {
        case "ollama":
          response = await callOllamaVision(config, system, user, request.screenshotBase64);
          break;
        case "openai":
          response = await callOpenAIVision(config, system, user, request.screenshotBase64);
          break;
        case "claude":
          response = await callClaudeVision(config, system, user, request.screenshotBase64);
          break;
        case "openrouter":
          response = await callOpenRouterVision(config, system, user, request.screenshotBase64);
          break;
        default:
          continue;
      }

      const parsed = parseVLMPlanResponse(response);

      return {
        steps: parsed.steps,
        reasoning: parsed.reasoning,
        provider: `${id}/${config.model}`,
        latencyMs: performance.now() - startTime,
        usedVisualContext: true,
      };
    } catch (err) {
      console.warn(`[VLESS] VLM provider ${id} failed:`, err);
      // Continue to next provider
    }
  }

  return {
    steps: [],
    reasoning: "No vision-capable provider available",
    provider: "none",
    latencyMs: performance.now() - startTime,
    usedVisualContext: false,
  };
}

/**
 * Convert a screenshot data URL to base64 for VLM transmission.
 * Strips the data URL prefix (data:image/png;base64,...).
 */
export function dataURLToBase64(dataURL: string): string {
  const commaIndex = dataURL.indexOf(",");
  if (commaIndex === -1) return dataURL;
  return dataURL.substring(commaIndex + 1);
}

/**
 * Check if any vision-capable provider is available.
 */
export async function isVLMAvailable(): Promise<boolean> {
  const configs = await loadProviderConfigs();
  return priority.some((id) => supportsVision(configs[id]));
}

const priority: ProviderID[] = ["openai", "claude", "openrouter", "ollama"];
