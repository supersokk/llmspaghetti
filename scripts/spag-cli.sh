#!/usr/bin/env bash
# =============================================================================
# llmspaghetti — LLMSpaghetti management CLI
# =============================================================================

INSTALL_DIR="/opt/llmspaghetti"
COMPOSE="docker compose -f $INSTALL_DIR/docker-compose.yml"
VERSION="0.1.0"

# Source checkout the installer leaves behind (curl|bash clones here and keeps it).
# `spag update` pulls it and redeploys our code. Overridable if you installed from
# your own clone elsewhere.
SRC_DIR="${LLMSPAGHETTI_SRC:-/opt/llmspaghetti-src}"
REPO_REF="${LLMSPAGHETTI_REF:-main}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

# ── Helpers ──────────────────────────────────────────────────────────────────
info()    { echo -e "${CYAN}▸${RESET}  $*"; }
success() { echo -e "${GREEN}✓${RESET}  $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET}  $*"; }
error()   { echo -e "${RED}✗${RESET}  $*" >&2; exit 1; }

require_root() {
  [[ $EUID -eq 0 ]] || error "This command requires root: sudo llmspaghetti $*"
}

# ── Commands ──────────────────────────────────────────────────────────────────

cmd_status() {
  echo ""
  echo -e "  ${BOLD}LLMSpaghetti v${VERSION}${RESET}"
  echo ""

  local ip
  ip=$(hostname -I | awk '{print $1}')
  echo -e "  Web UI   ${CYAN}http://${ip}${RESET}"
  echo -e "  API      ${CYAN}http://${ip}/api/v1${RESET}"
  echo -e "  Cockpit  ${CYAN}http://${ip}:9090${RESET}"
  echo ""

  local services=("ollama" "caddy" "cockpit")
  echo -e "  ${BOLD}Systemd services${RESET}"
  for svc in "${services[@]}"; do
    local state
    state=$(systemctl is-active "$svc" 2>/dev/null)
    if [[ "$state" == "active" ]]; then
      echo -e "    ${GREEN}●${RESET} $svc"
    else
      echo -e "    ${RED}○${RESET} $svc (${state})"
    fi
  done

  echo ""
  echo -e "  ${BOLD}Docker containers${RESET}"
  $COMPOSE ps --format "table {{.Name}}\t{{.Status}}" 2>/dev/null | tail -n +2 | while read -r line; do
    if echo "$line" | grep -q "Up"; then
      echo -e "    ${GREEN}●${RESET} $line"
    else
      echo -e "    ${RED}○${RESET} $line"
    fi
  done
  echo ""
}

cmd_start()   { info "Starting LLMSpaghetti stack..."; systemctl start llmspaghetti && success "Started"; }
cmd_stop()    { info "Stopping LLMSpaghetti stack..."; systemctl stop llmspaghetti  && success "Stopped"; }
cmd_restart() { info "Restarting..."; systemctl restart llmspaghetti && success "Restarted"; }

cmd_logs() {
  local svc="${1:-}"
  case "$svc" in
    router)  $COMPOSE logs -f router ;;
    litellm) $COMPOSE logs -f litellm ;;
    ollama)  journalctl -u ollama -f ;;
    caddy)   journalctl -u caddy -f ;;
    firstboot) tail -f "$INSTALL_DIR/logs/firstboot.log" ;;
    watchdog)  tail -f "$INSTALL_DIR/logs/watchdog.log" ;;
    *)
      echo "Usage: spag logs [router|litellm|ollama|caddy|firstboot|watchdog]"
      echo "Showing all Docker logs:"
      $COMPOSE logs -f
      ;;
  esac
}

cmd_pull() {
  local model="${1:?Usage: spag pull <model>  e.g. spag pull mistral}"
  info "Pulling model: $model"
  ollama pull "$model"
}

cmd_models() {
  echo ""
  echo -e "  ${BOLD}Downloaded models${RESET}"
  ollama list 2>/dev/null | tail -n +2 | while read -r line; do
    echo "    $line"
  done
  echo ""
}

cmd_comfyui() {
  local sub="${1:-}"; shift || true
  local setup="$INSTALL_DIR/scripts/comfyui-setup.sh"
  case "$sub" in
    install|setup)
      [[ -f "$setup" ]] || error "ComfyUI setup script not found at $setup"
      # The script figures out the target user itself (COMFYUI_USER → SUDO_USER →
      # first regular account) and handles both root and non-root invocation.
      COMFYUI_USER="${COMFYUI_USER:-${SUDO_USER:-}}" bash "$setup"
      ;;
    start)   info "Starting ComfyUI...";   systemctl start comfyui   && success "Started" ;;
    stop)    info "Stopping ComfyUI...";    systemctl stop comfyui    && success "Stopped" ;;
    restart) info "Restarting ComfyUI..."; systemctl restart comfyui && success "Restarted" ;;
    status)  systemctl status comfyui --no-pager ;;
    logs)    journalctl -u comfyui -f ;;
    *)
      echo "Usage: spag comfyui [install|start|stop|restart|status|logs]"
      echo "  install  — set up ComfyUI + a boot service (first-time setup)"
      echo "  start/stop/restart/status/logs — manage the service"
      ;;
  esac
}

cmd_update() {
  require_root update

  # 1. Update our own code from the source checkout, then redeploy it. This is the
  #    piece that was missing: `spag update` used to pull only the container images
  #    (cloud providers), never the router / Cockpit plugin / SpagDesk / scripts,
  #    which live in the git source and are copied into $INSTALL_DIR.
  if [[ -d "$SRC_DIR/.git" ]]; then
    info "Updating source at $SRC_DIR ($REPO_REF)..."
    # Shallow-clone-safe + robust against local dirt (e.g. an untracked
    # package-lock.json): fetch the ref and hard-reset instead of `git pull`.
    if git -C "$SRC_DIR" fetch --depth 1 origin "$REPO_REF" \
        && git -C "$SRC_DIR" reset --hard "origin/$REPO_REF"; then

      info "Redeploying router, SpagDesk, scripts..."
      cp -r "$SRC_DIR/router"            "$INSTALL_DIR/"                    # bind-mounted → restart picks it up
      cp    "$SRC_DIR/spagdesk/index.html" "$INSTALL_DIR/spagdesk/index.html" 2>/dev/null || true
      cp    "$SRC_DIR"/scripts/*.sh      "$INSTALL_DIR/scripts/"           2>/dev/null || true

      info "Rebuilding Cockpit plugin..."
      bash "$SRC_DIR/scripts/install-terminal.sh" || warn "Cockpit plugin rebuild failed — retry with: spag install-terminal"

      # Refresh the CLI itself last, via atomic rename so this running script's
      # inode is untouched (cp would truncate-in-place and can corrupt a live run).
      install -m 0755 "$SRC_DIR/scripts/spag-cli.sh"      /usr/local/bin/spag                 2>/dev/null || true
      install -m 0755 "$SRC_DIR/scripts/spag-watchdog.sh" /usr/local/bin/llmspaghetti-watchdog 2>/dev/null || true
      success "Code updated"
    else
      warn "Could not update $SRC_DIR — skipping code redeploy, updating images only"
    fi
  else
    warn "No source checkout at $SRC_DIR — updating container images only."
    warn "To enable code updates: git clone https://github.com/supersokk/llmspaghetti $SRC_DIR"
  fi

  # 2. Pull the cloud/service container images and restart the stack (also picks up
  #    the freshly-copied bind-mounted router code).
  info "Pulling latest container images..."
  $COMPOSE pull
  info "Restarting stack..."
  systemctl restart llmspaghetti
  success "Update complete — hard-refresh the browser (Ctrl+Shift+R) for Cockpit + SpagDesk"
}

cmd_config() {
  local editor="${EDITOR:-nano}"
  $editor "$INSTALL_DIR/config/litellm_config.yaml"
  info "Restarting LiteLLM to apply changes..."
  $COMPOSE restart litellm
  success "Config applied"
}

cmd_key() {
  local key_file="$INSTALL_DIR/config/master_key"
  if [[ -f "$key_file" ]]; then
    echo ""
    echo -e "  ${BOLD}API Master Key${RESET}"
    echo -e "  $(cat "$key_file")"
    echo ""
    echo -e "  Use this as the API key in your IDE/CLI."
    echo -e "  Base URL: http://$(hostname -I | awk '{print $1}')/api/v1"
    echo ""
  else
    warn "Master key not found — run setup first or check $INSTALL_DIR/config/litellm_config.yaml"
  fi
}

cmd_gpu() {
  bash "$INSTALL_DIR/../scripts/gpu-detect.sh" --summary 2>/dev/null || \
  bash /opt/llmspaghetti/scripts/gpu-detect.sh --summary 2>/dev/null || \
  warn "gpu-detect.sh not found"
}

cmd_doctor() {
  echo ""
  echo -e "  ${BOLD}LLMSpaghetti Doctor${RESET} — checking everything"
  echo ""

  local ok=true

  check() {
    local label="$1"; local cmd="$2"
    if eval "$cmd" &>/dev/null; then
      echo -e "  ${GREEN}✓${RESET}  $label"
    else
      echo -e "  ${RED}✗${RESET}  $label"
      ok=false
    fi
  }

  check "Docker installed"         "command -v docker"
  check "Docker running"           "systemctl is-active docker"
  check "Ollama installed"         "command -v ollama"
  check "Ollama running"           "systemctl is-active ollama"
  check "Caddy running"            "systemctl is-active caddy"
  check "Router container"         "docker inspect llmspaghetti-router"
  check "LiteLLM container"        "docker inspect llmspaghetti-litellm"
  check "Config file exists"       "test -f /opt/llmspaghetti/config/litellm_config.yaml"
  check "First-boot complete"      "test -f /opt/llmspaghetti/.firstboot-complete"
  check "Router reachable"         "curl -sf --max-time 3 http://localhost:5000/health"
  check "LiteLLM reachable"        "curl -sf --max-time 3 http://localhost:4000/health"

  echo ""
  $ok && success "All checks passed" || warn "Some checks failed — run: spag logs"
  echo ""
}

cmd_menu() {
  local ip
  ip=$(hostname -I | awk '{print $1}' 2>/dev/null || echo "localhost")

  while true; do
    clear
    echo ""
    echo -e "  ${BOLD}🍝 LLMSpaghetti v${VERSION}${RESET}   ${CYAN}http://${ip}${RESET}"
    echo ""

    # Live service status summary
    local stack_ok=true
    for svc in ollama caddy; do
      systemctl is-active "$svc" &>/dev/null || stack_ok=false
    done
    if $stack_ok; then
      echo -e "  ${GREEN}● Stack running${RESET}"
    else
      echo -e "  ${RED}○ Stack not fully running  (run option 3 for details)${RESET}"
    fi
    echo ""

    echo -e "  ${BOLD}Quick actions${RESET}"
    echo -e "    ${CYAN}1${RESET})  Status          — service health + URLs"
    echo -e "    ${CYAN}2${RESET})  Models           — list downloaded models"
    echo -e "    ${CYAN}3${RESET})  Doctor           — run health checks"
    echo -e "    ${CYAN}4${RESET})  Pull model       — download a new model"
    echo -e "    ${CYAN}5${RESET})  Logs             — tail service logs"
    echo -e "    ${CYAN}6${RESET})  Routing eval     — test classifier accuracy"
    echo -e "    ${CYAN}7${RESET})  Update stack     — pull latest images"
    echo -e "    ${CYAN}8${RESET})  Restart stack    — restart all services"
    echo -e "    ${CYAN}9${RESET})  Shell            — drop to full bash"
    echo -e "    ${CYAN}0${RESET})  Exit"
    echo ""
    read -rp "  → " choice
    echo ""
    case "$choice" in
      1)
        cmd_status
        read -rp "  Press Enter to continue…" _
        ;;
      2)
        cmd_models
        read -rp "  Press Enter to continue…" _
        ;;
      3)
        cmd_doctor
        read -rp "  Press Enter to continue…" _
        ;;
      4)
        read -rp "  Model name (e.g. mistral, llama3.2:3b, deepseek-r1:7b): " model
        if [[ -n "$model" ]]; then
          echo ""
          cmd_pull "$model"
        fi
        read -rp "  Press Enter to continue…" _
        ;;
      5)
        echo -e "  Services: ${CYAN}router  litellm  ollama  caddy  firstboot  watchdog${RESET}"
        read -rp "  Service name (or Enter for all): " svc
        cmd_logs "${svc:-}"
        read -rp "  Press Ctrl+C to stop tailing, then Enter to return…" _
        ;;
      6)
        info "Running routing eval…"
        python3 /opt/llmspaghetti/eval/eval_router.py \
          --fixtures /opt/llmspaghetti/data/fixtures_base.jsonl 2>/dev/null || \
        python3 "$(dirname "$0")/../eval/eval_router.py" 2>/dev/null || \
        warn "eval_router.py not found"
        read -rp "  Press Enter to continue…" _
        ;;
      7)
        cmd_update
        read -rp "  Press Enter to continue…" _
        ;;
      8)
        cmd_restart
        read -rp "  Press Enter to continue…" _
        ;;
      9)
        info "Dropping to bash. Type 'exit' or press Ctrl+D to return to menu."
        bash --login
        ;;
      0|q|Q)
        echo ""
        break
        ;;
      *)
        warn "Unknown option: $choice"
        sleep 0.8
        ;;
    esac
  done
}

cmd_reset_firstboot() {
  require_root "reset-firstboot"
  warn "This will re-run the first-boot wizard on next restart."
  read -rp "  Are you sure? (yes/no): " confirm
  [[ "$confirm" == "yes" ]] || { info "Cancelled."; exit 0; }
  rm -f "$INSTALL_DIR/.firstboot-complete"
  systemctl enable llmspaghetti-firstboot.service
  success "First-boot wizard re-enabled. Reboot to run it."
}

# ── Dispatch ──────────────────────────────────────────────────────────────────
cmd="${1:-help}"
shift 2>/dev/null || true

case "$cmd" in
  menu|"")          cmd_menu ;;
  start)            cmd_start ;;
  stop)             cmd_stop ;;
  restart)          cmd_restart ;;
  status)           cmd_status ;;
  logs)             cmd_logs "$@" ;;
  pull)             cmd_pull "$@" ;;
  models)           cmd_models ;;
  comfyui)          cmd_comfyui "$@" ;;
  update)           cmd_update ;;
  config)           cmd_config ;;
  key)              cmd_key ;;
  gpu)              cmd_gpu ;;
  doctor)           cmd_doctor ;;
  reset-firstboot)  cmd_reset_firstboot ;;
  install-terminal)
    require_root install-terminal
    bash /opt/llmspaghetti/scripts/install-terminal.sh
    ;;
  fixtures)
    subcmd="${1:-help}"; shift 2>/dev/null || true
    case "$subcmd" in
      export)
        info "Exporting routing corrections for community contribution..."
        EXPORT="/opt/llmspaghetti/data/corrections_export.jsonl"
        LOCAL="/opt/llmspaghetti/data/overrides_local.jsonl"
        if [[ ! -f "$LOCAL" ]] || [[ ! -s "$LOCAL" ]]; then
          warn "No local corrections found yet."
          info "Use the web UI to correct misroutes — they'll appear here."
        else
          COUNT=$(grep -c '"source":"local"' "$LOCAL" 2>/dev/null || echo 0)
          info "Found $COUNT local corrections"
          info "Stripping message text for privacy (embeddings + metadata only)..."
          python3 -c "
import json, sys
with open('$LOCAL') as f, open('$EXPORT', 'w') as out:
    for line in f:
        line = line.strip()
        if not line: continue
        r = json.loads(line)
        if r.get('tombstoned'): continue
        r['message'] = None  # strip at export boundary
        r['source'] = 'community'
        out.write(json.dumps(r) + '\n')
print('Export written to $EXPORT')
"
          echo ""
          success "Exported to $EXPORT"
          info "Review the file, then open a PR to:"
          info "community/fixtures/contributed/general.jsonl"
          info "Or use the web UI → Settings → Contribute corrections"
        fi
        ;;
      eval)
        info "Running router eval against local fixtures..."
        python3 /opt/llmspaghetti/eval/eval_router.py \
          --fixtures /opt/llmspaghetti/data/fixtures_base.jsonl \
          --verbose
        ;;
      *)
        echo "Usage: spag fixtures [export|eval]"
        echo "  export  — export corrections for community contribution"
        echo "  eval    — run routing accuracy eval"
        ;;
    esac
    ;;
  shell)
    # Quick shortcut — open a root shell via Cockpit URL
    IP=$(hostname -I | awk '{print $1}')
    echo "Open this in your browser for a root shell:"
    echo "  http://${IP}:9090/system/terminal"
    ;;
  version)          echo "llmspaghetti v$VERSION" ;;
  help|--help|-h)
    echo ""
    echo -e "  ${BOLD}llmspaghetti v${VERSION}${RESET} — LLM OS management"
    echo ""
    echo -e "  ${BOLD}Interactive${RESET}"
    echo "    menu               Guided numbered menu (default when no args)"
    echo ""
    echo -e "  ${BOLD}Service control${RESET}"
    echo "    start              Start the LLMSpaghetti stack"
    echo "    stop               Stop the LLMSpaghetti stack"
    echo "    restart            Restart the LLMSpaghetti stack"
    echo "    status             Show service status and URLs"
    echo ""
    echo -e "  ${BOLD}Models${RESET}"
    echo "    pull <model>       Download a model  (e.g. spag pull mistral)"
    echo "    models             List downloaded models"
    echo ""
    echo -e "  ${BOLD}Configuration${RESET}"
    echo "    config             Edit LiteLLM config (API keys, model routes)"
    echo "    key                Show your API master key"
    echo "    gpu                Show GPU detection info"
    echo ""
    echo -e "  ${BOLD}Maintenance${RESET}"
    echo "    logs [service]     Tail logs  (router|litellm|ollama|caddy)"
    echo "    update             Pull latest images and restart"
    echo "    doctor             Run health checks"
    echo "    reset-firstboot    Re-run the setup wizard"
    echo "    install-terminal   Install/reinstall the web terminal"
    echo "    shell              Get the Cockpit root terminal URL"
    echo ""
    echo -e "  ${BOLD}Routing${RESET}"
    echo "    fixtures export    Export corrections for community contribution"
    echo "    fixtures eval      Run routing accuracy eval"
    echo ""
    ;;
  *)
    error "Unknown command: $cmd  (run 'llmspaghetti help' for usage)"
    ;;
esac
