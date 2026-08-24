// ============================================================
// VLESS — Content Script (Production)
// Single source of truth for: DOM extraction, screenshot capture,
// action execution, PII overlay, redaction CSS injection
//
// Communicates with background service worker via messages.
// Never runs heavy ML — that stays in background.
// ============================================================

import { defineContentScript } from "wxt/utils/define-content-script";
import type { Message, PageState, AgentAction } from "../../types";
import { TRIPWIRE_MESSAGE, type TripwireMessage } from "../../core/privacy/tripwire";

/** Cap on observations accepted from one postMessage — the sender is untrusted. */
const MAX_RELAYED_OBSERVATIONS = 50;

export default defineContentScript({
  matches: ["<all_urls>"],

  main() {
    // ── State ──────────────────────────────────────────────

    let redactionStyleEl: HTMLStyleElement | null = null;
    let overlayContainer: HTMLDivElement | null = null;
    let pipelinePanel: HTMLDivElement | null = null;

    // NOTE: A DOM-settle primitive (wait for the page to stabilize after an
    // action) lands in P6 with the execution loop, wired into action results.
    // The previous MutationObserver scaffolding here was never consumed, so it
    // was removed rather than left as dead weight.

    // ── PII Tripwire relay ────────────────────────────────
    // The tripwire itself runs in the MAIN world (tripwire.content.ts) —
    // an isolated-world patch of fetch/XHR cannot see page traffic. Here
    // we only relay its observations to the background, which owns the
    // merged Privacy Ledger.
    window.addEventListener("message", (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as TripwireMessage | undefined;
      if (!data || data.source !== TRIPWIRE_MESSAGE) return;
      if (!Array.isArray(data.observations) || data.observations.length === 0) return;

      // Page scripts share this window and can post the same shape, so the
      // payload is untrusted: validate it and cap the volume rather than
      // letting a hostile page stuff the Privacy Ledger with fabricated
      // entries. Everything here is display-only and already masked.
      const observations = data.observations
        .slice(0, MAX_RELAYED_OBSERVATIONS)
        .filter(
          (o) =>
            o &&
            typeof o.url === "string" &&
            typeof o.method === "string" &&
            typeof o.bytes === "number" &&
            Number.isFinite(o.bytes) &&
            Array.isArray(o.matches)
        )
        .map((o) => ({
          url: o.url.slice(0, 512),
          method: o.method.slice(0, 16),
          bytes: Math.max(0, Math.min(o.bytes, Number.MAX_SAFE_INTEGER)),
          matches: o.matches.slice(0, 32),
        }));
      if (observations.length === 0) return;

      chrome.runtime
        .sendMessage({
          type: "REPORT_PAGE_EGRESS",
          payload: observations,
          source: "content",
          timestamp: Date.now(),
        })
        .catch(() => {
          // Background may be asleep — observations are best-effort.
        });
    });

    // ── Message Router ─────────────────────────────────────

    chrome.runtime.onMessage.addListener(
      (
        message: Message,
        _sender: chrome.runtime.MessageSender,
        sendResponse: (response?: any) => void
      ) => {
        switch (message.type) {
          case "PERCEIVE_PAGE":
            try {
              sendResponse(extractPageState());
            } catch (err: any) {
              sendResponse({ elements: [], forms: [], url: window.location.href, title: document.title, timestamp: Date.now(), textContent: "", metadata: { hasCAPTCHA: false, hasHoneypot: false, isSecure: true, hasFileUpload: false, hasPaymentForm: false, formCount: 0, totalElements: 0, interactiveElements: 0 }, confidence: 0, perceptionTime: 0 });
            }
            return true; // BUG-10 FIX: keep channel open even for sync path

          case "EXECUTE_ACTION":
            executeAction(message.payload as AgentAction)
              .then(sendResponse)
              .catch((err: Error) =>
                sendResponse({ success: false, error: err.message })
              );
            return true;

          case "CAPTURE_SCREENSHOT":
            captureVisibleTab()
              .then(sendResponse)
              .catch((err: Error) =>
                sendResponse({ success: false, error: err.message })
              );
            return true;

          case "INJECT_REDACTION_CSS":
            injectRedactionCSS(message.payload as string);
            sendResponse({ success: true });
            break;

          case "REMOVE_REDACTION_CSS":
            removeRedactionCSS();
            sendResponse({ success: true });
            break;

          case "SHOW_PII_OVERLAY":
            showPIIOverlay(message.payload as any);
            sendResponse({ success: true });
            break;

          case "HIDE_PII_OVERLAY":
            hidePIIOverlay();
            sendResponse({ success: true });
            break;

          case "SHOW_PIPELINE_PANEL":
            showPipelinePanel(message.payload as any);
            sendResponse({ success: true });
            break;

          case "UPDATE_PIPELINE_PANEL":
            updatePipelinePanel(message.payload as any);
            sendResponse({ success: true });
            break;

          case "CAPTURE_FULL_PAGE":
            captureFullPage()
              .then(sendResponse)
              .catch((err: Error) =>
                sendResponse({ success: false, error: err.message })
              );
            return true;

          default:
            sendResponse({ error: `Unknown message type: ${message.type}` });
        }
      }
    );

    // ════════════════════════════════════════════════════════
    // DOM EXTRACTION — Fast, ~10ms
    // ════════════════════════════════════════════════════════

    function extractPageState(): PageState {
      const startTime = performance.now();

      const INTERACTIVE_SELECTORS = [
        "a[href]",
        "button",
        "input",
        "select",
        "textarea",
        '[role="button"]',
        '[role="link"]',
        '[role="tab"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="switch"]',
        '[role="combobox"]',
        '[contenteditable="true"]',
        "[tabindex]",
      ].join(", ");

      const rawElements = document.querySelectorAll(INTERACTIVE_SELECTORS);
      const elements: PageState["elements"] = [];
      const seen = new Set<Element>();

      rawElements.forEach((el, i) => {
        if (seen.has(el)) return;
        seen.add(el);

        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);

        if (
          rect.width === 0 ||
          rect.height === 0 ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          parseFloat(style.opacity) < 0.1
        )
          return;

        if (rect.bottom < -100 || rect.top > window.innerHeight + 100) return;

        const text =
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          el.getAttribute("placeholder") ||
          el.textContent?.trim()?.slice(0, 150) ||
          "";

        const label = getFieldLabel(el);

        elements.push({
          // BUG-13 FIX: use stable sequential ID without Date.now() so the
        // planner's target references survive across perception → execution.
        id: el.id || `el-${i}`,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || inferRole(el),
          text,
          label,
          ariaLabel: el.getAttribute("aria-label") || "",
          placeholder: el.getAttribute("placeholder") || "",
          type: el.getAttribute("type") || "",
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            toJSON: () => ({}),
          } as DOMRect,
          isVisible: true,
          isInteractive: true,
          isDisabled: el.hasAttribute("disabled"),
          confidence: 0.95,
          source: "dom" as const,
        });
      });

      // Extract forms with field labels
      const formElements = document.querySelectorAll("form");
      const forms = Array.from(formElements).map((form, fi) => ({
        id: form.id || `form-${fi}`,
        action: form.action || window.location.href,
        method: form.method || "GET",
        fields: Array.from(
          form.querySelectorAll("input, select, textarea")
        ).map((input) => {
          const r = input.getBoundingClientRect();
          return {
            name: input.getAttribute("name") || "",
            id: input.id || "",
            type: input.getAttribute("type") || input.tagName.toLowerCase(),
            value: (input as HTMLInputElement).value || "",
            required: input.hasAttribute("required"),
            maxLength: parseInt(input.getAttribute("maxlength") || "0"),
            pattern: input.getAttribute("pattern") || "",
            options:
              input.tagName === "SELECT"
                ? Array.from((input as HTMLSelectElement).options).map(
                    (o) => o.text
                  )
                : [],
            rect: {
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              top: r.top,
              bottom: r.bottom,
              left: r.left,
              right: r.right,
              toJSON: () => ({}),
            } as DOMRect,
            label: getFieldLabel(input),
            // A radio/checkbox always reports its option token as `.value`,
            // selected or not — so "has a value" is meaningless for them.
            // Selection is the real signal.
            checked: isCheckable(input)
              ? (input as HTMLInputElement).checked
              : undefined,
            filledByUser: isCheckable(input)
              ? (input as HTMLInputElement).checked
              : !!(input as HTMLInputElement).value,
          };
        }),
      }));

      const pageHTML = document.documentElement.outerHTML;
      const pageText = document.body?.innerText || "";

      return {
        url: window.location.href,
        title: document.title,
        timestamp: Date.now(),
        elements,
        forms,
        textContent: pageText.slice(0, 5000),
        metadata: {
          hasCAPTCHA:
            /recaptcha|hcaptcha|turnstile|cf-challenge/i.test(pageHTML),
          hasHoneypot: detectHoneypots(),
          isSecure: window.location.protocol === "https:",
          hasFileUpload: elements.some((e) => e.type === "file"),
          hasPaymentForm:
            /payment|card number|cvv|expiry|billing/i.test(pageText),
          formCount: forms.length,
          totalElements: document.querySelectorAll("*").length,
          interactiveElements: elements.length,
        },
        confidence: 0.85,
        perceptionTime: performance.now() - startTime,
      };
    }

    // ════════════════════════════════════════════════════════
    // SCREENSHOT CAPTURE — via visible tab screenshot
    // ════════════════════════════════════════════════════════

    async function captureVisibleTab(): Promise<{
      success: boolean;
      dataUrl?: string;
      width?: number;
      height?: number;
      error?: string;
    }> {
      try {
        // Use chrome.tabs.captureVisibleTab from background
        // This message triggers the background to capture
        const response = await chrome.runtime.sendMessage({
          type: "DO_CAPTURE_TAB",
          payload: null,
          source: "content",
          timestamp: Date.now(),
        } as Message);

        if (response?.success && response.dataUrl) {
          return {
            success: true,
            dataUrl: response.dataUrl,
            width: response.width,
            height: response.height,
          };
        }

        // Fallback: capture via canvas (slower but works everywhere)
        return captureViaCanvas();
      } catch {
        return captureViaCanvas();
      }
    }

    function captureViaCanvas(): Promise<{
      success: boolean;
      dataUrl?: string;
      width?: number;
      height?: number;
      error?: string;
    }> {
      return new Promise((resolve) => {
        try {
          // Use html2canvas-like approach: render the page to a canvas
          // For production, we use a simpler approach:
          // Ask background to capture the tab
          chrome.runtime.sendMessage(
            {
              type: "DO_CAPTURE_TAB",
              payload: null,
              source: "content",
              timestamp: Date.now(),
            } as Message,
            (response) => {
              if (chrome.runtime.lastError) {
                // If background capture fails, try a minimal screenshot
                resolve({
                  success: false,
                  error: "Screenshot capture unavailable",
                });
                return;
              }
              resolve(response || { success: false, error: "No response" });
            }
          );
        } catch (err) {
          resolve({
            success: false,
            error: err instanceof Error ? err.message : "Capture failed",
          });
        }
      });
    }

    // ════════════════════════════════════════════════════════
    // SCROLL-STITCHING — Full-page capture
    // Captures multiple viewport screenshots while scrolling,
    // then stitches them into a single full-page image.
    // ============================================================

    async function captureFullPage(): Promise<{
      success: boolean;
      dataUrl?: string;
      width?: number;
      height?: number;
      error?: string;
    }> {
      try {
        const scrollHeight = document.documentElement.scrollHeight;
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;

        // If page fits in viewport, just capture normally
        if (scrollHeight <= viewportHeight * 1.1) {
          return captureVisibleTab();
        }

        // Capture multiple viewport screenshots while scrolling
        const captures: Array<{ dataUrl: string; scrollY: number }> = [];
        const originalScrollY = window.scrollY;
        const numCaptures = Math.ceil(scrollHeight / (viewportHeight * 0.8));

        for (let i = 0; i < numCaptures; i++) {
          const targetScroll = Math.min(
            i * viewportHeight * 0.8,
            scrollHeight - viewportHeight
          );
          window.scrollTo(0, targetScroll);
          // Wait for content to settle
          await new Promise((r) => setTimeout(r, 200));

          const response = await chrome.runtime.sendMessage({
            type: "DO_CAPTURE_TAB",
            payload: null,
            source: "content",
            timestamp: Date.now(),
          } as Message);

          if (response?.success && response.dataUrl) {
            captures.push({ dataUrl: response.dataUrl, scrollY: targetScroll });
          }
        }

        // Restore original scroll position
        window.scrollTo(0, originalScrollY);

        if (captures.length === 0) {
          return { success: false, error: "No captures obtained" };
        }

        if (captures.length === 1) {
          return { success: true, ...captures[0], width: viewportWidth, height: viewportHeight };
        }

        // Stitch captures into a single full-page image
        // Create a canvas the size of the full page
        const stitchCanvas = new OffscreenCanvas(viewportWidth, scrollHeight);
        const stitchCtx = stitchCanvas.getContext("2d")!;

        for (const capture of captures) {
          const response = await fetch(capture.dataUrl);
          const blob = await response.blob();
          const bitmap = await createImageBitmap(blob);
          stitchCtx.drawImage(bitmap, 0, capture.scrollY, viewportWidth, viewportHeight);
          bitmap.close();
        }

        const stitchedBlob = await stitchCanvas.convertToBlob({ type: "image/png" });
        const dataUrl = await blobToDataURL(stitchedBlob);

        return {
          success: true,
          dataUrl,
          width: viewportWidth,
          height: scrollHeight,
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : "Full-page capture failed",
        };
      }
    }

    function blobToDataURL(blob: Blob): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }

    // ════════════════════════════════════════════════════════
    // ACTION EXECUTION — Production-grade
    // ════════════════════════════════════════════════════════

    // DOM settle: wait for mutations to stop after an action
    function waitForDOMSettle(maxWaitMs = 2000): Promise<void> {
      return new Promise((resolve) => {
        let timeout: ReturnType<typeof setTimeout> | null = null;
        let debounce: ReturnType<typeof setTimeout> | null = null;
        const observer = new MutationObserver(() => {
          // Reset debounce on each mutation
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => {
            observer.disconnect();
            if (timeout) clearTimeout(timeout);
            resolve();
          }, 300); // 300ms of no mutations = settled
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        // Max wait: don't block forever
        timeout = setTimeout(() => {
          observer.disconnect();
          if (debounce) clearTimeout(debounce);
          resolve();
        }, maxWaitMs);
      });
    }

    async function executeAction(
      action: AgentAction
    ): Promise<{ success: boolean; error?: string }> {
      return new Promise((resolve) => {
        try {
          switch (action.type) {
            case "click": {
              const el = action.coordinates
                ? document.elementFromPoint(
                    action.coordinates.x,
                    action.coordinates.y
                  )
                : findElement(action.target || "");
              if (!el) {
                resolve({
                  success: false,
                  error: `Element not found: "${action.target}"`,
                });
                return;
              }
              el.scrollIntoView({ behavior: "smooth", block: "center" });
              setTimeout(async () => {
                const rect = el.getBoundingClientRect();
                const x = rect.x + rect.width / 2;
                const y = rect.y + rect.height / 2;
                for (const evt of [
                  "pointerdown",
                  "mousedown",
                  "pointerup",
                  "mouseup",
                  "click",
                ]) {
                  el.dispatchEvent(
                    new MouseEvent(evt, {
                      bubbles: true,
                      cancelable: true,
                      clientX: x,
                      clientY: y,
                      button: 0,
                    })
                  );
                }
                if ("focus" in el) (el as HTMLElement).focus();
                // Wait for DOM to settle after click (handles SPA navigation, dropdowns, etc.)
                await waitForDOMSettle(1500);
                resolve({ success: true });
              }, 300);
              break;
            }

            case "type": {
              const el = findElement(action.target || "");
              if (!el) {
                resolve({
                  success: false,
                  error: `Element not found: "${action.target}"`,
                });
                return;
              }
              const input = el as HTMLInputElement;
              input.focus();
              el.scrollIntoView({ behavior: "smooth", block: "center" });
              input.select();

              // Native setter hack: bypasses React/Vue synthetic event system
              // React overrides the value setter on input elements, so setting
              // input.value directly doesn't trigger React's onChange handler.
              // We use the native prototype setter to set the value, then dispatch
              // an input event so React picks it up.
              const isTextArea = el instanceof HTMLTextAreaElement;
              const proto = isTextArea
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;

              // BUG-12 FIX: removed duplicate `|| getOwnPropertyDescriptor(proto,"value")`
              // — both sides of the || were identical, making the fallback dead code.
              const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

              // Clear existing value
              if (nativeSetter) {
                nativeSetter.call(input, "");
              } else {
                input.value = "";
              }
              input.dispatchEvent(new Event("input", { bubbles: true }));

              // Human-like typing with realistic delays
              let i = 0;
              const value = action.value || "";
              const typeNext = () => {
                if (i >= value.length) {
                  input.dispatchEvent(
                    new Event("change", { bubbles: true })
                  );
                  input.blur();
                  resolve({ success: true });
                  return;
                }
                const char = value[i];
                input.dispatchEvent(
                  new KeyboardEvent("keydown", {
                    key: char,
                    code: `Key${char.toUpperCase()}`,
                    bubbles: true,
                  })
                );
                // Use native setter so React/Vue pick up the change
                const currentValue = input.value;
                if (nativeSetter) {
                  nativeSetter.call(input, currentValue + char);
                } else {
                  input.value += char;
                }
                input.dispatchEvent(
                  new InputEvent("input", {
                    data: char,
                    inputType: "insertText",
                    bubbles: true,
                  })
                );
                input.dispatchEvent(
                  new KeyboardEvent("keyup", {
                    key: char,
                    code: `Key${char.toUpperCase()}`,
                    bubbles: true,
                  })
                );
                i++;
                setTimeout(typeNext, 30 + Math.random() * 50);
              };
              typeNext();
              break;
            }

            case "select": {
              const el = findElement(action.target || "");
              if (!el || el.tagName !== "SELECT") {
                resolve({
                  success: false,
                  error: `Select not found: "${action.target}"`,
                });
                return;
              }
              const select = el as HTMLSelectElement;
              for (const opt of select.options) {
                if (
                  opt.value === action.value ||
                  opt.text.toLowerCase() === action.value?.toLowerCase()
                ) {
                  select.value = opt.value;
                  select.dispatchEvent(
                    new Event("change", { bubbles: true })
                  );
                  resolve({ success: true });
                  return;
                }
              }
              for (const opt of select.options) {
                if (
                  opt.text
                    .toLowerCase()
                    .includes((action.value || "").toLowerCase())
                ) {
                  select.value = opt.value;
                  select.dispatchEvent(
                    new Event("change", { bubbles: true })
                  );
                  resolve({ success: true });
                  return;
                }
              }
              resolve({
                success: false,
                error: `Option not found: "${action.value}"`,
              });
              break;
            }

            case "scroll": {
              const dir = (action.value || "down").toLowerCase();
              const amounts: Record<string, number> = {
                up: -window.innerHeight * 0.7,
                down: window.innerHeight * 0.7,
                top: -window.scrollY,
                bottom: document.body.scrollHeight - window.scrollY,
              };
              window.scrollBy({
                top: amounts[dir] || 500,
                behavior: "smooth",
              });
              resolve({ success: true });
              break;
            }

            case "navigate": {
              if (action.value) {
                window.location.href = action.value;
                resolve({ success: true });
              } else {
                resolve({ success: false, error: "No URL provided" });
              }
              break;
            }

            case "hover": {
              const el = findElement(action.target || "");
              if (!el) {
                resolve({
                  success: false,
                  error: `Element not found: "${action.target}"`,
                });
                return;
              }
              for (const evt of ["mouseover", "mouseenter", "pointerenter"]) {
                el.dispatchEvent(new MouseEvent(evt, { bubbles: true }));
              }
              resolve({ success: true });
              break;
            }

            case "press_key": {
              const active = document.activeElement || document.body;
              for (const evt of ["keydown", "keypress", "keyup"]) {
                active.dispatchEvent(
                  new KeyboardEvent(evt, {
                    key: action.key || "",
                    code: action.key || "",
                    bubbles: true,
                  })
                );
              }
              resolve({ success: true });
              break;
            }

            case "go_back": {
              window.history.back();
              resolve({ success: true });
              break;
            }

            case "wait": {
              setTimeout(
                () => resolve({ success: true }),
                action.timeout || 1000
              );
              break;
            }

            default:
              resolve({
                success: false,
                error: `Unknown action type: ${(action as any).type}`,
              });
          }
        } catch (err: any) {
          resolve({ success: false, error: err.message });
        }
      });
    }

    // ════════════════════════════════════════════════════════
    // PII OVERLAY — Shows detected PII regions on page
    // ════════════════════════════════════════════════════════

    interface PIIOverlayRegion {
      id: string;
      category: string;
      sensitivity: string;
      boundingBox: { x: number; y: number; width: number; height: number };
      confidence: number;
    }

    interface PIITextItem {
      category: string;
      sensitivity: string;
    }

    function showPIIOverlay(data: {
      regions: PIIOverlayRegion[];
      textItems?: PIITextItem[];
      summary: { totalRegions: number; criticalCount: number; highCount: number };
    }): void {
      hidePIIOverlay();

      // Only skip if literally nothing detected
      if (data.summary.totalRegions === 0) return;

      overlayContainer = document.createElement("div");
      overlayContainer.id = "vless-pii-overlay";
      overlayContainer.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        pointer-events: none;
        z-index: 2147483647;
      `;

      const SENSITIVITY_COLORS: Record<string, string> = {
        critical: "#e23829",
        high: "#f97316",
        medium: "#eab308",
        low: "#16a34a",
      };

      const CATEGORY_LABELS: Record<string, string> = {
        face: "Face",
        password: "Password",
        aadhaar: "Aadhaar",
        phone: "Phone",
        email: "Email",
        pan: "PAN",
        bank_account: "Bank Acct",
        name: "Name",
        address: "Address",
        financial: "Financial",
        medical: "Medical",
        credit_card: "Card",
      };

      // ── Draw visual bounding boxes for vision-detected PII ──
      for (const region of data.regions) {
        if (!region.boundingBox) continue;
        const bb = region.boundingBox;
        const color = SENSITIVITY_COLORS[region.sensitivity] || "#888";
        const label = CATEGORY_LABELS[region.category] || region.category.toUpperCase();

        const box = document.createElement("div");
        box.style.cssText = `
          position: absolute;
          left: ${bb.x}px;
          top: ${bb.y}px;
          width: ${bb.width}px;
          height: ${bb.height}px;
          border: 2px solid ${color};
          border-radius: 3px;
          background: ${color}18;
          pointer-events: none;
          transition: opacity 0.3s;
        `;

        const chip = document.createElement("span");
        chip.style.cssText = `
          position: absolute;
          top: -20px;
          left: 0;
          font-size: 10px;
          font-weight: 700;
          font-family: 'Spline Sans Mono', 'Courier New', monospace;
          color: white;
          background: ${color};
          padding: 1px 6px;
          border-radius: 2px;
          white-space: nowrap;
          letter-spacing: 0.05em;
        `;
        chip.textContent = `● ${label}`;
        box.appendChild(chip);
        overlayContainer.appendChild(box);
      }

      // ── Summary badge — always visible, shows total count ──
      const badge = document.createElement("div");
      badge.style.cssText = `
        position: fixed;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        background: #28231d;
        color: #f5f2e9;
        padding: 10px 18px;
        border-radius: 0;
        border: 2px solid #e23829;
        font-size: 12px;
        font-family: 'Spline Sans Mono', 'Courier New', monospace;
        box-shadow: 4px 4px 0 #e2382940;
        pointer-events: auto;
        z-index: 2147483647;
        max-width: 420px;
        min-width: 220px;
      `;

      // Count categories for the chip list
      const allItems = [
        ...data.regions.map(r => ({ category: r.category, sensitivity: r.sensitivity })),
        ...(data.textItems || []),
      ];
      const byCat: Record<string, { count: number; sensitivity: string }> = {};
      for (const item of allItems) {
        if (!byCat[item.category]) byCat[item.category] = { count: 0, sensitivity: item.sensitivity };
        byCat[item.category].count++;
      }

      const chipsHTML = Object.entries(byCat).map(([cat, { count, sensitivity }]) => {
        const color = SENSITIVITY_COLORS[sensitivity] || "#888";
        const lbl = CATEGORY_LABELS[cat] || cat;
        return `<span style="display:inline-block;background:${color};color:#fff;font-weight:700;padding:1px 7px;border-radius:2px;margin:2px 3px 2px 0;font-size:10px;letter-spacing:0.04em;">${lbl}${count > 1 ? ` ×${count}` : ""}</span>`;
      }).join("");

      const critText = data.summary.criticalCount > 0
        ? `<span style="color:#e23829;font-weight:700"> · ${data.summary.criticalCount} CRITICAL</span>`
        : "";

      badge.innerHTML = `
        <div style="font-weight:700;font-size:13px;margin-bottom:6px;letter-spacing:0.06em;color:#e23829;">
          ● VLESS — ${data.summary.totalRegions} PII DETECTED${critText}
        </div>
        <div style="line-height:1.8;">${chipsHTML}</div>
        <div style="margin-top:6px;font-size:10px;color:#a09882;letter-spacing:0.04em;">
          All data stays on-device. Auto-dismiss in 8s.
        </div>
      `;

      // Close button
      const close = document.createElement("button");
      close.textContent = "✕";
      close.style.cssText = `
        position: absolute;
        top: 6px; right: 8px;
        background: none; border: none;
        color: #a09882; font-size: 14px; cursor: pointer;
        pointer-events: auto; font-family: monospace; line-height: 1;
      `;
      close.onclick = () => hidePIIOverlay();
      badge.appendChild(close);
      badge.style.position = "fixed";
      overlayContainer.appendChild(badge);
      document.body.appendChild(overlayContainer);

      // Auto-dismiss after 8 seconds
      setTimeout(() => hidePIIOverlay(), 8000);
    }

    function hidePIIOverlay(): void {
      if (overlayContainer) {
        overlayContainer.remove();
        overlayContainer = null;
      }
    }

    // ════════════════════════════════════════════════════════
    // PIPELINE STATUS PANEL — Shows pipeline progress
    // ════════════════════════════════════════════════════════

    interface PipelineStatus {
      steps: Array<{
        name: string;
        status: "pending" | "running" | "complete" | "error";
        details: string;
      }>;
      privacyScore: number;
      piiDetected: number;
      piiRedacted: number;
    }

    function showPipelinePanel(data: PipelineStatus): void {
      hidePipelinePanel();

      pipelinePanel = document.createElement("div");
      pipelinePanel.id = "vless-pipeline-panel";
      pipelinePanel.style.cssText = `
        position: fixed;
        bottom: 16px;
        right: 16px;
        background: white;
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.2);
        padding: 14px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 12px;
        z-index: 2147483647;
        pointer-events: auto;
        min-width: 260px;
        max-width: 320px;
      `;

      updatePipelinePanelInternal(data);
      document.body.appendChild(pipelinePanel);
    }

    function updatePipelinePanel(data: PipelineStatus): void {
      if (!pipelinePanel) {
        showPipelinePanel(data);
        return;
      }
      updatePipelinePanelInternal(data);
    }

    function updatePipelinePanelInternal(data: PipelineStatus): void {
      if (!pipelinePanel) return;

      const STEP_ICONS: Record<string, string> = {
        pending: "[ ]",
        running: "[>]",
        complete: "[OK]",
        error: "[!!]",
      };

      const STEP_COLORS: Record<string, string> = {
        pending: "#9e9e9e",
        running: "#1a237e",
        complete: "#2e7d32",
        error: "#d32f2f",
      };

      let stepsHTML = "";
      for (const step of data.steps) {
        const icon = STEP_ICONS[step.status];
        const color = STEP_COLORS[step.status];
        stepsHTML += `
          <div style="display: flex; align-items: center; gap: 6px; padding: 2px 0; color: ${color};">
            <span style="font-family: monospace; font-size: 11px;">${icon}</span>
            <span style="font-weight: 500;">${step.name}</span>
            ${step.details ? `<span style="color: #888; font-size: 10px; margin-left: auto;">${step.details}</span>` : ""}
          </div>
        `;
      }

      const privacyColor =
        data.privacyScore === 100
          ? "#2e7d32"
          : data.privacyScore >= 80
            ? "#f9a825"
            : "#d32f2f";

      pipelinePanel.innerHTML = `
        <div style="font-weight: 700; font-size: 13px; margin-bottom: 8px; color: #1a237e;">
          VLESS Pipeline
        </div>
        ${stepsHTML}
        <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #eee;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <div style="width: 32px; height: 32px; border-radius: 50%; border: 2px solid ${privacyColor}; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 12px; color: ${privacyColor};">
              ${data.privacyScore}
            </div>
            <div>
              <div style="font-weight: 600; color: ${privacyColor};">
                ${data.privacyScore === 100 ? "Perfect Privacy" : "Privacy Risk"}
              </div>
              <div style="font-size: 10px; color: #888;">
                ${data.piiDetected} detected, ${data.piiRedacted} redacted
              </div>
            </div>
          </div>
        </div>
      `;
    }

    function hidePipelinePanel(): void {
      if (pipelinePanel) {
        pipelinePanel.remove();
        pipelinePanel = null;
      }
    }

    // ════════════════════════════════════════════════════════
    // REDACTION CSS INJECTION
    // ════════════════════════════════════════════════════════

    function injectRedactionCSS(css: string): void {
      removeRedactionCSS();
      if (!css.trim()) return;
      redactionStyleEl = document.createElement("style");
      redactionStyleEl.id = "vless-redaction-css";
      redactionStyleEl.textContent = css;
      document.head.appendChild(redactionStyleEl);
    }

    function removeRedactionCSS(): void {
      if (redactionStyleEl) {
        redactionStyleEl.remove();
        redactionStyleEl = null;
      }
    }

    // ════════════════════════════════════════════════════════
    // HELPERS
    // ════════════════════════════════════════════════════════

    // Cache of interactive elements for index-based lookup
    // The LLM returns targets like [0], [1], [2] which map to
    // the nth interactive element on the page.
    let interactiveElementCache: Element[] | null = null;

    function getInteractiveElements(): Element[] {
      if (interactiveElementCache) return interactiveElementCache;
      // Must match the selectors in extractPageState() exactly
      // so LLM indices [0],[1],[2] resolve to the same elements
      const SELECTORS = [
        "a[href]", "button", "input", "select", "textarea",
        '[role="button"]', '[role="link"]', '[role="tab"]',
        '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
        '[role="combobox"]', '[contenteditable="true"]',
        "[tabindex]",
      ].join(", ");
      const rawElements = document.querySelectorAll(SELECTORS);
      const seen = new Set<Element>();
      interactiveElementCache = [];
      rawElements.forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        if (!isVisible(el)) return;
        interactiveElementCache!.push(el);
      });
      return interactiveElementCache;
    }

    function findElement(target: string): Element | null {
      if (!target) return null;

      // Strategy 0: Index-based lookup [0], [1], [2]...
      // The LLM returns element indices from the page state.
      const indexMatch = target.match(/^\[(\d+)\]$/);
      if (indexMatch) {
        const idx = parseInt(indexMatch[1], 10);
        const elements = getInteractiveElements();
        if (idx >= 0 && idx < elements.length) {
          return elements[idx];
        }
        // If index is out of range, return null
        return null;
      }

      // Strategy 1: Direct ID
      const byId = document.getElementById(target);
      if (byId && isVisible(byId)) return byId;

      // Strategy 2: CSS selector
      if (
        target.includes(".") ||
        target.includes("[") ||
        target.includes(">") ||
        target.includes("#")
      ) {
        try {
          const bySelector = document.querySelector(target);
          if (bySelector && isVisible(bySelector)) return bySelector;
        } catch {
          /* invalid selector */
        }
      }

      // Strategy 3: Name attribute
      const byName = document.querySelector(`[name="${target}"]`);
      if (byName && isVisible(byName)) return byName;

      // Strategy 4: ARIA label
      const byAria = document.querySelector(`[aria-label="${target}"]`);
      if (byAria && isVisible(byAria)) return byAria;

      // Strategy 5: Placeholder
      const byPlaceholder = document.querySelector(
        `[placeholder="${target}"]`
      );
      if (byPlaceholder && isVisible(byPlaceholder)) return byPlaceholder;

      // Strategy 6: Label association
      const byLabel = document.querySelector(`label[for="${target}"]`);
      if (byLabel) {
        const input =
          byLabel.querySelector("input, select, textarea") ||
          document.getElementById(byLabel.getAttribute("for") || "");
        if (input) return input;
      }

      // Strategy 7: Exact text match (buttons, links)
      const textEls = document.querySelectorAll(
        "button, a, [role='button'], [role='link'], [role='tab'], [role='menuitem']"
      );
      const lower = target.toLowerCase();

      for (const el of textEls) {
        const text = el.textContent?.trim().toLowerCase() || "";
        if (text === lower && isVisible(el)) return el;
      }
      // Strategy 8: Contains match
      for (const el of textEls) {
        const text = el.textContent?.trim().toLowerCase() || "";
        if (text.includes(lower) && isVisible(el)) return el;
      }

      // Strategy 9: Word overlap match (all target words must appear)
      const words = lower.split(/\s+/);
      for (const el of textEls) {
        const text = el.textContent?.trim().toLowerCase() || "";
        if (words.every((w) => text.includes(w)) && isVisible(el)) return el;
      }

      // Strategy 10: Levenshtein fuzzy match (handles typos)
      let bestMatch: Element | null = null;
      let bestDistance = Infinity;
      const maxDistance = Math.max(2, Math.floor(lower.length * 0.3)); // Allow 30% typos

      for (const el of textEls) {
        const text = el.textContent?.trim().toLowerCase() || "";
        if (!text || !isVisible(el)) continue;
        const distance = levenshtein(lower, text.slice(0, lower.length + 5));
        if (distance < bestDistance && distance <= maxDistance) {
          bestDistance = distance;
          bestMatch = el;
        }
      }
      if (bestMatch) return bestMatch;

      // Strategy 11: Title/alt attribute match
      const byTitle = document.querySelector(`[title*="${target}"]`);
      if (byTitle && isVisible(byTitle)) return byTitle;

      const byAlt = document.querySelector(`[alt*="${target}"]`);
      if (byAlt && isVisible(byAlt)) return byAlt;

      return null;
    }

    // Levenshtein distance for fuzzy matching
    function levenshtein(a: string, b: string): number {
      if (a.length === 0) return b.length;
      if (b.length === 0) return a.length;
      const matrix: number[][] = [];
      for (let i = 0; i <= b.length; i++) matrix[i] = [i];
      for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
      for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
          const cost = b.charAt(i - 1) === a.charAt(j - 1) ? 0 : 1;
          matrix[i][j] = Math.min(
            matrix[i - 1][j] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j - 1] + cost
          );
        }
      }
      return matrix[b.length][a.length];
    }

    function isVisible(el: Element): boolean {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden")
        return false;
      if (parseFloat(style.opacity) < 0.1) return false;
      return true;
    }

    /** Radio and checkbox carry a fixed option token in `.value`. */
    function isCheckable(el: Element): boolean {
      const type = (el.getAttribute("type") || "").toLowerCase();
      return el.tagName === "INPUT" && (type === "radio" || type === "checkbox");
    }

    function getFieldLabel(input: Element): string {
      if (input.id) {
        const label = document.querySelector(`label[for="${input.id}"]`);
        if (label) return label.textContent?.trim() || "";
      }
      const parentLabel = input.closest("label");
      if (parentLabel) {
        const clone = parentLabel.cloneNode(true) as Element;
        clone
          .querySelectorAll("input, select, textarea")
          .forEach((c) => c.remove());
        const text = clone.textContent?.trim();
        if (text) return text;
      }
      // Previous sibling
      const prev = input.previousElementSibling;
      if (prev && ["LABEL", "SPAN", "DIV", "P"].includes(prev.tagName)) {
        return prev.textContent?.trim() || "";
      }
      return (
        input.getAttribute("aria-label") ||
        input.getAttribute("placeholder") ||
        ""
      );
    }

    function inferRole(el: Element): string {
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute("type")?.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "button") return "button";
      if (tag === "input") {
        if (type === "submit") return "button";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        return "textbox";
      }
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      return "generic";
    }

    function detectHoneypots(): boolean {
      return Array.from(document.querySelectorAll("input, textarea")).some(
        (el) => {
          const style = window.getComputedStyle(el);
          if (
            style.position === "absolute" &&
            (parseInt(style.left) < -9999 || parseInt(style.top) < -9999)
          )
            return true;
          const name =
            el.getAttribute("name") || el.getAttribute("id") || "";
          if (/captcha|trap|bot|honeypot|cf-|wp-/i.test(name)) return true;
          return false;
        }
      );
    }

    console.log("[VLESS] Content script loaded.");
  },
});
