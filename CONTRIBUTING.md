# Contributing to 🍝 LLMSpaghetti

First off — thank you. LLMSpaghetti is built by people who want better local AI tooling, and every contribution helps.

## Before you start

- Check [open issues](../../issues) to see if your idea is already being discussed
- For big changes, open an issue first so we can align before you spend time coding
- All contributions must be licensed under GPL v3 (by submitting a PR you agree to this)

---

## Development setup

### Requirements
- WSL2 (Windows) or any Linux machine
- Python 3.8+
- Node.js 18+
- bash 5+

### Get the code
```bash
git clone https://github.com/YOUR_USERNAME/llmspaghetti.git
cd llmspaghetti
```

### Install plugin build deps
```bash
cd cockpit-plugin
npm install
cd ..
```

### Run the pre-build check before every PR
```bash
bash test/pre-build-check.sh
```
All checks must pass. PRs with failures won't be merged.

---

## Project structure

```
scripts/          Shell scripts — bootstrap, GPU detection, CLI, watchdog
console/          Python — tty1 status display
firstboot/        Python/FastAPI — one-time setup wizard + Jinja2 templates
cockpit-plugin/   React — management web UI
  src/
    llmspaghetti.jsx         Main app + Models, Gateway, Terminal, Settings tabs
    tabs/
      Dashboard.jsx   Live system stats dashboard
services/         systemd unit files
stack/            docker-compose.yml + Caddyfile
iso/              ISO build scripts + autoinstall config
test/             Validation suite
docs/             Extended documentation
```

---

## How to add an optional service

Each tap-to-install service needs three things:

**1. A Docker Compose snippet** in `stack/services/<name>.yml`:
```yaml
services:
  comfyui:
    image: ghcr.io/ai-dock/comfyui:latest
    container_name: llmspaghetti-comfyui
    ...
```

**2. An install function** in `scripts/install-service.sh`:
```bash
install_comfyui() {
  merge_compose "stack/services/comfyui.yml"
  docker compose -f /opt/llmspaghetti/docker-compose.yml up -d comfyui
}
```

**3. A UI card** in `cockpit-plugin/src/tabs/Services.jsx`:
```jsx
{ id: "comfyui", name: "ComfyUI", desc: "Image generation", ... }
```

That's the full pattern. Copy an existing service as a template.

---

## Code style

**Shell scripts**
- `set -euo pipefail` at the top of every script
- Functions over inline code for anything >5 lines
- Colour output using the established `info/success/warn/error` helpers
- Comments for anything non-obvious

**Python**
- No external deps in `console/status.py` — stdlib only
- FastAPI for `firstboot/main.py` — keep it simple, no ORM
- Type hints appreciated but not required

**React / JSX**
- Functional components only, hooks for state
- Inline styles using the `C` colour token object (no CSS files)
- No external UI libraries — keep the bundle small for Cockpit

---

## Testing

Every PR should pass:
```bash
bash test/pre-build-check.sh    # always
python3 test/test_stats.py      # if you touched collect-stats.sh
python3 test/test_firstboot.py  # if you touched firstboot/
```

If you have a machine running LLMSpaghetti:
```bash
bash test/run-tests.sh --host your-machine-ip
```

---

## Submitting a PR

1. Fork the repo
2. Create a branch: `git checkout -b feature/your-feature`
3. Make your changes
4. Run `bash test/pre-build-check.sh` — must pass
5. Commit with a clear message: `git commit -m "feat: add SearXNG service"`
6. Push and open a PR against `main`

### Commit message format
```
feat: add ComfyUI tap-to-install service
fix: GPU detection fails on multi-GPU AMD systems
docs: add Aider connection example to README
test: add HTTP endpoint tests for /terminal/ route
chore: bump Open WebUI to latest image
```

---

## Reporting issues

Please include:
- Your GPU (make/model/VRAM)
- Ubuntu version (`lsb_release -a`)
- Output of `spag doctor`
- Relevant logs (`spag logs`)

---

## Hardware compatibility reports

Even just "tested on X GPU, works/doesn't work" is valuable.  
Open an issue with the `hardware-report` label.

---

## Questions?

Open a [Discussion](../../discussions) — issues are for bugs and feature requests.
