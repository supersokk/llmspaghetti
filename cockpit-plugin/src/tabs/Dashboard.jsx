/**
 * LLMSpaghetti Dashboard Tab
 * Live system stats: CPU, RAM, Disk, Network, per-GPU VRAM/temp/power/util
 * Service health dots, loaded models, power controls
 */

import React, { useState, useEffect, useRef, useCallback } from "react";

const cockpit = window.cockpit || {
  spawn: () => ({ stream: () => {}, then: (f) => { f("{}"); return { catch: () => {} }; }, catch: () => {} }),
  file:  () => ({ read: () => Promise.resolve("") }),
  http:  () => ({ get: () => Promise.resolve("{}") }),
};

const C = {
  bg: "#0d1117", surface: "#161b22", border: "#30363d",
  accent: "#2f81f7", accent2: "#58a6ff",
  green: "#3fb950", yellow: "#d29922", red: "#f85149",
  text: "#e6edf3", dim: "#8b949e", purple: "#bc8cff",
  orange: "#f0883e",
};

// ── Helpers ───────────────────────────────────────────────────────────────────
// cockpit.spawn runs with a minimal PATH that omits /usr/local/bin (where ollama
// lives), so prepend a full PATH or commands like `ollama`/`nvidia-smi` silently
// fail — the cause of empty dashboards and "no models installed".
const PATHFIX = "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; ";
const run = (cmd) => new Promise((res) => {
  let out = "";
  const proc = cockpit.spawn(["bash", "-c", PATHFIX + cmd], { superuser: "try", err: "message" });
  proc.stream(d => { out += d; });
  proc.then(() => res(out.trim())).catch(() => res(""));
});

const fmt = {
  mb:  (n) => n >= 1024 ? `${(n/1024).toFixed(1)}GB` : `${n}MB`,
  pct: (n) => `${Number(n).toFixed(1)}%`,
  w:   (n) => `${Number(n).toFixed(0)}W`,
  mhz: (n) => n >= 1000 ? `${(n/1000).toFixed(2)}GHz` : `${n}MHz`,
  net: (n) => `${Number(n).toFixed(1)} MB/s`,
};

// ── Sub-components ────────────────────────────────────────────────────────────

function StatBar({ value, max, label, sublabel, unit = "", warn = 75, crit = 90, height = 8 }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const colour = pct >= crit ? C.red : pct >= warn ? C.yellow : C.green;
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between",
                    fontSize: "0.78rem", marginBottom: "0.3rem" }}>
        <span style={{ color: C.dim }}>{label}</span>
        <span style={{ color: C.text, fontWeight: 600 }}>
          {sublabel || `${fmt.mb(value)} / ${fmt.mb(max)}`}
        </span>
      </div>
      <div style={{ background: C.border, borderRadius: "4px", height, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: colour,
                      borderRadius: "4px", transition: "width 0.6s ease" }} />
      </div>
    </div>
  );
}

function TempBadge({ temp }) {
  const colour = temp >= 85 ? C.red : temp >= 70 ? C.orange : temp >= 55 ? C.yellow : C.green;
  return (
    <span style={{ fontSize: "0.82rem", fontWeight: 700, color: colour }}>
      {temp}°C
    </span>
  );
}

function ServiceDot({ state, label }) {
  const colour = state === "active" || state === "running"  ? C.green
               : state === "activating" ? C.yellow
               : state === "failed"     ? C.red
               : C.dim;
  const dot = state === "active" || state === "running" ? "●"
            : state === "activating" ? "◐"
            : state === "failed"     ? "✗" : "○";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem",
                  fontSize: "0.82rem" }}>
      <span style={{ color: colour, fontSize: "0.9rem" }}>{dot}</span>
      <span style={{ color: state === "active" || state === "running" ? C.text : C.dim }}>
        {label}
      </span>
    </div>
  );
}

// ── Provider health (reads router_roles.yaml + pings via router API) ─────────
const ROLES_PATH_DH = "/opt/llmspaghetti/config/router_roles.yaml";
const ROUTER_PORT_DH = 5000;

const ROLE_ICONS = {
  image: "🖼", code: "💻", reasoning: "🧠",
  fast: "⚡", document: "📄", general: "💬", none: "🚫",
};

function _parseRolesDH(yaml) {
  const roles = {};
  if (!yaml) return roles;
  let inRoles = false, curRole = null;
  for (const line of yaml.split("\n")) {
    if (line.trim().startsWith("roles:")) { inRoles = true; continue; }
    if (!inRoles) continue;
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (line.match(/^\S/)) { inRoles = false; curRole = null; continue; }
    const sub = line.match(/^    (primary|fallback):\s*(.*)/);
    if (sub && curRole) {
      const v = sub[2].trim().replace(/^"|"$/g, "");
      roles[curRole][sub[1]] = (v === "null" || v === "") ? null : v;
      continue;
    }
    const m = line.match(/^  (\w+):\s*(.*)/);
    if (!m) continue;
    const [, role, rest] = m;
    const v = rest.trim().replace(/^"|"$/g, "");
    if (v === "") { roles[role] = { primary: null, fallback: null }; curRole = role; }
    else if (v === "null") { roles[role] = { primary: null, fallback: null }; curRole = null; }
    else { roles[role] = { primary: v, fallback: null }; curRole = null; }
  }
  return roles;
}

async function _pingDH(model) {
  if (!model) return null;
  const t0 = performance.now();
  try {
    const body = await cockpit.http(ROUTER_PORT_DH)
      .get(`/api/provider-health?model=${encodeURIComponent(model)}`);
    const d = JSON.parse(body || "{}");
    return { status: d.status || "ok", latency: Math.round(performance.now() - t0) };
  } catch {
    return { status: "unreachable", latency: null };
  }
}

function HealthDot({ status, latency }) {
  const colour = status === "ok"          ? C.green
               : status === "unreachable" ? C.red
               : status === "disabled"    ? C.dim
               : C.yellow;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%",
                     background: colour, display: "inline-block", flexShrink: 0 }} />
      {latency != null && <span style={{ fontSize: "0.7rem", color: C.dim }}>{latency}ms</span>}
    </span>
  );
}

function ProviderHealth() {
  const [rows, setRows]           = useState([]);
  const [loading, setLoading]     = useState(true);
  const [lastCheck, setLastCheck] = useState(null);
  const [routerUp, setRouterUp]   = useState(true);

  const ROLE_ORDER = ["image", "code", "reasoning", "fast", "document", "general"];

  const refresh = useCallback(async () => {
    try {
      const yaml   = await cockpit.file(ROLES_PATH_DH).read();
      const parsed = _parseRolesDH(yaml || "");

      const allModels = new Set();
      for (const entry of Object.values(parsed)) {
        if (entry?.primary)  allModels.add(entry.primary);
        if (entry?.fallback) allModels.add(entry.fallback);
      }

      const healthMap = {};
      const results = await Promise.allSettled(
        [...allModels].map(async m => [m, await _pingDH(m)])
      );
      let anyReachable = false;
      for (const r of results) {
        if (r.status === "fulfilled") {
          const [m, h] = r.value;
          healthMap[m] = h;
          if (h?.status === "ok") anyReachable = true;
        }
      }
      setRouterUp(allModels.size === 0 || anyReachable ||
        results.some(r => r.status === "fulfilled" && r.value[1]?.status !== "unreachable"));

      setRows(
        ROLE_ORDER
          .filter(r => parsed[r]?.primary)
          .map(role => {
            const { primary, fallback } = parsed[role] || {};
            return {
              role, primary, fallback,
              primaryHealth:  primary  ? healthMap[primary]  : null,
              fallbackHealth: fallback ? healthMap[fallback] : null,
            };
          })
      );
      setLastCheck(new Date());
    } catch {
      // cockpit not available or router down — silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`,
                  borderRadius: "10px", padding: "1.25rem" }}>
      <div style={{ fontSize: "0.72rem", color: C.dim, fontWeight: 600,
                    textTransform: "uppercase", letterSpacing: "0.05em",
                    marginBottom: "0.75rem", display: "flex",
                    justifyContent: "space-between", alignItems: "center" }}>
        <span>Provider Health</span>
        {lastCheck && (
          <span style={{ fontSize: "0.68rem", fontWeight: 400 }}>
            {lastCheck.toLocaleTimeString()}
          </span>
        )}
      </div>

      {loading ? (
        <div style={{ color: C.dim, fontSize: "0.82rem" }}>Checking…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: C.dim, fontSize: "0.82rem" }}>
          No roles configured. Set models in the{" "}
          <span style={{ color: C.accent2 }}>Routing</span> tab.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.border}` }}>
              {["Role", "Primary", "Fallback"].map(h => (
                <th key={h} style={{ padding: "0.3rem 0.5rem", color: C.dim, textAlign: "left",
                                      fontSize: "0.68rem", textTransform: "uppercase",
                                      letterSpacing: "0.05em", fontWeight: 600 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ role, primary, fallback, primaryHealth, fallbackHealth }) => (
              <tr key={role} style={{ borderBottom: `1px solid ${C.border}20` }}>
                <td style={{ padding: "0.35rem 0.5rem", color: C.dim, whiteSpace: "nowrap" }}>
                  {ROLE_ICONS[role]} {role}
                </td>
                <td style={{ padding: "0.35rem 0.5rem" }}>
                  {role === "image" ? (
                    // The image role goes to ComfyUI, NOT a text model — its role→model
                    // entry is vestigial. Show the real handler instead of a stray LLM.
                    <span style={{ fontSize: "0.75rem", color: C.purple }}>ComfyUI · Image Generator</span>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: "0.45rem",
                                  fontFamily: "monospace", fontSize: "0.75rem", color: C.accent2 }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis",
                                     whiteSpace: "nowrap", maxWidth: "130px" }}>{primary}</span>
                      {primaryHealth && <HealthDot {...primaryHealth} />}
                    </div>
                  )}
                </td>
                <td style={{ padding: "0.35rem 0.5rem" }}>
                  {fallback ? (
                    <div style={{ display: "flex", alignItems: "center", gap: "0.45rem",
                                  fontFamily: "monospace", fontSize: "0.75rem", color: C.dim }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis",
                                     whiteSpace: "nowrap", maxWidth: "130px" }}>{fallback}</span>
                      {fallbackHealth && <HealthDot {...fallbackHealth} />}
                    </div>
                  ) : (
                    <span style={{ color: C.dim, fontSize: "0.72rem" }}>—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── GPU Card (one per physical GPU) ──────────────────────────────────────────
function GPUCard({ gpu, index, vendor, onRefresh }) {
  const [freeing, setFreeing] = useState(false);

  // Reclaim VRAM held by running services — unload every loaded Ollama model AND
  // drop ComfyUI's cached model — WITHOUT stopping either service. Both reload on
  // next use; this just hands the VRAM back now.
  const freeVram = async () => {
    setFreeing(true);
    try {
      await run(
        // Ollama: stop only what's actually loaded (/api/ps).
        `curl -sf http://localhost:11434/api/ps | python3 -c ` +
        `"import json,sys,subprocess; [subprocess.run(['ollama','stop',m['name']]) ` +
        `for m in json.load(sys.stdin).get('models',[])]" 2>/dev/null; ` +
        // ComfyUI: free cached models + memory.
        `curl -sf -X POST http://localhost:8188/free -H 'Content-Type: application/json' ` +
        `-d '{"unload_models":true,"free_memory":true}' >/dev/null 2>&1; true`
      );
    } finally {
      setFreeing(false);
      if (onRefresh) onRefresh();
    }
  };

  const vramPct = gpu.vram_total_mb > 0
    ? (gpu.vram_used_mb / gpu.vram_total_mb) * 100 : 0;
  const utilPct = gpu.util_pct || 0;
  const powerPct = gpu.power_limit_w > 0
    ? (gpu.power_draw_w / gpu.power_limit_w) * 100 : 0;

  const vendorColour = vendor === "nvidia" ? C.green : C.accent;
  const vendorLabel  = vendor === "nvidia" ? "NVIDIA" : "AMD";

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`,
                  borderRadius: "10px", padding: "1.25rem" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between",
                    alignItems: "flex-start", marginBottom: "1rem" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem",
                        marginBottom: "0.2rem" }}>
            <span style={{ fontSize: "0.72rem", fontWeight: 700, color: vendorColour,
                           background: `${vendorColour}18`, padding: "0.15rem 0.5rem",
                           borderRadius: "20px", border: `1px solid ${vendorColour}30` }}>
              {vendorLabel} · GPU {index}
            </span>
          </div>
          <div style={{ fontSize: "0.92rem", fontWeight: 700, color: C.text }}>
            {gpu.name || "Unknown GPU"}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <TempBadge temp={gpu.temp_c || 0} />
          {gpu.fan_pct != null && (
            <div style={{ fontSize: "0.72rem", color: C.dim, marginTop: "0.15rem" }}>
              Fan {gpu.fan_pct}%
            </div>
          )}
          <button onClick={freeVram} disabled={freeing}
            title="Unload all Ollama models and drop ComfyUI's cached model from VRAM. Services keep running; they reload on next use."
            style={{ marginTop: "0.5rem", fontSize: "0.72rem", fontWeight: 600,
                     color: freeing ? C.dim : C.accent2, background: "transparent",
                     border: `1px solid ${C.border}`, borderRadius: "6px",
                     padding: "0.22rem 0.55rem", cursor: freeing ? "default" : "pointer",
                     whiteSpace: "nowrap" }}>
            {freeing ? "Freeing…" : "⤓ Free VRAM"}
          </button>
        </div>
      </div>

      {/* VRAM */}
      <StatBar
        value={gpu.vram_used_mb || 0}
        max={gpu.vram_total_mb || 1}
        label="VRAM"
        warn={80} crit={92}
        height={10}
      />

      {/* GPU Utilisation */}
      <StatBar
        value={utilPct}
        max={100}
        label="GPU Util"
        sublabel={fmt.pct(utilPct)}
        warn={85} crit={95}
        height={8}
      />

      {/* Power */}
      {gpu.power_draw_w != null && (
        <StatBar
          value={gpu.power_draw_w}
          max={gpu.power_limit_w || gpu.power_draw_w + 50}
          label="Power"
          sublabel={`${fmt.w(gpu.power_draw_w)} / ${fmt.w(gpu.power_limit_w)}`}
          warn={85} crit={95}
          height={6}
        />
      )}

      {/* Clocks */}
      {gpu.clock_gpu_mhz != null && (
        <div style={{ display: "flex", gap: "1rem", marginTop: "0.5rem" }}>
          <div style={{ fontSize: "0.75rem", color: C.dim }}>
            Core <span style={{ color: C.text }}>{fmt.mhz(gpu.clock_gpu_mhz)}</span>
          </div>
          <div style={{ fontSize: "0.75rem", color: C.dim }}>
            Mem <span style={{ color: C.text }}>{fmt.mhz(gpu.clock_mem_mhz)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Power Controls ────────────────────────────────────────────────────────────
function PowerMenu({ onAction }) {
  const [open, setOpen]       = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy]       = useState(false);
  const ref = useRef();

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const actions = [
    {
      id: "stop-models",
      label: "Stop all models",
      icon: "⏹",
      desc: "Unload LLMs from VRAM. Services keep running.",
      colour: C.yellow,
      needsConfirm: false,
      cmd: "curl -sf http://localhost:11434/api/tags | python3 -c \"import json,sys,subprocess; [subprocess.run(['ollama','stop',m['name']]) for m in json.load(sys.stdin).get('models',[])]\" 2>/dev/null || true",
    },
    {
      id: "stop-services",
      label: "Stop all services",
      icon: "⏸",
      desc: "Kill Docker stack and Ollama. Server stays on.",
      colour: C.orange,
      needsConfirm: true,
      cmd: "systemctl stop llmspaghetti docker ollama",
    },
    {
      id: "reboot",
      label: "Reboot",
      icon: "↺",
      desc: "Graceful stop and restart.",
      colour: C.red,
      needsConfirm: true,
      cmd: "systemctl reboot",
    },
    {
      id: "shutdown",
      label: "Shutdown",
      icon: "⏻",
      desc: "Full power off.",
      colour: C.red,
      needsConfirm: true,
      cmd: "systemctl poweroff",
    },
  ];

  const trigger = async (action) => {
    if (action.needsConfirm && confirm !== action.id) {
      setConfirm(action.id);
      return;
    }
    setBusy(action.id);
    setOpen(false);
    setConfirm(null);
    try {
      await run(action.cmd);
      onAction && onAction(action.id);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => { setOpen(o => !o); setConfirm(null); }}
        style={{ display: "flex", alignItems: "center", gap: "0.4rem",
                 background: "transparent", border: `1px solid ${C.border}`,
                 borderRadius: "8px", padding: "0.45rem 0.9rem",
                 color: C.text, cursor: "pointer", fontSize: "0.85rem",
                 fontWeight: 600, transition: "border-color 0.15s" }}
        onMouseOver={e => e.currentTarget.style.borderColor = C.red}
        onMouseOut={e => e.currentTarget.style.borderColor = C.border}>
        <span style={{ fontSize: "1rem" }}>⏻</span> Power
      </button>

      {open && (
        <div style={{ position: "absolute", right: 0, top: "calc(100% + 8px)",
                      background: C.surface, border: `1px solid ${C.border}`,
                      borderRadius: "10px", minWidth: "260px", zIndex: 100,
                      boxShadow: "0 8px 32px rgba(0,0,0,0.5)", overflow: "hidden" }}>
          <div style={{ padding: "0.5rem 0.75rem", fontSize: "0.72rem",
                        color: C.dim, borderBottom: `1px solid ${C.border}`,
                        fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Power controls
          </div>
          {actions.map(a => (
            <button key={a.id}
              onClick={() => trigger(a)}
              disabled={!!busy}
              style={{ display: "block", width: "100%", textAlign: "left",
                       padding: "0.75rem 1rem", background: confirm === a.id
                         ? `${a.colour}18` : "transparent",
                       border: "none", borderBottom: `1px solid ${C.border}`,
                       cursor: "pointer", transition: "background 0.15s" }}
              onMouseOver={e => { if (confirm !== a.id) e.currentTarget.style.background = "#ffffff08"; }}
              onMouseOut={e => { if (confirm !== a.id) e.currentTarget.style.background = "transparent"; }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                <span style={{ fontSize: "1.1rem", color: a.colour, width: "20px",
                               textAlign: "center" }}>{a.icon}</span>
                <div>
                  <div style={{ fontSize: "0.88rem", fontWeight: 600,
                                color: confirm === a.id ? a.colour : C.text }}>
                    {confirm === a.id ? `⚠ Click again to ${a.label.toLowerCase()}` : a.label}
                  </div>
                  <div style={{ fontSize: "0.75rem", color: C.dim }}>{a.desc}</div>
                </div>
                {busy === a.id && (
                  <div style={{ marginLeft: "auto",
                                width: 16, height: 16, borderRadius: "50%",
                                border: `2px solid ${C.border}`,
                                borderTopColor: a.colour,
                                animation: "spin 0.7s linear infinite" }} />
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Mini sparkline (last N values) ───────────────────────────────────────────
function Sparkline({ history, max = 100, colour = C.accent, width = 120, height = 32 }) {
  if (!history || history.length < 2) return null;
  const pts = history.slice(-24);
  const step = width / (pts.length - 1);
  const points = pts.map((v, i) => {
    const x = i * step;
    const y = height - (Math.min(v, max) / max) * height;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <polyline points={points} fill="none" stroke={colour}
        strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN DASHBOARD
// ═════════════════════════════════════════════════════════════════════════════
export default function Dashboard({ onTabChange }) {
  const [stats, setStats]       = useState(null);
  const [history, setHistory]   = useState({ cpu: [], ram: [], netRx: [], netTx: [] });
  const [loading, setLoading]   = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  const intervalRef = useRef(null);

  const STATS_SCRIPT = "/opt/llmspaghetti/scripts/collect-stats.sh";

  const refresh = useCallback(async () => {
    try {
      const raw = await run(`bash ${STATS_SCRIPT} 2>/dev/null`);
      if (!raw) return;
      const data = JSON.parse(raw);
      setStats(data);
      setLastUpdate(new Date());

      // Append to sparkline history
      setHistory(h => ({
        cpu:   [...h.cpu.slice(-23),   data.cpu?.usage   || 0],
        ram:   [...h.ram.slice(-23),   data.ram
          ? (data.ram.used_mb / data.ram.total_mb) * 100 : 0],
        netRx: [...h.netRx.slice(-23), data.network?.rx_mbps || 0],
        netTx: [...h.netTx.slice(-23), data.network?.tx_mbps || 0],
      }));
    } catch (e) {
      console.error("Stats parse error:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    intervalRef.current = setInterval(refresh, 5000);
    return () => clearInterval(intervalRef.current);
  }, [refresh]);

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem",
                  padding: "3rem", color: C.dim }}>
      <div style={{ width: 20, height: 20, border: `2px solid ${C.border}`,
                    borderTopColor: C.accent, borderRadius: "50%",
                    animation: "spin 0.7s linear infinite" }} />
      Collecting system stats…
    </div>
  );

  const { cpu, ram, disk, network, nvidia = [], amd = [], services, loaded_models = [], system } = stats || {};
  const allGpus = [
    ...(nvidia || []).map(g => ({ ...g, vendor: "nvidia" })),
    ...(Array.isArray(amd) ? amd.map(g => ({ ...g, vendor: "amd" })) : []),
  ];

  const totalVramUsed  = allGpus.reduce((s, g) => s + (g.vram_used_mb || 0), 0);
  const totalVramTotal = allGpus.reduce((s, g) => s + (g.vram_total_mb || 0), 0);
  const maxTemp        = allGpus.reduce((m, g) => Math.max(m, g.temp_c || 0), 0);

  return (
    <div>
      {/* ── Top bar: hostname + last update + power button ── */}
      <div style={{ display: "flex", justifyContent: "space-between",
                    alignItems: "center", marginBottom: "1.25rem" }}>
        <div style={{ fontSize: "0.75rem", color: C.dim }}>
          {system?.hostname && <span>{system.hostname} · </span>}
          {system?.uptime && `up ${system.uptime}`}
          {lastUpdate && ` · updated ${lastUpdate.toLocaleTimeString()}`}
        </div>
        {network?.ip && (
          <a href={`http://${network.ip}/`} target="_blank" rel="noreferrer"
            title="Open SpagDesk — your chat / workspace"
            style={{ fontSize: "0.8rem", fontWeight: 700, color: C.accent2, textDecoration: "none",
                     background: `${C.accent}14`, border: `1px solid ${C.accent}40`,
                     borderRadius: 20, padding: "0.28rem 0.8rem", whiteSpace: "nowrap" }}>
            🍝 Workspace → {network.ip}
          </a>
        )}
        <PowerMenu onAction={(id) => {
          if (id === "stop-models" || id === "stop-services") refresh();
        }} />
      </div>

      {/* ── Summary tiles ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)",
                    gap: "0.75rem", marginBottom: "1rem" }}>
        {[
          {
            label: "CPU",
            value: fmt.pct(cpu?.usage || 0),
            sub: cpu?.model?.replace(/\(R\)|\(TM\)|CPU|Processor/gi, "").trim().slice(0, 28),
            extra: <Sparkline history={history.cpu} colour={C.accent} />,
            alert: (cpu?.usage || 0) > 90,
          },
          {
            label: "RAM",
            value: fmt.mb(ram?.used_mb || 0),
            sub: `of ${fmt.mb(ram?.total_mb || 0)}`,
            extra: <Sparkline history={history.ram} colour={C.purple} />,
            alert: ram && (ram.used_mb / ram.total_mb) > 0.9,
          },
          {
            label: "GPU VRAM",
            value: totalVramTotal > 0 ? fmt.mb(totalVramUsed) : "no GPU",
            sub: totalVramTotal > 0 ? `of ${fmt.mb(totalVramTotal)}` : "CPU mode",
            extra: maxTemp > 0 && <TempBadge temp={maxTemp} />,
            alert: totalVramTotal > 0 && (totalVramUsed / totalVramTotal) > 0.92,
          },
          {
            label: "Network",
            value: `↓ ${fmt.net(network?.rx_mbps || 0)}`,
            sub: `↑ ${fmt.net(network?.tx_mbps || 0)}`,
            extra: <Sparkline history={history.netRx} colour={C.green} />,
            alert: false,
          },
        ].map(({ label, value, sub, extra, alert }) => (
          <div key={label} style={{ background: C.surface,
            border: `1px solid ${alert ? C.red + "60" : C.border}`,
            borderRadius: "10px", padding: "1rem 1.1rem" }}>
            <div style={{ fontSize: "0.72rem", color: C.dim, fontWeight: 600,
                          textTransform: "uppercase", letterSpacing: "0.05em",
                          marginBottom: "0.35rem" }}>{label}</div>
            <div style={{ fontSize: "1.4rem", fontWeight: 800,
                          color: alert ? C.red : C.text, lineHeight: 1 }}>{value}</div>
            {sub && <div style={{ fontSize: "0.75rem", color: C.dim, marginTop: "0.2rem" }}>{sub}</div>}
            {extra && <div style={{ marginTop: "0.5rem" }}>{extra}</div>}
          </div>
        ))}
      </div>

      {/* ── GPU cards (one per physical GPU) ── */}
      {allGpus.length > 0 && (
        <div style={{ display: "grid",
                      gridTemplateColumns: allGpus.length === 1 ? "1fr" : "1fr 1fr",
                      gap: "0.75rem", marginBottom: "1rem" }}>
          {allGpus.map((gpu, i) => (
            <GPUCard key={i} gpu={gpu} index={gpu.index ?? i} vendor={gpu.vendor} onRefresh={refresh} />
          ))}
        </div>
      )}

      {/* ── CPU + RAM detail ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr",
                    gap: "0.75rem", marginBottom: "1rem" }}>
        {/* CPU detail */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`,
                      borderRadius: "10px", padding: "1.25rem" }}>
          <div style={{ fontSize: "0.72rem", color: C.dim, fontWeight: 600,
                        textTransform: "uppercase", letterSpacing: "0.05em",
                        marginBottom: "0.75rem" }}>CPU</div>
          {cpu?.model && (
            <div style={{ fontSize: "0.82rem", color: C.dim, marginBottom: "0.75rem",
                          fontStyle: "italic" }}>
              {cpu.model.replace(/\(R\)|\(TM\)|CPU|Processor/gi, "").trim()}
            </div>
          )}
          <StatBar value={cpu?.usage || 0} max={100}
            label="Usage" sublabel={fmt.pct(cpu?.usage || 0)} warn={75} crit={90} height={8} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
                        gap: "0.5rem", marginTop: "0.5rem" }}>
            {[
              { label: "Cores", value: cpu?.cores || "—" },
              { label: "Temp",  value: cpu?.temp_c ? <TempBadge temp={cpu.temp_c} /> : "—" },
              { label: "Freq",  value: cpu?.freq_mhz ? fmt.mhz(cpu.freq_mhz) : "—" },
              { label: "Load 1m",  value: cpu?.load_1  || "—" },
              { label: "Load 5m",  value: cpu?.load_5  || "—" },
              { label: "Load 15m", value: cpu?.load_15 || "—" },
            ].map(({ label, value }) => (
              <div key={label}>
                <div style={{ fontSize: "0.68rem", color: C.dim }}>{label}</div>
                <div style={{ fontSize: "0.85rem", fontWeight: 600, color: C.text }}>{value}</div>
              </div>
            ))}
          </div>
        </div>

        {/* RAM detail */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`,
                      borderRadius: "10px", padding: "1.25rem" }}>
          <div style={{ fontSize: "0.72rem", color: C.dim, fontWeight: 600,
                        textTransform: "uppercase", letterSpacing: "0.05em",
                        marginBottom: "0.75rem" }}>RAM & Swap</div>
          <StatBar value={ram?.used_mb || 0} max={ram?.total_mb || 1}
            label="RAM" warn={80} crit={92} height={8} />
          <StatBar value={ram?.swap_used_mb || 0} max={ram?.swap_total_mb || 1}
            label="Swap" warn={50} crit={80} height={6} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr",
                        gap: "0.5rem", marginTop: "0.5rem" }}>
            {[
              { label: "Used",      value: fmt.mb(ram?.used_mb || 0) },
              { label: "Free",      value: fmt.mb(ram?.available_mb || 0) },
              { label: "Cached",    value: fmt.mb(ram?.cached_mb || 0) },
              { label: "Swap used", value: fmt.mb(ram?.swap_used_mb || 0) },
            ].map(({ label, value }) => (
              <div key={label}>
                <div style={{ fontSize: "0.68rem", color: C.dim }}>{label}</div>
                <div style={{ fontSize: "0.85rem", fontWeight: 600, color: C.text }}>{value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Disk + Network ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr",
                    gap: "0.75rem", marginBottom: "1rem" }}>
        {/* Disk */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`,
                      borderRadius: "10px", padding: "1.25rem" }}>
          <div style={{ fontSize: "0.72rem", color: C.dim, fontWeight: 600,
                        textTransform: "uppercase", letterSpacing: "0.05em",
                        marginBottom: "0.75rem" }}>Disk</div>
          <StatBar value={disk?.sys_used_mb || 0} max={disk?.sys_total_mb || 1}
            label="System (/)" warn={80} crit={92} height={8} />
          {disk?.model_total_mb !== disk?.sys_total_mb && (
            <StatBar value={disk?.model_used_mb || 0} max={disk?.model_total_mb || 1}
              label="Models" warn={80} crit={92} height={8} />
          )}
        </div>

        {/* Network */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`,
                      borderRadius: "10px", padding: "1.25rem" }}>
          <div style={{ fontSize: "0.72rem", color: C.dim, fontWeight: 600,
                        textTransform: "uppercase", letterSpacing: "0.05em",
                        marginBottom: "0.75rem" }}>
            Network · {network?.interface || "eth0"} · {network?.ip}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
            <div>
              <div style={{ fontSize: "0.68rem", color: C.dim }}>↓ Download</div>
              <div style={{ fontSize: "1.1rem", fontWeight: 700, color: C.green }}>
                {fmt.net(network?.rx_mbps || 0)}
              </div>
              <Sparkline history={history.netRx} colour={C.green} width={100} height={28} />
            </div>
            <div>
              <div style={{ fontSize: "0.68rem", color: C.dim }}>↑ Upload</div>
              <div style={{ fontSize: "1.1rem", fontWeight: 700, color: C.accent2 }}>
                {fmt.net(network?.tx_mbps || 0)}
              </div>
              <Sparkline history={history.netTx} colour={C.accent2} width={100} height={28} />
            </div>
          </div>
        </div>
      </div>

      {/* ── Services + Loaded models ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr",
                    gap: "0.75rem", marginBottom: "1rem" }}>
        {/* Services */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`,
                      borderRadius: "10px", padding: "1.25rem" }}>
          <div style={{ fontSize: "0.72rem", color: C.dim, fontWeight: 600,
                        textTransform: "uppercase", letterSpacing: "0.05em",
                        marginBottom: "0.75rem" }}>Services</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
            {[
              ["Ollama",   services?.ollama],
              ["Router",   services?.router],
              ["LiteLLM",  services?.litellm],
              ["Caddy",    services?.caddy],
              ["Cockpit",  services?.cockpit],
              ["Terminal", services?.terminal],
              ...(services?.comfyui && services.comfyui !== "stopped"
                ? [["ComfyUI", services.comfyui]] : []),
              // Open WebUI is optional now — only show it when it's actually installed.
              ...(services?.webui && !["stopped", "not-found", "absent"].includes(services.webui)
                ? [["Open WebUI", services.webui]] : []),
            ].map(([label, state]) => (
              <ServiceDot key={label} state={state || "inactive"} label={label} />
            ))}
          </div>
        </div>

        {/* Loaded models */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`,
                      borderRadius: "10px", padding: "1.25rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between",
                        alignItems: "center", marginBottom: "0.75rem" }}>
            <div style={{ fontSize: "0.72rem", color: C.dim, fontWeight: 600,
                          textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Loaded Models
            </div>
            <button onClick={() => onTabChange("models")}
              style={{ fontSize: "0.72rem", color: C.accent2, background: "none",
                       border: "none", cursor: "pointer" }}>
              Manage →
            </button>
          </div>
          {loaded_models.length === 0 ? (
            <div style={{ color: C.dim, fontSize: "0.85rem" }}>
              No models loaded in VRAM
              <div style={{ marginTop: "0.75rem" }}>
                <button onClick={() => onTabChange("models")}
                  style={{ background: C.accent, color: "white", border: "none",
                           borderRadius: "6px", padding: "0.4rem 0.9rem",
                           fontSize: "0.82rem", fontWeight: 600, cursor: "pointer" }}>
                  + Load a model
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {loaded_models.map(m => {
                // Where is it really? size_vram vs total size → VRAM / RAM / split.
                const total = m.size || 0;
                const vram  = m.size_vram || 0;
                const loc = !total          ? { t: "loaded",   c: C.green }
                          : vram >= total * 0.95 ? { t: "in VRAM",  c: C.green }
                          : vram <= total * 0.05 ? { t: "in RAM",   c: C.yellow }
                          :                        { t: "VRAM+RAM", c: C.yellow };
                return (
                  <div key={m.name} style={{ display: "flex", justifyContent: "space-between",
                                             alignItems: "center",
                                             padding: "0.4rem 0.6rem",
                                             background: `${loc.c}0a`,
                                             border: `1px solid ${loc.c}25`,
                                             borderRadius: "6px" }}>
                    <div>
                      <div style={{ fontSize: "0.85rem", fontWeight: 600,
                                    fontFamily: "monospace", color: C.text }}>{m.name}</div>
                      <div style={{ fontSize: "0.72rem", color: C.dim }}>
                        {total ? fmt.mb(Math.round(total / 1024 / 1024)) : ""}
                        {loc.t === "VRAM+RAM" && vram
                          ? ` · ${fmt.mb(Math.round(vram / 1024 / 1024))} on GPU` : ""}
                      </div>
                    </div>
                    <span style={{ fontSize: "0.75rem", color: loc.c,
                                   background: `${loc.c}18`,
                                   padding: "0.15rem 0.5rem", borderRadius: "20px" }}>
                      ● {loc.t}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Provider health ── */}
      <div style={{ marginBottom: "1rem" }}>
        <ProviderHealth />
      </div>

      {/* ── System info footer ── */}
      <div style={{ fontSize: "0.75rem", color: C.dim, display: "flex", gap: "1.5rem" }}>
        <span>Kernel: {system?.kernel}</span>
        <span>Boot: {system?.boot_time}</span>
      </div>
    </div>
  );
}
