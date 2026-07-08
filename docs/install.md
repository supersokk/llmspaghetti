# Install & Setup

Everything needed to install, run, and troubleshoot LLMSpaghetti.

> **Living document.** Built from real installs on real hardware and updated as
> we learn. Current install path is **`git clone` + `bootstrap.sh`** — the
> bootable ISO is planned but not built yet.

---

## Requirements

**Option A — Router only (no GPU):** route your cloud API keys (Claude, ChatGPT,
Groq) through one endpoint. The box does no inference itself.

| | Minimum |
|---|---|
| CPU | any 64-bit from ~2012 |
| RAM | 4 GB |
| Disk | 50 GB (Docker images + OS; 20 GB is not enough) |
| GPU | not needed |

**Option B — Local inference (the primary use case):** run models on your own GPU.

| | Minimum | Recommended |
|---|---|---|
| CPU | any 64-bit x86 | 8+ cores |
| RAM | 8 GB | 32 GB+ |
| Disk | 100 GB | 500 GB+ |
| GPU | GTX 1080 / RX 5700 (8 GB) | RTX 3090 / RX 7900 XTX (24 GB) |

> CPU-only works but is slow and can comfortably run only **one small** model at
> a time. Running multiple models at once needs a GPU.

### Tested hardware

| Config | Result |
|---|---|
| Ryzen 3 3200G, 16 GB, **RTX 2060 Super 8 GB**, Ubuntu 26.04 | ✅ full success — multi-model routing on GPU (qwen2.5:3b + qwen2.5-coder:3b, ~4.3 GB VRAM) |
| 4 vCPU, 7 GB, no GPU, Ubuntu 26.04 (VM) | ✅ installs & routes; one small model only (CPU ceiling) |

> 💡 **Tip:** if your CPU has an integrated GPU (e.g. Ryzen's Vega), plug the
> monitor into the **iGPU** and leave the discrete NVIDIA card headless — all its
> VRAM stays free for models.

---

## Prerequisites

- Ubuntu Server **22.04 / 24.04 / 26.04**, minimal install, with SSH.
- **Outbound HTTPS** (bootstrap pulls Docker, Ollama, drivers, images). Note:
  `ping` may be blocked even when HTTPS works — test with
  `curl -sI https://get.docker.com`.

Verify your starting point:

```bash
lsb_release -a                     # Ubuntu version
nproc ; free -h ; df -h /          # CPU / RAM / disk
lspci | grep -i -E 'vga|nvidia'    # GPU visible?
curl -sI https://get.docker.com    # outbound HTTPS (not ping)
```

---

## Install (recommended: existing Ubuntu server)

```bash
# Private repo: authenticate first (skip if public)
sudo apt update && sudo apt install -y git gh
gh auth login            # GitHub.com → HTTPS → login via browser

git clone https://github.com/supersokk/llmspaghetti.git
sudo bash llmspaghetti/scripts/bootstrap.sh
```

Or, once the repo is public, the one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/supersokk/llmspaghetti/main/scripts/bootstrap.sh | sudo bash
```

**What bootstrap does (~10–20 min):** system update → creates the `llmspaghetti`
user + dirs → **GPU detection + driver install** → Docker → Ollama → Cockpit →
web terminal → Caddy → Python venv → systemd services → first-boot wizard.

> **NVIDIA GPUs need a reboot** after the driver installs. Bootstrap drops a
> `.needs-reboot` flag and the console tells you. After reboot the wizard is
> waiting at `http://<server-ip>`.

### GPU / driver notes

- The NVIDIA driver is installed via **`ubuntu-drivers install`** (Ubuntu's
  prebuilt, kernel-matched modules). Ollama bundles its own CUDA runtime, so the
  driver alone is enough — the full CUDA toolkit is only needed for optional
  runtimes like vLLM.
- **Dual GPU (NVIDIA + AMD iGPU):** detection picks CUDA and skips ROCm. Correct.
- After the driver reboot, refresh the GPU cache and restart Ollama:
  ```bash
  sudo bash ~/llmspaghetti/scripts/gpu-detect.sh --json | sudo tee /opt/llmspaghetti/gpu-info.json
  sudo systemctl restart ollama
  ```

---

## First-run wizard

Open `http://<server-ip>` and the setup wizard walks you through:

- Hostname / timezone / SSH key
- Model selection (suggestions based on your GPU)
- API keys — Anthropic, OpenAI, Groq (all optional)

Models download in the background; the done page shows live progress and moves
you into the chat when it's ready.

---

## Try it in a VM first

**VirtualBox:** new VM → Ubuntu 64-bit → 8 GB RAM → **50 GB+** disk → Bridged
network. Install Ubuntu Server, then follow the install steps above over SSH.

---

## Bootable ISO — planned, not built yet

The intended "flash a USB, boot, done" experience (Subiquity autoinstall →
silent install → browser wizard) is **not built yet**. Use the `git clone` +
`bootstrap.sh` path above. Tracked in [TODO.md](../TODO.md) (Phase 6).

---

## After install

### Add local models

Pull models with `spag pull <model>` or `ollama pull <model>`. Rough VRAM guide:

| VRAM | Good starting model |
|---|---|
| 24 GB+ | Llama 3 70B |
| 12 GB | Mistral 7B + a coder model together |
| 8 GB | one 7B, or two 3B models |
| No GPU | qwen2:0.5b (fast) / phi3:mini (slow but capable) |

### Add / change API keys

Edit in Cockpit (Settings → API Keys) or:

```bash
spag config     # opens config, restarts LiteLLM on save
```

### Connect an IDE / CLI

Any OpenAI-compatible tool (Cursor, Continue, Aider, Cline, curl) uses two fields:

```
Base URL:  http://<server-ip>/v1
API Key:   shown in the wizard, or `spag key`
```

The routing happens server-side — the tool needs nothing else. Example:

```bash
curl http://<server-ip>/v1/chat/completions \
  -H "Authorization: Bearer <your-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
```

---

## The `spag` CLI

```bash
spag status          # is it running?
spag pull <model>    # download a model
spag models          # list downloaded models
spag key             # show your API key
spag config          # edit routing rules + API keys
spag gpu             # GPU detection info
spag logs [service]  # webui | litellm | ollama | caddy
spag doctor          # health-check everything
spag restart         # restart the stack
spag update          # apt + Ollama + Docker images + Python deps
spag reset-firstboot # re-run the setup wizard
```

---

## Updating

```bash
spag update
```
Runs apt upgrade, updates Ollama, pulls latest container images, and refreshes
Python deps in the venv.

---

## Default credentials

| Service | URL | Login |
|---|---|---|
| Open WebUI | `http://<server-ip>` | create on first use |
| Cockpit | `http://<server-ip>:9090` | your Ubuntu user |
| SSH | port 22 | your Ubuntu user |

**Change any default passwords immediately** (`passwd` over SSH).

---

## Troubleshooting

```bash
ssh <user>@<server-ip>
spag doctor
```

| Problem | Try |
|---|---|
| Can't reach web UI | Use `http://` explicitly (browsers try HTTPS first; Caddy is HTTP on :80). Try incognito. |
| GPU not detected / CPU mode | `sudo ubuntu-drivers install` → reboot → refresh gpu-info.json → `sudo systemctl restart ollama` |
| Model download stuck | `spag logs ollama` |
| Chat returns JSON tool-schema junk | Small model choking on client-injected tools — the router strips them; update & restart the router |
| Everything on fire | `spag restart` |

---

## Gotchas found on real hardware

The most valuable part of this doc — real failures, real fixes. A fresh
`bootstrap.sh` now handles all of these; they're recorded for anyone debugging.

- **NVIDIA driver on Ubuntu 26.04.** NVIDIA's `nvidia-kernel-open-dkms` had no
  26.04 candidate; because `apt install` is atomic it aborted the whole GPU step
  → CPU mode. Fixed by using `ubuntu-drivers install` (prebuilt, kernel-matched).
- **Ollama crash-loop: "mkdir models: permission denied — path not traversable."**
  The `ollama` user couldn't traverse `/opt/llmspaghetti`. Fix: `chmod 755
  /opt/llmspaghetti` + `chown -R ollama:ollama /opt/llmspaghetti/models`.
- **Open WebUI won't start: "mount data/webui: no such file or directory."** The
  container's bind-mount target didn't exist. Fix: `mkdir -p
  /opt/llmspaghetti/data/webui`.
- **Open WebUI answers were JSON tool schemas on small models.** OWUI injects a
  built-in `update_task` tool; small models can't tool-call and echo the schema.
  Fix: the router strips client-supplied `tools`/`tool_choice`.
- **tty1 console "Ctrl+C for shell" bounced.** The status service is
  `Restart=always`, so exiting on Ctrl+C just respawned it. Fix: Ctrl+C now
  spawns `login` and resumes on logout. Workaround anywhere: **Ctrl+Alt+F2**.
- **Caddy served only HTTP; browser couldn't connect.** Use `http://` explicitly.
- **Disk:** minimum 50 GB. After a VirtualBox disk resize you must
  `growpart` + `pvresize` + `lvextend` + `resize2fs` to actually use it.
- **Open WebUI makes background model calls on every message.** It auto-generates
  a chat title, tags, and follow-up suggestions via extra LLM calls (and
  Follow-Up Generation is what makes the model appear to "ask itself" questions).
  The router routes these to the cheap `utility` model so they don't hit your
  expensive tier — but they *do* consume a model each turn. On a cloud-only box
  that costs money/quota; point `utility` at your cheapest model or disable
  Follow-Up / Title / Tags in OWUI (Admin → Settings → Interface). See
  [technical.md](technical.md#utility-requests-housekeeping).

Isolate a bad response by `curl`-ing the router (:5000) vs LiteLLM (:4000)
directly — if both are clean, the client is the problem.
