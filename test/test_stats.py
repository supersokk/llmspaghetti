#!/usr/bin/env python3
"""
Unit tests for collect-stats.sh
Run directly: python3 test/test_stats.py
Or against remote: python3 test/test_stats.py --host 192.168.1.x
"""

import sys
import json
import subprocess
import argparse
import time

RED   = "\033[0;31m"
GREEN = "\033[0;32m"
YELLOW= "\033[1;33m"
DIM   = "\033[2m"
RESET = "\033[0m"
BOLD  = "\033[1m"

PASS = FAIL = WARN = 0

def run(cmd, host=None):
    if host:
        full = ["ssh", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no",
                f"llmspaghetti@{host}", cmd]
    else:
        full = ["bash", "-c", cmd]
    r = subprocess.run(full, capture_output=True, text=True, timeout=30)
    return r.stdout.strip(), r.returncode

def check(label, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  {GREEN}✓{RESET}  {label}")
    else:
        FAIL += 1
        print(f"  {RED}✗{RESET}  {label}")
        if detail:
            print(f"     {DIM}→ {detail}{RESET}")

def warn(label, detail=""):
    global WARN
    WARN += 1
    print(f"  {YELLOW}⚠{RESET}  {label}")
    if detail:
        print(f"     {DIM}→ {detail}{RESET}")

def test_stats(host=None):
    print(f"\n{BOLD}{GREEN}━━━ collect-stats.sh Output Validation ━━━{RESET}\n")

    # Run it
    t0 = time.time()
    raw, rc = run("bash /opt/llmspaghetti/scripts/collect-stats.sh 2>/dev/null", host)
    elapsed = time.time() - t0

    check("Script exits successfully", rc == 0, f"exit code: {rc}")
    check("Script completes under 3s", elapsed < 3.0, f"took {elapsed:.1f}s")

    if not raw:
        check("Output is non-empty", False, "empty output")
        return

    # Parse JSON
    try:
        d = json.loads(raw)
        check("Output is valid JSON", True)
    except json.JSONDecodeError as e:
        check("Output is valid JSON", False, str(e))
        print(f"\n{DIM}Raw output:\n{raw[:500]}{RESET}")
        return

    # ── CPU ──────────────────────────────────────────────────────────────────
    print(f"\n  {DIM}── CPU{RESET}")
    cpu = d.get("cpu", {})
    check("cpu field present",         "cpu" in d)
    check("cpu.usage is a number",     isinstance(cpu.get("usage"), (int, float)))
    check("cpu.usage in range 0-100",  0 <= float(cpu.get("usage", -1)) <= 100,
          f"value: {cpu.get('usage')}")
    check("cpu.cores > 0",             int(cpu.get("cores", 0)) > 0)
    check("cpu.model is non-empty",    bool(cpu.get("model", "").strip()))
    check("cpu.load_1 present",        "load_1" in cpu)

    # ── RAM ──────────────────────────────────────────────────────────────────
    print(f"\n  {DIM}── RAM{RESET}")
    ram = d.get("ram", {})
    check("ram field present",         "ram" in d)
    check("ram.total_mb > 0",          int(ram.get("total_mb", 0)) > 0)
    check("ram.used_mb >= 0",          int(ram.get("used_mb", -1)) >= 0)
    check("ram.used_mb <= total",
          int(ram.get("used_mb", 0)) <= int(ram.get("total_mb", 1)),
          f"used={ram.get('used_mb')} total={ram.get('total_mb')}")
    check("ram.available_mb present",  "available_mb" in ram)
    check("ram.swap_total_mb present", "swap_total_mb" in ram)

    # ── Disk ─────────────────────────────────────────────────────────────────
    print(f"\n  {DIM}── Disk{RESET}")
    disk = d.get("disk", {})
    check("disk field present",           "disk" in d)
    check("disk.sys_total_mb > 0",        int(disk.get("sys_total_mb", 0)) > 0)
    check("disk.sys_used_mb >= 0",        int(disk.get("sys_used_mb", -1)) >= 0)
    check("disk.sys_used_mb <= total",
          int(disk.get("sys_used_mb", 0)) <= int(disk.get("sys_total_mb", 1)))

    # ── Network ──────────────────────────────────────────────────────────────
    print(f"\n  {DIM}── Network{RESET}")
    net = d.get("network", {})
    check("network field present",    "network" in d)
    check("network.ip non-empty",     bool(net.get("ip", "").strip()))
    check("network.interface present", bool(net.get("interface", "").strip()))
    check("network.rx_mbps >= 0",     float(net.get("rx_mbps", -1)) >= 0)
    check("network.tx_mbps >= 0",     float(net.get("tx_mbps", -1)) >= 0)

    # ── GPU (NVIDIA) ──────────────────────────────────────────────────────────
    print(f"\n  {DIM}── GPU{RESET}")
    nvidia = d.get("nvidia", [])
    check("nvidia field present", "nvidia" in d)
    check("amd field present",    "amd" in d)

    if isinstance(nvidia, list) and len(nvidia) > 0:
        gpu0 = nvidia[0]
        check("nvidia[0].name present",       bool(gpu0.get("name")))
        check("nvidia[0].vram_total_mb > 0",  int(gpu0.get("vram_total_mb", 0)) > 0)
        check("nvidia[0].vram_used_mb >= 0",  int(gpu0.get("vram_used_mb", -1)) >= 0)
        check("nvidia[0].util_pct in 0-100",  0 <= float(gpu0.get("util_pct", -1)) <= 100)
        check("nvidia[0].temp_c > 0",         float(gpu0.get("temp_c", 0)) > 0)
        check("nvidia[0].power_draw_w present", "power_draw_w" in gpu0)
    else:
        warn("No NVIDIA GPUs detected (expected if AMD/CPU machine)")

    # ── Services ─────────────────────────────────────────────────────────────
    print(f"\n  {DIM}── Services{RESET}")
    services = d.get("services", {})
    check("services field present", "services" in d)
    for svc in ["ollama", "webui", "litellm", "caddy", "cockpit"]:
        check(f"services.{svc} present", svc in services)

    # ── System ───────────────────────────────────────────────────────────────
    print(f"\n  {DIM}── System{RESET}")
    system = d.get("system", {})
    check("system field present",        "system" in d)
    check("system.hostname non-empty",   bool(system.get("hostname", "").strip()))
    check("system.kernel non-empty",     bool(system.get("kernel", "").strip()))
    check("system.uptime non-empty",     bool(system.get("uptime", "").strip()))

    # ── Timestamp ────────────────────────────────────────────────────────────
    check("timestamp present",           "timestamp" in d)
    ts = d.get("timestamp", 0)
    now = time.time()
    check("timestamp is recent (±60s)",  abs(now - int(ts)) < 60,
          f"ts={ts} now={int(now)}")

    # Summary
    print(f"\n{BOLD}{'='*42}{RESET}")
    total = PASS + FAIL + WARN
    print(f"  {GREEN}Passed{RESET}   {PASS}/{total}")
    if FAIL:
        print(f"  {RED}Failed{RESET}   {FAIL}/{total}")
    if WARN:
        print(f"  {YELLOW}Warned{RESET}   {WARN}/{total}")
    print(f"  {DIM}Time{RESET}     {elapsed:.1f}s")

    return FAIL == 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=None, help="Remote host to test")
    args = parser.parse_args()
    ok = test_stats(args.host)
    sys.exit(0 if ok else 1)
