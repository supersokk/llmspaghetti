# LLMSpaghetti — a tangled mess of AI routing that somehow works.

A minimal Linux appliance that turns any PC into a self-hosted AI gateway.
Boot the ISO → it installs silently → open a browser → done.

## What you get

| Component | Role | URL |
|---|---|---|
| **Open WebUI** | Chat interface, model manager | `http://your-server` |
| **Ollama** | Local model runner (llama3, mistral, etc.) | internal |
| **LiteLLM** | Unified API gateway (local + cloud) | `http://your-server/v1` |
| **Cockpit** | Server management web UI | `http://your-server:9090` |
| **Caddy** | Reverse proxy, auto-HTTPS | internal |

---

## Design / planning docs (things to think through before building)

- [PLANNED-model-management.md](PLANNED-model-management.md) — where model
  management lives now that Open WebUI's Ollama API is disabled ⚠️ open question
- [PLANNED-private-role.md](PLANNED-private-role.md) — the no-cloud "private" role
- [PLANNED-router-model.md](PLANNED-router-model.md) — community-trained classifier
- [PLANNED-routing-fixture-flywheel.md](PLANNED-routing-fixture-flywheel.md) — how
  routing corrections improve the classifier over time

---

## Project structure

```
llmspaghetti/
├── iso/
│   ├── build.sh                  # Master ISO builder (run from WSL2)
│   ├── install-build-deps.sh     # Install xorriso, squashfs-tools etc.
│   ├── test-vm.sh                # Test ISO in QEMU without physical hardware
│   └── autoinstall/
│       ├── user-data             # Subiquity silent installer config
│       └── meta-data             # Required empty file
│
├── scripts/
│   ├── bootstrap.sh              # Main installer (runs on first boot)
│   ├── gpu-detect.sh             # GPU detection (NVIDIA/AMD/none)
│   ├── install-gpu-drivers.sh    # CUDA / ROCm installer
│   ├── spag-cli.sh              # `llmspaghetti` CLI tool
│   └── llmspaghetti-watchdog.sh         # Service health watchdog
│
├── console/
│   └── status.py                 # tty1 live status dashboard
│
├── firstboot/
│   ├── main.py                   # FastAPI setup wizard (runs once)
│   ├── requirements.txt
│   └── templates/
│       ├── base.html
│       ├── welcome.html
│       ├── step_system.html      # Hostname, timezone, SSH key
│       ├── step_models.html      # Model selection
│       ├── step_apikeys.html     # Anthropic / OpenAI / Groq keys
│       ├── step_confirm.html     # Review and install
│       └── done.html             # Success page with URLs and API key
│
├── services/
│   ├── llmspaghetti-firstboot.service   # Runs web wizard (once only)
│   ├── llmspaghetti-status.service      # tty1 console display
│   ├── llmspaghetti.service             # Docker Compose stack
│   └── llmspaghetti-watchdog.service    # Health monitor
│
└── stack/
    └── docker-compose.yml        # Open WebUI + LiteLLM
```

---

## Quick start (WSL2)

### 1 — Install build tools
```bash
sudo bash iso/install-build-deps.sh
```

### 2 — Build the ISO
```bash
sudo bash iso/build.sh
# Outputs: llmspaghetti-YYYYMMDD.iso (~1.5GB)
```

### 3 — Test in a VM (no hardware needed)
```bash
# Install QEMU first
sudo apt install qemu-system-x86 qemu-utils

bash iso/test-vm.sh llmspaghetti-YYYYMMDD.iso
```
Then open `http://localhost:8080` in your browser.

### 4 — Flash to USB (for real hardware)
**Windows:** Use [Rufus](https://rufus.ie) — select your ISO, choose **DD mode**.  
**Linux/WSL2:**
```bash
sudo dd if=llmspaghetti-YYYYMMDD.iso of=/dev/sdX bs=4M status=progress
```

---

## Boot experience

```
1. Insert USB → boot
2. GRUB shows "Install LLMSpaghetti" → auto-selects in 5 seconds
3. Ubuntu installs silently (~5-10 minutes depending on disk speed)
4. Machine reboots automatically
5. Console shows:

   ██╗     ██╗     ███╗   ███╗ ██████╗  ███████╗
   ██║     ██║     ████╗ ████║██╔═══██╗██╔════╝
   ...
   
   Web Interface    http://192.168.1.42
   LLM API         http://192.168.1.42/v1
   Management      http://192.168.1.42:9090

6. Open browser → wizard guides you through:
   - Hostname / timezone / SSH key
   - Model selection (suggestions based on your GPU)
   - API keys (Anthropic, OpenAI, Groq — all optional)
7. Click Install → 30 seconds → done
8. Models download in background
```

---

## llmspaghetti CLI reference

```bash
# Service control
spag start|stop|restart|status

# Models
spag pull mistral          # Download a model
spag models                # List downloaded models

# Config
spag config                # Edit LiteLLM config (API keys, routes)
spag key                   # Show your API master key
spag gpu                   # GPU detection info

# Maintenance
spag logs [webui|litellm|ollama|caddy]
spag update                # Pull latest images
spag doctor                # Health check all services
spag reset-firstboot       # Re-run the setup wizard
```

---

## Connecting your IDE / CLI

Once setup is done, point any OpenAI-compatible tool at:

```
Base URL:  http://your-server/v1
API Key:   (shown in setup wizard and via `spag key`)
```

### Cursor
`Settings → Models → OpenAI API Key` → enter your key  
`Settings → Models → Override URL` → `http://your-server/v1`

### Continue.dev (VS Code / JetBrains)
```json
{
  "models": [{
    "title": "LLMSpaghetti",
    "provider": "openai",
    "model": "llama3",
    "apiBase": "http://your-server/v1",
    "apiKey": "your-master-key"
  }]
}
```

### Aider
```bash
aider --openai-api-base http://your-server/v1 \
      --openai-api-key your-master-key \
      --model llama3
```

### Shell / curl
```bash
curl http://your-server/v1/chat/completions \
  -H "Authorization: Bearer your-master-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"llama3","messages":[{"role":"user","content":"Hello"}]}'
```

---

## Adding API keys after setup

```bash
spag config
# Opens /opt/llmspaghetti/config/litellm_config.yaml in nano
# Add/change keys, save, LiteLLM restarts automatically
```

Or via the Cockpit web UI at `http://your-server:9090`.

---

## GPU support

- **NVIDIA** — CUDA drivers installed automatically if card detected
- **AMD** — ROCm installed automatically if card detected
- **Both** — both stacks installed, Ollama prefers CUDA
- **CPU** — works, just slower (use phi3:mini or gemma:2b)

Run `spag gpu` to see what was detected.

---

## Default credentials

| Service | URL | Default login |
|---|---|---|
| Open WebUI | `http://your-server` | Create on first use |
| Cockpit | `http://your-server:9090` | `llmspaghetti` / `llmspaghetti` (change this!) |
| SSH | port 22 | `llmspaghetti` / `llmspaghetti` (change this!) |

**Change the default password immediately:**
```bash
ssh llmspaghetti@your-server
passwd
```
