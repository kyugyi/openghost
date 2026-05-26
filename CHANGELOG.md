# Changelog

All notable changes to **OpenGhost** (formerly **Inkwell**) are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/), and the project adheres to [Semantic Versioning](https://semver.org/).

## [1.1.0] — 2026-05-25

### Renamed
- **Project renamed Inkwell → OpenGhost** for its open-source release (new icon, repo, and brand by
  Ghostoli Production). Internal env vars went `INKWELL_*` → `OPENGHOST_*` and the server identity is
  now `openghost`. Tool names (`generate_image`, `edit_image`), behavior, and config are unchanged.
  Note: this installs as a **new** extension alongside any existing Inkwell — it is not an in-place
  update of the old one.

### Added
- **`auto_open_image` setting (opt-in) — see your image without digging through folders.** When ON,
  each generated image is opened automatically in your OS default viewer (Preview on macOS, the
  shell-associated app on Windows/Linux) right after it's saved. This is the reliable way to *see*
  the result in the **normal Claude Desktop chat**, which — unlike Claude Code — does **not** render
  MCP tool image blocks inline (a documented Claude Desktop limitation: tool images land in the
  collapsed "tool use" accordion, never inline). Off by default, because a batch/asset-library run
  would otherwise spawn one window per image. Toggle it in Settings → Extensions → Inkwell.
- New helpers `viewerCommand(platform, path)` (pure, per-OS command map) and `openInViewer(path)`
  (best-effort spawn — never throws, args passed as an array so the path can't be shell-interpreted).
  New env var `INKWELL_AUTO_OPEN` (1/true/yes/on). Now 87 tests.

### Note
- This does **not** make images appear *inside* the normal chat bubble (no extension can — it's the
  client's call, and it's on Anthropic's roadmap). It makes the image **pop open on screen
  automatically** so you don't have to open the file yourself. Inline rendering already works in
  Claude Code.

## [1.0.9] — 2026-05-25

### Fixed
- **Generation no longer fails when the agent passes a sandbox path.** In a Claude Code / Cowork
  chat, the assistant runs with a Linux-sandbox mental model and may call `generate_image` with
  `output_path: "/mnt/user-data/outputs/…"`. That folder doesn't exist on the user's Mac, so
  `resolveOutputPath` threw `ENOENT … mkdir '/mnt/user-data/outputs'` and the whole tool call errored
  (no image, no inline preview) — sometimes several times before the agent retried without a path.

### Changed
- New `resolveOutputPathWithFallback`: if the requested `output_path` can't be created/written,
  Inkwell now **falls back to the configured output directory** (and timestamped filename) instead of
  failing, and adds a transparent note to the response (`Note: "…" wasn't writable on this machine —
  saved to … instead.`). Both `generate_image` and `edit_image` use it. The fallback is resolved
  **before** the OpenAI call, so a bad path never burns a paid generation. Net effect: the image is
  always produced and the inline preview always has a chance to render — including inside Cowork.
- Bumped to **81 tests** (added unit coverage for `resolveOutputPathWithFallback` and a stdio e2e
  case that requests an unwritable path and asserts graceful fallback + a still-returned image block).

## [1.0.8] — 2026-05-25

### Fixed
- **Inline image previews now actually render in Claude Desktop.** Generated images were saved to
  disk but the inline preview never appeared in the chat — only the "image saved" text showed.
  Root cause: the inline `image` content block exceeded **Claude Desktop's tool-result display
  threshold (~150,000 characters)**. Such a block is still delivered to the model (so Claude could
  report the saved path) but is **silently dropped from the UI** — no error, no render. The v1.0.7
  384 px thumbnail of a photographic 1024² image was ~321 KB → **~428,000 base64 characters**, far
  over the line. (The earlier full-image attempt was ~1.8 MB, also over the separate 1 MB hard cap.)

### Changed
- `buildSuccessResponse` now emits a **size-bounded** inline thumbnail via the new
  `makeBoundedThumbnail`, which downscales the longest edge (from `THUMBNAIL_MAX_DIM` = 384 px) in
  20 % steps until the base64 payload fits `THUMBNAIL_MAX_B64_CHARS` (**90,000 chars**, a conservative
  margin under the ~150 k threshold and the 25 k-token reading), with a 96 px floor that guarantees
  the loop terminates well under budget for any input. Flat/illustration images keep the full 384 px;
  high-entropy photos settle smaller but always render.
- The content-array **shape is unchanged** — still `[{type:"image", data, mimeType:"image/png"}, {type:"text", ...}]`
  with raw (non-`data:`-prefixed) base64 — so this is fully backward compatible. The full-resolution
  PNG continues to be written to disk untouched; only the inline preview is bounded.
- `makeThumbnail`'s 10 s safety timer is now `unref()`'d and cleared once the decode settles, so it
  never keeps the MCP process (or a test run) alive after a result is ready. Output bytes unchanged.
- Diagnostic log line enriched: `[inkwell] inline thumbnail INCLUDED (52KB, 124px, 70536 b64 chars)`.

### Added
- `base64Length(byteLength)` helper — exact base64 character count without allocating the string.
- New constants: `THUMBNAIL_MIN_DIM` (96), `THUMBNAIL_MAX_B64_CHARS` (90,000).
- Reconstructed and expanded the test suite (77 tests): unit coverage for every pure helper, the
  thumbnail pipeline, and `buildSuccessResponse`, plus a real **stdio e2e test** (`npm run test:e2e`)
  that spawns the server and drives `initialize` → `tools/list` → `tools/call` against a mocked OpenAI
  endpoint, asserting the returned content array is `[image, text]` with the image under the display
  threshold.
- README: new "Inline previews & the MCP image content format" section for contributors.

## Earlier versions

> Reconstructed from the project's release history. These releases iterated toward getting a
> generated image to display inline in Claude Desktop.

- **1.0.7** — Switched to a thumbnail strategy: downscale 1024 px → 384 px via pure-JS `pngjs` and send
  that inline. Still didn't render (the 384 px payload was over the display threshold — see 1.0.8).
- **1.0.6** — Removed the inline size threshold guard; full image still not displayed.
- **1.0.5** — Attempted to embed the full-resolution PNG inline; hit Claude Desktop's **1 MB** hard cap
  ("tool result too large") and fell back to a text-only "image too large for inline preview" note.
- **1.0.4** — Fixed `${HOME}` / `$HOME/` / `~` expansion in the configured output directory (paths were
  being created literally as `${HOME}/inkwell-images`).
- **1.0.1** — Fixed an `isMain` boot check that prevented the server from starting on macOS.
- **1.0.0** — Initial release: `generate_image` + `edit_image` over MCP, OpenAI GPT Image 2, cost
  guardrails (n=1, 1024² cap, medium default), API key in the OS keychain.

[1.1.0]: https://github.com/kyugyi/openghost/releases/tag/v1.1.0
[1.0.9]: https://github.com/kyugyi/openghost/releases/tag/v1.0.9
[1.0.8]: https://github.com/kyugyi/openghost/releases/tag/v1.0.8
