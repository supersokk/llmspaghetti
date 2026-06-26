#!/usr/bin/env bash
# =============================================================================
# LLMSpaghetti Watchdog
# Runs every 60s via systemd. Checks health of all services and restarts
# anything that has silently died.
# =============================================================================

INSTALL_DIR="/opt/llmspaghetti"
LOG="$INSTALL_DIR/logs/watchdog.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

check_systemd() {
  local name="$1"
  local state
  state=$(systemctl is-active "$name" 2>/dev/null)
  if [[ "$state" != "active" ]]; then
    log "RESTART systemd/$name (was: $state)"
    systemctl restart "$name" 2>/dev/null
    return 1
  fi
  return 0
}

check_container() {
  local name="$1"
  local state
  state=$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null)
  if [[ "$state" != "running" ]]; then
    log "RESTART container/$name (was: ${state:-not found})"
    docker start "$name" 2>/dev/null || \
      docker compose -f "$INSTALL_DIR/docker-compose.yml" up -d 2>/dev/null
    return 1
  fi
  return 0
}

main() {
  check_systemd "ollama"
  check_container "llmspaghetti-webui"
  check_container "llmspaghetti-litellm"
  check_systemd "caddy"
  check_systemd "cockpit"

  # Rotate log if over 5MB
  if [[ -f "$LOG" ]] && [[ $(stat -c%s "$LOG" 2>/dev/null || echo 0) -gt 5242880 ]]; then
    mv "$LOG" "${LOG}.1"
    log "Log rotated"
  fi
}

main
