# 🍝 LLMSpaghetti — Changelog

All notable changes to LLMSpaghetti will be documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).  
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Planned
- Models tab: Load / Stop / Eject / Delete / per-model config panel
- Services tab: tap-to-install ComfyUI, SearXNG, Whisper, Qdrant, n8n, Flowise
- Runtime switcher: llama.cpp, vLLM as optional backends
- Intel Arc GPU support
- OTA update system
- ARM64 / Raspberry Pi 5 port

---

## [0.1.0] — 2024

### Added
- Bootable ISO with silent Subiquity autoinstall
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
