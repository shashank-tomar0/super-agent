// ============================================================
// VLESS Companion Server
// Accepts sanitized page context from the extension,
// runs LLM inference, returns action plans.
//
// Usage:
//   node server/index.js
//   # or
//   npx tsx server/index.js
//
// The server never sees raw screenshots or PII.
// Only sanitized DOM metadata is transmitted.
// ============================================================

const http = require("http");
const https = require("https");

// ── Configuration ────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const CLOUD_API_KEY = process.env.CLOUD_API_KEY || "";
const CLOUD_API_MODEL = process.env.CLOUD_API_MODEL || "claude-sonnet-4-20250514";

// ── Server ───────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS headers — restrict to extension origin only
  const allowedOrigin = req.headers.origin || "";
  const isExtension = allowedOrigin.startsWith("chrome-extension://") ||
    allowedOrigin.startsWith("moz-extension://") ||
    allowedOrigin === ""; // Allow non-browser clients (e.g. curl, tests)
  res.setHeader("Access-Control-Allow-Origin", isExtension ? allowedOrigin : "http://localhost:3000");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check
  if (url.pathname === "/api/health" && req.method === "GET") {
    const ollamaAvailable = await checkOllama();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      ollama: ollamaAvailable,
      cloud: !!CLOUD_API_KEY,
      timestamp: Date.now(),
    }));
    return;
  }

  // Plan generation
  if (url.pathname === "/api/plan" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const { task, context, data } = JSON.parse(body);

    console.log(`[VLESS] Plan request: "${task}"`);
    console.log(`[VLESS] Context domain: ${context?.pageStructure?.metadata?.domain || "unknown"}`);
    console.log(`[VLESS] PII redacted: ${context?.redactionProof?.totalPIIDetected || 0} regions`);

    // Server-side PII defense-in-depth: scan incoming context for any leaked PII
    const contextStr = JSON.stringify(context || {});
    const serverSidePIIPatterns = [
      /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, // Aadhaar
      /\b[A-Z]{5}\d{4}[A-Z]\b/,              // PAN
      /\b[6-9]\d{9}\b/,                        // Indian phone
    ];
    for (const pattern of serverSidePIIPatterns) {
      if (pattern.test(contextStr)) {
        console.warn("[VLESS] ⚠️ SERVER-SIDE PII DETECTION: Leaked PII found in incoming context. Blocking.");
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "PII detected in context — request blocked by server-side privacy scan" }));
        return;
      }
    }

      // Try Ollama first, then cloud API
      let result;
      if (await checkOllama()) {
        result = await planWithOllama(task, context, data);
      } else if (CLOUD_API_KEY) {
        result = await planWithCloud(task, context, data);
      } else {
        result = { steps: [], reasoning: "No LLM available", provider: "none" };
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error("[VLESS] Plan error:", error.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // Page explanation
  if (url.pathname === "/api/explain" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const { context } = JSON.parse(body);

      let explanation = "";
      if (await checkOllama()) {
        explanation = await explainWithOllama(context);
      } else if (CLOUD_API_KEY) {
        explanation = await explainWithCloud(context);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ explanation }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// ── Ollama Integration ───────────────────────────────────────

async function checkOllama() {
  try {
    const response = await fetch(`${OLLAMA_HOST}/api/version`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function planWithOllama(task, context, data) {
  const prompt = buildPlanningPrompt(task, context, data);

  const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen2.5:1.5b",
      prompt,
      stream: false,
      options: { temperature: 0.3, num_predict: 2048 },
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) throw new Error(`Ollama ${response.status}`);
  const result = await response.json();
  return parsePlanResponse(result.response || "", "ollama");
}

async function explainWithOllama(context) {
  const ps = context?.pageStructure;
  const prompt = `Describe this webpage briefly in 2-3 sentences.
Domain: ${ps?.metadata?.domain || "unknown"}
Title: ${ps?.metadata?.title || "unknown"}
Elements: ${ps?.metadata?.elementCount || 0}
Forms: ${ps?.forms?.length || 0}`;

  const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen2.5:1.5b",
      prompt,
      stream: false,
      options: { temperature: 0.3, num_predict: 512 },
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) return "";
  const result = await response.json();
  return result.response || "";
}

// ── Cloud API Integration ────────────────────────────────────

async function planWithCloud(task, context, data) {
  const prompt = buildPlanningPrompt(task, context, data);

  const url = new URL("https://api.anthropic.com/v1/messages");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CLOUD_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLOUD_API_MODEL,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) throw new Error(`Cloud API ${response.status}`);
  const result = await response.json();
  const text = result.content?.[0]?.text || "";
  return parsePlanResponse(text, "cloud");
}

async function explainWithCloud(context) {
  const ps = context?.pageStructure;
  const prompt = `Describe this webpage briefly in 2-3 sentences.
Domain: ${ps?.metadata?.domain || "unknown"}
Title: ${ps?.metadata?.title || "unknown"}
Elements: ${ps?.metadata?.elementCount || 0}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CLOUD_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLOUD_API_MODEL,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) return "";
  const result = await response.json();
  return result.content?.[0]?.text || "";
}

// ── Prompt Engineering ───────────────────────────────────────

function buildPlanningPrompt(task, context, data) {
  const ps = context?.pageStructure;

  const elements = (ps?.elements || []).slice(0, 30).map((e, i) => {
    return `[${i}] <${e.tag}> role="${e.role}" label="${e.label}" type="${e.type}" ${e.isDisabled ? "DISABLED" : ""}`;
  }).join("\n");

  const forms = (ps?.forms || []).map((f) => {
    const fields = f.fields.map((ff) => {
      const val = ff.hasValue ? "FILLED" : "EMPTY";
      const req = ff.isRequired ? "REQUIRED" : "";
      const pii = ff.piiCategory ? `[PII:${ff.piiCategory}]` : "";
      return `  - ${ff.label}: ${ff.type} ${val} ${req} ${pii}`;
    }).join("\n");
    return `Form ${f.id}:\n${fields}`;
  }).join("\n\n");

  return `You are a browser automation agent. Plan actions to complete the task.

TASK: "${task}"

PAGE STATE (sanitized):
Domain: ${ps?.metadata?.domain || "unknown"}
Title: ${ps?.metadata?.title || "unknown"}
Elements (${ps?.metadata?.elementCount || 0} total):
${elements}

${forms ? `FORMS:\n${forms}` : "No forms detected."}

Privacy: ${context?.redactionProof?.totalPIIDetected || 0} PII regions detected and redacted.
Sensitive fields are marked [PII:category]. Do NOT ask for their values.

Respond with JSON:
{
  "reasoning": "Your analysis",
  "steps": [
    {
      "index": 0,
      "action": { "type": "click|type|scroll|navigate|select|wait", "target": "element label", "value": "if typing" },
      "reasoning": "Why this step",
      "confidence": 0.0-1.0,
      "risk": "low|medium|high",
      "verification": "How to verify"
    }
  ]
}

Rules:
- Use labels or text to identify elements
- Don't ask for PII values (client has them locally)
- Mark high-risk actions (submit, payment) for confirmation
- Max 20 steps`;
}

// ── Response Parsing ─────────────────────────────────────────

function parsePlanResponse(text, provider) {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { steps: [], reasoning: "No JSON in response", provider };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const steps = (parsed.steps || []).map((step, i) => ({
      index: i,
      action: {
        id: `server-${i}`,
        type: step.action?.type || "wait",
        target: step.action?.target,
        value: step.action?.value,
        retries: 0,
        maxRetries: 3,
      },
      reasoning: step.reasoning || "Server-planned step",
      confidence: step.confidence || 0.7,
      verification: step.verification || "Check page state",
      risk: step.risk || "low",
    }));

    return {
      success: steps.length > 0,
      steps,
      reasoning: parsed.reasoning || `Generated ${steps.length} steps`,
      provider,
    };
  } catch {
    return { steps: [], reasoning: "Failed to parse response", provider };
  }
}

// ── Utilities ────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// ── Start Server ─────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[VLESS] Companion server running on http://localhost:${PORT}`);
  console.log(`[VLESS] Health: http://localhost:${PORT}/api/health`);
  console.log(`[VLESS] Plan: POST http://localhost:${PORT}/api/plan`);

  checkOllama().then((available) => {
    console.log(`[VLESS] Ollama: ${available ? "connected" : "not found"}`);
  });

  if (CLOUD_API_KEY) {
    console.log(`[VLESS] Cloud API: configured (${CLOUD_API_MODEL})`);
  } else {
    console.log(`[VLESS] Cloud API: not configured (set CLOUD_API_KEY)`);
  }
});
