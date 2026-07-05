#!/usr/bin/env bash
# =============================================================================
# LLMSpaghetti Stats Collector
# Called by the dashboard every few seconds via cockpit.spawn
# Outputs a single JSON blob with all system metrics
# Fast: designed to complete in under 500ms
# =============================================================================

collect_cpu() {
  # CPU model
  local model
  model=$(grep "model name" /proc/cpuinfo | head -1 | cut -d: -f2 | xargs)

  # Core count
  local cores
  cores=$(nproc)

  # Overall usage (100 - idle from /proc/stat snapshot)
  local cpu_line1 cpu_line2
  cpu_line1=$(grep "^cpu " /proc/stat)
  sleep 0.2
  cpu_line2=$(grep "^cpu " /proc/stat)

  local idle1 total1 idle2 total2
  idle1=$(echo "$cpu_line1" | awk '{print $5}')
  total1=$(echo "$cpu_line1" | awk '{s=0; for(i=2;i<=NF;i++) s+=$i; print s}')
  idle2=$(echo "$cpu_line2" | awk '{print $5}')
  total2=$(echo "$cpu_line2" | awk '{s=0; for(i=2;i<=NF;i++) s+=$i; print s}')

  local usage=0
  if (( total2 - total1 > 0 )); then
    usage=$(echo "scale=1; 100 * (1 - ($idle2 - $idle1) / ($total2 - $total1))" | bc)
  fi

  # Load average
  local load
  load=$(cat /proc/loadavg | awk '{print $1, $2, $3}')
  local load1 load5 load15
  read -r load1 load5 load15 <<< "$load"

  # Temperature (try multiple sources)
  local temp=0
  if command -v sensors &>/dev/null; then
    temp=$(sensors 2>/dev/null | grep -E "^(Package|Core 0|Tctl|k10temp)" | \
      grep -oP '\+\K[0-9.]+' | head -1 || echo 0)
  fi
  if [[ "$temp" == "0" ]] && [[ -f /sys/class/thermal/thermal_zone0/temp ]]; then
    temp=$(echo "scale=1; $(cat /sys/class/thermal/thermal_zone0/temp) / 1000" | bc)
  fi

  # Clock speed (MHz)
  local freq
  freq=$(grep "cpu MHz" /proc/cpuinfo | head -1 | awk '{print int($4)}')

  echo "\"cpu\": {
    \"model\": \"$(echo $model | sed 's/"/\\"/g')\",
    \"cores\": $cores,
    \"usage\": $usage,
    \"temp\": ${temp:-0},
    \"freq_mhz\": ${freq:-0},
    \"load_1\": $load1,
    \"load_5\": $load5,
    \"load_15\": $load15
  }"
}

collect_ram() {
  local total avail used buffers cached swap_total swap_used
  total=$(grep "^MemTotal"     /proc/meminfo | awk '{print int($2/1024)}')
  avail=$(grep "^MemAvailable" /proc/meminfo | awk '{print int($2/1024)}')
  buffers=$(grep "^Buffers"    /proc/meminfo | awk '{print int($2/1024)}')
  cached=$(grep "^Cached"      /proc/meminfo | awk '{print int($2/1024)}')
  swap_total=$(grep "^SwapTotal" /proc/meminfo | awk '{print int($2/1024)}')
  swap_used=$(grep "^SwapFree"   /proc/meminfo | awk '{print int($2/1024)}')
  used=$(( total - avail ))
  swap_used=$(( swap_total - swap_used ))

  echo "\"ram\": {
    \"total_mb\": $total,
    \"used_mb\": $used,
    \"available_mb\": $avail,
    \"buffers_mb\": $buffers,
    \"cached_mb\": $cached,
    \"swap_total_mb\": $swap_total,
    \"swap_used_mb\": $swap_used
  }"
}

collect_disk() {
  local sys_used sys_total sys_avail model_used model_total model_avail
  read -r sys_used sys_total sys_avail <<< $(df -BM / | tail -1 | awk '{
    gsub(/M/,"",$3); gsub(/M/,"",$2); gsub(/M/,"",$4)
    print $3, $2, $4
  }')

  # Models dir may be on a different mount
  local model_dir="/opt/llmspaghetti/models"
  if mountpoint -q "$model_dir" 2>/dev/null; then
    read -r model_used model_total model_avail <<< $(df -BM "$model_dir" | tail -1 | awk '{
      gsub(/M/,"",$3); gsub(/M/,"",$2); gsub(/M/,"",$4)
      print $3, $2, $4
    }')
  else
    model_used=$sys_used
    model_total=$sys_total
    model_avail=$sys_avail
  fi

  # Disk I/O (read bytes, write bytes since boot from /proc/diskstats)
  local read_mb write_mb
  read_mb=$(awk '{sum += $6} END {print int(sum * 512 / 1024 / 1024)}' /proc/diskstats 2>/dev/null || echo 0)
  write_mb=$(awk '{sum += $10} END {print int(sum * 512 / 1024 / 1024)}' /proc/diskstats 2>/dev/null || echo 0)

  echo "\"disk\": {
    \"sys_used_mb\": ${sys_used:-0},
    \"sys_total_mb\": ${sys_total:-0},
    \"sys_avail_mb\": ${sys_avail:-0},
    \"model_used_mb\": ${model_used:-0},
    \"model_total_mb\": ${model_total:-0},
    \"model_avail_mb\": ${model_avail:-0},
    \"read_total_mb\": $read_mb,
    \"write_total_mb\": $write_mb
  }"
}

collect_network() {
  # Sample net stats twice for live rate
  local iface
  iface=$(ip route | grep default | awk '{print $5}' | head -1)
  [[ -z "$iface" ]] && iface="eth0"

  local rx1 tx1 rx2 tx2
  rx1=$(cat /sys/class/net/${iface}/statistics/rx_bytes 2>/dev/null || echo 0)
  tx1=$(cat /sys/class/net/${iface}/statistics/tx_bytes 2>/dev/null || echo 0)
  sleep 0.5
  rx2=$(cat /sys/class/net/${iface}/statistics/rx_bytes 2>/dev/null || echo 0)
  tx2=$(cat /sys/class/net/${iface}/statistics/tx_bytes 2>/dev/null || echo 0)

  local rx_rate tx_rate
  rx_rate=$(echo "scale=2; ($rx2 - $rx1) * 2 / 1024 / 1024" | bc)
  tx_rate=$(echo "scale=2; ($tx2 - $tx1) * 2 / 1024 / 1024" | bc)

  local ip
  ip=$(hostname -I | awk '{print $1}')

  echo "\"network\": {
    \"interface\": \"$iface\",
    \"ip\": \"$ip\",
    \"rx_mbps\": ${rx_rate:-0},
    \"tx_mbps\": ${tx_rate:-0},
    \"rx_total_mb\": $(( rx2 / 1024 / 1024 )),
    \"tx_total_mb\": $(( tx2 / 1024 / 1024 ))
  }"
}

collect_nvidia() {
  if ! command -v nvidia-smi &>/dev/null; then
    echo "\"nvidia\": []"
    return
  fi

  local gpus_json="[]"
  local count
  count=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | wc -l)
  [[ $count -eq 0 ]] && { echo "\"nvidia\": []"; return; }

  local json="["
  local first=true

  while IFS=',' read -r idx name vram_used vram_total util temp power_draw power_limit fan clock_mem clock_gpu; do
    $first || json+=","
    first=false
    # Strip whitespace
    name=$(echo "$name" | xargs)
    json+="{
      \"index\": $idx,
      \"name\": \"$(echo $name | sed 's/"/\\"/g')\",
      \"vram_used_mb\": $(echo "$vram_used" | xargs | tr -d ' '),
      \"vram_total_mb\": $(echo "$vram_total" | xargs | tr -d ' '),
      \"util_pct\": $(echo "$util" | xargs | tr -d ' '),
      \"temp_c\": $(echo "$temp" | xargs | tr -d ' '),
      \"power_draw_w\": $(echo "$power_draw" | xargs | tr -d ' '),
      \"power_limit_w\": $(echo "$power_limit" | xargs | tr -d ' '),
      \"fan_pct\": $(echo "$fan" | xargs | tr -d ' '),
      \"clock_mem_mhz\": $(echo "$clock_mem" | xargs | tr -d ' '),
      \"clock_gpu_mhz\": $(echo "$clock_gpu" | xargs | tr -d ' ')
    }"
  done < <(nvidia-smi \
    --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,power.limit,fan.speed,clocks.mem,clocks.gr \
    --format=csv,noheader,nounits 2>/dev/null)

  json+="]"
  echo "\"nvidia\": $json"
}

collect_amd() {
  if ! command -v rocm-smi &>/dev/null; then
    echo "\"amd\": []"
    return
  fi

  local count
  count=$(rocm-smi --showid 2>/dev/null | grep -c "GPU\[" || echo 0)
  [[ $count -eq 0 ]] && { echo "\"amd\": []"; return; }

  # rocm-smi JSON output
  local raw
  raw=$(rocm-smi --showuse --showtemp --showmeminfo vram --showpower --json 2>/dev/null || echo "{}")

  echo "\"amd\": $raw"
}

collect_services() {
  # Strip ALL whitespace from the tool output so a stray newline (e.g. docker
  # printing a blank line to stdout before it fails, or systemctl echoing status
  # then the `||` firing) can't inject a raw control character into the JSON
  # string. Default to a clean token when empty.
  svc_status() {
    local s; s=$(systemctl is-active "$1" 2>/dev/null | tr -d '[:space:]')
    echo "${s:-inactive}"
  }
  container_status() {
    local s; s=$(docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null | tr -d '[:space:]')
    echo "${s:-stopped}"
  }

  # Ollama loaded models — /api/ps is what's actually resident in memory (NOT
  # /api/tags, which lists every installed model on disk). size_vram tells us how
  # much of each model is on the GPU vs spilled to system RAM.
  local models_json="[]"
  if command -v ollama &>/dev/null; then
    local raw
    raw=$(curl -sf http://localhost:11434/api/ps 2>/dev/null || echo '{"models":[]}')
    models_json=$(echo "$raw" | python3 -c "
import json,sys
data=json.load(sys.stdin)
models=data.get('models',[])
out=[]
for m in models:
    out.append({'name':m.get('name',''),'size':m.get('size',0),'size_vram':m.get('size_vram',0)})
print(json.dumps(out))
" 2>/dev/null || echo "[]")
  fi

  echo "\"services\": {
    \"ollama\":   \"$(svc_status ollama)\",
    \"webui\":    \"$(container_status llmspaghetti-webui)\",
    \"litellm\":  \"$(container_status llmspaghetti-litellm)\",
    \"cockpit\":  \"$(svc_status cockpit)\",
    \"caddy\":    \"$(svc_status caddy)\",
    \"terminal\": \"$(svc_status llmspaghetti-terminal)\",
    \"comfyui\":  \"$(container_status llmspaghetti-comfyui)\"
  },
  \"loaded_models\": $models_json"
}

collect_system() {
  local uptime kernel hostname
  uptime=$(uptime -p 2>/dev/null | sed 's/up //')
  kernel=$(uname -r)
  hostname=$(hostname)
  local boot_time
  boot_time=$(who -b 2>/dev/null | awk '{print $3, $4}' || uptime -s)

  echo "\"system\": {
    \"hostname\": \"$hostname\",
    \"kernel\": \"$kernel\",
    \"uptime\": \"$uptime\",
    \"boot_time\": \"$boot_time\"
  }"
}

# ── Main: collect everything and output JSON ──────────────────────────────────
main() {
  # NOTE: these run sequentially on purpose. The previous version used
  # `var=$(collector) &` which sets the variable inside a backgrounded SUBSHELL —
  # the parent shell never sees it, so every section came out empty (bare commas,
  # invalid JSON). Sequential is correct and still ~1s (dominated by the two
  # sampling sleeps), well within the 5s dashboard refresh.
  local cpu_out ram_out disk_out net_out nvidia_out amd_out svc_out sys_out

  cpu_out=$(collect_cpu)
  ram_out=$(collect_ram)
  disk_out=$(collect_disk)
  net_out=$(collect_network)
  nvidia_out=$(collect_nvidia)
  amd_out=$(collect_amd)
  svc_out=$(collect_services)
  sys_out=$(collect_system)

  echo "{"
  echo "  $cpu_out,"
  echo "  $ram_out,"
  echo "  $disk_out,"
  echo "  $net_out,"
  echo "  $nvidia_out,"
  echo "  $amd_out,"
  echo "  $svc_out,"
  echo "  $sys_out,"
  echo "  \"timestamp\": $(date +%s)"
  echo "}"
}

main
