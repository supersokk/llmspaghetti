#!/usr/bin/env bash
# =============================================================================
# LLMSpaghetti Master Bootstrap
# Installs the complete LLMSpaghetti stack on a fresh Ubuntu 22.04/24.04/26.04 server.
# Called by the ISO's first-boot service, or can be run manually.
#
# ⚠  HOBBY PROJECT — vibecoded spaghetti, no warranty, use at own risk.
#    See DISCLAIMER.md for the full story.
#
# Usage:
#   sudo bash bootstrap.sh
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/llmspaghetti"
LLMSPAGHETTI_USER="llmspaghetti"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

step()    { echo -e "\n${BOLD}${CYAN}━━━ $* ━━━${RESET}"; }
info()    { echo -e "  ${CYAN}▸${RESET}  $*"; }
success() { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn()    { echo -e "  ${YELLOW}⚠${RESET}  $*"; }
error()   { echo -e "  ${RED}✗${RESET}  $*" >&2; exit 1; }

[[ $EUID -ne 0 ]] && error "Run as root: sudo bash bootstrap.sh"

# ── System update ─────────────────────────────────────────────────────────────
step "System update"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq
apt-get install -y -qq \
  curl wget git jq unzip pciutils \
  ca-certificates gnupg lsb-release \
  software-properties-common apt-transport-https \
  python3 python3-pip python3-venv \
  net-tools iproute2 htop
success "System updated"

# ── Create service user and directories ──────────────────────────────────────
step "Creating LLMSpaghetti user and directories"

if ! id "$LLMSPAGHETTI_USER" &>/dev/null; then
  useradd -r -m -d "$INSTALL_DIR" -s /bin/bash "$LLMSPAGHETTI_USER"
  success "User '$LLMSPAGHETTI_USER' created"
fi

mkdir -p "$INSTALL_DIR"/{config,logs,data,images,models,scripts}
# data/webui is the bind-mount target for the Open WebUI container's data volume
# (see docker-compose.yml). Must exist before the stack starts or the mount fails.
mkdir -p "$INSTALL_DIR/data/webui"

# Copy base fixtures from eval/ into runtime data path
cp "$SCRIPT_DIR/../eval/fixtures_base.jsonl" "$INSTALL_DIR/data/" 2>/dev/null || true
# overrides_local.jsonl starts empty — user corrections accumulate here
touch "$INSTALL_DIR/data/overrides_local.jsonl"

# api_keys.env: created empty on first run, written by Settings tab
# Both the router and LiteLLM containers load this via env_file.
if [[ ! -f "$INSTALL_DIR/config/api_keys.env" ]]; then
  cat > "$INSTALL_DIR/config/api_keys.env" << 'ENVEOF'
# LLMSpaghetti API Keys
# Managed by Settings → API Keys panel.
# Keys added here are automatically picked up by LiteLLM and the router.
# Restart the stack (spag restart) or save from the UI to apply changes.

# OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
# GROQ_API_KEY=gsk_...
# COHERE_API_KEY=...
# GEMINI_API_KEY=...
# BRAVE_API_KEY=...
# GITHUB_PERSONAL_ACCESS_TOKEN=ghp_...
ENVEOF
  success "api_keys.env created (add your keys in Settings)"
fi

# mcp.json: empty server map on first run, written by Services → MCP Tools
if [[ ! -f "$INSTALL_DIR/config/mcp.json" ]]; then
  echo '{"mcpServers":{}}' > "$INSTALL_DIR/config/mcp.json"
fi

chown -R "$LLMSPAGHETTI_USER:$LLMSPAGHETTI_USER" "$INSTALL_DIR"
# Ollama runs as its own user. It needs to (a) traverse INSTALL_DIR and
# (b) write to the models dir. Without the 755 on INSTALL_DIR, Ollama fails
# with "mkdir models: permission denied — ensure path elements are traversable".
chmod 755 "$INSTALL_DIR"
chown -R ollama:ollama "$INSTALL_DIR/models" 2>/dev/null || true
success "Directories ready"

# ── Copy project files ────────────────────────────────────────────────────────
step "Installing LLMSpaghetti files"

# If running from repo, copy everything; else files are already in /opt/llmspaghetti
if [[ -d "$SCRIPT_DIR/../console" ]]; then
  cp -r "$SCRIPT_DIR/../console"   "$INSTALL_DIR/"
  cp -r "$SCRIPT_DIR/../firstboot" "$INSTALL_DIR/"
  cp -r "$SCRIPT_DIR/../router"    "$INSTALL_DIR/"
  cp -r "$SCRIPT_DIR/../eval"      "$INSTALL_DIR/"
  cp -r "$SCRIPT_DIR/../config/."  "$INSTALL_DIR/config/"
  cp -r "$SCRIPT_DIR/../stack/."   "$INSTALL_DIR/"
  cp "$SCRIPT_DIR/gpu-detect.sh"            "$INSTALL_DIR/scripts/"
  cp "$SCRIPT_DIR/install-gpu-drivers.sh"   "$INSTALL_DIR/scripts/"
  cp "$SCRIPT_DIR/spag-cli.sh"              /usr/local/bin/spag
  cp "$SCRIPT_DIR/spag-watchdog.sh"         /usr/local/bin/llmspaghetti-watchdog
  chmod +x /usr/local/bin/spag /usr/local/bin/llmspaghetti-watchdog
fi

chown -R "$LLMSPAGHETTI_USER:$LLMSPAGHETTI_USER" "$INSTALL_DIR"
success "Files installed"

# ── GPU detection and driver install ─────────────────────────────────────────
step "GPU detection and driver installation"
bash "$INSTALL_DIR/scripts/install-gpu-drivers.sh" || warn "GPU driver install failed — continuing in CPU mode"

# ── Docker ────────────────────────────────────────────────────────────────────
step "Installing Docker"
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  usermod -aG docker "$LLMSPAGHETTI_USER"
  systemctl enable --now docker
  success "Docker installed"
else
  success "Docker already installed"
fi

# ── Ollama ────────────────────────────────────────────────────────────────────
step "Installing Ollama"
if ! command -v ollama &>/dev/null; then
  curl -fsSL https://ollama.com/install.sh | sh
  success "Ollama installed"
else
  success "Ollama already installed"
fi

# Configure Ollama: listen on all interfaces, use LLMSpaghetti model directory
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/llmspaghetti.conf << EOF
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_MODELS=${INSTALL_DIR}/models"
EOF
systemctl daemon-reload
systemctl enable --now ollama
success "Ollama configured and running"

# ── Cockpit (server management UI) ───────────────────────────────────────────
step "Installing Cockpit"
if ! command -v cockpit &>/dev/null; then
  apt-get install -y -qq cockpit cockpit-storaged
  systemctl enable --now cockpit.socket
  success "Cockpit installed"
else
  success "Cockpit already installed"
fi

# ── Terminal + Cockpit plugin ─────────────────────────────────────────────────
step "Installing web terminal and Cockpit plugin"
bash "$SCRIPT_DIR/install-terminal.sh" || warn "Terminal install failed — can be retried with: spag install-terminal"

# ── Caddy (reverse proxy) ─────────────────────────────────────────────────────
step "Installing Caddy"
if ! command -v caddy &>/dev/null; then
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor > /etc/apt/keyrings/caddy-stable.gpg
  echo "deb [signed-by=/etc/apt/keyrings/caddy-stable.gpg] \
    https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy
  success "Caddy installed"
fi

mkdir -p /etc/caddy /var/log/caddy
cat > /etc/caddy/Caddyfile << 'EOF'
# LLMSpaghetti Caddy config — initial (first-boot wizard on port 3001)
# After setup, start_stack() rewrites this to proxy Open WebUI (port 3000).
:80 {
    handle /v1/* {
        reverse_proxy localhost:5000
    }
    handle {
        reverse_proxy localhost:3001
    }
    encode gzip
    log {
        output file /var/log/caddy/llmspaghetti.log
        format json
    }
}
EOF

mkdir -p /var/log/caddy
systemctl enable --now caddy
success "Caddy configured"

# ── Install systemd services ──────────────────────────────────────────────────
step "Installing systemd services"

SVC_DIR="$SCRIPT_DIR/../services"
if [[ -d "$SVC_DIR" ]]; then
  cp "$SVC_DIR"/*.service /etc/systemd/system/
fi

systemctl daemon-reload
systemctl enable llmspaghetti-firstboot.service
systemctl enable llmspaghetti-status.service
systemctl enable llmspaghetti-watchdog.service
# llmspaghetti.service is enabled by firstboot wizard after setup
success "Services installed"

# ── Python deps for first-boot wizard ────────────────────────────────────────
step "Installing Python dependencies"
# Ubuntu 24.04+ enforces PEP 668 — use a venv to avoid "externally managed" errors.
apt-get install -y -qq python3-venv python3-full 2>/dev/null || true
VENV="$INSTALL_DIR/.venv"
python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q fastapi uvicorn jinja2 python-multipart httpx pyyaml
# Make the venv pip available as llmspaghetti-pip for later use
ln -sf "$VENV/bin/pip"    /usr/local/bin/llmspaghetti-pip
ln -sf "$VENV/bin/python" /usr/local/bin/llmspaghetti-python
chown -R "$LLMSPAGHETTI_USER:$LLMSPAGHETTI_USER" "$VENV"
success "Python dependencies installed (venv: $VENV)"

# ── Disable getty on tty1 (status screen takes over) ─────────────────────────
step "Configuring console"
systemctl disable getty@tty1.service 2>/dev/null || true
systemctl mask    getty@tty1.service 2>/dev/null || true
success "Console configured"

# ── Start first-boot wizard ───────────────────────────────────────────────────
step "Starting services"

if [[ -f "$INSTALL_DIR/.firstboot-complete" ]]; then
  warn "First-boot already complete — starting main stack"
  systemctl start llmspaghetti.service
else
  systemctl start llmspaghetti-firstboot.service
  systemctl start llmspaghetti-status.service
fi

# ── Done ──────────────────────────────────────────────────────────────────────
IP=$(hostname -I | awk '{print $1}')

echo ""
echo -e "${BOLD}${GREEN}┌──────────────────────────────────────────────┐${RESET}"
echo -e "${BOLD}${GREEN}│         LLMSpaghetti Bootstrap Complete!            │${RESET}"
echo -e "${BOLD}${GREEN}└──────────────────────────────────────────────┘${RESET}"
echo ""
echo -e "  Open ${CYAN}http://${IP}${RESET} in your browser to complete setup."
echo ""

if [[ -f "$INSTALL_DIR/.needs-reboot" ]]; then
  echo -e "  ${YELLOW}⚠  GPU drivers were installed — a reboot is recommended.${RESET}"
  echo -e "  After reboot: open ${CYAN}http://${IP}${RESET} and the wizard will be waiting."
  echo ""
fi
