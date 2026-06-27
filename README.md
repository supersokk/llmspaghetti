# 🍝 LLMSpaghetti

![LLMSpaghetti](docs/logo.png)

> A tangled mess of AI routing that somehow works.

---

> ⚠️ **HONEST DISCLAIMER — PLEASE READ**
>
> This is a **hobby project** built for fun. The code is, by the author's own admission, **vibecoded spaghetti** — held together with bash, enthusiasm, and a concerning amount of optimism.
>
> **Use at your own risk.** The authors take zero responsibility for anything that happens to your hardware, data, API bills, pets, or general wellbeing as a result of running this software.
>
> **Do not expect regular updates.** This is not a product. There is no roadmap, no SLA, no support contract, and no guarantee that any of this will work on your specific setup. Updates happen when someone feels like it.
>
> **That said** — it works on the machines it's been tested on, the community is welcome to improve it, and if it saves you from juggling six browser tabs, it's done its job.
>
> PRs welcome. Bug reports welcome. Complaints about the code quality — also welcome, you're probably right.
>
> Full disclaimer: [DISCLAIMER.md](DISCLAIMER.md)

---

## 📍 Current status (2026-06-27)

Honest state of the project, because the rest of this README describes the
*vision* and not everything is built yet.

**✅ Works today (tested on an Ubuntu 26.04 VM):**
- Install from `git clone` + `scripts/bootstrap.sh`
- First-boot setup wizard
- Full silent routing chain: chat → router classifies → LiteLLM → model → reply
- Routing is enforced — the chat UI cannot bypass the router
- Local models via Ollama (tested CPU-only with `qwen2:0.5b`)

**🚧 Built but not yet proven:**
- Multi-model routing (router picks *different* models per intent) — needs 2+ models loaded
- Image routing, MCP tools, cloud-provider routing, Cockpit management tabs
- VS Code extension

**❌ Not built yet:**
- The bootable ISO (the "flash to USB" path below is aspirational —
  use the `git clone` install path for now)
- Multi-node, AMD ROCm / multi-GPU verification

See [TODO.md](TODO.md) for the full checklist.

---

## The "holy shit" moment 🤯

You're in **one chat window**. You type:

> *"Can you generate an image of a cyberpunk city at night"*

LLMSpaghetti sees **generate image** → routes to DALL-E/ChatGPT → image appears in your chat.

You type:

> *"Now help me write the React component to display that image"*

Routes to **Claude** → code comes back → same window.

You type:

> *"Quick, what's the capital of Norway?"*

Routes to **Groq** → answer in 200ms → same window.

**You never switched tabs. You never thought about which AI to use. It just went to the right one.**

---

## Got an old laptop gathering dust? 💻

That's all you need.

LLMSpaghetti running as a pure API router uses almost **no resources** — it's just passing traffic, not doing any AI itself. A 10 year old ThinkPad with 4GB RAM handles this perfectly.

```
Old laptop (no GPU needed)
        ↓
Install LLMSpaghetti
        ↓
Add your API keys  (Claude, ChatGPT, Groq — whatever you pay for)
        ↓
One URL. One chat. Every AI you subscribe to.
Every device on your network. Phone, tablet, work laptop. All of them.
```

No new subscriptions. No GPU. No cloud service.
Just a laptop, your existing API keys, and one place to manage everything.

---

## Or go full local 🖥️

Have a machine with a decent GPU? Run models completely locally.
Nothing leaves your network. Ever. Not because we promise it — because there's nowhere for it to go.

```
RTX 3090 in your home server
        ↓
Llama 3 70B running locally
        ↓
Your code, your documents, your conversations
        ↓
Stays on your machine
```

Mix and match. Private stuff → local model. Quick tasks → Groq. Complex code → Claude.
**You set the rules. LLMSpaghetti enforces them.**

---

## What it actually is

One endpoint that routes to everything:

```
Your IDE / Chat / CLI
        ↓
http://your-server/v1   ← one URL, never changes
        ↓
  LLMSpaghetti Router
        ├── "generate image"     → ChatGPT / DALL-E    🖼
        ├── "think through this" → DeepSeek R1          🧠
        ├── code files (.py .js) → Claude               💻
        ├── "confidential"       → Local Llama 3  🔒 (never leaves machine)
        ├── "quick question"     → Groq                 ⚡
        └── everything else      → your default model   🏠
```

One API key. One URL. Every model you have access to.
Cursor, VS Code, Aider, any OpenAI-compatible tool — they all just work.

---

## What's included

| Component | Role |
|---|---|
| [Ollama](https://ollama.com) | Runs local AI models |
| [Open WebUI](https://github.com/open-webui/open-webui) | The chat interface — your one window for everything |
| [LiteLLM](https://litellm.ai) | The routing engine — sends requests to the right model |
| [Cockpit](https://cockpit-project.org) | Server management web UI |
| [ttyd](https://github.com/tsl0922/ttyd) | Terminal in the browser |
| [Caddy](https://caddyserver.com) | Reverse proxy + optional HTTPS |
| Ubuntu Server | The base OS underneath |

---

## Before you start

**Option A — Old laptop / no GPU (router only mode)**

| | Minimum |
|---|---|
| CPU | Any 64-bit from ~2012 onwards |
| RAM | 4GB |
| Disk | 50GB (Docker images + OS; 20GB is not enough) |
| GPU | Not needed |
| Network | Ethernet recommended |

This runs your cloud APIs (Claude, ChatGPT, Groq) through one endpoint.
No local models — just routing. Perfectly useful.

**Option B — Full local inference**

| | Minimum | Recommended |
|---|---|---|
| CPU | Any 64-bit x86 | 8+ cores |
| RAM | 8GB | 32GB+ |
| Disk | 100GB | 500GB+ |
| GPU | GTX 1080 / RX 5700 | RTX 3090 / RX 7900 XTX |
| VRAM | 8GB | 24GB+ |

---

## Installation — pick your path

### Path 1 — Flash to USB and install (recommended)

**Step 1 — Download the ISO**

Go to [Releases](../../releases) and download the latest `llmspaghetti-YYYYMMDD.iso`.

> No release yet? Follow [Build it yourself](#build-it-yourself-advanced) below.

**Step 2 — Flash to USB**

**Windows** — use [Rufus](https://rufus.ie):
1. Open Rufus → select your USB stick
2. Click SELECT → choose the ISO
3. Partition scheme: **GPT**
4. Click START → choose **DD Image mode**

**Mac** — use [balenaEtcher](https://etcher.balena.io):
1. Flash from file → select ISO → select USB → Flash

**Linux:**
```bash
sudo dd if=llmspaghetti-*.iso of=/dev/sdX bs=4M status=progress
```

**Step 3 — Boot from USB**

1. Plug USB into target machine
2. Power on → press boot menu key (usually F12, F11, Esc, or Del)
3. Select USB → LLMSpaghetti installs itself (~10 min)
4. Machine reboots automatically

**Step 4 — Open your browser**

Your machine screen shows:
```
  🍝 LLMSpaghetti

  Setup:   http://192.168.1.42
  Status:  installing...
```

Open that URL on any device. A 4-step wizard handles the rest.

---

### Path 2 — Install on existing Ubuntu server

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/llmspaghetti/main/scripts/bootstrap.sh | sudo bash
```

When done, open `http://your-server-ip` in a browser.

---

### Path 3 — Try in a VM first

**VirtualBox (Windows/Mac):**
1. New VM → Linux → Ubuntu 64-bit → 4GB RAM → 60GB disk
2. Attach ISO as CD/DVD → Start
3. After install, open the IP shown in the VM window

**QEMU (Linux/WSL2):**
```bash
sudo apt install qemu-system-x86 qemu-utils
bash iso/test-vm.sh llmspaghetti-*.iso
# Open http://localhost:8080
```

---

## After install

**Router-only setup (old laptop / no GPU)**

The setup wizard will ask for your API keys:
- Anthropic (Claude) → `sk-ant-...`
- OpenAI (ChatGPT + DALL-E) → `sk-...`
- Groq (fast free tier) → `gsk_...`

That's it. Open `http://your-server-ip` and you have one chat window with every AI you subscribe to.

**Adding local models**

Open WebUI → Models → Pull. Suggestions based on your GPU VRAM appear automatically.

| Your VRAM | Good starting model |
|---|---|
| 24GB+ | Llama 3 70B |
| 12GB | Mistral 7B + CodeLlama 13B simultaneously |
| 8GB | Llama 3 8B |
| No GPU | Phi-3 Mini (CPU, slower but works) — or qwen2:0.5b for fast testing |

---

## Using it with your IDE or coding tools

Any OpenAI-compatible tool (Cline, Cursor, Continue, Aider, anything) connects with two fields:

```
Base URL:  http://your-server-ip/v1
API Key:   shown in setup wizard  (or: spag key)
```

Paste those in. Done. The routing happens on the server — your tool doesn't need to know anything else.

---

## The `spag` CLI

```bash
spag status          # is the spaghetti running?
spag pull mistral    # add more noodles
spag models          # what's in the pot?
spag key             # show your API key
spag doctor          # untangle something broken
spag logs            # what's the spaghetti doing?
spag config          # edit routing rules + API keys
spag gpu             # GPU detection info
spag restart         # stir the pot
spag update          # fresh pasta
```

---

## Something broke?

```bash
ssh llmspaghetti@your-server-ip
spag doctor
```

Checks everything and tells you what's wrong.

| Problem | Try |
|---|---|
| Can't reach web UI | Check IP on screen. Use `http://` not `https://` |
| Image generation not working | Check OpenAI key has DALL-E access |
| Model download stuck | `spag logs` |
| GPU not detected | Reboot — drivers need it after first install |
| Everything on fire | `spag restart` |

---

## Build it yourself (advanced)

```bash
git clone https://github.com/YOUR_USERNAME/llmspaghetti.git
cd llmspaghetti

# Install build tools
sudo bash iso/install-build-deps.sh

# Install Node deps
cd cockpit-plugin && npm install && cd ..

# Validate everything
bash test/pre-build-check.sh

# Build ISO (~20 min)
sudo bash iso/build.sh
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

Good first contributions:
- Testing on different hardware and reporting results
- Adding optional services (ComfyUI, SearXNG, Whisper, n8n)
- Improving routing rules and role detection
- Documentation and translations

Bigger contributions:
- Multi-node support
- Intel Arc GPU support
- ARM64 / Raspberry Pi port
- OTA updates

---

## License

GPL v3 — see [LICENSE](LICENSE).
Use it. Modify it. Share your changes.

---

## Acknowledgements

Built on the shoulders of giants:
[Ollama](https://ollama.com) · [Open WebUI](https://github.com/open-webui/open-webui) · [LiteLLM](https://litellm.ai) · [Cockpit](https://cockpit-project.org) · [ttyd](https://github.com/tsl0922/ttyd) · [Caddy](https://caddyserver.com) · Ubuntu

---

*Yes, it's spaghetti. Yes, it works. Somehow.* 🍝
