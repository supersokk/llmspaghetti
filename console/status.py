#!/usr/bin/env python3
"""
LLMSpaghetti Console Status Display
Runs on tty1 instead of a login prompt.
Shows live service health, GPU stats, IP address, and access URL.
No external dependencies — only Python stdlib.
"""

import os
import sys
import time
import json
import socket
import subprocess
import signal
import re
from pathlib import Path
from datetime import datetime

# ── Terminal control ──────────────────────────────────────────────────────────

ESC = "\033"
CLEAR        = f"{ESC}[2J{ESC}[H"
HIDE_CURSOR  = f"{ESC}[?25l"
SHOW_CURSOR  = f"{ESC}[?25h"
RESET        = f"{ESC}[0m"
BOLD         = f"{ESC}[1m"
DIM          = f"{ESC}[2m"

# Colour palette
C_BG         = f"{ESC}[48;5;232m"   # near-black background
C_ACCENT     = f"{ESC}[38;5;39m"    # bright blue
C_GREEN      = f"{ESC}[38;5;82m"
C_YELLOW     = f"{ESC}[38;5;226m"
C_RED        = f"{ESC}[38;5;196m"
C_WHITE      = f"{ESC}[38;5;255m"
C_GREY       = f"{ESC}[38;5;240m"
C_CYAN       = f"{ESC}[38;5;51m"
C_PURPLE     = f"{ESC}[38;5;135m"

VERSION = "0.1.0"
INSTALL_DIR = Path("/opt/llmspaghetti")


def term_size():
    try:
        rows, cols = os.get_terminal_size()
    except OSError:
        rows, cols = 40, 120
    return rows, cols


def move(row, col):
    return f"{ESC}[{row};{col}H"


def center(text, width, fill=" "):
    """Centre plain text (strip ANSI for length calculation)."""
    plain = re.sub(r'\033\[[0-9;]*m', '', text)
    pad = max(0, (width - len(plain)) // 2)
    return fill * pad + text


# ── Data fetchers ─────────────────────────────────────────────────────────────

def get_ip():
    """Best-effort primary IP address."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "no network"


def run(cmd, timeout=3):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip()
    except Exception:
        return ""


def service_status(name):
    """Returns 'running', 'stopped', 'failed', or 'unknown'."""
    out = run(f"systemctl is-active {name} 2>/dev/null")
    mapping = {
        "active":        "running",
        "activating":    "starting",
        "deactivating":  "stopping",
        "inactive":      "stopped",
        "failed":        "failed",
    }
    return mapping.get(out, "unknown")


def docker_container_status(name):
    out = run(f"docker inspect -f '{{{{.State.Status}}}}' {name} 2>/dev/null")
    return out if out else "stopped"


def gpu_info():
    """Returns dict with GPU stats."""
    info = {"vendor": "none", "name": "", "vram_total": 0, "vram_used": 0, "util": 0, "temp": 0}

    # Try cached detection result first
    cache = INSTALL_DIR / "gpu-info.json"
    if cache.exists():
        try:
            with open(cache) as f:
                data = json.load(f)
                info["vendor"] = data.get("driver_stack", "none")
                info["name"] = data.get("nvidia", {}).get("models", "") or \
                               data.get("amd", {}).get("models", "")
                info["vram_total"] = data.get("total_vram_gb", 0)
        except Exception:
            pass

    # Live NVIDIA stats
    if "cuda" in info["vendor"]:
        raw = run("nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu "
                  "--format=csv,noheader,nounits 2>/dev/null | head -1")
        if raw:
            parts = [p.strip() for p in raw.split(",")]
            if len(parts) >= 4:
                try:
                    info["util"]       = int(parts[0])
                    info["vram_used"]  = int(parts[1]) // 1024   # MiB → GiB
                    info["vram_total"] = int(parts[2]) // 1024
                    info["temp"]       = int(parts[3])
                except ValueError:
                    pass

    # Live AMD stats
    elif "rocm" in info["vendor"]:
        util = run("rocm-smi --showuse 2>/dev/null | grep 'GPU use' | head -1 | awk '{print $NF}'")
        temp = run("rocm-smi --showtemp 2>/dev/null | grep 'Temperature' | head -1 | awk '{print $NF}'")
        try:
            info["util"] = int(util.rstrip('%'))
            info["temp"] = int(temp.rstrip('c').rstrip('C'))
        except Exception:
            pass

    return info


def sys_stats():
    """CPU, RAM, disk stats."""
    stats = {"cpu": 0, "ram_used": 0, "ram_total": 0, "disk_used": 0, "disk_total": 0}
    try:
        # CPU (1s sample)
        cpu = run("top -bn1 | grep 'Cpu(s)' | awk '{print $2}' | cut -d'%' -f1")
        stats["cpu"] = float(cpu) if cpu else 0.0

        # RAM from /proc/meminfo
        with open("/proc/meminfo") as f:
            mem = {}
            for line in f:
                k, v = line.split(":")
                mem[k.strip()] = int(v.strip().split()[0])  # kB
        total = mem.get("MemTotal", 0)
        avail = mem.get("MemAvailable", 0)
        stats["ram_total"] = total // 1024 // 1024
        stats["ram_used"]  = (total - avail) // 1024 // 1024

        # Disk
        df = run("df -BG / | tail -1 | awk '{print $3, $2}'")
        if df:
            used, total_d = df.split()
            stats["disk_used"]  = int(used.rstrip("G"))
            stats["disk_total"] = int(total_d.rstrip("G"))
    except Exception:
        pass
    return stats


def ollama_models():
    """List of locally available model names."""
    raw = run("ollama list 2>/dev/null | tail -n +2 | awk '{print $1}'")
    if not raw:
        return []
    return [m for m in raw.splitlines() if m]


# ── Bar rendering ─────────────────────────────────────────────────────────────

def bar(value, max_val, width=20, fill="█", empty="░"):
    if max_val == 0:
        pct = 0
    else:
        pct = min(1.0, value / max_val)
    filled = int(pct * width)
    colour = C_GREEN
    if pct > 0.85:
        colour = C_RED
    elif pct > 0.65:
        colour = C_YELLOW
    return f"{colour}{fill * filled}{C_GREY}{empty * (width - filled)}{RESET}"


def status_dot(state):
    if state == "running":
        return f"{C_GREEN}●{RESET}"
    elif state == "starting":
        return f"{C_YELLOW}◐{RESET}"
    elif state == "failed":
        return f"{C_RED}✗{RESET}"
    elif state == "stopped":
        return f"{C_GREY}○{RESET}"
    else:
        return f"{C_GREY}?{RESET}"


# ── Main draw loop ────────────────────────────────────────────────────────────

def draw(tick):
    rows, cols = term_size()
    buf = [CLEAR, HIDE_CURSOR]

    W = min(cols, 100)
    left_margin = (cols - W) // 2

    def line(content="", row=None):
        plain = re.sub(r'\033\[[0-9;]*m', '', content)
        padding = " " * max(0, W - len(plain))
        buf.append(f"{' ' * left_margin}{content}{padding}\n")

    now = datetime.now().strftime("%Y-%m-%d  %H:%M:%S")
    ip  = get_ip()

    # ── Header ──────────────────────────────────────────────────────────────
    line()
    line(f"{C_ACCENT}{BOLD}  ██╗     ██╗     ███╗   ███╗ ██████╗  ███████╗{RESET}")
    line(f"{C_ACCENT}{BOLD}  ██║     ██║     ████╗ ████║██╔═══██╗██╔════╝{RESET}")
    line(f"{C_ACCENT}{BOLD}  ██║     ██║     ██╔████╔██║██║   ██║███████╗{RESET}")
    line(f"{C_ACCENT}{BOLD}  ██║     ██║     ██║╚██╔╝██║██║   ██║╚════██║{RESET}")
    line(f"{C_ACCENT}{BOLD}  ███████╗███████╗██║ ╚═╝ ██║╚██████╔╝███████║{RESET}")
    line(f"{C_GREY}{BOLD}  ╚══════╝╚══════╝╚═╝     ╚═╝ ╚═════╝ ╚══════╝  v{VERSION}{RESET}")
    line()

    spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[tick % 10]

    # ── Access URLs ──────────────────────────────────────────────────────────
    line(f"  {C_WHITE}{BOLD}Web Interface{RESET}   {C_CYAN}http://{ip}{RESET}           {C_GREY}{now}{RESET}")
    line(f"  {C_WHITE}{BOLD}LLM API{RESET}         {C_CYAN}http://{ip}/api/v1{RESET}")
    line(f"  {C_WHITE}{BOLD}Management{RESET}      {C_CYAN}http://{ip}:9090{RESET}  {C_GREY}(Cockpit){RESET}")
    line()
    line(f"  {C_GREY}{'─' * (W - 4)}{RESET}")
    line()

    # ── Services ─────────────────────────────────────────────────────────────
    line(f"  {C_WHITE}{BOLD}SERVICES{RESET}")
    line()

    services = [
        ("Ollama",      service_status("ollama"),                   "Local model runner"),
        ("Open WebUI",  docker_container_status("llmspaghetti-webui"),     "Chat interface"),
        ("LiteLLM",     docker_container_status("llmspaghetti-litellm"),   "API gateway"),
        ("Cockpit",     service_status("cockpit"),                  "Server management"),
        ("Caddy",       service_status("caddy"),                    "Reverse proxy"),
    ]

    for name, state, desc in services:
        dot   = status_dot(state)
        stext = f"{C_GREEN}running{RESET}" if state == "running" else \
                f"{C_YELLOW}{state}{RESET}" if state == "starting" else \
                f"{C_RED}{state}{RESET}"   if state == "failed"   else \
                f"{C_GREY}{state}{RESET}"
        line(f"  {dot}  {C_WHITE}{name:<14}{RESET}  {stext:<30}  {C_GREY}{desc}{RESET}")

    line()
    line(f"  {C_GREY}{'─' * (W - 4)}{RESET}")
    line()

    # ── GPU ──────────────────────────────────────────────────────────────────
    gpu = gpu_info()
    line(f"  {C_WHITE}{BOLD}GPU{RESET}")
    line()

    if gpu["vendor"] == "none":
        line(f"  {C_GREY}No GPU detected — running CPU inference{RESET}")
    else:
        vendor_label = "NVIDIA" if "cuda" in gpu["vendor"] else "AMD" if "rocm" in gpu["vendor"] else gpu["vendor"]
        name_short = gpu["name"].split("|")[0][:40] if gpu["name"] else "Unknown"
        line(f"  {C_CYAN}{vendor_label}{RESET}  {C_WHITE}{name_short}{RESET}   {C_GREY}{gpu['temp']}°C{RESET}")
        line()
        vram_bar = bar(gpu["vram_used"], gpu["vram_total"], 24)
        util_bar = bar(gpu["util"], 100, 24)
        line(f"  GPU util    {util_bar}  {C_WHITE}{gpu['util']:3d}%{RESET}")
        line(f"  VRAM        {vram_bar}  {C_WHITE}{gpu['vram_used']}/{gpu['vram_total']}GB{RESET}")

    line()
    line(f"  {C_GREY}{'─' * (W - 4)}{RESET}")
    line()

    # ── System stats ─────────────────────────────────────────────────────────
    sys = sys_stats()
    line(f"  {C_WHITE}{BOLD}SYSTEM{RESET}")
    line()

    cpu_bar  = bar(sys["cpu"], 100, 24)
    ram_bar  = bar(sys["ram_used"], sys["ram_total"], 24)
    disk_bar = bar(sys["disk_used"], sys["disk_total"], 24)

    line(f"  CPU         {cpu_bar}  {C_WHITE}{sys['cpu']:5.1f}%{RESET}")
    line(f"  RAM         {ram_bar}  {C_WHITE}{sys['ram_used']}/{sys['ram_total']}GB{RESET}")
    line(f"  Disk        {disk_bar}  {C_WHITE}{sys['disk_used']}/{sys['disk_total']}GB{RESET}")
    line()
    line(f"  {C_GREY}{'─' * (W - 4)}{RESET}")
    line()

    # ── Local models ─────────────────────────────────────────────────────────
    line(f"  {C_WHITE}{BOLD}LOCAL MODELS{RESET}  {C_GREY}(manage at http://{ip}){RESET}")
    line()

    models = ollama_models()
    if models:
        for i, m in enumerate(models[:6]):   # show up to 6
            line(f"  {C_GREY}▸{RESET}  {C_WHITE}{m}{RESET}")
        if len(models) > 6:
            line(f"  {C_GREY}  ... and {len(models) - 6} more{RESET}")
    else:
        line(f"  {C_GREY}No models downloaded yet — visit the web UI to pull your first model{RESET}")

    line()
    line(f"  {C_GREY}{'─' * (W - 4)}{RESET}")
    line()

    # ── Footer ───────────────────────────────────────────────────────────────
    line(f"  {C_GREY}Press Ctrl+C to access the system shell   •   {spinner} refreshing every 5s{RESET}")
    line()

    sys.stdout.write("".join(buf))
    sys.stdout.flush()


def on_exit(sig, frame):
    print(SHOW_CURSOR + "\n")
    print("Dropping to shell. Type 'spag status' to check services.")
    print("Type 'exit' to return to the LLMSpaghetti console.\n")
    sys.exit(0)


def main():
    signal.signal(signal.SIGINT,  on_exit)
    signal.signal(signal.SIGTERM, on_exit)

    tick = 0
    while True:
        try:
            draw(tick)
        except Exception as e:
            # Never crash — just show error and keep running
            print(f"\n[console error: {e}]", file=sys.stderr)
        tick += 1
        time.sleep(5)


if __name__ == "__main__":
    main()
