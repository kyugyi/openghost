<div align="center">

# 👻 OpenGhost

**Image generation for Claude Desktop, powered by OpenAI's GPT Image 2 — with style consistency that sticks.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![MCPB v0.3](https://img.shields.io/badge/MCPB-v0.3-purple.svg)](https://github.com/modelcontextprotocol/mcpb)
[![Made by Ghostoli](https://img.shields.io/badge/by-Ghostoli%20Production-0033CC.svg)](https://github.com/kyugyi)

</div>

---

OpenGhost is a [Claude Desktop extension](https://github.com/modelcontextprotocol/mcpb) (`.mcpb`) that brings OpenAI's GPT Image 2 directly into Claude — optimized for **design workflows where visual consistency matters**.

Pass any reference image and OpenGhost uses it as visual context, so every generated asset stays on-brand. Built for designers and indie devs building icon sets, illustration libraries, mood boards, or any task where you need ten-plus images to share a visual identity.

## ✨ Features

- 🎨 **Style that sticks** — multi-reference image input means every generation can match a canonical style anchor
- 💸 **Smart cost defaults** — medium quality (~$0.053/img), 1024×1024 hard cap, 1 image per call, conservative retries
- 🔍 **Cost transparency** — every response shows the approximate cost so you can audit your spend
- 🛡️ **Zero waste** — schema-enforced single-image generation, no surprise bulk billing
- 🔒 **API key in your keychain** — never logged, never leaves your machine
- 🖼️ **Inpainting support** — optional mask for precision edits

## 🚀 Installation

### Option 1 — Download the prebuilt extension (recommended)

1. Download the latest [`openghost-1.1.0.mcpb`](https://github.com/kyugyi/openghost/releases/latest/download/openghost-1.1.0.mcpb) from Releases
2. Double-click the file — Claude Desktop opens an installation dialog
3. Enter your OpenAI API key (get one at [platform.openai.com/api-keys](https://platform.openai.com/api-keys))
4. Done — the tools appear in any new Claude conversation

### Option 2 — Build from source

```bash
git clone https://github.com/kyugyi/openghost.git
cd openghost
npm install
npm install -g @anthropic-ai/mcpb
npm run build
# Produces openghost-1.1.0.mcpb in the project root
```

## 🛠️ Tools

### `generate_image`

From-scratch text-to-image generation.

```json
{
  "prompt": "a soft watercolor blue tiger spirit, sparkles around the head",
  "output_path": "/Users/me/Desktop/tiger.png",
  "quality": "medium"
}
```

### `edit_image`

Generation with 1–16 reference images for style consistency or inpainting.

```json
{
  "prompt": "a young tiger cub in the same style",
  "reference_images": ["/Users/me/style-anchor.png"],
  "output_path": "/Users/me/Desktop/cub.png"
}
```

Pass the **same canonical reference image** across multiple calls to lock visual identity across an entire asset library.

## 💰 Pricing

Approximate per-image cost at 1024×1024:

| Model | Low | Medium | High |
|---|---|---|---|
| **`gpt-image-2`** *(default)* | $0.005 | **$0.053** | $0.211 |
| `gpt-image-1.5` | $0.009 | $0.034 | $0.133 |
| `gpt-image-1` | $0.011 | $0.040 | $0.167 |
| `gpt-image-1-mini` | $0.005 | $0.011 | $0.036 |

You're billed only for successful 200 responses. Failed calls are not billed.

For a typical asset library of ~95 illustrations at medium quality: **~$5 total**.

## ⚙️ Configuration

All settings are configured through Claude Desktop's UI when you install or click "Configure" on the extension:

| Setting | Default | Purpose |
|---|---|---|
| **OpenAI API Key** | *(required)* | Stored in your OS keychain (macOS Keychain / Windows Credential Manager) |
| **Default model** | `gpt-image-2` | Switch to `gpt-image-1-mini` for cheaper test runs |
| **Default quality** | `medium` | `low` / `medium` / `high` |
| **Output directory** | `~/openghost-images` | Where generated PNGs land when no absolute path is given |
| **Default style reference** | *(optional)* | Pin a canonical reference image for style-consistency workflows |
| **Timeout** | `180` seconds | Increase for `high` quality at large sizes |
| **Auto-open generated images** | `off` | When on, each image opens in your default viewer (e.g. Preview) right after it's saved — the reliable way to *see* the result in the normal Claude chat (which doesn't render MCP images inline). Leave off for batch runs. |

## 🛡️ Cost guardrails

OpenGhost actively prevents cost surprises:

1. **Size hard-capped at 1024×1024.** Even if the agent asks for 1536×1024, the extension silently caps. This is the biggest cost lever — larger sizes cost ~50% more at the same quality.
2. **Always 1 image per call.** The agent cannot ask for `n=4` to waste 4× the budget.
3. **Quality defaults to your setting.** Medium by default. If the agent doesn't specify, you don't get charged for High.
4. **Cost shown in response.** Every successful generation reports the approximate cost so you can audit:
   ```
   Generated image with gpt-image-2 (quality=medium, size=1024x1024 ~$0.053)
   Saved: /Users/me/openghost-images/image.png (842 KB)
   ```
5. **Conservative retries.** `maxRetries: 1` on the OpenAI client (= 2 attempts max per call).

## 🧪 Development

```bash
# Install dependencies
npm install

# Lint
npm run lint

# Run all tests
npm test

# Just unit tests
npm run test:unit

# Just integration tests (spawns the server, speaks MCP protocol)
npm run test:integration

# Build the .mcpb
npm run build
```

Tests use Node's built-in test runner — zero external test dependencies.

## 🏗️ How it works

```
┌─────────────────┐    stdio    ┌──────────────────┐    HTTPS    ┌──────────────┐
│ Claude Desktop  │ ──────────► │ OpenGhost MCP      │ ──────────► │  OpenAI API  │
│ (UI + agent)    │ ◄────────── │ Node.js server   │ ◄────────── │ GPT Image 2  │
└─────────────────┘    JSON     └──────────────────┘   base64    └──────────────┘
                       MCP                                          PNG decoded
                                                                    + saved to
                                                                    disk locally
```

- The MCP server runs locally on your machine via stdio (no network listening, no proxy)
- Your OpenAI API key is stored in your OS keychain (sensitive: true in manifest)
- Images are streamed back as base64 and saved to disk — never uploaded anywhere else
- All file I/O happens on your machine

## 🖼️ Inline previews & the MCP image content format

Every successful generation returns an MCP tool-result **content array** of exactly two blocks:

```jsonc
{
  "content": [
    { "type": "image", "data": "<raw base64 PNG>", "mimeType": "image/png" }, // inline preview
    { "type": "text",  "text": "Generated image with gpt-image-2 ...\nSaved: /path/to/image.png" }
  ]
}
```

A few things future contributors should know:

- **`data` is raw base64** — no `data:image/png;base64,` URI prefix. That prefix breaks rendering.
- **Claude Desktop has a tool-result display threshold (~150,000 characters).** A block whose payload
  exceeds it is still delivered to the model but is **silently not rendered** in the chat (no error).
  A full 1024×1024 PNG is ~1–2 MB → ~1.5–2.7M base64 chars, far over the line — which is exactly why
  embedding the full image inline produced "image saved" text but no visible preview.
- **So the inline block is a size-bounded thumbnail, not the full image.** `buildSuccessResponse`
  calls `makeBoundedThumbnail`, which downscales the longest edge (starting at `THUMBNAIL_MAX_DIM` =
  384 px) until the base64 fits `THUMBNAIL_MAX_B64_CHARS` (90,000 chars — a conservative margin under
  the threshold). High-entropy photos settle smaller; flat illustrations keep the full 384 px.
- **The full-resolution PNG always stays on disk** at the saved path (the text block reports it). The
  thumbnail is for display only.
- If thumbnailing fails (corrupt PNG, decode error) the response degrades gracefully to **text-only**
  with a note pointing at the on-disk file — OpenGhost never emits an image block the client would drop.

## 🤝 Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

Common areas where help is wanted:
- Additional MIME types (TIFF, AVIF) for reference images
- Localized error messages
- Windows-specific testing
- Examples for additional creative workflows

## 📋 Changelog

See [CHANGELOG.md](CHANGELOG.md).

## 📜 License

MIT — see [LICENSE](LICENSE).

## 🙏 Acknowledgments

- Built on the [MCP Bundle spec](https://github.com/modelcontextprotocol/mcpb) by Anthropic
- Uses the [official OpenAI Node SDK](https://github.com/openai/openai-node)
- Inspired by the lack of a clean, cost-aware OpenAI image extension for Claude Desktop

---

<div align="center">

Made with 👻 by [Ghostoli Production](https://github.com/kyugyi)

</div>
