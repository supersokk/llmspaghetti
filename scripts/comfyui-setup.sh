#!/usr/bin/env bash
#
# ComfyUI setup for LLMSpaghetti image generation.
#
# Installs ComfyUI (if missing) and registers a systemd service so it starts on
# boot and restarts on failure — no more nohup babysitting. Idempotent: safe to
# re-run (skips the clone/deps if they're already there, just refreshes the
# service). Picks the ComfyUI VRAM flag from the detected GPU.
#
# Run as your NORMAL user (not root). It uses sudo only for the systemd bits and
# will prompt for your password once. ComfyUI itself runs as you, from your home,
# so model downloads and the GPU work exactly as they do when you launch it by hand.
#
#   Usage:  bash scripts/comfyui-setup.sh
#   Env:    COMFYUI_DIR (default ~/ComfyUI)   COMFYUI_PORT (default 8188)

set -euo pipefail

CYAN='\033[36m'; GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; RESET='\033[0m'
info(){ echo -e "${CYAN}▸${RESET}  $*"; }
ok(){   echo -e "${GREEN}✓${RESET}  $*"; }
warn(){ echo -e "${YELLOW}⚠${RESET}  $*"; }
die(){  echo -e "${RED}✗${RESET}  $*" >&2; exit 1; }

[[ "$(id -un)" == "root" ]] && die "Run as your normal user, not root (it uses sudo only where needed)."

COMFY_DIR="${COMFYUI_DIR:-$HOME/ComfyUI}"
COMFY_PORT="${COMFYUI_PORT:-8188}"
COMFY_USER="$(id -un)"
REPO="https://github.com/comfyanonymous/ComfyUI.git"

# ── 1. Clone ComfyUI if it isn't there ────────────────────────────────────────
if [[ ! -d "$COMFY_DIR/.git" && ! -f "$COMFY_DIR/main.py" ]]; then
  info "Cloning ComfyUI → $COMFY_DIR"
  git clone "$REPO" "$COMFY_DIR"
else
  ok "ComfyUI already present at $COMFY_DIR"
fi

# ── 2. venv + Python deps (skip if PyTorch already imports) ───────────────────
if [[ ! -x "$COMFY_DIR/venv/bin/python" ]]; then
  info "Creating virtualenv"
  python3 -m venv "$COMFY_DIR/venv"
fi
if "$COMFY_DIR/venv/bin/python" -c "import torch" >/dev/null 2>&1; then
  ok "PyTorch already installed — skipping dependency install"
else
  info "Installing PyTorch + ComfyUI requirements (large download, be patient)…"
  "$COMFY_DIR/venv/bin/pip" install --upgrade pip -q
  "$COMFY_DIR/venv/bin/pip" install -r "$COMFY_DIR/requirements.txt"
  "$COMFY_DIR/venv/bin/python" -c "import torch" >/dev/null 2>&1 \
    || die "PyTorch failed to install — check the pip output above."
fi

# ── 3. Pick the VRAM flag from the actual GPU ─────────────────────────────────
VRAM_MB=0
if command -v nvidia-smi >/dev/null 2>&1; then
  VRAM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')
fi
VRAM_MB=${VRAM_MB:-0}
if   [[ "$VRAM_MB" -gt 0 && "$VRAM_MB" -lt 10000 ]]; then VRAM_FLAG="--lowvram";  info "GPU ${VRAM_MB}MB → --lowvram (coexists with chat models by spilling to RAM)"
elif [[ "$VRAM_MB" -ge 10000 ]];                     then VRAM_FLAG="";           info "GPU ${VRAM_MB}MB → default VRAM mode"
else                                                      VRAM_FLAG="--cpu";       warn "No NVIDIA GPU detected → --cpu (image generation will be slow)"
fi

# ── 4. If a manual instance is already holding the port, stop it ──────────────
if command -v ss >/dev/null 2>&1 && ss -ltn "( sport = :$COMFY_PORT )" 2>/dev/null | grep -q ":$COMFY_PORT"; then
  warn "Something is already listening on :$COMFY_PORT (probably a manual 'nohup python main.py')."
  warn "Stop it before the service can bind — e.g.  pkill -f 'main.py --listen'"
fi

# ── 5. systemd service — starts on boot, restarts on failure ──────────────────
info "Writing /etc/systemd/system/comfyui.service (runs as $COMFY_USER)"
sudo tee /etc/systemd/system/comfyui.service >/dev/null <<UNIT
[Unit]
Description=ComfyUI (LLMSpaghetti image generation)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$COMFY_USER
WorkingDirectory=$COMFY_DIR
ExecStart=$COMFY_DIR/venv/bin/python $COMFY_DIR/main.py --listen 0.0.0.0 --port $COMFY_PORT $VRAM_FLAG
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now comfyui.service

echo
ok "ComfyUI service is enabled — it will start automatically on every boot."
info "Status:  systemctl status comfyui        Logs:  journalctl -u comfyui -f"
info "Point the Image Generator tab's engine dir (comfy_dir) at: $COMFY_DIR"
