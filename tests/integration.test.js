/**
 * OpenGhost integration / e2e test.
 *
 * Spawns the real MCP server (server/index.js) over stdio and drives it exactly
 * as Claude Desktop does — initialize, tools/list, tools/call — with the OpenAI
 * endpoint redirected (via OPENAI_BASE_URL) to a local mock that returns a real
 * 1024px PNG. This exercises the full stack: stdio transport, request routing,
 * generateImage, disk save, and the size-bounded inline thumbnail.
 *
 * It asserts the tools/call result is exactly the shape Claude Desktop receives:
 * [{type:"image", ...}, {type:"text", ...}] with the image payload kept under
 * the client's tool-result display threshold.
 *
 * Run: node --test tests/integration.test.js   (or: npm run test:e2e)
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "server", "index.js");
const DISPLAY_THRESHOLD = 150_000; // ~Claude Desktop tool-result display limit (chars)

function mockPngBase64(dim = 1024) {
  const png = new PNG({ width: dim, height: dim });
  for (let i = 0; i < png.data.length; i++) png.data[i] = (Math.random() * 256) | 0; // incompressible
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  const chunks = [];
  return new Promise((resolve) =>
    png.pack().on("data", (c) => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks).toString("base64")))
  );
}

/** Start a local stand-in for the OpenAI images API. */
function startMockOpenAI(b64) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.method === "POST" && /\/images\/(generations|edits)$/.test(req.url)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ created: Date.now(), data: [{ b64_json: b64 }] }));
        } else {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${req.url}` } }));
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/**
 * Spawn the server, send the given newline-delimited JSON-RPC requests, and
 * resolve a map {id: response} once every request bearing an `id` has replied.
 */
function runSession(requests, env, expectIds, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [SERVER], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const responses = {};
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`session timed out; stderr:\n${stderr}\nstdout:\n${stdout}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      let nl;
      while ((nl = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && msg.id !== null) responses[msg.id] = msg;
        if (expectIds.every((id) => id in responses)) {
          clearTimeout(timer);
          child.kill("SIGKILL");
          resolve(responses);
        }
      }
    });
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });

    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
  });
}

// ── shared session ──────────────────────────────────────────────────────────
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "openghost-e2e-"));
const b64 = await mockPngBase64(1024);
const mock = await startMockOpenAI(b64);

// A file where a directory is expected — makes any output_path under it fail to
// create, deterministically reproducing the sandbox-path case (e.g. an agent
// passing /mnt/user-data/outputs/... on a Mac). v1.0.9 should fall back to OUT.
const blocker = path.join(OUT, "blocker");
fs.writeFileSync(blocker, "x");
const unwritableReq = path.join(blocker, "sub", "img.png");

const responses = await runSession(
  [
    { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1.0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "generate_image", arguments: { prompt: "a red square", quality: "low" } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "generate_image", arguments: { prompt: "a blue circle", quality: "low", output_path: unwritableReq } } },
  ],
  {
    OPENAI_API_KEY: "sk-test-mock",
    OPENAI_BASE_URL: `http://127.0.0.1:${mock.port}/v1`,
    OPENGHOST_OUTPUT_DIR: OUT,
    OPENGHOST_MODEL: "gpt-image-2",
    OPENGHOST_DEFAULT_QUALITY: "medium",
  },
  [0, 1, 2, 3]
);

test.after(() => {
  mock.server.close();
  fs.rmSync(OUT, { recursive: true, force: true });
});

// ── assertions ───────────────────────────────────────────────────────────────
test("e2e: initialize handshake succeeds", () => {
  assert.ok(responses[0]?.result, "initialize returned a result");
  assert.equal(responses[0].result.serverInfo.name, "openghost");
  assert.equal(responses[0].result.serverInfo.version, "1.1.0");
});

test("e2e: tools/list advertises both tools", () => {
  const names = (responses[1].result.tools ?? []).map((t) => t.name).sort();
  assert.deepEqual(names, ["edit_image", "generate_image"]);
});

test("e2e: generate_image returns a content array of [image, text]", () => {
  const r = responses[2].result;
  assert.ok(r, "tools/call returned a result");
  assert.ok(!r.isError, "result is not an error");
  assert.equal(r.content.length, 2);
  assert.equal(r.content[0].type, "image");
  assert.equal(r.content[1].type, "text");
});

test("e2e: image block is a raw-base64 PNG (the shape Claude Desktop renders)", () => {
  const img = responses[2].result.content[0];
  assert.equal(img.mimeType, "image/png");
  assert.ok(!img.data.startsWith("data:"), "no data: URI prefix");
  assert.match(img.data, /^[A-Za-z0-9+/=]+$/);
  assert.ok(img.data.startsWith("iVBORw0KGgo"), "decodes to a PNG header");
});

test("e2e: inline image stays under the display threshold (this is the v1.0.8 fix)", () => {
  const img = responses[2].result.content[0];
  assert.ok(
    img.data.length < DISPLAY_THRESHOLD,
    `image data is ${img.data.length} chars; must be < ${DISPLAY_THRESHOLD} to render inline`
  );
});

test("e2e: text block reports the saved full-resolution path", () => {
  const txt = responses[2].result.content[1].text;
  assert.match(txt, /Saved:/);
  assert.match(txt, /\.png/);
});

test("e2e: the full-resolution PNG was actually written to disk", () => {
  const files = fs.readdirSync(OUT).filter((f) => f.endsWith(".png"));
  assert.ok(files.length >= 1, "at least one PNG saved");
  const full = fs.readFileSync(path.join(OUT, files[0]));
  assert.deepEqual(full.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "valid PNG magic");
  // Disk copy is the untouched full image; the inline copy is the smaller thumbnail.
  const inlineBytes = Buffer.from(responses[2].result.content[0].data, "base64").length;
  assert.ok(inlineBytes < full.length, "inline thumbnail is smaller than the saved original");
});

test("e2e: an unwritable output_path falls back instead of erroring (v1.0.9)", () => {
  const r = responses[3].result;
  assert.ok(r, "tools/call returned a result");
  assert.ok(!r.isError, "did NOT error on the unwritable sandbox-style path");
  assert.equal(r.content[0].type, "image", "still returns the inline image");
  assert.equal(r.content[1].type, "text");
  assert.match(r.content[1].text, /wasn't writable/, "notes the fallback");
  // It saved under the configured dir, not the impossible requested path.
  assert.match(r.content[1].text, new RegExp(OUT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
