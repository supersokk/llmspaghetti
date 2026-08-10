#!/usr/bin/env bash
# =============================================================================
# gpu-refresh.sh — re-detect the GPU on the boot AFTER a driver install.
#
# On a fresh install nouveau holds the NVIDIA card, so gpu-detect (run during
# bootstrap) writes gpu-info.json = "cpu" and the wizard shows CPU-only. The
# driver + nouveau blacklist only take effect after a reboot — but nothing
# refreshed the stale cache, so the box still thought it was CPU-only.
#
# This runs once on that reboot (guarded by the .needs-reboot flag bootstrap
# drops), re-detects with the real driver now bound, and restarts Ollama so it
# picks up the GPU. Then it clears the flag so it never runs again.
# =============================================================================
set -uo pipefail

INSTALL_DIR="/opt/llmspaghetti"
FLAG="$INSTALL_DIR/.needs-reboot"
DETECT="$INSTALL_DIR/scripts/gpu-detect.sh"

# Only act when a driver-install reboot was pending (also set as a systemd
# ConditionPathExists, but re-checked here so the script is safe to run by hand).
[[ -f "$FLAG" ]] || exit 0

if [[ -f "$DETECT" ]]; then
  # Best-effort: a detection hiccup must not wedge boot.
  bash "$DETECT" --json > "$INSTALL_DIR/gpu-info.json" 2>/dev/null || true
fi

# Ollama auto-detects CUDA at startup; if it started before the driver was up
# (or on the previous nouveau boot) it fell back to CPU — restart so it re-scans.
systemctl restart ollama 2>/dev/null || true

rm -f "$FLAG"
