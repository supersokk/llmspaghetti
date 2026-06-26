#!/usr/bin/env bash
# =============================================================================
# LLMSpaghetti Terminal & Cockpit Plugin Installer
# Installs ttyd (web terminal) and the LLMSpaghetti Cockpit plugin.
# Called by bootstrap.sh — also safe to run standalone.
# =============================================================================

set -euo pipefail

INSTALL_DIR="/opt/llmspaghetti"
PLUGIN_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../cockpit-plugin" && pwd)"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RESET='\033[0m'
info()    { echo -e "  ${CYAN}▸${RESET}  $*"; }
success() { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn()    { echo -e "  ${YELLOW}⚠${RESET}  $*"; }

# ── Install ttyd ──────────────────────────────────────────────────────────────
install_ttyd() {
  info "Installing ttyd (web terminal)..."

  if command -v ttyd &>/dev/null; then
    success "ttyd already installed ($(ttyd --version 2>&1 | head -1))"
    return
  fi

  # Try apt first (available in Ubuntu 22.04+)
  if apt-cache show ttyd &>/dev/null 2>&1; then
    apt-get install -y -qq ttyd
    success "ttyd installed via apt"
    return
  fi

  # Fallback: download latest binary from GitHub releases
  info "Downloading ttyd binary from GitHub..."
  TTYD_VER=$(curl -fsSL https://api.github.com/repos/tsl0922/ttyd/releases/latest \
    | grep '"tag_name"' | sed 's/.*"v\([^"]*\)".*/\1/')

  wget -qO /usr/bin/ttyd \
    "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VER}/ttyd.x86_64"
  chmod +x /usr/bin/ttyd
  success "ttyd ${TTYD_VER} installed from GitHub"
}

# ── Install the systemd service ───────────────────────────────────────────────
install_terminal_service() {
  info "Installing llmspaghetti-terminal.service..."

  cp "$PLUGIN_SRC/../services/llmspaghetti-terminal.service" \
     /etc/systemd/system/llmspaghetti-terminal.service

  systemctl daemon-reload
  systemctl enable llmspaghetti-terminal.service
  systemctl restart llmspaghetti-terminal.service 2>/dev/null || \
    systemctl start  llmspaghetti-terminal.service

  success "Terminal service running on port 7681"
}

# ── Build and install Cockpit plugin ─────────────────────────────────────────
install_cockpit_plugin() {
  info "Building LLMSpaghetti Cockpit plugin..."

  # Need Node.js for webpack build
  if ! command -v node &>/dev/null; then
    info "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
  fi

  cd "$PLUGIN_SRC"

  # Install build deps
  npm install --silent 2>/dev/null

  # Build the React app
  npm run build

  # Install to Cockpit's plugin directory
  COCKPIT_DIR="/usr/share/cockpit/llmspaghetti"
  mkdir -p "$COCKPIT_DIR"
  cp dist/llmspaghetti.js     "$COCKPIT_DIR/"
  cp manifest.json     "$COCKPIT_DIR/"
  cp index.html        "$COCKPIT_DIR/"

  success "Cockpit plugin installed at $COCKPIT_DIR"

  # Restart Cockpit to pick up the new plugin
  systemctl restart cockpit 2>/dev/null || true
  success "Cockpit restarted"
}

# ── Update Caddy config to include /terminal/ route ──────────────────────────
update_caddy() {
  info "Updating Caddy config with terminal route..."

  CADDYFILE_SRC="$PLUGIN_SRC/../stack/Caddyfile"
  if [[ -f "$CADDYFILE_SRC" ]]; then
    cp "$CADDYFILE_SRC" /etc/caddy/Caddyfile
    systemctl reload caddy
    success "Caddy config updated"
  else
    warn "Caddyfile not found at $CADDYFILE_SRC — skipping"
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  install_ttyd
  install_terminal_service
  install_cockpit_plugin
  update_caddy

  echo ""
  IP=$(hostname -I | awk '{print $1}')
  echo -e "  ${GREEN}Terminal available at:${RESET}"
  echo -e "    Embedded  : http://${IP}  → Terminal tab"
  echo -e "    Cockpit   : http://${IP}:9090/system/terminal  (root shell)"
  echo ""
}

main "$@"
