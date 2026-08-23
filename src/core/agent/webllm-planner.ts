// ============================================================
// VLESS — WebLLM On-Device Planner
// Runs Llama-3.2-1B via @mlc-ai/web-llm in the offscreen document.
// Fully offline — no network required. WebGPU acceleration.
//
// This is the "100% offline" planning path:
//   WebLLM (WebGPU) → Ollama (CPU) → deterministic → rule-based
//
// Usage: called from the offscreen document via the RPC bus.
// ============================================================

import type { SanitizedContext, PlanResult } from "./server-bridge";
import type { PlannedAction } from "../../types";

// ── Lazy Model Singleton ────────────────────────────────────

let engine: any = null;
let modelLoading = false;
let modelReady = false;

const MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const LOAD_TIMEOUT_MS = 60_000;

/**
 * Ensure the WebLLM engine is loaded.
 * Returns true if ready, false if WebGPU unavailable or model failed.
 */
export async function ensureWebLLM(): Promise<boolean> {
  if (modelReady && engine) return true;
  if (modelLoading) return false;

  try {
    modelLoading = true;

    // Dynamic import — only loaded when needed (offscreen doc only)
    const webllm = await import("@mlc-ai/web-llm");

    // Check WebGPU availability
    if (!(navigator as any).gpu) {
      console.warn("[VLESS] WebLLM: WebGPU not available");
      return false;
    }

    engine = new (webllm as any).ChatCompletionPipeline();

    await Promise.race([
      engine.reload(MODEL_ID, {
        logLevel: "SILENT",
        // @ts-ignore — progress callback
        progressCallback: (step: number, total: number) => {
          if (step % 50 === 0) {
            console.log(`[VLESS] WebLLM loading: ${step}/${total}`);
          }
        },
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("WebLLM load timeout")), LOAD_TIMEOUT_MS)
      ),
    ]);

    modelReady = true;
    console.log("[VLESS] WebLLM ready: Llama-3.2-1B loaded");
    return true;
  } catch (err) {
    console.warn("[VLESS] WebLLM failed to load:", err);
    engine = null;
    modelReady = false;
    return false;
  } finally {
    modelLoading = false;
  }
}

/**
 * Check if WebLLM is available without triggering a load.
 */
export function isWebLLMReady(): boolean {
  return modelReady && engine !== null;
}

/**
 * Generate a plan using WebLLM.
 * Must be called from the offscreen document (has WebGPU).
 */
export async function planWithWebLLM(
  taskDescription: string,
  context: SanitizedContext,
  _dataContext?: Record<string, string>
): Promise<PlanResult> {
  const startTime = performance.now();

  if (!(await ensureWebLLM())) {
    return {
      success: false,
      steps: [],
      reasoning: "WebLLM not available",
      provider: "webllm",
      latencyMs: 0,
      error: "WebGPU not available or model failed to load",
    };
  }

  try {
    const ps = context.pageStructure;

    const elements = ps.elements
      .slice(0, 30)
      .map((e, i) => {
        return `[${i}] <${e.tag}> role="${e.role}" label="${e.label}" type="${e.type}" ${e.isDisabled ? "DISABLED" : ""}`;
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

    const prompt = `You are a browser automation agent. Analyze the page and produce an action plan.

TASK: "${taskDescription}"

PAGE STATE:
Domain: ${ps.metadata.domain}
Title: ${ps.metadata.title}
Elements (${ps.metadata.elementCount} total):
${elements}

${forms ? `FORMS:\n${forms}` : "No forms detected."}

${ps.metadata.hasCAPTCHA ? "WARNING: CAPTCHA detected." : ""}

Rules:
- Use [0], [1] etc. as element indices
- For form filling: click first, then type
- Fields marked [PII:category] are filled locally — reference by index only
- Max 15 steps

Respond with ONLY valid JSON:
{"reasoning":"<analysis>","steps":[{"action":{"type":"click|type|scroll|select|wait|press_key","target":"[<index>]","value":"<optional>"},"reasoning":"<why>","confidence":0.9,"risk":"low"}]}`;

    const response = await engine.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 2048,
    });

    const text = response.choices?.[0]?.message?.content || "";
    const parsed = parsePlanResponse(text);

    return {
      success: parsed.steps.length > 0,
      steps: parsed.steps,
      reasoning: parsed.reasoning,
      provider: "webllm/Llama-3.2-1B",
      latencyMs: performance.now() - startTime,
    };
  } catch (err) {
    console.warn("[VLESS] WebLLM planning failed:", err);
    return {
      success: false,
      steps: [],
      reasoning: "",
      provider: "webllm",
      latencyMs: performance.now() - startTime,
      error: err instanceof Error ? err.message : "WebLLM planning failed",
    };
  }
}

// ── Response Parsing ────────────────────────────────────────

function parsePlanResponse(response: string): {
  steps: PlannedAction[];
  reasoning: string;
} {
  const cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { steps: [], reasoning: "No JSON found in WebLLM response" };
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
            id: `webllm-action-${i}`,
            type: actionType,
            target,
            value: action.value,
            retries: 0,
            maxRetries: 3,
          },
          reasoning: step.reasoning || "WebLLM-planned step",
          confidence: (step.confidence as number) || 0.8,
          verification: "Check page state after action",
          risk: (step.risk as "low" | "medium" | "high") || "low",
        };
      }
    );
    return {
      steps,
      reasoning: parsed.reasoning || `WebLLM generated ${steps.length} steps`,
    };
  } catch {
    return { steps: [], reasoning: "Failed to parse WebLLM response" };
  }
}
