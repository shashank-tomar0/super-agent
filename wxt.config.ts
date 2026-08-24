import { defineConfig } from "wxt";
import react from "@vitejs/plugin-react";

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "VLESS — On-Device Browser Agent",
    description:
      "Privacy-preserving AI that sees your screen, understands your intent, and automates web tasks — without sending a single pixel to the cloud.",
    permissions: [
      "activeTab",
      "scripting",
      "storage",
      "sidePanel",
      "tabs",
      "tabCapture",
      "offscreen",
      "webNavigation",
      "alarms",
    ],
    host_permissions: ["<all_urls>"],
    side_panel: {
      default_path: "sidepanel.html",
    },
    icons: {
      16: "icons/icon-16.svg",
      48: "icons/icon-48.svg",
      128: "icons/icon-128.svg",
    },
    action: {
      default_icon: {
        16: "icons/icon-16.svg",
        48: "icons/icon-48.svg",
      },
    },
    // MV3's default CSP is "script-src 'self'; object-src 'self'", which
    // blocks WebAssembly compilation outright. Without 'wasm-unsafe-eval'
    // the first ORT initWasm() throws, ORT caches that rejection, and every
    // later call reports "previous call to 'initWasm()' failed" — which is
    // what broke OCR, re-OCR redaction verification, and Florence-2.
    //
    // 'wasm-unsafe-eval' permits WebAssembly ONLY. It does not re-enable
    // eval() or inline script, so this stays the narrowest grant that makes
    // on-device inference possible at all.
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self';",
    },
  },
  vite: () => ({
    plugins: [react()],
    build: {
      modulePreload: false,
    },
  }),
});
