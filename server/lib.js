/**
 * OpenGhost library — pure helpers, schemas, and tool implementations.
 * Importable by both the boot script (index.js) and the test suite.
 *
 * @license MIT
 * @author Ghostoli Production
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import OpenAI, { toFile } from "openai";
import { PNG } from "pngjs";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration — read once at module load from environment
// ─────────────────────────────────────────────────────────────────────────────

/** @typedef {{ apiKey: string, model: string, defaultQuality: string, outputDir: string, styleReference: string, timeoutMs: number, autoOpen: boolean }} OpenGhostConfig */

/**
 * Expand ${HOME} or ~/ prefix in a path string to the actual home directory.
 * Claude Desktop does NOT always expand ${HOME} in manifest user_config defaults,
 * so we handle it ourselves to be robust across versions.
 * @param {string|undefined} p
 * @returns {string|undefined}
 */
function expandHome(p) {
  if (!p) return p;
  if (p.startsWith("${HOME}")) return os.homedir() + p.slice("${HOME}".length);
  if (p.startsWith("$HOME/")) return path.join(os.homedir(), p.slice("$HOME/".length));
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return p;
}

/** @type {OpenGhostConfig} */
export const CONFIG = {
  apiKey: process.env.OPENAI_API_KEY?.trim() ?? "",
  model: process.env.OPENGHOST_MODEL?.trim() || "gpt-image-2",
  defaultQuality: (process.env.OPENGHOST_DEFAULT_QUALITY?.trim() || "medium").toLowerCase(),
  outputDir: expandHome(process.env.OPENGHOST_OUTPUT_DIR?.trim()) || path.join(os.homedir(), "openghost-images"),
  styleReference: expandHome(process.env.OPENGHOST_STYLE_REFERENCE?.trim()) || "",
  timeoutMs: (Number(process.env.OPENGHOST_TIMEOUT_S) || 180) * 1000,
  // Opt-in: after saving, open the image in the OS default viewer so the user
  // sees it without opening the file manually. Off by default (would spawn many
  // windows during batch/asset-library runs). Accepts 1/true/yes/on.
  autoOpen: /^(1|true|yes|on)$/i.test(process.env.OPENGHOST_AUTO_OPEN?.trim() || ""),
};

export const ALLOWED_QUALITIES = new Set(["low", "medium", "high", "auto"]);
export const ALLOWED_SIZES = new Set(["1024x1024", "1024x1536", "1536x1024", "auto"]);
export const MAX_SAFE_SIZE = "1024x1024";

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (unit-testable)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a quality value, falling back to default if missing/invalid.
 * @param {string|undefined} q
 * @returns {string}
 */
export function normalizeQuality(q) {
  if (!q) return CONFIG.defaultQuality;
  const lower = String(q).toLowerCase();
  return ALLOWED_QUALITIES.has(lower) ? lower : CONFIG.defaultQuality;
}

/**
 * Cap size to MAX_SAFE_SIZE (defense in depth over schema enum).
 * @param {string|undefined} s
 * @returns {[string, boolean]} [cappedSize, wasCapped]
 */
export function capSize(s) {
  if (!s || !ALLOWED_SIZES.has(s) || s === "auto") return [MAX_SAFE_SIZE, false];
  if (s === MAX_SAFE_SIZE) return [s, false];
  return [MAX_SAFE_SIZE, true];
}

/**
 * Resolve output path: absolute as-is, relative under outputDir, missing = timestamp.
 * Always ensures .png extension and parent directory exists.
 * @param {string|undefined} outputPath
 * @returns {string} absolute file path
 */
export function resolveOutputPath(outputPath) {
  let p = outputPath?.trim();
  if (p) p = expandHome(p); // handle ${HOME} / ~ in agent-passed paths too
  if (!p) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    p = `image-${ts}.png`;
  }
  if (!path.isAbsolute(p)) p = path.join(CONFIG.outputDir, p);
  if (path.extname(p).toLowerCase() !== ".png") p = `${p}.png`;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

/**
 * Resolve the output path, but never let an unwritable requested path fail the
 * whole generation. Agents running in a Linux sandbox (Claude Code / Cowork)
 * often pass a sandbox path like "/mnt/user-data/outputs/foo.png" that does not
 * exist on the user's Mac — `resolveOutputPath` then throws on mkdir. In that
 * case we fall back to the configured output directory so the image is still
 * produced AND the inline preview still renders.
 *
 * @param {string|undefined} outputPath
 * @returns {{ path: string, fellBack: boolean, requested?: string }}
 */
export function resolveOutputPathWithFallback(outputPath) {
  try {
    return { path: resolveOutputPath(outputPath), fellBack: false };
  } catch (err) {
    // No requested path means the configured output dir itself failed — nothing
    // to fall back to, so surface the real error.
    if (!outputPath?.trim()) throw err;
    console.error(
      `[openghost] output_path "${outputPath}" is not writable (${err?.message ?? err}); falling back to ${CONFIG.outputDir}`
    );
    return { path: resolveOutputPath(undefined), fellBack: true, requested: outputPath };
  }
}

/**
 * Infer MIME type from file extension.
 * @param {string} p
 * @returns {string} MIME type
 */
export function inferMime(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

/**
 * Translate OpenAI SDK errors into actionable messages for the agent.
 * @param {unknown} err
 * @returns {string}
 */
export function formatOpenAIError(err) {
  const msg = String(err?.message ?? err);
  if (/api[_-]?key|authentication|401/i.test(msg)) {
    return "OpenAI API key missing or invalid. Open Claude Desktop → Settings → Extensions → OpenGhost to set it. Get a key at https://platform.openai.com/api-keys";
  }
  if (/rate.?limit|429/i.test(msg)) {
    return "OpenAI rate limit hit. Wait a few seconds and retry. Free tier = 5 images/min; upgrade tier at https://platform.openai.com/settings/organization/limits";
  }
  if (/billing|quota|insufficient/i.test(msg)) {
    return "OpenAI billing/quota issue. Add credit at https://platform.openai.com/usage";
  }
  if (/safety|moderation|policy/i.test(msg)) {
    return "Prompt rejected by OpenAI safety system. Reword to remove references to real people, violence, or explicit content.";
  }
  if (/model.*not.*found|404/i.test(msg)) {
    return `Model "${CONFIG.model}" not available on your account. Try a different model in extension settings (gpt-image-1, gpt-image-1-mini, gpt-image-1.5, gpt-image-2).`;
  }
  if (/timeout|timed out/i.test(msg)) {
    return `Request timed out after ${CONFIG.timeoutMs / 1000}s. Try a lower quality setting, or increase the timeout in extension settings.`;
  }
  return `OpenAI error: ${msg}`;
}

/**
 * Approximate per-image cost (USD) at 1024x1024.
 * @param {string} model
 * @param {string} quality
 * @returns {number|null}
 */
export function imagePriceUsd(model, quality) {
  const table = {
    "gpt-image-2": { low: 0.005, medium: 0.053, high: 0.211 },
    "gpt-image-1.5": { low: 0.009, medium: 0.034, high: 0.133 },
    "gpt-image-1": { low: 0.011, medium: 0.04, high: 0.167 },
    "gpt-image-1-mini": { low: 0.005, medium: 0.011, high: 0.036 },
  };
  return table[model]?.[quality] ?? null;
}

function formatSuccess(result, model, quality, size, extraNotes = []) {
  const kb = (result.sizeBytes / 1024).toFixed(0);
  const cost = imagePriceUsd(model, quality);
  const costStr = cost != null ? ` ~$${cost.toFixed(3)}` : "";
  const notes = extraNotes.length ? `\n${extraNotes.join("\n")}` : "";
  return `Generated image with ${model} (quality=${quality}, size=${size}${costStr})\nSaved: ${result.path} (${kb} KB)${notes}`;
}

// Constants for thumbnail generation
export const THUMBNAIL_MAX_DIM = 384; // px — longest edge of the inline preview (starting point)
export const THUMBNAIL_MIN_DIM = 96; // px — floor; never shrink the longest edge below this
export const THUMBNAIL_TIMEOUT_MS = 10_000; // 10s — generous; a real PNG decode takes ms

// Claude Desktop silently DROPS (does not render) a tool-result content block
// whose payload exceeds its display threshold (~150k characters), even though
// the block is still delivered to the model and stays under the 1MB hard cap.
// We keep the inline thumbnail's base64 well under that threshold so it ALWAYS
// renders in the chat. See README "MCP image content" and CHANGELOG v1.0.8.
export const THUMBNAIL_MAX_B64_CHARS = 90_000;

/**
 * Exact length of the standard base64 encoding (with padding, no newlines)
 * of an N-byte buffer — i.e. what `buffer.toString("base64").length` returns.
 * @param {number} byteLength
 * @returns {number}
 */
export function base64Length(byteLength) {
  if (!Number.isFinite(byteLength) || byteLength < 0) {
    throw new Error(`base64Length: byteLength must be a non-negative number, got ${byteLength}`);
  }
  return Math.ceil(byteLength / 3) * 4;
}

/**
 * Resize a PNG buffer to a smaller PNG buffer using nearest-neighbor sampling.
 * Pure JS via pngjs — no native deps required, works cross-platform.
 *
 * @param {Buffer} pngBuffer - source PNG bytes
 * @param {number} maxDim - max width/height for thumbnail (preserves aspect ratio)
 * @returns {Promise<Buffer>} thumbnail PNG bytes
 * @throws if the input is not a valid PNG or processing exceeds THUMBNAIL_TIMEOUT_MS
 */
export async function makeThumbnail(pngBuffer, maxDim = THUMBNAIL_MAX_DIM) {
  if (!Buffer.isBuffer(pngBuffer) || pngBuffer.length === 0) {
    throw new Error("makeThumbnail: input must be a non-empty Buffer");
  }
  if (!Number.isFinite(maxDim) || maxDim < 1) {
    throw new Error(`makeThumbnail: maxDim must be a positive number, got ${maxDim}`);
  }

  // Race against a timeout so a corrupted PNG cannot hang the server. The timer
  // is unref'd and cleared once the race settles so it never keeps the event
  // loop (or the MCP process / a test run) alive after we already have a result.
  let timer;
  return await Promise.race([
    new Promise((resolve, reject) => {
      new PNG().parse(pngBuffer, (err, src) => {
        if (err) return reject(err);

        const { width: srcW, height: srcH } = src;
        if (!srcW || !srcH) return reject(new Error(`makeThumbnail: invalid PNG dimensions ${srcW}x${srcH}`));

        // Preserve aspect ratio, scale longest edge to maxDim
        const scale = Math.min(1, maxDim / Math.max(srcW, srcH)); // never upscale
        const dstW = Math.max(1, Math.round(srcW * scale));
        const dstH = Math.max(1, Math.round(srcH * scale));

        const dst = new PNG({ width: dstW, height: dstH });

        // Nearest-neighbor downsample (fast, good enough for previews)
        for (let y = 0; y < dstH; y++) {
          const srcY = Math.min(srcH - 1, Math.floor((y + 0.5) * srcH / dstH));
          for (let x = 0; x < dstW; x++) {
            const srcX = Math.min(srcW - 1, Math.floor((x + 0.5) * srcW / dstW));
            const srcIdx = (srcY * srcW + srcX) * 4;
            const dstIdx = (y * dstW + x) * 4;
            dst.data[dstIdx]     = src.data[srcIdx];     // R
            dst.data[dstIdx + 1] = src.data[srcIdx + 1]; // G
            dst.data[dstIdx + 2] = src.data[srcIdx + 2]; // B
            dst.data[dstIdx + 3] = src.data[srcIdx + 3]; // A
          }
        }

        const chunks = [];
        dst.pack()
          .on("data", (c) => chunks.push(c))
          .on("end", () => resolve(Buffer.concat(chunks)))
          .on("error", reject);
      });
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`makeThumbnail: timed out after ${THUMBNAIL_TIMEOUT_MS}ms`)), THUMBNAIL_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Produce a PNG thumbnail whose base64 encoding fits within `maxB64Chars`, so
 * the inline preview stays under Claude Desktop's tool-result display threshold
 * and actually renders in the chat.
 *
 * Strategy: start at `startDim` and step the longest edge down by 20% until the
 * encoded size fits, or `minDim` is reached. High-entropy (photographic) images
 * compress worse and settle at a smaller dimension; flat illustrations keep the
 * full `startDim`. The 96px floor guarantees the loop terminates well under
 * budget for any realistic input (a 96px noise PNG is ~42k base64 chars).
 *
 * @param {Buffer} pngBuffer - source PNG bytes
 * @param {{ maxB64Chars?: number, startDim?: number, minDim?: number }} [opts]
 * @returns {Promise<{ buffer: Buffer, dim: number, b64Chars: number, withinBudget: boolean }>}
 */
export async function makeBoundedThumbnail(pngBuffer, opts = {}) {
  const maxB64Chars = opts.maxB64Chars ?? THUMBNAIL_MAX_B64_CHARS;
  const startDim = opts.startDim ?? THUMBNAIL_MAX_DIM;
  const minDim = opts.minDim ?? THUMBNAIL_MIN_DIM;

  let dim = startDim;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const buffer = await makeThumbnail(pngBuffer, dim);
    const b64Chars = base64Length(buffer.length);
    const result = { buffer, dim, b64Chars, withinBudget: b64Chars <= maxB64Chars };
    if (result.withinBudget || dim <= minDim) return result;
    dim = Math.max(minDim, Math.floor(dim * 0.8));
  }
}

/**
 * Build the MCP success response with an inline thumbnail preview.
 * The full-resolution PNG remains on disk at `saved.path`; a size-bounded
 * thumbnail is sent inline so it ALWAYS renders in the chat — its base64 is
 * kept under Claude Desktop's tool-result display threshold (see
 * THUMBNAIL_MAX_B64_CHARS), which a full 1024px image would blow past and be
 * silently dropped by the client.
 *
 * If thumbnail generation fails (corrupted PNG, decode error, timeout) or the
 * preview cannot be brought under budget, we fall back to text-only with a
 * clear note explaining the path is the source of truth.
 *
 * @param {string} b64 - base64 PNG from OpenAI
 * @param {{path: string, sizeBytes: number}} saved - disk file info
 * @param {string} model
 * @param {string} quality
 * @param {string} size
 * @param {string[]} extraNotes
 * @returns {Promise<{content: Array<{type: string, [k: string]: any}>}>}
 */
export async function buildSuccessResponse(b64, saved, model, quality, size, extraNotes = []) {
  const notes = [...extraNotes];
  const fullBuf = Buffer.from(b64, "base64");

  try {
    const thumb = await makeBoundedThumbnail(fullBuf);
    if (thumb.withinBudget) {
      console.error(
        `[openghost] inline thumbnail INCLUDED (${Math.round(thumb.buffer.length / 1024)}KB, ${thumb.dim}px, ${thumb.b64Chars} b64 chars)`
      );
      return {
        content: [
          { type: "image", data: thumb.buffer.toString("base64"), mimeType: "image/png" },
          { type: "text", text: formatSuccess(saved, model, quality, size, notes) },
        ],
      };
    }
    // Unreachable for realistic input (the 96px floor is ~42k chars), but stay
    // safe: never emit an image block the client would silently drop.
    console.error(
      `[openghost] thumbnail OVER BUDGET at ${thumb.dim}px (${thumb.b64Chars} > ${THUMBNAIL_MAX_B64_CHARS} chars); sending text-only`
    );
    notes.push("Inline preview unavailable (exceeded size budget) — open the file path above to view.");
    return { content: [{ type: "text", text: formatSuccess(saved, model, quality, size, notes) }] };
  } catch (thumbErr) {
    console.error(`[openghost] thumbnail FAILED:`, thumbErr?.message ?? thumbErr);
    notes.push(`Inline preview unavailable (${thumbErr?.message ?? "thumbnail failed"}) — open the file path above to view.`);
    return {
      content: [{ type: "text", text: formatSuccess(saved, model, quality, size, notes) }],
    };
  }
}

async function saveBase64Png(b64, outPath) {
  const buf = Buffer.from(b64, "base64");
  await fs.promises.writeFile(outPath, buf);
  const size = (await fs.promises.stat(outPath)).size;
  return { path: outPath, sizeBytes: size };
}

/**
 * Map a platform to the command that opens a file in its default app.
 * Pure + exported so it's unit-testable without spawning anything.
 * @param {NodeJS.Platform} platform
 * @param {string} filePath
 * @returns {{ cmd: string, args: string[] } | null} null if unsupported
 */
export function viewerCommand(platform, filePath) {
  switch (platform) {
    case "darwin":
      return { cmd: "open", args: [filePath] };
    case "win32":
      // `start` is a cmd builtin; empty "" is the window-title argument.
      return { cmd: "cmd", args: ["/c", "start", "", filePath] };
    case "linux":
      return { cmd: "xdg-open", args: [filePath] };
    default:
      return null;
  }
}

/**
 * Best-effort: open a saved image in the OS default viewer (Preview on macOS)
 * so the user sees it inline-ish without navigating folders. NEVER throws — a
 * viewer failure must not break an otherwise successful generation. Args are
 * passed as an array (no shell) so the file path can't be interpreted.
 * @param {string} filePath
 * @returns {boolean} whether an open command was launched
 */
export function openInViewer(filePath) {
  const c = viewerCommand(process.platform, filePath);
  if (!c) {
    console.error(`[openghost] auto-open: unsupported platform ${process.platform}`);
    return false;
  }
  try {
    const child = spawn(c.cmd, c.args, { detached: true, stdio: "ignore" });
    child.on("error", (err) => console.error(`[openghost] auto-open failed: ${err?.message ?? err}`));
    child.unref();
    console.error(`[openghost] auto-opened ${filePath} via ${c.cmd}`);
    return true;
  } catch (err) {
    console.error(`[openghost] auto-open failed: ${err?.message ?? err}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI client (lazy init)
// ─────────────────────────────────────────────────────────────────────────────

let _client = null;
function getClient() {
  if (_client) return _client;
  if (!CONFIG.apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Open Claude Desktop → Settings → Extensions → OpenGhost → enter your API key (get one at https://platform.openai.com/api-keys)."
    );
  }
  _client = new OpenAI({
    apiKey: CONFIG.apiKey,
    timeout: CONFIG.timeoutMs,
    maxRetries: 1, // Conservative: max 2 attempts per call
  });
  return _client;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool schemas
// ─────────────────────────────────────────────────────────────────────────────

const generateImageSchema = {
  type: "object",
  required: ["prompt"],
  properties: {
    prompt: {
      type: "string",
      description:
        "Detailed description of the image. Be specific about style, composition, colors, subject, atmosphere.",
      minLength: 1,
      maxLength: 32000,
    },
    output_path: {
      type: "string",
      description:
        "Optional. Absolute path (recommended) or relative path resolved under the configured output directory. PNG extension auto-added. If omitted, a timestamped filename is generated.",
    },
    quality: {
      type: "string",
      enum: ["low", "medium", "high", "auto"],
      description:
        "Quality tier. low ~$0.006, medium ~$0.053 (recommended), high ~$0.211. If omitted, uses the default from extension settings.",
    },
    size: {
      type: "string",
      enum: ["1024x1024"],
      description: "Image size. Hard-capped at 1024x1024 by this extension to prevent runaway costs.",
    },
    background: {
      type: "string",
      enum: ["auto", "transparent", "opaque"],
      description: "Optional. transparent produces alpha channel — useful for app icons or sticker assets.",
    },
    model: {
      type: "string",
      enum: ["gpt-image-2", "gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini"],
      description: "Optional. Override the default model for this call. If omitted, uses the model from extension settings.",
    },
  },
  additionalProperties: false,
};

const editImageSchema = {
  type: "object",
  required: ["prompt", "reference_images"],
  properties: {
    prompt: {
      type: "string",
      description: "Description of the desired output. Reference images guide style/composition/subject.",
      minLength: 1,
      maxLength: 32000,
    },
    reference_images: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 16,
      description:
        "Absolute file paths to 1-16 reference PNG/JPG/WebP images. The model uses them as visual context. Pass the same canonical reference across multiple calls to lock visual identity across an asset library.",
    },
    output_path: {
      type: "string",
      description:
        "Optional. Absolute path or relative path resolved under the configured output directory. PNG extension auto-added.",
    },
    quality: {
      type: "string",
      enum: ["low", "medium", "high", "auto"],
      description: "Quality tier. If omitted, uses the default from extension settings.",
    },
    size: {
      type: "string",
      enum: ["1024x1024"],
      description: "Image size. Hard-capped at 1024x1024.",
    },
    mask_path: {
      type: "string",
      description:
        "Optional. Absolute path to a mask PNG with transparency. Transparent pixels mark areas to edit, opaque pixels are preserved. Only valid when reference_images has exactly 1 image.",
    },
    model: {
      type: "string",
      enum: ["gpt-image-2", "gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini"],
      description: "Optional. Override the default model for this call. If omitted, uses the model from extension settings.",
    },
  },
  additionalProperties: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool implementations
// ─────────────────────────────────────────────────────────────────────────────

export async function generateImage(args) {
  try {
    const prompt = args.prompt?.trim();
    if (!prompt) {
      return { isError: true, content: [{ type: "text", text: "ERROR: prompt is required and cannot be empty" }] };
    }

    const quality = normalizeQuality(args.quality);
    const [size, wasCapped] = capSize(args.size);
    const { path: outPath, fellBack, requested } = resolveOutputPathWithFallback(args.output_path);
    const model = args.model?.trim() || CONFIG.model;

    try {
      const client = getClient();
      const params = { model, prompt, n: 1, size, quality };
      if (args.background && args.background !== "auto") {
        params.background = args.background;
      }
      console.error(`[openghost] generate_image: model=${model} quality=${quality} size=${size} promptLen=${prompt.length}`);
      const response = await client.images.generate(params);

      const b64 = response.data?.[0]?.b64_json;
      if (!b64) {
        console.error("[openghost] generate_image: no b64_json in response", JSON.stringify(response).slice(0, 500));
        return { isError: true, content: [{ type: "text", text: "ERROR: OpenAI returned no image data. Check Claude Desktop developer logs for the raw response." }] };
      }
      const saved = await saveBase64Png(b64, outPath);
      const notes = [];
      if (fellBack) notes.push(`Note: "${requested}" wasn't writable on this machine — saved to ${path.dirname(outPath)} instead.`);
      if (wasCapped) notes.push(`Note: requested size capped to ${MAX_SAFE_SIZE} by extension policy.`);
      if (CONFIG.autoOpen && openInViewer(saved.path)) notes.push("Opened the image in your default viewer (auto-open is on).");
      console.error(`[openghost] generate_image: success, saved ${saved.path} (${saved.sizeBytes} bytes)`);
      return await buildSuccessResponse(b64, saved, model, quality, size, notes);
    } catch (err) {
      const rawMsg = err?.message ?? String(err);
      const errStatus = err?.status ?? err?.response?.status ?? "unknown";
      console.error(`[openghost] generate_image FAILED status=${errStatus} message="${rawMsg}"`);
      if (err?.response?.data) {
        console.error(`[openghost] OpenAI response body:`, JSON.stringify(err.response.data).slice(0, 1000));
      }
      if (err?.stack) console.error(`[openghost] stack:`, err.stack.slice(0, 800));
      return { isError: true, content: [{ type: "text", text: `ERROR: ${formatOpenAIError(err)}` }] };
    }
  } catch (outerErr) {
    // Last-resort catch — should never hit, but ensures the tool always returns a valid MCP result
    console.error(`[openghost] generate_image OUTER catch:`, outerErr?.stack ?? outerErr);
    return { isError: true, content: [{ type: "text", text: `ERROR: Unexpected internal error: ${outerErr?.message ?? outerErr}` }] };
  }
}

export async function editImage(args) {
  try {
    const prompt = args.prompt?.trim();
    const refs = Array.isArray(args.reference_images) ? args.reference_images : [];
    if (!prompt) {
      return { isError: true, content: [{ type: "text", text: "ERROR: prompt is required and cannot be empty" }] };
    }
    if (refs.length === 0) {
      return { isError: true, content: [{ type: "text", text: "ERROR: at least one reference_images path is required" }] };
    }

    const resolvedRefs = refs.map((r) => (path.isAbsolute(r) ? r : path.resolve(r)));
    for (const r of resolvedRefs) {
      if (!fs.existsSync(r)) {
        return { isError: true, content: [{ type: "text", text: `ERROR: Reference image not found: ${r}` }] };
      }
    }

    let maskAbs = null;
    if (args.mask_path) {
      if (resolvedRefs.length !== 1) {
        return { isError: true, content: [{ type: "text", text: "ERROR: mask_path requires exactly 1 reference_image" }] };
      }
      maskAbs = path.isAbsolute(args.mask_path) ? args.mask_path : path.resolve(args.mask_path);
      if (!fs.existsSync(maskAbs)) {
        return { isError: true, content: [{ type: "text", text: `ERROR: Mask not found: ${maskAbs}` }] };
      }
    }

    const quality = normalizeQuality(args.quality);
    const [size, wasCapped] = capSize(args.size);
    const { path: outPath, fellBack, requested } = resolveOutputPathWithFallback(args.output_path);
    const model = args.model?.trim() || CONFIG.model;

    const openStreams = [];
    try {
      const client = getClient();

      const refUploadables = await Promise.all(
        resolvedRefs.map(async (p) => {
          const stream = fs.createReadStream(p);
          openStreams.push(stream);
          return await toFile(stream, path.basename(p), { type: inferMime(p) });
        })
      );

      let maskUploadable = null;
      if (maskAbs) {
        const stream = fs.createReadStream(maskAbs);
        openStreams.push(stream);
        maskUploadable = await toFile(stream, path.basename(maskAbs), { type: "image/png" });
      }

      const params = {
        model,
        image: refUploadables.length === 1 ? refUploadables[0] : refUploadables,
        prompt,
        n: 1,
        size,
        quality,
      };
      if (maskUploadable) params.mask = maskUploadable;

      console.error(`[openghost] edit_image: model=${model} quality=${quality} refs=${refUploadables.length}${maskAbs ? " +mask" : ""}`);
      const response = await client.images.edit(params);
      const b64 = response.data?.[0]?.b64_json;
      if (!b64) {
        console.error("[openghost] edit_image: no b64_json in response", JSON.stringify(response).slice(0, 500));
        return { isError: true, content: [{ type: "text", text: "ERROR: OpenAI returned no image data. Check Claude Desktop developer logs for the raw response." }] };
      }
      const saved = await saveBase64Png(b64, outPath);
      const notes = [];
      notes.push(`Used: ${resolvedRefs.length === 1 ? "1 reference image" : `${resolvedRefs.length} reference images`}${maskAbs ? " + mask" : ""}`);
      if (fellBack) notes.push(`Note: "${requested}" wasn't writable on this machine — saved to ${path.dirname(outPath)} instead.`);
      if (wasCapped) notes.push(`Note: requested size capped to ${MAX_SAFE_SIZE} by extension policy.`);
      if (CONFIG.autoOpen && openInViewer(saved.path)) notes.push("Opened the image in your default viewer (auto-open is on).");
      console.error(`[openghost] edit_image: success, saved ${saved.path} (${saved.sizeBytes} bytes)`);
      return await buildSuccessResponse(b64, saved, model, quality, size, notes);
    } catch (err) {
      const rawMsg = err?.message ?? String(err);
      const errStatus = err?.status ?? err?.response?.status ?? "unknown";
      console.error(`[openghost] edit_image FAILED status=${errStatus} message="${rawMsg}"`);
      if (err?.response?.data) {
        console.error(`[openghost] OpenAI response body:`, JSON.stringify(err.response.data).slice(0, 1000));
      }
      if (err?.stack) console.error(`[openghost] stack:`, err.stack.slice(0, 800));
      return { isError: true, content: [{ type: "text", text: `ERROR: ${formatOpenAIError(err)}` }] };
    } finally {
      for (const s of openStreams) {
        try { s.destroy(); } catch { /* already closed */ }
      }
    }
  } catch (outerErr) {
    console.error(`[openghost] edit_image OUTER catch:`, outerErr?.stack ?? outerErr);
    return { isError: true, content: [{ type: "text", text: `ERROR: Unexpected internal error: ${outerErr?.message ?? outerErr}` }] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool registry (consumed by index.js)
// ─────────────────────────────────────────────────────────────────────────────

export const TOOLS = [
  {
    name: "generate_image",
    description:
      "Generate an image from a text prompt using OpenAI's GPT Image 2 (or configured model). Smart defaults: medium quality (~$0.053/image), 1024x1024 max, 1 image per call. Pass `output_path` to save to a specific location; otherwise a timestamped file is created in the configured output directory.",
    inputSchema: generateImageSchema,
  },
  {
    name: "edit_image",
    description:
      "Generate an image using 1-16 reference images for style consistency. Pass the same canonical reference image across multiple calls to lock visual identity across an asset library (recommended for consistent illustration packs). Optional mask_path enables inpainting (transparent = edit area, opaque = preserve).",
    inputSchema: editImageSchema,
  },
];
