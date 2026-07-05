#!/usr/bin/env bash
#
# ComfyUI setup for LLMSpaghetti image generation.
#
# Installs ComfyUI (if missing) and registers a systemd service so it starts on
# boot and restarts on failure — no more nohup babysitting. Idempotent: safe to
# re-run (skips clone/deps if present, just refreshes the service). Picks the
# ComfyUI VRAM flag from the detected GPU.
#
# Works two ways so both the CLI and the Cockpit Services button can call it:
#   • run as your normal user  → installs for you, sudos only for the service
#   • run as root (Cockpit)     → installs for the target user (COMFYUI_USER,
#                                 else SUDO_USER, else the first regular account)
#
#   Usage:  bash scripts/comfyui-setup.sh
#   Env:    COMFYUI_DIR   (default <user home>/ComfyUI)
#           COMFYUI_PORT  (default 8188)
#           COMFYUI_USER  (target user when run as root)

set -euo pipefail

CYAN='\033[36m'; GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; RESET='\033[0m'
info(){ echo -e "${CYAN}▸${RESET}  $*"; }
ok(){   echo -e "${GREEN}✓${RESET}  $*"; }
warn(){ echo -e "${YELLOW}⚠${RESET}  $*"; }
die(){  echo -e "${RED}✗${RESET}  $*" >&2; exit 1; }

COMFY_PORT="${COMFYUI_PORT:-8188}"
REPO="https://github.com/comfyanonymous/ComfyUI.git"

# ── Who owns & runs ComfyUI (its venv + models live in that user's home) ──────
if [[ $EUID -eq 0 ]]; then
  TARGET_USER="${COMFYUI_USER:-${SUDO_USER:-}}"
  [[ -n "$TARGET_USER" ]] || TARGET_USER="$(getent passwd | awk -F: '$3>=1000 && $3<65000 {print $1; exit}')"
  [[ -n "$TARGET_USER" ]] || die "Running as root but no target user found — set COMFYUI_USER=<user>."
else
  TARGET_USER="$(id -un)"
fi
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
[[ -n "$TARGET_HOME" ]] || die "Could not resolve the home directory for '$TARGET_USER'."
COMFY_DIR="${COMFYUI_DIR:-$TARGET_HOME/ComfyUI}"

# Run a snippet as the target user (root→runuser, already-them→direct).
as_user(){ if [[ "$(id -un)" == "$TARGET_USER" ]]; then bash -c "$1"; else runuser -u "$TARGET_USER" -- bash -c "$1"; fi; }
# Run a privileged snippet (root→direct, else sudo).
as_root(){ if [[ $EUID -eq 0 ]]; then bash -c "$1"; else sudo bash -c "$1"; fi; }

info "ComfyUI will run as '$TARGET_USER' from $COMFY_DIR"

# ── 1. Clone if missing ───────────────────────────────────────────────────────
if [[ -f "$COMFY_DIR/main.py" ]]; then
  ok "ComfyUI already present at $COMFY_DIR"
else
  info "Cloning ComfyUI → $COMFY_DIR"
  as_user "git clone '$REPO' '$COMFY_DIR'"
fi

# ── 2. venv + deps (skip if PyTorch already imports) ──────────────────────────
if ! as_user "test -x '$COMFY_DIR/venv/bin/python'"; then
  info "Creating virtualenv"
  as_user "python3 -m venv '$COMFY_DIR/venv'"
fi
if as_user "'$COMFY_DIR/venv/bin/python' -c 'import torch'" >/dev/null 2>&1; then
  ok "PyTorch already installed — skipping dependency install"
else
  info "Installing PyTorch + ComfyUI requirements (large download, be patient)…"
  as_user "'$COMFY_DIR/venv/bin/pip' install --upgrade pip -q"
  as_user "'$COMFY_DIR/venv/bin/pip' install -r '$COMFY_DIR/requirements.txt'"
  as_user "'$COMFY_DIR/venv/bin/python' -c 'import torch'" >/dev/null 2>&1 \
    || die "PyTorch failed to install — check the pip output above."
fi

# ── 3. Pick the VRAM flag from the actual GPU ─────────────────────────────────
VRAM_MB=0
command -v nvidia-smi >/dev/null 2>&1 && \
  VRAM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')
VRAM_MB=${VRAM_MB:-0}
if   [[ "$VRAM_MB" -gt 0 && "$VRAM_MB" -lt 10000 ]]; then VRAM_FLAG="--lowvram"; info "GPU ${VRAM_MB}MB → --lowvram (spills to RAM to coexist with chat models)"
elif [[ "$VRAM_MB" -ge 10000 ]];                     then VRAM_FLAG="";          info "GPU ${VRAM_MB}MB → default VRAM mode"
else                                                      VRAM_FLAG="--cpu";      warn "No NVIDIA GPU detected → --cpu (image generation will be slow)"
fi

# ── 4. Warn if the port is already held by a manual instance ──────────────────
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$COMFY_PORT "; then
  warn "Port $COMFY_PORT is already in use (a manual 'nohup python main.py'?)."
  warn "Stop it so the service can bind:  pkill -f 'main.py --listen'"
fi

# ── 5. systemd service — starts on boot, restarts on failure ──────────────────
info "Installing /etc/systemd/system/comfyui.service (runs as $TARGET_USER)"
UNIT=$(cat <<UNIT
[Unit]
Description=ComfyUI (LLMSpaghetti image generation)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$TARGET_USER
WorkingDirectory=$COMFY_DIR
ExecStart=$COMFY_DIR/venv/bin/python $COMFY_DIR/main.py --listen 0.0.0.0 --port $COMFY_PORT $VRAM_FLAG
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
)
TMP="$(mktemp)"
printf '%s\n' "$UNIT" > "$TMP"
as_root "install -m0644 '$TMP' /etc/systemd/system/comfyui.service && systemctl daemon-reload && systemctl enable --now comfyui.service"
rm -f "$TMP"

echo
ok "ComfyUI service is enabled — it starts automatically on every boot."
info "Status:  systemctl status comfyui        Logs:  journalctl -u comfyui -f"
info "Image Generator tab → set comfy_dir to: $COMFY_DIR"
