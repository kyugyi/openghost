/**
 * OpenGhost unit tests — pure helpers, thumbnailing, and response building.
 *
 * Reconstructed for v1.0.8 from server/lib.js. Covers the cost/path/error
 * helpers plus the inline-preview pipeline (makeThumbnail, makeBoundedThumbnail,
 * buildSuccessResponse) that keeps the image payload under Claude Desktop's
 * tool-result display threshold.
 *
 * Run: node --test tests/unit.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

// Point the output dir at a throwaway tmp location BEFORE importing lib.js,
// since CONFIG is frozen at module load and resolveOutputPath creates dirs.
const TMP_OUT = fs.mkdtempSync(path.join(os.tmpdir(), "openghost-unit-"));
process.env.OPENGHOST_OUTPUT_DIR = TMP_OUT;
process.env.OPENGHOST_DEFAULT_QUALITY = "medium";
delete process.env.OPENGHOST_MODEL; // exercise the gpt-image-2 default

const {
  CONFIG,
  MAX_SAFE_SIZE,
  normalizeQuality,
  capSize,
  resolveOutputPath,
  resolveOutputPathWithFallback,
  inferMime,
  formatOpenAIError,
  imagePriceUsd,
  base64Length,
  viewerCommand,
  openInViewer,
  makeThumbnail,
  makeBoundedThumbnail,
  buildSuccessResponse,
  generateImage,
  editImage,
  THUMBNAIL_MAX_DIM,
  THUMBNAIL_MIN_DIM,
  THUMBNAIL_MAX_B64_CHARS,
} = await import("../server/lib.js");

// ── helpers for building test PNGs ──────────────────────────────────────────
function packPng(png) {
  const chunks = [];
  return new Promise((resolve) =>
    png.pack().on("data", (c) => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks)))
  );
}
/** Incompressible RGBA PNG — worst case for size. */
function noisePng(w, h = w) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i++) png.data[i] = (Math.random() * 256) | 0;
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  return packPng(png);
}
/** Flat single-colour RGBA PNG — compresses to almost nothing. */
function flatPng(w, h = w) {
  const png = new PNG({ width: w, height: h });
  png.data.fill(0);
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  return packPng(png);
}
function pngDims(buf) {
  return new Promise((resolve, reject) =>
    new PNG().parse(buf, (err, png) => (err ? reject(err) : resolve({ width: png.width, height: png.height })))
  );
}

test.after(() => fs.rmSync(TMP_OUT, { recursive: true, force: true }));

// ── normalizeQuality ────────────────────────────────────────────────────────
test("normalizeQuality: undefined falls back to configured default", () => {
  assert.equal(normalizeQuality(undefined), CONFIG.defaultQuality);
});
test("normalizeQuality: empty string falls back to default", () => {
  assert.equal(normalizeQuality(""), CONFIG.defaultQuality);
});
test("normalizeQuality: valid values pass through", () => {
  for (const q of ["low", "medium", "high", "auto"]) assert.equal(normalizeQuality(q), q);
});
test("normalizeQuality: is case-insensitive", () => {
  assert.equal(normalizeQuality("HIGH"), "high");
  assert.equal(normalizeQuality("Low"), "low");
});
test("normalizeQuality: invalid value falls back to default", () => {
  assert.equal(normalizeQuality("ultra"), CONFIG.defaultQuality);
});

// ── capSize ─────────────────────────────────────────────────────────────────
test("capSize: undefined returns max safe size, not capped", () => {
  assert.deepEqual(capSize(undefined), [MAX_SAFE_SIZE, false]);
});
test("capSize: 'auto' returns max safe size, not capped", () => {
  assert.deepEqual(capSize("auto"), [MAX_SAFE_SIZE, false]);
});
test("capSize: invalid size returns max safe size, not capped", () => {
  assert.deepEqual(capSize("4096x4096"), [MAX_SAFE_SIZE, false]);
});
test("capSize: exact max size returns unchanged, not capped", () => {
  assert.deepEqual(capSize("1024x1024"), ["1024x1024", false]);
});
test("capSize: larger allowed sizes are capped (flagged true)", () => {
  assert.deepEqual(capSize("1024x1536"), [MAX_SAFE_SIZE, true]);
  assert.deepEqual(capSize("1536x1024"), [MAX_SAFE_SIZE, true]);
});

// ── resolveOutputPath ───────────────────────────────────────────────────────
test("resolveOutputPath: absolute path with .png is preserved", () => {
  const p = path.join(TMP_OUT, "sub", "pic.png");
  assert.equal(resolveOutputPath(p), p);
  assert.ok(fs.existsSync(path.dirname(p)), "parent dir is created");
});
test("resolveOutputPath: appends .png when extension missing", () => {
  const p = path.join(TMP_OUT, "noext");
  assert.equal(resolveOutputPath(p), `${p}.png`);
});
test("resolveOutputPath: relative path resolves under output dir", () => {
  const out = resolveOutputPath("rel/name.png");
  assert.equal(out, path.join(CONFIG.outputDir, "rel/name.png"));
});
test("resolveOutputPath: missing path yields timestamped png under output dir", () => {
  const out = resolveOutputPath(undefined);
  assert.equal(path.dirname(out), CONFIG.outputDir);
  assert.match(path.basename(out), /^image-.*\.png$/);
});
test("resolveOutputPath: expands ${HOME} prefix", () => {
  const out = resolveOutputPath("${HOME}/openghost-test-xyz/a.png");
  assert.equal(out, path.join(os.homedir(), "openghost-test-xyz/a.png"));
  fs.rmSync(path.join(os.homedir(), "openghost-test-xyz"), { recursive: true, force: true });
});
test("resolveOutputPath: expands ~/ prefix", () => {
  const out = resolveOutputPath("~/openghost-test-tilde/a");
  assert.equal(out, path.join(os.homedir(), "openghost-test-tilde/a.png"));
  fs.rmSync(path.join(os.homedir(), "openghost-test-tilde"), { recursive: true, force: true });
});

// ── resolveOutputPathWithFallback (v1.0.9) ──────────────────────────────────
test("resolveOutputPathWithFallback: a writable path is used as-is", () => {
  const p = path.join(TMP_OUT, "ok", "a.png");
  const r = resolveOutputPathWithFallback(p);
  assert.equal(r.fellBack, false);
  assert.equal(r.path, p);
});
test("resolveOutputPathWithFallback: undefined uses the default dir, no fallback", () => {
  const r = resolveOutputPathWithFallback(undefined);
  assert.equal(r.fellBack, false);
  assert.equal(path.dirname(r.path), CONFIG.outputDir);
});
test("resolveOutputPathWithFallback: an unwritable requested path falls back to the output dir", () => {
  // Simulates the real trigger: an agent in a Linux sandbox passes a path like
  // "/mnt/user-data/outputs/x.png" that can't be created on the user's machine.
  // We force the same failure deterministically by making the parent a FILE.
  const blocker = path.join(TMP_OUT, "blocker");
  fs.writeFileSync(blocker, "x");
  const requested = path.join(blocker, "sub", "img.png");
  const r = resolveOutputPathWithFallback(requested);
  assert.equal(r.fellBack, true);
  assert.equal(r.requested, requested);
  assert.equal(path.dirname(r.path), CONFIG.outputDir);
  assert.ok(fs.existsSync(path.dirname(r.path)), "fallback dir exists");
});

// ── inferMime ───────────────────────────────────────────────────────────────
test("inferMime: png", () => assert.equal(inferMime("/a/b.png"), "image/png"));
test("inferMime: jpg and jpeg", () => {
  assert.equal(inferMime("/a/b.jpg"), "image/jpeg");
  assert.equal(inferMime("/a/b.JPEG"), "image/jpeg");
});
test("inferMime: webp", () => assert.equal(inferMime("/a/b.webp"), "image/webp"));
test("inferMime: unknown extension defaults to png", () => assert.equal(inferMime("/a/b.gif"), "image/png"));
test("inferMime: no extension defaults to png", () => assert.equal(inferMime("/a/b"), "image/png"));

// ── viewerCommand / openInViewer / auto-open (v1.1.0) ───────────────────────
test("viewerCommand: macOS uses `open`", () => {
  assert.deepEqual(viewerCommand("darwin", "/a/b c.png"), { cmd: "open", args: ["/a/b c.png"] });
});
test("viewerCommand: Windows uses cmd start with a title arg", () => {
  assert.deepEqual(viewerCommand("win32", "/a/b.png"), { cmd: "cmd", args: ["/c", "start", "", "/a/b.png"] });
});
test("viewerCommand: Linux uses xdg-open", () => {
  assert.deepEqual(viewerCommand("linux", "/a/b.png"), { cmd: "xdg-open", args: ["/a/b.png"] });
});
test("viewerCommand: unknown platform returns null", () => {
  assert.equal(viewerCommand("sunos", "/a/b.png"), null);
});
test("openInViewer: launches without throwing, returns a boolean", () => {
  // Use a nonexistent path so no real viewer window pops up during the test
  // (e.g. `open /…/nope.png` just prints an error and opens nothing).
  const r = openInViewer(path.join(TMP_OUT, "nope-autoopen.png"));
  assert.equal(typeof r, "boolean");
  if (["darwin", "linux", "win32"].includes(process.platform)) {
    assert.equal(r, true, "the open command was launched on a supported platform");
  }
});
test("CONFIG.autoOpen is off unless OPENGHOST_AUTO_OPEN is set", () => {
  assert.equal(CONFIG.autoOpen, false); // not set in this test env
});

// ── formatOpenAIError ───────────────────────────────────────────────────────
test("formatOpenAIError: auth/401 message", () => {
  assert.match(formatOpenAIError(new Error("Incorrect API key provided")), /API key/i);
  assert.match(formatOpenAIError(new Error("401 Unauthorized")), /API key/i);
});
test("formatOpenAIError: rate limit/429", () => {
  assert.match(formatOpenAIError(new Error("Rate limit reached")), /rate limit/i);
  assert.match(formatOpenAIError(new Error("429 Too Many Requests")), /rate limit/i);
});
test("formatOpenAIError: billing/quota", () => {
  assert.match(formatOpenAIError(new Error("insufficient_quota")), /billing|quota/i);
});
test("formatOpenAIError: safety/moderation", () => {
  assert.match(formatOpenAIError(new Error("flagged by our safety system")), /safety/i);
});
test("formatOpenAIError: model not found mentions configured model", () => {
  const msg = formatOpenAIError(new Error("The model gpt-foo does not exist (404)"));
  assert.match(msg, new RegExp(CONFIG.model));
});
test("formatOpenAIError: timeout mentions the timeout seconds", () => {
  const msg = formatOpenAIError(new Error("request timed out"));
  assert.match(msg, new RegExp(String(CONFIG.timeoutMs / 1000)));
});
test("formatOpenAIError: generic fallback", () => {
  assert.match(formatOpenAIError(new Error("some weird thing")), /^OpenAI error: some weird thing/);
});
test("formatOpenAIError: accepts a bare string", () => {
  assert.match(formatOpenAIError("boom"), /OpenAI error: boom/);
});

// ── imagePriceUsd ───────────────────────────────────────────────────────────
test("imagePriceUsd: known model+quality", () => {
  assert.equal(imagePriceUsd("gpt-image-2", "medium"), 0.053);
  assert.equal(imagePriceUsd("gpt-image-1-mini", "low"), 0.005);
});
test("imagePriceUsd: unknown model returns null", () => {
  assert.equal(imagePriceUsd("dall-e-9", "medium"), null);
});
test("imagePriceUsd: known model, unknown quality returns null", () => {
  assert.equal(imagePriceUsd("gpt-image-2", "auto"), null);
});

// ── base64Length ────────────────────────────────────────────────────────────
test("base64Length: matches Buffer.toString('base64').length", () => {
  for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 10, 99, 1000, 100003]) {
    assert.equal(base64Length(n), Buffer.alloc(n).toString("base64").length, `n=${n}`);
  }
});
test("base64Length: padding boundaries", () => {
  assert.equal(base64Length(0), 0);
  assert.equal(base64Length(1), 4);
  assert.equal(base64Length(3), 4);
  assert.equal(base64Length(4), 8);
});
test("base64Length: throws on negative", () => assert.throws(() => base64Length(-1)));
test("base64Length: throws on NaN", () => assert.throws(() => base64Length(NaN)));

// ── makeThumbnail ───────────────────────────────────────────────────────────
test("makeThumbnail: returns a Buffer", async () => {
  assert.ok(Buffer.isBuffer(await makeThumbnail(await flatPng(512))));
});
test("makeThumbnail: output is a valid, decodable PNG", async () => {
  const { width, height } = await pngDims(await makeThumbnail(await flatPng(512)));
  assert.ok(width > 0 && height > 0);
});
test("makeThumbnail: downscales longest edge to maxDim", async () => {
  const { width, height } = await pngDims(await makeThumbnail(await noisePng(800), 384));
  assert.equal(Math.max(width, height), 384);
});
test("makeThumbnail: honours a custom maxDim", async () => {
  const { width, height } = await pngDims(await makeThumbnail(await flatPng(800), 100));
  assert.equal(Math.max(width, height), 100);
});
test("makeThumbnail: default maxDim is THUMBNAIL_MAX_DIM", async () => {
  const { width, height } = await pngDims(await makeThumbnail(await flatPng(1024)));
  assert.equal(Math.max(width, height), THUMBNAIL_MAX_DIM);
});
test("makeThumbnail: never upscales a small source", async () => {
  const { width, height } = await pngDims(await makeThumbnail(await flatPng(50), 384));
  assert.equal(width, 50);
  assert.equal(height, 50);
});
test("makeThumbnail: preserves aspect ratio for wide images", async () => {
  const { width, height } = await pngDims(await makeThumbnail(await flatPng(800, 400), 384));
  assert.equal(width, 384);
  assert.equal(height, 192);
});
test("makeThumbnail: preserves aspect ratio for tall images", async () => {
  const { width, height } = await pngDims(await makeThumbnail(await flatPng(400, 800), 384));
  assert.equal(width, 192);
  assert.equal(height, 384);
});
test("makeThumbnail: rejects an empty buffer", async () => {
  await assert.rejects(() => makeThumbnail(Buffer.alloc(0)));
});
test("makeThumbnail: rejects a non-buffer input", async () => {
  await assert.rejects(() => makeThumbnail("not a buffer"));
});
test("makeThumbnail: rejects maxDim < 1", async () => {
  const png = await flatPng(64);
  await assert.rejects(() => makeThumbnail(png, 0));
});
test("makeThumbnail: rejects non-finite maxDim", async () => {
  const png = await flatPng(64);
  await assert.rejects(() => makeThumbnail(png, Infinity));
});
test("makeThumbnail: rejects non-PNG bytes", async () => {
  await assert.rejects(() => makeThumbnail(Buffer.from("this is definitely not a png")));
});

// ── makeBoundedThumbnail ────────────────────────────────────────────────────
test("makeBoundedThumbnail: returns the documented shape", async () => {
  const r = await makeBoundedThumbnail(await flatPng(256));
  assert.ok(Buffer.isBuffer(r.buffer));
  assert.equal(typeof r.dim, "number");
  assert.equal(typeof r.b64Chars, "number");
  assert.equal(typeof r.withinBudget, "boolean");
});
test("makeBoundedThumbnail: b64Chars equals base64Length(buffer)", async () => {
  const r = await makeBoundedThumbnail(await noisePng(1024));
  assert.equal(r.b64Chars, base64Length(r.buffer.length));
  assert.equal(r.b64Chars, r.buffer.toString("base64").length);
});
test("makeBoundedThumbnail: worst-case noise still fits the default budget", async () => {
  const r = await makeBoundedThumbnail(await noisePng(1024));
  assert.ok(r.withinBudget, `expected within budget, got ${r.b64Chars}`);
  assert.ok(r.b64Chars <= THUMBNAIL_MAX_B64_CHARS);
});
test("makeBoundedThumbnail: dim stays within [min, start]", async () => {
  const r = await makeBoundedThumbnail(await noisePng(1024));
  assert.ok(r.dim >= THUMBNAIL_MIN_DIM && r.dim <= THUMBNAIL_MAX_DIM);
});
test("makeBoundedThumbnail: never exceeds the start dimension", async () => {
  const r = await makeBoundedThumbnail(await flatPng(2048));
  assert.ok(r.dim <= THUMBNAIL_MAX_DIM);
});
test("makeBoundedThumbnail: highly compressible image keeps the full start dim", async () => {
  const r = await makeBoundedThumbnail(await flatPng(1024));
  assert.equal(r.dim, THUMBNAIL_MAX_DIM);
  assert.ok(r.withinBudget);
});
test("makeBoundedThumbnail: noisy image shrinks below the start dim", async () => {
  const r = await makeBoundedThumbnail(await noisePng(1024));
  assert.ok(r.dim < THUMBNAIL_MAX_DIM, `expected shrink, got ${r.dim}px`);
});
test("makeBoundedThumbnail: impossible tiny budget bottoms out at the floor", async () => {
  const r = await makeBoundedThumbnail(await noisePng(1024), { maxB64Chars: 500 });
  assert.equal(r.dim, THUMBNAIL_MIN_DIM);
  assert.equal(r.withinBudget, false);
});
test("makeBoundedThumbnail: honours custom start/min dims", async () => {
  const r = await makeBoundedThumbnail(await noisePng(1024), { startDim: 200, minDim: 64, maxB64Chars: 10 });
  assert.ok(r.dim <= 200 && r.dim >= 64);
});
test("makeBoundedThumbnail: result buffer decodes at the reported dim", async () => {
  const r = await makeBoundedThumbnail(await noisePng(1024));
  const { width, height } = await pngDims(r.buffer);
  assert.equal(Math.max(width, height), r.dim);
});

// ── buildSuccessResponse ────────────────────────────────────────────────────
const saved = { path: "/tmp/out.png", sizeBytes: 1_800_000 };

test("buildSuccessResponse: returns [image, text]", async () => {
  const b64 = (await noisePng(1024)).toString("base64");
  const res = await buildSuccessResponse(b64, saved, "gpt-image-2", "medium", "1024x1024");
  assert.equal(res.content.length, 2);
  assert.equal(res.content[0].type, "image");
  assert.equal(res.content[1].type, "text");
});
test("buildSuccessResponse: image block has png mimeType", async () => {
  const b64 = (await flatPng(1024)).toString("base64");
  const res = await buildSuccessResponse(b64, saved, "gpt-image-2", "medium", "1024x1024");
  assert.equal(res.content[0].mimeType, "image/png");
});
test("buildSuccessResponse: image data is raw base64 with no data: URI prefix", async () => {
  const b64 = (await noisePng(1024)).toString("base64");
  const res = await buildSuccessResponse(b64, saved, "gpt-image-2", "medium", "1024x1024");
  assert.ok(!res.content[0].data.startsWith("data:"));
  assert.match(res.content[0].data, /^[A-Za-z0-9+/=]+$/);
});
test("buildSuccessResponse: inline image stays under the display budget", async () => {
  const b64 = (await noisePng(1024)).toString("base64");
  const res = await buildSuccessResponse(b64, saved, "gpt-image-2", "medium", "1024x1024");
  assert.ok(res.content[0].data.length <= THUMBNAIL_MAX_B64_CHARS, `${res.content[0].data.length} chars`);
  assert.ok(res.content[0].data.length < 150_000);
});
test("buildSuccessResponse: text reports the saved path and cost", async () => {
  const b64 = (await flatPng(1024)).toString("base64");
  const res = await buildSuccessResponse(b64, saved, "gpt-image-2", "medium", "1024x1024");
  assert.match(res.content[1].text, /Saved: \/tmp\/out\.png/);
  assert.match(res.content[1].text, /~\$0\.053/);
});
test("buildSuccessResponse: appends extra notes to the text", async () => {
  const b64 = (await flatPng(512)).toString("base64");
  const res = await buildSuccessResponse(b64, saved, "gpt-image-2", "medium", "1024x1024", ["Note: capped."]);
  assert.match(res.content[1].text, /Note: capped\./);
});
test("buildSuccessResponse: falls back to text-only when the data is not a PNG", async () => {
  const notPng = Buffer.from("hello world, not a png at all").toString("base64");
  const res = await buildSuccessResponse(notPng, saved, "gpt-image-2", "medium", "1024x1024");
  assert.equal(res.content.length, 1);
  assert.equal(res.content[0].type, "text");
  assert.match(res.content[0].text, /Inline preview unavailable/);
});

// ── tool-level argument validation (no network) ─────────────────────────────
test("generateImage: empty prompt is a clean error", async () => {
  const res = await generateImage({ prompt: "   " });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /prompt is required/i);
});
test("editImage: missing reference_images is a clean error", async () => {
  const res = await editImage({ prompt: "x" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /reference_images|reference image/i);
});
test("editImage: nonexistent reference path is a clean error", async () => {
  const res = await editImage({ prompt: "x", reference_images: ["/no/such/file-xyz.png"] });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /not found/i);
});
test("editImage: mask requires exactly one reference", async () => {
  const a = path.join(TMP_OUT, "ref-a.png");
  const b = path.join(TMP_OUT, "ref-b.png");
  fs.writeFileSync(a, await flatPng(32));
  fs.writeFileSync(b, await flatPng(32));
  const res = await editImage({ prompt: "x", reference_images: [a, b], mask_path: a });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /mask_path requires exactly 1/i);
});
