#!/usr/bin/env bash
# =============================================================================
# LLMSpaghetti NODE Bootstrap — minimal compute node
# Turns a GPU (or CPU) box into an Ollama compute node for an LLMSpaghetti core.
#
# Installs ONLY: GPU drivers + Ollama (LAN-exposed). No Docker, no router, no
# Cockpit, no web stack — every resource goes to models. The "core" (a separate
# LLMSpaghetti install) classifies + routes to this node's Ollama over the LAN.
#
# ⚠  HOBBY PROJECT — vibecoded spaghetti, no warranty. See DISCLAIMER.md.
#
# Usage (on the node):
#   curl -fsSL https://raw.githubusercontent.com/supersokk/llmspaghetti/main/scripts/node-bootstrap.sh | sudo bash
#
#   # …and, to let the core PUSH installs/pulls to this node over SSH later,
#   # pass the core's node-management public key:
#   curl -fsSL .../node-bootstrap.sh | sudo CORE_SSH_KEY="ssh-ed25519 AAAA… core" bash
# =============================================================================

set -euo pipefail

# Real BASH_SOURCE when run from a checkout; empty when piped (curl | sudo bash).
SCRIPT_SRC="${BASH_SOURCE[0]:-}"
if [[ -n "$SCRIPT_SRC" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SRC")" && pwd)"
else
  SCRIPT_DIR=""
fi

NODE_DIR="/opt/llmspaghetti-node"
MODELS_DIR="$NODE_DIR/models"
REPO_URL="${LLMSPAGHETTI_REPO:-https://github.com/supersokk/llmspaghetti}"
REPO_REF="${LLMSPAGHETTI_REF:-main}"
CORE_SSH_KEY="${CORE_SSH_KEY:-}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
step()    { echo -e "\n${BOLD}${CYAN}━━━ $* ━━━${RESET}"; }
info()    { echo -e "  ${CYAN}▸${RESET}  $*"; }
success() { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn()    { echo -e "  ${YELLOW}⚠${RESET}  $*"; }
error()   { echo -e "  ${RED}✗${RESET}  $*" >&2; exit 1; }

[[ $EUID -ne 0 ]] && error "Run as root: sudo bash node-bootstrap.sh"

# ── Minimal system deps ───────────────────────────────────────────────────────
step "System update"
apt-get update -qq
apt-get install -y -qq curl wget git jq pciutils ca-certificates gnupg lsb-release
success "Base packages installed"

# ── Fetch source if piped in (need gpu-detect.sh + install-gpu-drivers.sh) ────
if [[ -z "$SCRIPT_DIR" || ! -f "$SCRIPT_DIR/install-gpu-drivers.sh" ]]; then
  step "Fetching LLMSpaghetti source"
  SRC_DIR="/opt/llmspaghetti-src"
  if [[ -d "$SRC_DIR/.git" ]]; then
    git -C "$SRC_DIR" fetch --depth 1 origin "$REPO_REF" \
      && git -C "$SRC_DIR" reset --hard "origin/$REPO_REF"
  else
    rm -rf "$SRC_DIR"
    git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$SRC_DIR"
  fi
  SCRIPT_DIR="$SRC_DIR/scripts"
  success "Source ready at $SRC_DIR"
fi

# ── GPU detection + drivers (NVIDIA / AMD-Vulkan / CPU) ───────────────────────
step "GPU detection and driver installation"
# install-gpu-drivers.sh drops a reboot marker + gpu-info.json under this path.
mkdir -p /opt/llmspaghetti
bash "$SCRIPT_DIR/install-gpu-drivers.sh" || warn "GPU driver install had issues — continuing (CPU mode if no GPU)"

# ── Ollama (native, LAN-exposed) ─────────────────────────────────────────────
step "Installing Ollama"
if ! command -v ollama &>/dev/null; then
  curl -fsSL https://ollama.com/install.sh | sh
  success "Ollama installed"
else
  success "Ollama already installed"
fi

# Ollama runs as its own 'ollama' user and must own the models dir it writes.
mkdir -p "$MODELS_DIR"
chown -R ollama:ollama "$NODE_DIR" 2>/dev/null || true
chmod 755 "$NODE_DIR"

# Expose on the LAN + point at our models dir. OLLAMA_MAX_LOADED_MODELS / KEEP_ALIVE
# tune residency (see the core bootstrap notes); a node is smaller so default to 4.
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/llmspaghetti-node.conf << EOF
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_MODELS=${MODELS_DIR}"
Environment="OLLAMA_MAX_LOADED_MODELS=${OLLAMA_MAX_LOADED_MODELS:-4}"
Environment="OLLAMA_KEEP_ALIVE=${OLLAMA_KEEP_ALIVE:--1}"
EOF
systemctl daemon-reload
# RESTART, not `enable --now`: Ollama's installer already started the service on
# the DEFAULT 127.0.0.1, so `enable --now` is a no-op and the drop-in wouldn't
# take effect (lesson from the core bootstrap). Restart so it binds 0.0.0.0.
systemctl enable ollama
systemctl restart ollama
success "Ollama exposed on 0.0.0.0:11434  (models in $MODELS_DIR)"

# ── Optional: authorize the core to manage this node over SSH ─────────────────
if [[ -n "$CORE_SSH_KEY" ]]; then
  step "Authorizing core SSH access"
  # The core pushes installs (ComfyUI, drivers, model pulls) as root over SSH.
  # Key-based root login only (Ubuntu's default PermitRootLogin prohibit-password).
  install -d -m 700 /root/.ssh
  touch /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
  grep -qF "$CORE_SSH_KEY" /root/.ssh/authorized_keys \
    || echo "$CORE_SSH_KEY" >> /root/.ssh/authorized_keys
  success "Core key authorized — the core can now push installs/pulls to this node"
else
  info "No CORE_SSH_KEY given: Ollama is reachable, but the core can't push"
  info "installs over SSH yet. Add the core's key later (Cockpit → Nodes will"
  info "generate one), or re-run with CORE_SSH_KEY=… to enable remote management."
fi

# ── Done ──────────────────────────────────────────────────────────────────────
NODE_IP="$(hostname -I | awk '{print $1}')"
step "Node ready"
echo ""
echo -e "  ${BOLD}Ollama:${RESET}  ${CYAN}http://${NODE_IP}:11434${RESET}"
echo -e "  Register it on the core (Cockpit → Nodes), or point a role's model here."
echo ""
echo -e "  Quick check from the core:  ${CYAN}curl http://${NODE_IP}:11434/api/tags${RESET}"
echo -e "  Pull a model here:          ${CYAN}ollama pull qwen2.5-coder:3b${RESET}"
echo ""
warn "Security: Ollama is open on the LAN with no auth. If you want it locked to"
echo -e "  the core only:  ${CYAN}sudo ufw allow from <core-ip> to any port 11434 && sudo ufw enable${RESET}"

if [[ -f /opt/llmspaghetti/.needs-reboot ]]; then
  echo ""
  warn "GPU drivers were installed — a reboot is recommended before serving models."
fi
