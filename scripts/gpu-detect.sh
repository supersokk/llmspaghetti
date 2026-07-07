#!/usr/bin/env bash
# =============================================================================
# LLMSpaghetti GPU Detection
# Outputs a JSON blob describing available GPUs and recommends a driver stack.
#
# Usage:
#   source gpu-detect.sh          # sets GPU_VENDOR, GPU_MODEL, GPU_VRAM vars
#   bash gpu-detect.sh --json     # prints JSON and exits
#   bash gpu-detect.sh --summary  # prints human-readable summary and exits
# =============================================================================

_gpu_detect_main() {
  local NVIDIA_COUNT=0
  local AMD_COUNT=0
  local NVIDIA_MODELS=""
  local AMD_MODELS=""
  local NVIDIA_VRAM=0
  local AMD_VRAM=0
  local DRIVER_STACK="none"
  local CUDA_VERSION=""
  local ROCM_VERSION=""

  # ── Detect NVIDIA ───────────────────────────────────────────────────────────
  if command -v nvidia-smi &>/dev/null; then
    NVIDIA_COUNT=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | wc -l)
    if [[ $NVIDIA_COUNT -gt 0 ]]; then
      NVIDIA_MODELS=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | tr '\n' '|' | sed 's/|$//')
      NVIDIA_VRAM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | \
        awk '{sum += $1} END {print int(sum/1024)}')  # MiB → GiB
      CUDA_VERSION=$(nvidia-smi | grep -oP 'CUDA Version: \K[0-9.]+' 2>/dev/null || echo "unknown")
      DRIVER_STACK="cuda"
    fi
  elif lspci 2>/dev/null | grep -qi "nvidia"; then
    # nvidia-smi not installed yet but GPU present — count only display controllers
    NVIDIA_COUNT=$(lspci | grep -iE "vga|3d|display" | grep -ci "nvidia")
    NVIDIA_MODELS=$(lspci | grep -i "nvidia" | sed 's/.*: //' | tr '\n' '|' | sed 's/|$//')
    DRIVER_STACK="cuda-pending"
  fi

  # ── Detect AMD ──────────────────────────────────────────────────────────────
  if command -v rocm-smi &>/dev/null; then
    AMD_COUNT=$(rocm-smi --showid 2>/dev/null | grep -c "GPU\[" || echo 0)
    if [[ $AMD_COUNT -gt 0 ]]; then
      AMD_MODELS=$(rocm-smi --showproductname 2>/dev/null | grep -oP 'Card series:\s*\K.*' | tr '\n' '|' | sed 's/|$//')
      AMD_VRAM=$(rocm-smi --showmeminfo vram 2>/dev/null | grep "Total Memory" | \
        awk '{sum += $NF} END {print int(sum/1024/1024/1024)}' 2>/dev/null || echo 0)
      ROCM_VERSION=$(rocm-smi --version 2>/dev/null | grep -oP 'ROCm-SMI version: \K[0-9.]+' || echo "unknown")
      [[ "$DRIVER_STACK" == "none" ]] && DRIVER_STACK="rocm"
      [[ "$DRIVER_STACK" == "cuda"* ]] && DRIVER_STACK="cuda+rocm"
    fi
  elif lspci 2>/dev/null | grep -iE "vga|3d|display" | grep -qi "amd\|radeon\|advanced micro"; then
    # Count only display controllers — plain "amd" grep matches chipset/USB/etc. on Ryzen
    AMD_COUNT=$(lspci | grep -iE "vga|3d|display" | grep -ci "amd\|radeon")
    AMD_MODELS=$(lspci | grep -i "amd\|radeon" | grep -i "vga\|3d\|display" | sed 's/.*: //' | tr '\n' '|' | sed 's/|$//')
    # AMD GPU present but no ROCm → default to VULKAN (Mesa RADV): works on nearly
    # every AMD GPU, and Ollama uses Vulkan automatically. ROCm is an opt-in upgrade
    # (Services tab) for the cards it supports.
    [[ "$DRIVER_STACK" == "none" ]] && DRIVER_STACK="vulkan"
  fi

  # ── Fallback: parse lspci even if no drivers yet ──────────────────────────
  if [[ "$DRIVER_STACK" == "none" ]] && command -v lspci &>/dev/null; then
    if lspci | grep -qi "nvidia"; then
      DRIVER_STACK="cuda-pending"
      NVIDIA_COUNT=$(lspci | grep -ci "nvidia")
    elif lspci | grep -qi "amd\|radeon"; then
      DRIVER_STACK="vulkan"   # broad-compat AMD default (Mesa RADV); ROCm is opt-in
      AMD_COUNT=$(lspci | grep -ci "amd\|radeon")
    fi
  fi

  # ── Recommend ollama runtime flag ─────────────────────────────────────────
  local OLLAMA_RUNTIME="cpu"
  case "$DRIVER_STACK" in
    cuda+rocm)   OLLAMA_RUNTIME="cuda" ;;   # prefer CUDA when both present
    cuda*)       OLLAMA_RUNTIME="cuda" ;;
    rocm*)       OLLAMA_RUNTIME="rocm" ;;     # ROCm installed → use it (faster on supported cards)
    vulkan)      OLLAMA_RUNTIME="vulkan" ;;   # broad-compat AMD; Ollama uses Vulkan by default
  esac

  # ── Recommended model tier based on VRAM ─────────────────────────────────
  local TOTAL_GPU_VRAM=$(( NVIDIA_VRAM + AMD_VRAM ))
  local MODEL_TIER
  if [[ $TOTAL_GPU_VRAM -ge 24 ]]; then
    MODEL_TIER="large"     # 70B models, full precision
  elif [[ $TOTAL_GPU_VRAM -ge 12 ]]; then
    MODEL_TIER="medium"    # 13B-34B models
  elif [[ $TOTAL_GPU_VRAM -ge 6 ]]; then
    MODEL_TIER="small"     # 7B-8B models
  elif [[ $TOTAL_GPU_VRAM -ge 2 ]]; then
    MODEL_TIER="tiny"      # 1B-3B models
  else
    MODEL_TIER="cpu"       # CPU inference only
  fi

  # ── Export as shell vars (when sourced) ──────────────────────────────────
  export GPU_VENDOR="$DRIVER_STACK"
  export GPU_NVIDIA_COUNT="$NVIDIA_COUNT"
  export GPU_AMD_COUNT="$AMD_COUNT"
  export GPU_NVIDIA_MODELS="$NVIDIA_MODELS"
  export GPU_AMD_MODELS="$AMD_MODELS"
  export GPU_TOTAL_VRAM="$TOTAL_GPU_VRAM"
  export GPU_MODEL_TIER="$MODEL_TIER"
  export GPU_OLLAMA_RUNTIME="$OLLAMA_RUNTIME"
  export GPU_CUDA_VERSION="$CUDA_VERSION"
  export GPU_ROCM_VERSION="$ROCM_VERSION"

  # ── Output modes ─────────────────────────────────────────────────────────
  case "${1:-}" in
    --json)
      cat << EOF
{
  "driver_stack": "$DRIVER_STACK",
  "ollama_runtime": "$OLLAMA_RUNTIME",
  "model_tier": "$MODEL_TIER",
  "total_vram_gb": $TOTAL_GPU_VRAM,
  "nvidia": {
    "count": $NVIDIA_COUNT,
    "models": "$NVIDIA_MODELS",
    "vram_gb": $NVIDIA_VRAM,
    "cuda_version": "$CUDA_VERSION"
  },
  "amd": {
    "count": $AMD_COUNT,
    "models": "$AMD_MODELS",
    "vram_gb": $AMD_VRAM,
    "rocm_version": "$ROCM_VERSION"
  }
}
EOF
      ;;
    --summary)
      echo "GPU Detection Summary"
      echo "───────────────────────────────────"
      echo "Driver stack   : $DRIVER_STACK"
      echo "Ollama runtime : $OLLAMA_RUNTIME"
      echo "Total VRAM     : ${TOTAL_GPU_VRAM}GB"
      echo "Model tier     : $MODEL_TIER"
      if [[ $NVIDIA_COUNT -gt 0 ]]; then
        echo "NVIDIA GPUs    : $NVIDIA_COUNT × $NVIDIA_MODELS (CUDA $CUDA_VERSION)"
      fi
      if [[ $AMD_COUNT -gt 0 ]]; then
        if [[ "$DRIVER_STACK" == "vulkan" ]]; then
          echo "AMD GPUs       : $AMD_COUNT × $AMD_MODELS (Vulkan / Mesa RADV — ROCm optional)"
        else
          echo "AMD GPUs       : $AMD_COUNT × $AMD_MODELS (ROCm $ROCM_VERSION)"
        fi
      fi
      echo "───────────────────────────────────"
      ;;
  esac
}

# Run when executed directly, not when sourced
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  _gpu_detect_main "$@"
fi
