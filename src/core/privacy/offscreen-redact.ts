// ============================================================
// VLESS — Offscreen Redaction & Verification
// Runs in the offscreen document (has OffscreenCanvas + WebGPU).
// The service worker CANNOT do canvas operations — this module
// provides the redaction and re-OCR verification that the
// pipeline needs.
// ============================================================

import { runOcr } from "../ocr/ocr-engine";
import { scanTextForPII } from "./pii-detector";
import type { OcrResult } from "../../types/runtime";
import {
  verifyAadhaarChecksum,
  verifyLuhn,
  verifyPANFormat,
  verifyIFSCFormat,
  verifyIndianPhone,
} from "./pii-detector";

// ── Types ────────────────────────────────────────────────────

interface RedactRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  strategy: "blur" | "black_box" | "pixelate" | "mask_text";
}

export async function redactScreenshot(
  imageDataUrl: string,
  regions: RedactRegion[],
  viewportWidth?: number,
  viewportHeight?: number
): Promise<{ imageDataUrl: string; regionsRedacted: number }> {
  // Decode the image
  const response = await fetch(imageDataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  const width = bitmap.width;
  const height = bitmap.height;

  // Compute High-DPI / DevicePixelRatio scaling factors
  const scaleX = viewportWidth && viewportWidth > 0 ? width / viewportWidth : 1;
  const scaleY = viewportHeight && viewportHeight > 0 ? height / viewportHeight : 1;

  // Create canvas and draw original
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  let regionsRedacted = 0;

  for (const region of regions) {
    const x = Math.max(0, Math.round(region.x * scaleX));
    const y = Math.max(0, Math.round(region.y * scaleY));
    const w = Math.min(Math.round(region.width * scaleX), width - x);
    const h = Math.min(Math.round(region.height * scaleY), height - y);

    if (w <= 0 || h <= 0) continue;

    switch (region.strategy) {
      case "black_box":
        ctx.fillStyle = "#000000";
        ctx.fillRect(x, y, w, h);
        regionsRedacted++;
        break;

      case "blur":
        applyBoxBlur(ctx, x, y, w, h, 3);
        regionsRedacted++;
        break;

      case "pixelate":
        applyPixelate(ctx, x, y, w, h, 8);
        regionsRedacted++;
        break;

      case "mask_text":
        // Text masking is handled by CSS overlay in the DOM
        // For canvas, we just black-box it
        ctx.fillStyle = "#000000";
        ctx.fillRect(x, y, w, h);
        regionsRedacted++;
        break;
    }
  }

  // Convert back to data URL
  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  const outDataUrl = await blobToDataURL(outBlob);

  return { imageDataUrl: outDataUrl, regionsRedacted };
}

/**
 * Verify a redacted screenshot contains zero PII text.
 * Re-runs OCR on the redacted image and checks for residual PII patterns.
 */
export async function verifyRedactionOffscreen(
  imageDataUrl: string
): Promise<{
  passed: boolean;
  residualPII: number;
  wordsFound: number;
  ocrTimeMs: number;
  ran: boolean;
  unavailableReason?: string;
}> {
  const t0 = performance.now();

  // Run OCR on the redacted image
  let ocrResult: OcrResult;
  try {
    ocrResult = await runOcr({ imageDataUrl, lang: "auto" });
  } catch (err) {
    // OCR unavailable (models not downloaded, backend init failed) means
    // verification could not be ATTEMPTED. That is not the same as
    // verification failing, and must not be reported as residual PII —
    // the old `-1` rendered in the UI as "-1 PII regions residual".
    return {
      passed: false,
      residualPII: 0,
      wordsFound: 0,
      ocrTimeMs: performance.now() - t0,
      ran: false,
      unavailableReason: err instanceof Error ? err.message : "OCR unavailable",
    };
  }

  const ocrTimeMs = performance.now() - t0;

  // Check for residual PII using the same checksum-gated scanner as the
  // rest of the system. Bare regex here reported any 12-digit number left
  // on the page as a redaction failure.
  let residualPII = 0;
  for (const word of ocrResult.words) {
    if (scanTextForPII(word.text).length > 0) residualPII++;
  }

  return {
    passed: residualPII === 0,
    residualPII,
    wordsFound: ocrResult.words.length,
    ocrTimeMs,
    ran: true,
  };
}

// ── Image Processing Helpers ─────────────────────────────────

/**
 * Multi-pass box blur (Gaussian approximation).
 * 3 passes approximates a Gaussian with sigma ≈ kernel_radius.
 */
function applyBoxBlur(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  passes: number
): void {
  // Read the region pixels
  const imageData = ctx.getImageData(x, y, w, h);
  const data = imageData.data;

  // Apply box blur multiple times
  for (let p = 0; p < passes; p++) {
    const temp = new Uint8ClampedArray(data);
    const radius = 3;

    for (let cy = 0; cy < h; cy++) {
      for (let cx = 0; cx < w; cx++) {
        let r = 0, g = 0, b = 0, count = 0;

        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
              const idx = (ny * w + nx) * 4;
              r += temp[idx];
              g += temp[idx + 1];
              b += temp[idx + 2];
              count++;
            }
          }
        }

        const idx = (cy * w + cx) * 4;
        data[idx] = r / count;
        data[idx + 1] = g / count;
        data[idx + 2] = b / count;
      }
    }
  }

  ctx.putImageData(imageData, x, y);
}

/**
 * Pixelate a region by averaging blocks.
 */
function applyPixelate(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  blockSize: number
): void {
  const imageData = ctx.getImageData(x, y, w, h);
  const data = imageData.data;

  for (let by = 0; by < h; by += blockSize) {
    for (let bx = 0; bx < w; bx += blockSize) {
      let r = 0, g = 0, b = 0, count = 0;

      // Average the block
      for (let dy = 0; dy < blockSize && by + dy < h; dy++) {
        for (let dx = 0; dx < blockSize && bx + dx < w; dx++) {
          const idx = ((by + dy) * w + (bx + dx)) * 4;
          r += data[idx];
          g += data[idx + 1];
          b += data[idx + 2];
          count++;
        }
      }

      r = Math.round(r / count);
      g = Math.round(g / count);
      b = Math.round(b / count);

      // Fill the block with the average color
      for (let dy = 0; dy < blockSize && by + dy < h; dy++) {
        for (let dx = 0; dx < blockSize && bx + dx < w; dx++) {
          const idx = ((by + dy) * w + (bx + dx)) * 4;
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
        }
      }
    }
  }

  ctx.putImageData(imageData, x, y);
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ── Vision PII Detection (runs in offscreen — has canvas) ───

/**
 * Detect PII from a screenshot using vision: face detection + password dots.
 * Returns bounding boxes for visual PII that DOM-only detection misses.
 * Runs in the offscreen document where HTMLCanvasElement is available.
 */
export async function detectVisionPII(
  imageDataUrl: string
): Promise<Array<{
  category: string;
  sensitivity: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  confidence: number;
  detectionMethod: string;
}>> {
  const regions: Array<{
    category: string;
    sensitivity: string;
    boundingBox: { x: number; y: number; width: number; height: number };
    confidence: number;
    detectionMethod: string;
  }> = [];

  try {
    const response = await fetch(imageDataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    // Face detection via SkinDetector heuristic (works in offscreen)
    const faceRegions = detectFacesInOffscreen(ctx, canvas.width, canvas.height);
    for (const face of faceRegions) {
      regions.push({
        category: "face",
        sensitivity: "critical",
        boundingBox: face,
        confidence: 0.7,
        detectionMethod: "Face detected via skin-color + shape heuristic (offscreen)",
      });
    }

    // Password dot detection
    const pwdRegions = detectPasswordDotsInOffscreen(ctx, canvas.width, canvas.height);
    for (const pwd of pwdRegions) {
      regions.push({
        category: "password",
        sensitivity: "critical",
        boundingBox: pwd,
        confidence: 0.85,
        detectionMethod: "Password dot pattern detected (uniform small glyphs in input field)",
      });
    }
  } catch (err) {
    console.warn("[VLESS] Vision PII detection failed:", err);
  }

  return regions;
}

function detectFacesInOffscreen(
  ctx: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number
): Array<{ x: number; y: number; width: number; height: number }> {
  const scale = 4;
  const smallW = Math.floor(width / scale);
  const smallH = Math.floor(height / scale);

  const smallCanvas = new OffscreenCanvas(smallW, smallH);
  const smallCtx = smallCanvas.getContext("2d")!;
  smallCtx.drawImage(ctx.canvas, 0, 0, smallW, smallH);

  const imageData = smallCtx.getImageData(0, 0, smallW, smallH);
  const pixels = imageData.data;

  // HSV skin detection
  const skinMask = new Uint8Array(smallW * smallH);
  for (let y = 0; y < smallH; y++) {
    for (let x = 0; x < smallW; x++) {
      const idx = (y * smallW + x) * 4;
      const r = pixels[idx] / 255;
      const g = pixels[idx + 1] / 255;
      const b = pixels[idx + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const delta = max - min;
      const s = max === 0 ? 0 : delta / max;
      let h = 0;
      if (delta !== 0) {
        if (max === r) h = ((g - b) / delta) % 6;
        else if (max === g) h = (b - r) / delta + 2;
        else h = (r - g) / delta + 4;
        h *= 60;
        if (h < 0) h += 360;
      }
      const isSkinTone = r > g && g > b && (r - b) > 0.05;
      if (h >= 0 && h <= 45 && s >= 0.25 && s <= 0.65 && max >= 0.40 && max <= 0.90 && isSkinTone) {
        skinMask[y * smallW + x] = 1;
      }
    }
  }

  // Simple connected components
  const faces: Array<{ x: number; y: number; width: number; height: number }> = [];
  const visited = new Uint8Array(smallW * smallH);
  const pixelArea = smallW * smallH;

  for (let y = 0; y < smallH; y++) {
    for (let x = 0; x < smallW; x++) {
      const idx = y * smallW + x;
      if (skinMask[idx] && !visited[idx]) {
        // BFS flood fill
        const queue = [{ x, y }];
        visited[idx] = 1;
        let minX = x, maxX = x, minY = y, maxY = y;
        let count = 0;
        while (queue.length > 0) {
          const { x: cx, y: cy } = queue.shift()!;
          count++;
          minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
          minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
          for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
            const nx = cx + dx, ny = cy + dy;
            if (nx >= 0 && nx < smallW && ny >= 0 && ny < smallH && skinMask[ny * smallW + nx] && !visited[ny * smallW + nx]) {
              visited[ny * smallW + nx] = 1;
              queue.push({ x: nx, y: ny });
            }
          }
        }
        const w = maxX - minX + 1;
        const h = maxY - minY + 1;
        const area = w * h;
        const ar = w / h;
        if (ar >= 0.6 && ar <= 1.8 && area >= pixelArea * 0.003 && area <= pixelArea * 0.10) {
          faces.push({
            x: minX * scale, y: minY * scale,
            width: w * scale, height: h * scale,
          });
        }
      }
    }
  }

  return faces;
}

function detectPasswordDotsInOffscreen(
  ctx: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number
): Array<{ x: number; y: number; width: number; height: number }> {
  const imageData = ctx.getImageData(0, 0, width, height);
  const pixels = imageData.data;
  const regions: Array<{ x: number; y: number; width: number; height: number }> = [];
  const rowScanHeight = 20;
  const darkThreshold = 50;

  for (let y = 0; y < height - rowScanHeight; y += rowScanHeight) {
    let darkPixelCount = 0;
    let totalPixels = 0;
    let minX = width, maxX = 0;
    for (let dy = 0; dy < rowScanHeight; dy++) {
      for (let x = 0; x < width; x++) {
        const idx = ((y + dy) * width + x) * 4;
        const brightness = (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 3;
        if (brightness < darkThreshold) {
          darkPixelCount++;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
        totalPixels++;
      }
    }
    const darkRatio = darkPixelCount / totalPixels;
    if (darkRatio >= 0.05 && darkRatio <= 0.4 && maxX - minX > 30) {
      // Check for dot pattern (multiple small dark runs separated by light gaps)
      const midY = y + Math.floor(rowScanHeight / 2);
      const runs: number[] = [];
      let currentRun = 0;
      for (let x = 0; x < width; x++) {
        const idx = (midY * width + x) * 4;
        const brightness = (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 3;
        if (brightness < darkThreshold) { currentRun++; }
        else { if (currentRun > 0) { runs.push(currentRun); currentRun = 0; } }
      }
      if (currentRun > 0) runs.push(currentRun);
      const avgRun = runs.length > 0 ? runs.reduce((a, b) => a + b, 0) / runs.length : 0;
      if (avgRun >= 2 && avgRun <= 10 && runs.length >= 3) {
        regions.push({ x: minX, y, width: maxX - minX, height: rowScanHeight });
      }
    }
  }

  return regions;
}
