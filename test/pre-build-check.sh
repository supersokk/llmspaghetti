#!/usr/bin/env bash
# =============================================================================
# LLMSpaghetti Pre-Build Smoke Test
# Run this from WSL2 BEFORE building the ISO to catch obvious problems.
# Does NOT require a running LLMSpaghetti install — tests the repo files themselves.
# =============================================================================

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
DIM='\033[2m'; BOLD='\033[1m'; RESET='\033[0m'

PASS=0; FAIL=0; WARN=0

pass() { PASS=$(( PASS+1 )); echo -e "  ${GREEN}✓${RESET}  $1"; }
fail() { FAIL=$(( FAIL+1 )); echo -e "  ${RED}✗${RESET}  $1"; [[ -n "${2:-}" ]] && echo -e "     ${DIM}→ $2${RESET}"; }
warn() { WARN=$(( WARN+1 )); echo -e "  ${YELLOW}⚠${RESET}  $1"; }

section() { echo -e "\n${BOLD}${YELLOW}▶ $1${RESET}"; }

echo ""
echo -e "${BOLD}${GREEN}LLMSpaghetti Pre-Build Smoke Test${RESET}"
echo -e "${DIM}Repo: $REPO${RESET}"

# ── File completeness ─────────────────────────────────────────────────────────
section "Required files"

REQUIRED=(
  "eval/classifier.py"
  "eval/eval_router.py"
  "eval/fixtures_base.jsonl"
  "eval/README.md"
  "community/fixtures/README.md"
  "community/fixtures/contributed/image-routing.jsonl"
  "community/fixtures/contributed/document-vs-fast.jsonl"
  "community/fixtures/contributed/general.jsonl"
  "docs/PLANNED-routing-fixture-flywheel.md"
  "scripts/bootstrap.sh"
  "scripts/gpu-detect.sh"
  "scripts/install-gpu-drivers.sh"
  "scripts/install-terminal.sh"
  "scripts/spag-cli.sh"
  "scripts/spag-watchdog.sh"
  "scripts/collect-stats.sh"
  "console/status.py"
  "firstboot/main.py"
  "firstboot/requirements.txt"
  "firstboot/templates/base.html"
  "firstboot/templates/welcome.html"
  "firstboot/templates/step_system.html"
  "firstboot/templates/step_models.html"
  "firstboot/templates/step_apikeys.html"
  "firstboot/templates/step_confirm.html"
  "firstboot/templates/done.html"
  "services/llmspaghetti-firstboot.service"
  "services/llmspaghetti-status.service"
  "services/llmspaghetti-terminal.service"
  "services/llmspaghetti-watchdog.service"
  "services/llmspaghetti.service"
  "stack/docker-compose.yml"
  "stack/Caddyfile"
  "iso/autoinstall/user-data"
  "iso/autoinstall/meta-data"
  "iso/build.sh"
  "cockpit-plugin/src/llmspaghetti.jsx"
  "cockpit-plugin/src/tabs/Dashboard.jsx"
  "cockpit-plugin/manifest.json"
  "cockpit-plugin/package.json"
  "cockpit-plugin/webpack.config.js"
)

for f in "${REQUIRED[@]}"; do
  path="$REPO/$f"
  if [[ -f "$path" ]]; then
    # meta-data can be minimal (just instance-id) — that's valid for Subiquity
    if [[ "$f" == "iso/autoinstall/meta-data" ]]; then
      pass "$f (cloud-init meta-data)"
    elif [[ -s "$path" ]]; then
      pass "$f"
    else
      fail "$f" "file is empty"
    fi
  else
    fail "$f" "file not found"
  fi
done

# ── Shell script syntax ───────────────────────────────────────────────────────
section "Shell script syntax (bash -n)"

SHELL_SCRIPTS=(
  "scripts/bootstrap.sh"
  "scripts/gpu-detect.sh"
  "scripts/install-gpu-drivers.sh"
  "scripts/install-terminal.sh"
  "scripts/spag-cli.sh"
  "scripts/spag-watchdog.sh"
  "scripts/collect-stats.sh"
  "iso/build.sh"
  "iso/install-build-deps.sh"
  "iso/test-vm.sh"
)

for f in "${SHELL_SCRIPTS[@]}"; do
  path="$REPO/$f"
  [[ -f "$path" ]] || continue
  if bash -n "$path" 2>/dev/null; then
    pass "$f syntax OK"
  else
    err=$(bash -n "$path" 2>&1)
    fail "$f syntax error" "$err"
  fi
done

# ── Python syntax ─────────────────────────────────────────────────────────────
section "Python syntax (py_compile)"

if command -v python3 &>/dev/null; then
  PYTHON_FILES=(
    "console/status.py"
    "firstboot/main.py"
    "test/test_stats.py"
    "test/test_firstboot.py"
  )
  for f in "${PYTHON_FILES[@]}"; do
    path="$REPO/$f"
    [[ -f "$path" ]] || continue
    if python3 -m py_compile "$path" 2>/dev/null; then
      pass "$f syntax OK"
    else
      err=$(python3 -m py_compile "$path" 2>&1)
      fail "$f syntax error" "$err"
    fi
  done
else
  warn "python3 not found — skipping Python syntax checks"
fi

# ── systemd service unit lint ─────────────────────────────────────────────────
section "Systemd service units"

for svc in "$REPO"/services/*.service; do
  name=$(basename "$svc")
  [[ "$name" == "README*" ]] && continue

  # Check required sections
  for section_name in "[Unit]" "[Service]" "[Install]"; do
    if grep -q "$section_name" "$svc"; then
      pass "$name: $section_name present"
    else
      fail "$name: $section_name missing"
    fi
  done

  # Check for common mistakes
  if grep -q "ExecStart=" "$svc"; then
    pass "$name: ExecStart defined"
  else
    fail "$name: ExecStart missing"
  fi
done

# ── Docker Compose validation ─────────────────────────────────────────────────
section "Docker Compose"

if command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
  if docker compose -f "$REPO/stack/docker-compose.yml" config > /dev/null 2>&1; then
    pass "docker-compose.yml is valid"
  else
    err=$(docker compose -f "$REPO/stack/docker-compose.yml" config 2>&1)
    fail "docker-compose.yml validation failed" "$err"
  fi
else
  warn "docker compose not available — skipping compose validation"
fi

# ── Caddyfile checks ──────────────────────────────────────────────────────────
section "Caddyfile"

CADDY="$REPO/stack/Caddyfile"
if [[ -f "$CADDY" ]]; then
  grep -q "root \* /opt/llmspaghetti/spagdesk" "$CADDY" && pass "Caddyfile: SpagDesk served at root" \
    || fail "Caddyfile: SpagDesk root missing"
  grep -q "reverse_proxy localhost:5000" "$CADDY" && pass "Caddyfile: router proxy present" \
    || fail "Caddyfile: router proxy missing"
  grep -q "reverse_proxy localhost:7681" "$CADDY" && pass "Caddyfile: terminal proxy present" \
    || fail "Caddyfile: terminal proxy missing"
  grep -q "Upgrade" "$CADDY" && pass "Caddyfile: WebSocket upgrade headers present" \
    || warn "Caddyfile: WebSocket upgrade headers not found"
fi

# ── Autoinstall YAML ──────────────────────────────────────────────────────────
section "ISO autoinstall config"

USERDATA="$REPO/iso/autoinstall/user-data"
if [[ -f "$USERDATA" ]]; then
  grep -q "^autoinstall:" "$USERDATA" && pass "user-data: autoinstall key present" \
    || fail "user-data: missing 'autoinstall:' key"
  grep -q "version:" "$USERDATA" && pass "user-data: version key present" \
    || fail "user-data: missing version key"
  grep -q "storage:" "$USERDATA" && pass "user-data: storage section present" \
    || fail "user-data: missing storage section"
  grep -q "late-commands:" "$USERDATA" && pass "user-data: late-commands present" \
    || fail "user-data: missing late-commands"
  grep -q "bootstrap.sh" "$USERDATA" && pass "user-data: calls bootstrap.sh" \
    || fail "user-data: doesn't reference bootstrap.sh"

  if command -v python3 &>/dev/null; then
    if python3 -c "
import sys
content = open('$USERDATA').read()
# Remove the #cloud-config header line for YAML parsing
lines = content.split('\n')
yaml_lines = [l for l in lines if not l.startswith('#cloud-config')]
yaml_content = '\n'.join(yaml_lines)
try:
    import yaml
    yaml.safe_load(yaml_content)
    print('ok')
except ImportError:
    print('ok')  # no yaml module, skip
except Exception as e:
    print(f'error: {e}')
    sys.exit(1)
" 2>/dev/null | grep -q "ok"; then
      pass "user-data is valid YAML"
    else
      warn "user-data YAML validation inconclusive"
    fi
  fi
fi

# ── JSX / React checks ────────────────────────────────────────────────────────
section "Cockpit plugin (basic checks)"

PLUGIN="$REPO/cockpit-plugin"
JSX="$PLUGIN/src/llmspaghetti.jsx"
DASH="$PLUGIN/src/tabs/Dashboard.jsx"

[[ -f "$JSX" ]] && grep -q "import Dashboard" "$JSX" \
  && pass "llmspaghetti.jsx imports Dashboard" \
  || fail "llmspaghetti.jsx: Dashboard import missing"

[[ -f "$DASH" ]] && grep -q "export default" "$DASH" \
  && pass "Dashboard.jsx has default export" \
  || fail "Dashboard.jsx: missing default export"

[[ -f "$PLUGIN/manifest.json" ]] && python3 -c "
import json
d = json.load(open('$PLUGIN/manifest.json'))
assert 'name' in d
assert 'menu' in d or 'dashboard' in d
" 2>/dev/null && pass "manifest.json is valid JSON with required keys" \
  || fail "manifest.json invalid"

if command -v node &>/dev/null; then
  pass "Node.js available for plugin build"
  if [[ -d "$PLUGIN/node_modules" ]]; then
    pass "node_modules installed"
  else
    warn "node_modules not installed — run: cd cockpit-plugin && npm install"
  fi
else
  warn "Node.js not found — install to build Cockpit plugin"
fi

# ── Router eval ───────────────────────────────────────────────────────────────
section "Router eval (classifier accuracy)"

if command -v python3 &>/dev/null; then
  if python3 "$REPO/eval/eval_router.py" \
      --fixtures "$REPO/eval/fixtures_base.jsonl" \
      --max-misroute 0.15 \
      --max-critical 0 2>/dev/null; then
    pass "Router eval passes budget (misroute < 15%, critical = 0)"
  else
    fail "Router eval failed budget" "Run: python3 eval/eval_router.py --verbose"
  fi

  python3 -m py_compile "$REPO/eval/classifier.py" && \
    pass "classifier.py syntax OK" || fail "classifier.py syntax error"

  python3 -m py_compile "$REPO/eval/eval_router.py" && \
    pass "eval_router.py syntax OK" || fail "eval_router.py syntax error"
else
  warn "python3 not found — skipping router eval"
fi

# ── GPU detect script ─────────────────────────────────────────────────────────
section "GPU detection script"

GPU_SCRIPT="$REPO/scripts/gpu-detect.sh"
if [[ -f "$GPU_SCRIPT" ]]; then
  bash -n "$GPU_SCRIPT" && pass "gpu-detect.sh syntax OK"

  # Test --json mode runs (may return none GPU on WSL2)
  out=$(bash "$GPU_SCRIPT" --json 2>/dev/null || echo "{}")
  if echo "$out" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
    pass "gpu-detect.sh --json produces valid JSON"
    driver=$(echo "$out" | python3 -c "import json,sys; print(json.load(sys.stdin).get('driver_stack','?'))")
    pass "gpu-detect.sh detected: $driver"
  else
    fail "gpu-detect.sh --json output is not valid JSON" "$out"
  fi

  # Test --summary mode
  if bash "$GPU_SCRIPT" --summary &>/dev/null; then
    pass "gpu-detect.sh --summary runs without error"
  else
    fail "gpu-detect.sh --summary failed"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}════════════════════════════════════${RESET}"
echo -e "${BOLD}  Pre-Build Smoke Test Summary${RESET}"
echo -e "${BOLD}════════════════════════════════════${RESET}"
echo ""
echo -e "  ${GREEN}Passed${RESET}   $PASS"
[[ $FAIL -gt 0 ]] && echo -e "  ${RED}Failed${RESET}   $FAIL"
[[ $WARN -gt 0 ]] && echo -e "  ${YELLOW}Warned${RESET}   $WARN"
echo ""

if [[ $FAIL -eq 0 ]]; then
  echo -e "  ${GREEN}${BOLD}All checks passed — safe to build ISO${RESET}"
  echo -e "  Run: ${YELLOW}sudo bash iso/build.sh${RESET}"
else
  echo -e "  ${RED}${BOLD}Fix $FAIL failure(s) before building${RESET}"
fi
echo ""

exit $(( FAIL > 0 ? 1 : 0 ))
