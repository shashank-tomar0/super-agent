# VLESS — Technical Architecture

**SIH 2026 · PS 26171 — On-device Visual Perception for Lightweight Browser Agents**

---

## System Overview

VLESS is a **privacy-preserving browser agent** that runs a three-tier architecture:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ CONTENT SCRIPT (has DOM)                                                  │
│  • DOM extraction (structural prior)                                       │
│  • Action execution (native-setter, full event sequence)                  │
│  • Visual overlay (PII bounding boxes, pipeline status)                   │
│  • PII tripwire (blocks outbound fetch/XHR containing PII)               │
└───────────────▲───────────────────────────────────────┬──────────────────┘
                │ messages                               │ actions
┌───────────────┴───────────────────────────────────────▼──────────────────┐
│ SERVICE WORKER (orchestrator — no DOM, no canvas, no WebGPU)              │
│  • executeFullPipeline() — single orchestration path                     │
│  • Task state machine + AbortController + chrome.alarms keepalive         │
│  • webRequest privacy ledger                                              │
└───────────────▲───────────────────────────────────────┬──────────────────┘
                │ frames + jobs                          │ results
┌───────────────┴───────────────────────────────────────▼──────────────────┐
│ OFFSCREEN DOCUMENT (has WebGPU + OffscreenCanvas — the ML host)          │
│  • Florence-2-base-ft (ViT): open-vocab detection, OCR, grounding       │
│  • PP-OCRv5: detection (DB) + recognition (CTC) with EN + Devanagari    │
│  • Redaction canvas (blur/black-box/pixelate) + re-OCR verification     │
│  • Backend detection (WebGPU → WASM SIMD → CPU tier ladder)              │
└──────────────────────────────────────────────────────────────────────────┘
```

**Key principle**: The server never sees raw screenshots, PII, faces, or passwords. Only sanitized structural metadata (element types, positions, labels) is transmitted — or nothing at all when running fully local.

---

## Pipeline Data Flow

Every task runs through `executeFullPipeline()`:

```
1. CAPTURE (10-50ms)
   Content script extracts DOM → PageState with 30+ fields per element
   Best-effort screenshot via chrome.tabs.sendMessage

2. VISION PERCEPTION (200-2000ms)
   Florence-2 ViT in offscreen document via transformers.js v3
   Three tasks: <OD> open-vocab detection, <OCR_WITH_REGION>, <CAPTION_TO_PHRASE_GROUNDING>
   Graceful degradation: if unavailable, pipeline continues with DOM+OCR only

3. SCREEN GRAPH FUSION (5-20ms)  ← THE KEY INNOVATION
   fuseScreenGraph() merges three signals:
   • DOM elements (structural backbone — fast, accurate for HTML)
   • OCR text regions (catches canvas-rendered, image-embedded text)
   • Florence-2 ViT detections (catches what DOM misses — icon buttons, images)
   IoU-based deduplication with confidence boosting for fused signals

4. DETECT PII (5-20ms)
   Multi-signal: DOM regex (15 Indian PII types) + checksum validation
   • Verhoeff checksum for Aadhaar (12 digits)
   • Luhn algorithm for credit/debit cards
   • PAN format validation (5L + 4D + 1L, valid series)
   • IFSC structure validation
   • Indian phone number format (starts 6-9, exactly 10 digits)
   • OCR text blocks scanned for PII patterns (catches image-rendered PII)

5. REDACT (10-100ms)
   OffscreenCanvas: Gaussian blur (faces), black-box (passwords/Aadhaar), pixelate (medium)
   CSS injection for visual indicators on page
   Visual overlay with bounding boxes and confidence scores

6. VERIFY REDACTION (100-500ms)
   Re-OCR the REDACTED screenshot
   Scan for residual PII patterns
   Mathematical assertion: zero PII text remains in pixels
   This is the "provable privacy" — no competitor does this

7. PLAN (50ms-10s)
   Priority chain:
   1. VLM (redacted screenshot → multimodal LLM) — satisfies PS requirement
   2. Multi-provider LLM (Ollama → Claude → OpenAI → OpenRouter)
   3. Deterministic form planner (fuzzy label matching, zero LLM needed)
   4. Rule-based fallback
   PII NEVER enters any prompt — only indices and field types

8. EXECUTE (200-500ms per step)
   Content script: native value setter + full keyboard event sequence
   Human-like timing (30-80ms between keystrokes)
   Multi-strategy element resolution (ID → CSS → name → ARIA → text → fuzzy)

9. VERIFY (50ms)
   DOM diff (before/after page state comparison)
   Form value verification
   Reasoning trace logged for full explainability
```

---

## PII Detection Engine

The PII detector is 40% of the SIH evaluation score. Implementation:

### DOM-based Detection (15 Indian PII Types)

| PII Type | Detection Method | Checksum |
|----------|-----------------|----------|
| Aadhaar | 12-digit pattern + field semantics | Verhoeff algorithm |
| PAN Card | ABCDE1234F format + valid series | Structure validation |
| Phone (Indian) | 10 digits starting 6-9 | Format validation |
| Email | Standard regex | N/A |
| Bank Account | 9-18 digits in payment context | Luhn for cards |
| IFSC Code | 4L + 0 + 6AN | Structure validation |
| UPI ID | name@provider | Known provider list |
| Passport | A + 7-8 digits | Format validation |
| PIN Code | 6 digits in address context | N/A |
| Date of Birth | Various date formats | Context-gated |
| Names | Capitalized word sequences | Context-gated |
| Passwords | input[type=password] | N/A |
| Financial | 16-digit card numbers | Luhn validation |

### Vision-based Detection
- **Face detection**: Skin-color analysis in YCbCr color space + connected component analysis
- **Password dots**: Pattern detection for repeated small circles
- **OCR text scan**: OCR text blocks scanned for PII patterns (catches text rendered in images/canvas)

### Verification
- Checksum validation eliminates false positives (e.g., phone-like 10-digit numbers that aren't actually phone numbers)
- Context gating: only flags PII in relevant form fields or page text, not random number sequences
- Both precision AND recall measured (not just recall)

---

## On-Device ML Models

| Model | Size | Purpose | Runtime |
|-------|------|---------|---------|
| PP-OCRv3 Detection | 2.4MB | Locate text regions (DB map) | ONNX Runtime Web |
| PP-OCRv5 Recognition (EN) | 7.8MB | Read Latin text (CTC decode) | ONNX Runtime Web |
| PP-OCRv3 Recognition (HI) | 8.9MB | Read Devanagari text | ONNX Runtime Web |
| Florence-2-base-ft | 360MB | ViT: detection + grounding + OCR | transformers.js v3 |

### Tier Degradation

- **Tier A (WebGPU)**: All models, full experience
- **Tier B (WASM SIMD)**: Florence-2 q4 + OCR, reduced speed
- **Tier C (CPU only)**: OCR + DOM, deterministic planner, Florence optional

---

## Privacy Architecture

1. **PII Tripwire**: Monkey-patches `fetch()` and `XMLHttpRequest` in content script. Scans every outbound request body for PII patterns. BLOCKS requests containing detected PII. Verifiable in DevTools Network tab.

2. **Network Monitor**: `chrome.webRequest` listener tracks all outbound requests. Generates a "privacy proof" log showing exactly what data left the device.

3. **Redaction Verification**: After redacting a screenshot, re-runs OCR on the redacted image. Scans for residual PII patterns. Mathematical assertion: zero PII in pixels before any send.

4. **Encrypted Memory**: AES-256-GCM encryption for stored page schemas and action patterns. Non-extractable key via Web Crypto API.

---

## LLM Planning

Four providers with automatic fallback:

| Priority | Provider | Where | Cost |
|----------|----------|-------|------|
| 1st | WebLLM (WebGPU) | In-browser | Free |
| 2nd | Ollama (CPU) | Local machine | Free |
| 3rd | Claude / OpenAI | Cloud API | Pay/token |
| 4th | Rule-based | Client-side | Free |

**Privacy guarantee**: PII values NEVER enter any LLM prompt. The LLM sees only:
- Element indices: `[0] Given Name [PII:name] EMPTY REQUIRED`
- Field types and labels
- Task description
Actual PII values are filled client-side by index after planning.

---

## Side Panel UI (7 Tabs)

| Tab | Components | Purpose |
|-----|-----------|---------|
| Dashboard | AgentStatusPanel, LearningLog, StatusCards | Overview + quick actions |
| Task | TaskInput, PipelineResult | Task creation + data forms |
| Perception | PageInspector, ReasoningTrace | What the agent sees + thinks |
| Privacy | PrivacyMonitor, PrivacyLedger | Network monitoring + proof |
| Models | RuntimePanel, ModelManagerUI | Backend detection + model status |
| Settings | ProviderSettings | LLM provider configuration |
| Debug | LearningLog | Full activity feed |

---

## Evaluation Criteria Mapping

| Criterion | Weight | How VLESS Wins |
|-----------|--------|----------------|
| Visual context accuracy | 25% | Florence-2 ViT + ScreenGraph tri-signal fusion handles canvas/SPA/PDF |
| PII recall/precision | 20% | Checksum-validated regex + 15 Indian PII types + vision detection |
| Redaction precision | 20% | Sensitivity-matched strategies + re-OCR verification |
| Client resource utilization | 20% | Tiered degradation (WebGPU→WASM→CPU), lazy loading, Cache API |
| End-to-end latency | 15% | DOM fast-path, async pipeline, measured latency breakdown |
