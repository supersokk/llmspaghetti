# 🍝 LLMSpaghetti — Changelog

All notable changes to LLMSpaghetti will be documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).  
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added (2026-07-02 — provenance tag)

- **"Show your work" on every reply.** The router now tags each routed answer
  with the model that actually handled it — a visible footer
  (`` `↳ LLMSpaghetti → <model> · <role>` ``) plus a machine-readable
  `x_llmspaghetti` field on the response body. Router-side, so it works in every
  client (Open WebUI, VS Code, curl) with no per-client plugin.
- **Resolves the real model name** from its LiteLLM alias, so the tag shows
  `qwen2:0.5b`, not the internal `local-default` placeholder.
- **Fallback-aware:** if the primary model fails and a fallback answers, the tag
  names the fallback and sets `"fallback": true`. Covers both streaming and
  non-streaming. In streaming the footer is injected just *before* the
  `finish_reason` chunk — clients (Open WebUI) drop content that arrives after
  the stop, so a footer placed before `[DONE]` never rendered.
- Toggle with `show_provenance` in `config/router_roles.yaml` (default on).
- Implements the core "Nothing hidden — show your work" principle. See
  docs/technical.md.

### Fixed (2026-07-02 — classifier code-routing miss)

- **Code prompts with natural phrasing now route to `code`.** The keyword rule
  required the code-noun immediately after the verb (`write a function` ✅) so
  anything with adjectives in between missed (`write a reverse hello world
  python script` → wrongly `general`). Loosened the write/create/make/build/
  generate rule to allow a short run of words before the artifact, and added a
  language+noun branch (`python script`, `javascript function`). Guarded against
  false positives (`write a letter`, `write a short story` stay `general`).
  Added regression fixtures (code-06..08, edge-06..07); all 36 pass. Surfaced by
  the new provenance tag.

### Proven (2026-07-01 — first bare-metal GPU deployment)
- **Multi-model routing proven on real GPU hardware.** Ryzen 3 3200G + RTX 2060
  Super 8GB, Ubuntu 26.04. qwen2.5:3b (general) + qwen2.5-coder:3b (code) both
  resident in VRAM (~4.3GB). Code question → coder model, general question →
  general model, automatically, both 200 OK, fast, no soft-lock. The thesis
  works on the machine it was designed for. See docs/install.md.
- **GPU driver install fixed:** use `ubuntu-drivers install` (Ubuntu's prebuilt,
  kernel-matched modules) instead of NVIDIA's `cuda-toolkit + nvidia-kernel-open-dkms`
  (the latter has no candidate on Ubuntu 26.04 and aborted the whole GPU step).
- **Bootstrap hardening from the clean install:** create `data/webui` (Open WebUI
  bind mount), `chmod 755` INSTALL_DIR (Ollama traversal), console checks
  `cockpit.socket` not `.service`, gpu-detect counts only display controllers.
- Recommended setup tip: use an iGPU for display, dedicate the dGPU to inference.
- **Router now strips client-supplied `tools`/`tool_choice`.** Open WebUI injects
  a built-in `update_task` tool; small models choke and echo the schema instead
  of answering. The router owns tool management (MCP), so client tools are
  dropped. Verified: clean "Oslo" + real Python through the Open WebUI UI.
- **Full stack proven through the chat UI**, not just the API: Open WebUI →
  router → correct model (general vs coder) → GPU → clean answer, fast.

### Proven (2026-06-27 — multi-model routing milestone, CPU VM)
- **The core thesis works.** With two local models loaded (qwen2:0.5b +
  qwen2.5-coder:0.5b), the router classifies each message and sends it to a
  DIFFERENT model automatically:
  - "write a python function to reverse a string" → `code` → code-local (coder)
  - "what is the capital of Norway" → `fast` → local-default (qwen2:0.5b)
  Verified in the router log on the VM. Routing is no longer theoretical.
- Confirmed the 500 errors were only a missing model (coder not pulled), not a
  routing fault — once pulled, the route resolved.
- **Hardware ceiling documented:** a CPU-only VM (7GB RAM, no swap) soft-locks
  running two models (kernel "soft lockup, CPU stuck [llama-server]"). Not a bug
  — CPU inference saturates all cores. Reinforces local-first-with-a-GPU as the
  primary target. CPU-VM testing should stay to one model.
- Added OLLAMA_MAX_LOADED_MODELS guidance for low-RAM boxes (limits memory, not
  CPU — doesn't cure the lockup, only a GPU/more cores does).

### Direction / decisions (2026-06-27)
- **Product reframed local-first.** Primary use case = homelab with multiple
  local models, each assigned a role. Cloud APIs are the secondary path. README
  + PROJECT-SCOPE reworded to lead with this.
- **Client strategy decided.** One smart `/v1` endpoint; the router holds ALL
  intelligence; clients (Open WebUI now, VS Code next, our own chat as end-game)
  are thin, swappable consumers. Rule: logic in the router, never client glue.
  See docs/PLANNED-client-strategy.md.
- **Principle added: "Nothing hidden — show your work."** Provenance tag on every
  reply, visible (never silent) fallbacks, inspectable routing log, GPL code.
- **Principle sharpened: "Use what we have, but smarter."** Orchestrate
  Ollama/LiteLLM/Open WebUI; never reinvent them. Own the routing brain only.
- New planning docs: model-management, background-jobs, client-strategy.

### Added (2026-06-27 — first real VM deployment)
- Confirmed full routing chain works end-to-end on Ubuntu 26.04 VM
- Python venv-based install (replaces pip --break-system-packages; required for Ubuntu 26.04 / PEP 668)
- `ENABLE_OLLAMA_API=false` on Open WebUI so every message is forced through the router
- MCP tool injection + tool-call resolution loop in router (from prior session)
- VS Code extension, Settings tab API-key management (from prior session)

### Changed (2026-06-27)
- External OpenAI-compatible API moved from `/api/v1` to `/v1` (avoids clash with Open WebUI's own `/api/`)
- LiteLLM runs with 1 worker (was 2) and no master_key (it's internal-only now)
- First-boot wizard runs on port 3001; Caddy auto-switches to Open WebUI (3000) once healthy
- `local-default` model now follows the user's first model pick (was hardcoded to llama3)
- Documented minimum disk as 50GB (20GB is insufficient for Docker image extraction)

### Fixed (2026-06-27)
- Bootstrap: create /etc/caddy, copy router/eval/config dirs, chown Ollama models dir, create api_keys.env/mcp.json
- Security: litellm_config.yaml now uses env-var references for keys; added to .gitignore
- Stack startup no longer blocks the wizard during `docker compose pull`

### Planned
- Multi-model routing demo (router picks different models per intent)
- Model management UI now that Open WebUI's Ollama API is disabled (see docs/PLANNED-model-management.md)
- Models tab: Load / Stop / Eject / Delete / per-model config panel
- Services tab: tap-to-install ComfyUI, SearXNG, Whisper, Qdrant, n8n, Flowise
- Runtime switcher: llama.cpp, vLLM as optional backends
- Bootable ISO (currently install is git clone + bootstrap.sh only)
- Intel Arc GPU support
- OTA update system
- ARM64 / Raspberry Pi 5 port

---

## Initial scaffold (2024)

Not a released product — the first pass that stood up the whole stack. Some of
this was only scaffolded here and proven later (see the 2026 entries above);
the **bootable ISO in particular is a long-term goal, not a shipped feature** —
it needs a complete, proven product first.

### Added / scaffolded
- ISO builder + autoinstall config **scaffolded only** — the working "flash a
  USB and boot" ISO is way down the roadmap (build it once the product is complete)
- Auto-detection of NVIDIA (CUDA) and AMD (ROCm) GPUs
- First-boot web wizard (hostname, timezone, SSH key, model selection, API keys)
- tty1 live console status display (services, GPU stats, IP address)
- Ollama for local model management
- Open WebUI for chat interface
- LiteLLM proxy — unified OpenAI-compatible API endpoint
- Cockpit for server management (port 9090)
- ttyd embedded web terminal (llmspaghetti user) + Cockpit root terminal
- Dashboard: live CPU, RAM, per-GPU VRAM/temp/power/util, network, disk
- `llmspaghetti` CLI: start/stop/restart/status/pull/models/config/key/gpu/doctor/update
- Watchdog service — auto-restarts failed services
- Power controls: stop models, stop services, reboot, shutdown
- Pre-build validation suite (84 checks)
- Full test suite for live installs (local + remote SSH)
- GPL v3 license
