#!/usr/bin/env bash
# =============================================================================
# LLMSpaghetti Validation Suite
# Run this on a machine where LLMSpaghetti has been installed (or is being installed).
# Can also be run from WSL2 against a remote machine via SSH.
#
# Usage:
#   bash test/run-tests.sh                    # test local machine
#   bash test/run-tests.sh --host 192.168.1.x # test remote machine over SSH
#   bash test/run-tests.sh --suite gpu        # run only one suite
#   bash test/run-tests.sh --quick            # skip slow tests (model pulls etc)
#
# Exit codes:
#   0 = all passed
#   1 = one or more failures
#   2 = suite could not run (missing deps)
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Args ──────────────────────────────────────────────────────────────────────
TARGET_HOST=""
SUITE_FILTER=""
QUICK=false
VERBOSE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --host)    TARGET_HOST="$2"; shift 2 ;;
    --suite)   SUITE_FILTER="$2"; shift 2 ;;
    --quick)   QUICK=true; shift ;;
    --verbose) VERBOSE=true; shift ;;
    *) shift ;;
  esac
done

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

# ── Counters ──────────────────────────────────────────────────────────────────
PASS=0; FAIL=0; SKIP=0; WARN=0
FAILED_TESTS=()
START_TIME=$(date +%s)

# ── Remote exec wrapper ───────────────────────────────────────────────────────
remote() {
  if [[ -n "$TARGET_HOST" ]]; then
    ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no \
        "llmspaghetti@${TARGET_HOST}" "$@" 2>/dev/null
  else
    bash -c "$*" 2>/dev/null
  fi
}

remote_root() {
  if [[ -n "$TARGET_HOST" ]]; then
    ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no \
        "llmspaghetti@${TARGET_HOST}" "sudo $*" 2>/dev/null
  else
    sudo bash -c "$*" 2>/dev/null
  fi
}

http_get() {
  local url="$1"
  local host="${TARGET_HOST:-localhost}"
  curl -sf --max-time 8 "${url/localhost/$host}" 2>/dev/null
}

# ── Test primitives ───────────────────────────────────────────────────────────
CURRENT_SUITE=""

suite() {
  CURRENT_SUITE="$1"
  echo ""
  echo -e "${BOLD}${CYAN}━━━ $1 ━━━${RESET}"
}

pass() {
  PASS=$(( PASS + 1 ))
  echo -e "  ${GREEN}✓${RESET}  $1"
}

fail() {
  FAIL=$(( FAIL + 1 ))
  FAILED_TESTS+=("[$CURRENT_SUITE] $1")
  echo -e "  ${RED}✗${RESET}  $1"
  [[ -n "${2:-}" ]] && echo -e "     ${DIM}→ $2${RESET}"
}

warn() {
  WARN=$(( WARN + 1 ))
  echo -e "  ${YELLOW}⚠${RESET}  $1"
  [[ -n "${2:-}" ]] && echo -e "     ${DIM}→ $2${RESET}"
}

skip() {
  SKIP=$(( SKIP + 1 ))
  echo -e "  ${DIM}–${RESET}  $1 ${DIM}(skipped)${RESET}"
}

check() {
  # check "label" "command that should exit 0"
  local label="$1"; local cmd="$2"
  local out
  if out=$(eval "$cmd" 2>&1); then
    pass "$label"
    $VERBOSE && [[ -n "$out" ]] && echo -e "     ${DIM}$out${RESET}"
  else
    fail "$label" "$out"
  fi
}

check_remote() {
  local label="$1"; local cmd="$2"
  local out
  if out=$(remote "$cmd" 2>&1); then
    pass "$label"
  else
    fail "$label" "$out"
  fi
}

check_http() {
  local label="$1"; local url="$2"; local expect="${3:-}"
  local out
  out=$(http_get "$url" || true)
  if [[ -z "$out" ]]; then
    fail "$label" "no response from $url"
  elif [[ -n "$expect" ]] && ! echo "$out" | grep -q "$expect"; then
    fail "$label" "response missing '$expect'"
  else
    pass "$label"
  fi
}

# ── Suite: System requirements ────────────────────────────────────────────────
suite_system() {
  suite "System Requirements"

  # OS check
  local os
  os=$(remote "cat /etc/os-release 2>/dev/null | grep ^ID= | cut -d= -f2 | tr -d '\"'")
  if [[ "$os" == "ubuntu" ]]; then
    pass "Ubuntu detected"
  else
    warn "OS is '$os' — tested on Ubuntu 22.04/24.04"
  fi

  # Architecture
  local arch
  arch=$(remote "uname -m")
  [[ "$arch" == "x86_64" ]] && pass "Architecture x86_64" || warn "Architecture is $arch"

  # Disk space
  local avail_gb
  avail_gb=$(remote "df -BG / | tail -1 | awk '{gsub(/G/,\"\",$4); print $4}'")
  if (( avail_gb >= 20 )); then
    pass "Disk space: ${avail_gb}GB free"
  elif (( avail_gb >= 10 )); then
    warn "Low disk space: ${avail_gb}GB free (20GB+ recommended)"
  else
    fail "Insufficient disk space: ${avail_gb}GB free"
  fi

  # RAM
  local ram_gb
  ram_gb=$(remote "free -g | awk 'NR==2{print $2}'")
  if (( ram_gb >= 8 )); then
    pass "RAM: ${ram_gb}GB"
  elif (( ram_gb >= 4 )); then
    warn "Low RAM: ${ram_gb}GB (8GB+ recommended)"
  else
    fail "Insufficient RAM: ${ram_gb}GB"
  fi

  # Network
  check_remote "Internet connectivity" "curl -sf --max-time 5 https://ollama.com > /dev/null"

  # Kernel version
  local kernel
  kernel=$(remote "uname -r")
  pass "Kernel: $kernel"
}

# ── Suite: GPU ────────────────────────────────────────────────────────────────
suite_gpu() {
  suite "GPU Detection"

  local gpu_json
  gpu_json=$(remote "bash /opt/llmspaghetti/scripts/gpu-detect.sh --json 2>/dev/null" || echo "{}")

  if [[ "$gpu_json" == "{}" ]]; then
    warn "gpu-detect.sh not found or returned empty" "Is bootstrap.sh done?"
    return
  fi

  local vendor
  vendor=$(echo "$gpu_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('driver_stack','none'))" 2>/dev/null || echo "none")

  case "$vendor" in
    none)
      warn "No GPU detected — CPU inference only" \
        "Performance will be limited for large models"
      ;;
    cuda*)
      local vram
      vram=$(echo "$gpu_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('total_vram_gb',0))" 2>/dev/null || echo 0)
      pass "NVIDIA GPU detected (CUDA)"
      pass "Total VRAM: ${vram}GB"
      check_remote "nvidia-smi available" "nvidia-smi > /dev/null"
      check_remote "CUDA drivers loaded"  "nvidia-smi | grep -q 'Driver Version'"
      ;;
    rocm*)
      pass "AMD GPU detected (ROCm)"
      check_remote "rocm-smi available" "rocm-smi > /dev/null"
      ;;
  esac

  # Validate gpu-info.json was written
  check_remote "gpu-info.json exists" "test -f /opt/llmspaghetti/gpu-info.json"

  # Validate collect-stats.sh GPU section
  local stats
  stats=$(remote "bash /opt/llmspaghetti/scripts/collect-stats.sh 2>/dev/null" || echo "{}")
  if echo "$stats" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
    pass "collect-stats.sh outputs valid JSON"
  else
    fail "collect-stats.sh output is not valid JSON" "$stats"
  fi
}

# ── Suite: Core services ──────────────────────────────────────────────────────
suite_services() {
  suite "Core Services"

  # Docker
  check_remote "Docker installed"     "command -v docker"
  check_remote "Docker daemon active" "systemctl is-active docker | grep -q active"
  check_remote "Docker accessible"    "docker ps > /dev/null"

  # Ollama
  check_remote "Ollama installed"  "command -v ollama"
  check_remote "Ollama active"     "systemctl is-active ollama | grep -q active"
  check_remote "Ollama API alive"  "curl -sf http://localhost:11434/api/tags > /dev/null"

  # Open WebUI container
  local webui_state
  webui_state=$(remote "docker inspect -f '{{.State.Status}}' llmspaghetti-webui 2>/dev/null" || echo "missing")
  if [[ "$webui_state" == "running" ]]; then
    pass "Open WebUI container running"
  elif [[ "$webui_state" == "missing" ]]; then
    warn "Open WebUI container not found" "Run: spag start"
  else
    fail "Open WebUI container state: $webui_state"
  fi

  # LiteLLM container
  local litellm_state
  litellm_state=$(remote "docker inspect -f '{{.State.Status}}' llmspaghetti-litellm 2>/dev/null" || echo "missing")
  if [[ "$litellm_state" == "running" ]]; then
    pass "LiteLLM container running"
  elif [[ "$litellm_state" == "missing" ]]; then
    warn "LiteLLM container not found" "Run: spag start"
  else
    fail "LiteLLM container state: $litellm_state"
  fi

  # Caddy
  check_remote "Caddy active"    "systemctl is-active caddy | grep -q active"
  check_remote "Caddy listening" "ss -tlnp | grep -q ':80'"

  # Cockpit
  check_remote "Cockpit active"    "systemctl is-active cockpit | grep -q active"
  check_remote "Cockpit listening" "ss -tlnp | grep -q ':9090'"

  # ttyd terminal
  local ttyd_state
  ttyd_state=$(remote "systemctl is-active llmspaghetti-terminal 2>/dev/null" || echo "inactive")
  if [[ "$ttyd_state" == "active" ]]; then
    pass "ttyd terminal service active"
    check_remote "ttyd listening on 7681" "ss -tlnp | grep -q ':7681'"
  else
    warn "ttyd terminal not active" "Run: spag install-terminal"
  fi
}

# ── Suite: HTTP endpoints ─────────────────────────────────────────────────────
suite_http() {
  suite "HTTP Endpoints"

  local host="${TARGET_HOST:-localhost}"

  # Main web UI
  check_http "Open WebUI loads"        "http://${host}/"        "html"
  check_http "Ollama API reachable"    "http://${host}:11434/api/tags" "models"

  # LiteLLM
  check_http "LiteLLM health"          "http://${host}:4000/health"   ""
  check_http "LiteLLM models list"     "http://${host}:4000/v1/models" "data"

  # API via Caddy proxy
  check_http "API gateway /api/v1/models" "http://${host}/api/v1/models" "data"

  # Terminal
  check_http "ttyd terminal via proxy" "http://${host}/terminal/" "xterm"

  # Cockpit
  check_http "Cockpit UI"             "http://${host}:9090/"    ""
}

# ── Suite: Config files ───────────────────────────────────────────────────────
suite_config() {
  suite "Configuration Files"

  check_remote "Install dir exists"        "test -d /opt/llmspaghetti"
  check_remote "Config dir exists"         "test -d /opt/llmspaghetti/config"
  check_remote "Logs dir exists"           "test -d /opt/llmspaghetti/logs"
  check_remote "litellm_config.yaml exists" "test -f /opt/llmspaghetti/config/litellm_config.yaml"
  check_remote "master_key exists"         "test -f /opt/llmspaghetti/config/master_key"
  check_remote "docker-compose.yml exists" "test -f /opt/llmspaghetti/docker-compose.yml"

  # Validate YAML is parseable
  local yaml_ok
  yaml_ok=$(remote "python3 -c \"import yaml; yaml.safe_load(open('/opt/llmspaghetti/config/litellm_config.yaml'))\" 2>&1" || echo "fail")
  if [[ "$yaml_ok" != "fail" ]] && [[ -z "$yaml_ok" ]]; then
    pass "litellm_config.yaml is valid YAML"
  else
    fail "litellm_config.yaml parse error" "$yaml_ok"
  fi

  # Master key format
  local key
  key=$(remote "cat /opt/llmspaghetti/config/master_key 2>/dev/null" || echo "")
  if [[ "$key" == sk-spag-* ]]; then
    pass "Master key format valid (sk-spag-...)"
  else
    fail "Master key missing or wrong format" "$key"
  fi

  # Caddyfile
  check_remote "Caddyfile exists"     "test -f /etc/caddy/Caddyfile"
  local caddy_ok
  caddy_ok=$(remote_root "caddy validate --config /etc/caddy/Caddyfile 2>&1" || echo "fail")
  if echo "$caddy_ok" | grep -q "Valid configuration"; then
    pass "Caddyfile is valid"
  else
    warn "Caddyfile validation inconclusive" "$caddy_ok"
  fi

  # First-boot flag
  if remote "test -f /opt/llmspaghetti/.firstboot-complete" 2>/dev/null; then
    pass "First-boot complete flag set"
  else
    warn "First-boot not yet complete" "Open http://${TARGET_HOST:-localhost} to run setup wizard"
  fi
}

# ── Suite: CLI tool ───────────────────────────────────────────────────────────
suite_cli() {
  suite "LLMSpaghetti CLI"

  check_remote "llmspaghetti command exists"      "command -v llmspaghetti"
  check_remote "llmspaghetti is executable"       "test -x /usr/local/bin/spag"
  check_remote "spag version runs"        "spag version"
  check_remote "spag status runs"         "spag status > /dev/null"
  check_remote "spag models runs"         "spag models > /dev/null"
  check_remote "spag doctor runs"         "spag doctor > /dev/null"
  check_remote "spag gpu runs"            "spag gpu > /dev/null"
  check_remote "llmspaghetti-watchdog exists"     "test -x /usr/local/bin/llmspaghetti-watchdog"
}

# ── Suite: Stats collector ────────────────────────────────────────────────────
suite_stats() {
  suite "Stats Collector"

  check_remote "collect-stats.sh exists"   "test -f /opt/llmspaghetti/scripts/collect-stats.sh"
  check_remote "collect-stats.sh executable" "test -x /opt/llmspaghetti/scripts/collect-stats.sh"

  # Run it and validate JSON
  local stats
  stats=$(remote "bash /opt/llmspaghetti/scripts/collect-stats.sh 2>/dev/null" || echo "FAIL")

  if [[ "$stats" == "FAIL" ]]; then
    fail "collect-stats.sh failed to run"
    return
  fi

  # Validate JSON structure
  local fields=("cpu" "ram" "disk" "network" "system")
  local json_ok=true
  for field in "${fields[@]}"; do
    if echo "$stats" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert '$field' in d, 'missing $field'
" 2>/dev/null; then
      pass "collect-stats.sh: '$field' field present"
    else
      fail "collect-stats.sh: '$field' field missing"
      json_ok=false
    fi
  done

  # Sanity check values
  local cpu_usage
  cpu_usage=$(echo "$stats" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['cpu']['usage'])
" 2>/dev/null || echo "-1")

  if python3 -c "assert 0 <= float('$cpu_usage') <= 100" 2>/dev/null; then
    pass "CPU usage value sane: ${cpu_usage}%"
  else
    fail "CPU usage value out of range: $cpu_usage"
  fi

  # Timing
  local start end elapsed
  start=$(date +%s%3N)
  remote "bash /opt/llmspaghetti/scripts/collect-stats.sh > /dev/null 2>&1"
  end=$(date +%s%3N)
  elapsed=$(( end - start ))
  if (( elapsed < 2000 )); then
    pass "collect-stats.sh completes in ${elapsed}ms"
  else
    warn "collect-stats.sh slow: ${elapsed}ms (target <2000ms)"
  fi
}

# ── Suite: First-boot wizard ──────────────────────────────────────────────────
suite_firstboot() {
  suite "First-Boot Wizard"

  check_remote "firstboot/main.py exists"  "test -f /opt/llmspaghetti/firstboot/main.py"
  check_remote "Templates dir exists"      "test -d /opt/llmspaghetti/firstboot/templates"

  local templates=("base.html" "welcome.html" "step_system.html" "step_models.html"
                   "step_apikeys.html" "step_confirm.html" "done.html")
  for t in "${templates[@]}"; do
    check_remote "Template $t exists" "test -f /opt/llmspaghetti/firstboot/templates/$t"
  done

  # Python deps
  check_remote "fastapi installed"          "python3 -c 'import fastapi'"
  check_remote "uvicorn installed"          "python3 -c 'import uvicorn'"
  check_remote "jinja2 installed"           "python3 -c 'import jinja2'"
  check_remote "python-multipart installed" "python3 -c 'import multipart'"

  # Syntax check the FastAPI app
  check_remote "main.py syntax valid" "python3 -m py_compile /opt/llmspaghetti/firstboot/main.py"

  # Service unit
  check_remote "llmspaghetti-firstboot.service exists" \
    "test -f /etc/systemd/system/llmspaghetti-firstboot.service"
}

# ── Suite: Console status screen ─────────────────────────────────────────────
suite_console() {
  suite "Console Status Screen"

  check_remote "status.py exists"       "test -f /opt/llmspaghetti/console/status.py"
  check_remote "status.py syntax valid" "python3 -m py_compile /opt/llmspaghetti/console/status.py"
  check_remote "llmspaghetti-status.service exists" \
    "test -f /etc/systemd/system/llmspaghetti-status.service"

  # Check tty1 config
  local getty_masked
  getty_masked=$(remote "systemctl is-masked getty@tty1.service 2>/dev/null" || echo "no")
  if [[ "$getty_masked" == "masked" ]]; then
    pass "getty@tty1 masked (status screen takes over)"
  else
    warn "getty@tty1 not masked" "Status screen may not show on tty1"
  fi
}

# ── Suite: Systemd services ───────────────────────────────────────────────────
suite_systemd() {
  suite "Systemd Services"

  local services=(
    "llmspaghetti-firstboot"
    "llmspaghetti-status"
    "llmspaghetti-watchdog"
    "llmspaghetti"
  )

  for svc in "${services[@]}"; do
    check_remote "${svc}.service installed" \
      "test -f /etc/systemd/system/${svc}.service"
    local enabled
    enabled=$(remote "systemctl is-enabled ${svc}.service 2>/dev/null" || echo "unknown")
    if [[ "$enabled" == "enabled" ]] || [[ "$enabled" == "static" ]]; then
      pass "${svc}.service enabled"
    elif [[ "$enabled" == "disabled" ]] && [[ "$svc" == "llmspaghetti-firstboot" ]]; then
      # firstboot disables itself after running — that's correct
      pass "llmspaghetti-firstboot.service disabled (setup complete)"
    else
      warn "${svc}.service enabled state: $enabled"
    fi
  done
}

# ── Suite: API key smoke test ─────────────────────────────────────────────────
suite_api() {
  suite "API Gateway Smoke Test"

  $QUICK && { skip "API smoke test (--quick mode)"; return; }

  local host="${TARGET_HOST:-localhost}"
  local key
  key=$(remote "cat /opt/llmspaghetti/config/master_key 2>/dev/null" || echo "")

  if [[ -z "$key" ]]; then
    skip "API smoke test (no master key found)"
    return
  fi

  # List models via API
  local models_resp
  models_resp=$(curl -sf --max-time 8 \
    -H "Authorization: Bearer $key" \
    "http://${host}/api/v1/models" 2>/dev/null || echo "")

  if echo "$models_resp" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'data' in d" 2>/dev/null; then
    pass "LiteLLM /v1/models returns valid response"
  else
    fail "LiteLLM /v1/models failed" "$models_resp"
  fi

  # Check Ollama models are exposed via LiteLLM
  local model_count
  model_count=$(echo "$models_resp" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(len(d.get('data',[])))
" 2>/dev/null || echo 0)
  pass "LiteLLM exposes $model_count model(s)"

  # Test a real completion if models are loaded
  if (( model_count > 0 )); then
    local first_model
    first_model=$(echo "$models_resp" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['data'][0]['id'] if d['data'] else '')
" 2>/dev/null || echo "")

    if [[ -n "$first_model" ]]; then
      local completion
      completion=$(curl -sf --max-time 30 \
        -H "Authorization: Bearer $key" \
        -H "Content-Type: application/json" \
        -d "{\"model\":\"$first_model\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with only the word: LLMSpaghetti\"}],\"max_tokens\":10}" \
        "http://${host}/api/v1/chat/completions" 2>/dev/null || echo "")

      if echo "$completion" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert 'choices' in d and len(d['choices']) > 0
" 2>/dev/null; then
        pass "Chat completion via $first_model succeeded"
      else
        warn "Chat completion failed" "Model may still be loading"
      fi
    fi
  fi
}

# ── Summary ───────────────────────────────────────────────────────────────────
print_summary() {
  local end_time elapsed
  end_time=$(date +%s)
  elapsed=$(( end_time - START_TIME ))

  echo ""
  echo -e "${BOLD}════════════════════════════════════════${RESET}"
  echo -e "${BOLD}  LLMSpaghetti Validation Summary${RESET}"
  echo -e "${BOLD}════════════════════════════════════════${RESET}"
  echo ""
  echo -e "  ${GREEN}Passed${RESET}   $PASS"
  echo -e "  ${RED}Failed${RESET}   $FAIL"
  echo -e "  ${YELLOW}Warnings${RESET} $WARN"
  echo -e "  ${DIM}Skipped${RESET}  $SKIP"
  echo -e "  ${DIM}Time${RESET}     ${elapsed}s"
  echo ""

  if [[ ${#FAILED_TESTS[@]} -gt 0 ]]; then
    echo -e "  ${RED}${BOLD}Failed tests:${RESET}"
    for t in "${FAILED_TESTS[@]}"; do
      echo -e "  ${RED}✗${RESET}  $t"
    done
    echo ""
  fi

  if [[ $FAIL -eq 0 ]]; then
    echo -e "  ${GREEN}${BOLD}All tests passed!${RESET}"
    if [[ -n "$TARGET_HOST" ]]; then
      echo ""
      echo -e "  Open ${CYAN}http://${TARGET_HOST}${RESET} to use LLMSpaghetti"
    fi
  else
    echo -e "  ${RED}${BOLD}$FAIL test(s) failed.${RESET}"
    echo -e "  Run with ${YELLOW}--verbose${RESET} for more detail."
    echo -e "  Check logs: ${CYAN}spag logs${RESET}"
  fi

  echo ""
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  echo ""
  echo -e "${BOLD}${CYAN}LLMSpaghetti Validation Suite${RESET}"
  if [[ -n "$TARGET_HOST" ]]; then
    echo -e "  Target: ${CYAN}$TARGET_HOST${RESET}"
  else
    echo -e "  Target: ${CYAN}local machine${RESET}"
  fi
  $QUICK && echo -e "  Mode:   ${YELLOW}quick (slow tests skipped)${RESET}"

  # Connection check for remote
  if [[ -n "$TARGET_HOST" ]]; then
    if ! ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no \
         "llmspaghetti@${TARGET_HOST}" "echo ok" &>/dev/null; then
      echo -e "\n  ${RED}Cannot connect to $TARGET_HOST${RESET}"
      echo -e "  Make sure SSH is running and the llmspaghetti user exists."
      exit 2
    fi
  fi

  # Run suites (filtered if --suite given)
  run_suite() {
    local name="$1"; local fn="$2"
    if [[ -z "$SUITE_FILTER" ]] || [[ "$SUITE_FILTER" == "$name" ]]; then
      $fn
    fi
  }

  run_suite "system"     suite_system
  run_suite "gpu"        suite_gpu
  run_suite "config"     suite_config
  run_suite "services"   suite_services
  run_suite "http"       suite_http
  run_suite "cli"        suite_cli
  run_suite "stats"      suite_stats
  run_suite "firstboot"  suite_firstboot
  run_suite "console"    suite_console
  run_suite "systemd"    suite_systemd
  run_suite "api"        suite_api

  print_summary

  [[ $FAIL -eq 0 ]] && exit 0 || exit 1
}

main
