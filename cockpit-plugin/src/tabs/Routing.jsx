/**
 * LLMSpaghetti Routing Tab
 * - Routing mode toggle: Auto (classify every message) vs Single (pin one model)
 * - Role → primary + optional fallback model assignment
 * - Provider health monitor (primary + fallback)
 * - Live routing log with fallback / quota / override indicators
 */

import React, { useState, useEffect, useCallback } from "react";

const cockpit = window.cockpit || {
  file: (p) => ({ read: () => Promise.resolve(""), replace: () => Promise.resolve() }),
  spawn: (cmd, opts) => ({ stream: () => {}, then: (f) => { f(""); return { catch: () => {} }; }, catch: () => {} }),
  http: () => ({ get: () => Promise.resolve("{}"), request: () => Promise.resolve("{}") }),
};

const C = {
  bg: "#0d1117", surface: "#161b22", border: "#30363d",
  accent: "#2f81f7", accent2: "#58a6ff",
  green: "#3fb950", yellow: "#d29922", red: "#f85149",
  text: "#e6edf3", dim: "#8b949e", purple: "#bc8cff",
};

// cockpit.spawn has a minimal PATH without /usr/local/bin (ollama), so prepend one.
const PATHFIX = "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; ";
const run = (cmd) => new Promise((res) => {
  let out = "";
  const proc = cockpit.spawn(["bash", "-c", PATHFIX + cmd], { superuser: "try", err: "message" });
  proc.stream(d => { out += d; });
  proc.then(() => res(out.trim())).catch(() => res(""));
});

const ROLES_PATH      = "/opt/llmspaghetti/config/router_roles.yaml";
const ROLE_TOOLS_PATH = "/opt/llmspaghetti/config/role_tools.yaml";
const ROUTER_PORT     = 5000;

// Router API calls go through Cockpit's server-side bridge (cockpit.http), NOT
// browser fetch — the router binds 127.0.0.1:5000 on the SERVER, unreachable
// from a remote browser and CORS-blocked even locally.
const rget = (path) =>
  cockpit.http(ROUTER_PORT).get(path).then(b => JSON.parse(b || "{}"));
const rrequest = (method, path, obj) =>
  cockpit.http(ROUTER_PORT).request({
    method, path,
    body: obj ? JSON.stringify(obj) : "",
    headers: obj ? { "Content-Type": "application/json" } : {},
  }).then(b => (b ? JSON.parse(b) : {}));

const ROLE_META = {
  image:     { icon: "🖼",  label: "Image",     desc: "Generate, draw, create images" },
  code:      { icon: "💻",  label: "Code",      desc: "Write, debug, refactor code" },
  reasoning: { icon: "🧠",  label: "Reasoning", desc: "Architecture, planning, deep thinking" },
  fast:      { icon: "⚡",  label: "Fast",      desc: "Quick lookups, short questions" },
  document:  { icon: "📄",  label: "Document",  desc: "Summarise, read, analyse files" },
  general:   { icon: "💬",  label: "General",   desc: "Catch-all fallback" },
  none:      { icon: "🚫",  label: "None",      desc: "Excluded from auto-routing" },
};

// ── Config parser — handles mode, single_model, and roles (flat + {primary,fallback}) ──
function parseConfig(yaml) {
  const cfg = { mode: "auto", single_model: null, roles: {} };
  if (!yaml) return cfg;
  let inRoles  = false;
  let curRole  = null;

  for (const line of yaml.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // Top-level: mode
    const modeM = line.match(/^mode:\s*(.*)/);
    if (modeM) {
      cfg.mode = modeM[1].trim().replace(/^"|"$/g, "") || "auto";
      continue;
    }
    // Top-level: single_model
    const smM = line.match(/^single_model:\s*(.*)/);
    if (smM) {
      const v = smM[1].trim().replace(/^"|"$/g, "");
      cfg.single_model = (v === "null" || v === "") ? null : v;
      continue;
    }

    // roles: section start
    if (line.trim().startsWith("roles:")) { inRoles = true; continue; }
    if (!inRoles) continue;
    // End of roles section
    if (line.match(/^\S/)) { inRoles = false; curRole = null; continue; }

    // 4-space: sub-key (primary/fallback)
    const sub = line.match(/^    (primary|fallback):\s*(.*)/);
    if (sub && curRole) {
      const v = sub[2].trim().replace(/^"|"$/g, "");
      cfg.roles[curRole][sub[1]] = (v === "null" || v === "") ? null : v;
      continue;
    }

    // 2-space: role key
    const m = line.match(/^  (\w+):\s*(.*)/);
    if (!m) continue;
    const [, role, rest] = m;
    const v = rest.trim().replace(/^"|"$/g, "");
    if (v === "") {
      cfg.roles[role] = { primary: null, fallback: null };
      curRole = role;
    } else if (v === "null") {
      cfg.roles[role] = { primary: null, fallback: null };
      curRole = null;
    } else {
      cfg.roles[role] = { primary: v, fallback: null };
      curRole = null;
    }
  }
  return cfg;
}

function serializeConfig(cfg) {
  const { mode, single_model, roles } = cfg;
  const lines = [
    "# LLMSpaghetti Router — Role → Model mapping",
    "# Managed by the Routing panel. Edit with: spag config",
    "# Model names must match model_name entries in litellm_config.yaml",
    "",
    `mode: "${mode || "auto"}"`,
    `single_model: ${single_model ? `"${single_model}"` : "null"}`,
    "",
    "roles:",
  ];
  for (const [role, entry] of Object.entries(roles)) {
    const primary  = entry?.primary  || null;
    const fallback = entry?.fallback || null;
    if (!primary) {
      lines.push(`  ${role}: null`);
    } else if (fallback) {
      lines.push(`  ${role}:`);
      lines.push(`    primary: "${primary}"`);
      lines.push(`    fallback: "${fallback}"`);
    } else {
      lines.push(`  ${role}: "${primary}"`);
    }
  }
  return lines.join("\n") + "\n";
}

// ── Provider health check ─────────────────────────────────────────────────────
async function pingModel(modelName) {
  if (!modelName || modelName === "null") return { status: "disabled", latency: null };
  const t0 = performance.now();
  try {
    const data = await rget(`/api/provider-health?model=${encodeURIComponent(modelName)}`);
    return { status: data.status || "ok", latency: Math.round(performance.now() - t0) };
  } catch {
    return { status: "unreachable", latency: null };
  }
}

// ── Role card ─────────────────────────────────────────────────────────────────
function RoleCard({ role, entry, availableModels, onChange, health }) {
  const meta     = ROLE_META[role] || { icon: "?", label: role, desc: "" };
  const primary  = entry?.primary  || null;
  const fallback = entry?.fallback || null;

  const dotColor = (model) => {
    if (!model) return C.dim;
    const h = health?.[model];
    return h?.status === "ok"           ? C.green
         : h?.status === "unreachable"  ? C.red
         : h?.status === "disabled"     ? C.dim
         : C.yellow;
  };

  const selStyle = {
    width: "100%", background: C.bg, border: `1px solid ${C.border}`,
    borderRadius: "6px", color: C.text, padding: "0.45rem 0.65rem", fontSize: "0.85rem",
  };
  const labelStyle = {
    fontSize: "0.7rem", color: C.dim, fontWeight: 600,
    textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "0.25rem",
  };

  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.border}`,
      borderRadius: "10px", padding: "1.1rem 1.25rem",
      opacity: role !== "image" && !primary ? 0.6 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.75rem" }}>
        <span style={{ fontSize: "1.2rem" }}>{meta.icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: "0.92rem" }}>{meta.label}</div>
          <div style={{ fontSize: "0.74rem", color: C.dim }}>{meta.desc}</div>
        </div>
        {primary && (
          <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor(primary) }} />
            {health?.[primary]?.latency != null && (
              <span style={{ fontSize: "0.72rem", color: C.dim }}>{health[primary].latency}ms</span>
            )}
          </div>
        )}
      </div>

      {role === "image" ? (
        <div style={{ fontSize: "0.82rem", color: C.dim, lineHeight: 1.5,
                      background: C.bg, border: `1px solid ${C.border}`,
                      borderRadius: "8px", padding: "0.7rem 0.85rem" }}>
          🖼 Handled by the <strong style={{ color: C.accent2 }}>Image Generator</strong> tab —
          image requests go to ComfyUI using the engine you pick there. No model to set here.
        </div>
      ) : (
        <>
          <div style={{ marginBottom: "0.55rem" }}>
            <div style={labelStyle}>Primary</div>
            <select
              value={primary || "null"}
              onChange={e => onChange(role, "primary", e.target.value === "null" ? null : e.target.value)}
              style={selStyle}>
              <option value="null">— disabled (no routing) —</option>
              {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>

          {primary && (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.25rem" }}>
                <div style={labelStyle}>Fallback</div>
                {fallback && (
                  <div style={{ width: 6, height: 6, borderRadius: "50%",
                                background: dotColor(fallback), marginBottom: "0.25rem" }} />
                )}
              </div>
              <select
                value={fallback || "none"}
                onChange={e => onChange(role, "fallback", e.target.value === "none" ? null : e.target.value)}
                style={{ ...selStyle, color: fallback ? C.text : C.dim }}>
                <option value="none">— none (no fallback) —</option>
                {availableModels
                  .filter(m => m !== primary)
                  .map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Routing log + corrections (Flywheel capture UI) ────────────────────────────

// Roles a human can correct a route TO (mirrors the router's VALID_ROLES).
const ROLE_CHOICES = ["reasoning", "code", "fast", "document", "general", "image", "none"];

// Must match the router's _normalize_msg (lowercase, collapse whitespace).
const normalizeMsg = (m) => (m || "").toLowerCase().trim().split(/\s+/).join(" ");

async function postCorrection(body) {
  return rrequest("POST", "/api/correction", body);
}
async function undoCorrection(message) {
  return rrequest("DELETE", `/api/correction?message=${encodeURIComponent(message)}`);
}
async function fetchCorrections() {
  try {
    return (await rget("/api/corrections")).active || {};
  } catch { /* router not running */ }
  return {};
}

// Per-row control: pick the correct role, or show/undo an existing correction.
function CorrectionControl({ entry, corrected, busy, onCorrect, onUndo }) {
  // quota / image marker rows carry no id and aren't user-intent — not correctable
  if (!entry.id) return <span style={{ color: C.dim, fontSize: "0.75rem" }}>—</span>;

  if (corrected) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
        <span style={{ fontSize: "0.72rem", fontWeight: 600, color: C.green,
                       background: `${C.green}18`, padding: "0.1rem 0.45rem", borderRadius: "20px" }}>
          ✓ {ROLE_META[corrected]?.icon} {corrected}
        </span>
        <button onClick={() => onUndo(entry.message)} title="Undo this correction"
          style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.dim,
                   borderRadius: "5px", fontSize: "0.68rem", padding: "0.1rem 0.4rem",
                   cursor: "pointer" }}>undo</button>
      </span>
    );
  }

  return (
    <select value="" disabled={busy}
      onChange={e => e.target.value && onCorrect(entry, e.target.value)}
      title="Mark this route wrong and pick the correct role"
      style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.dim,
               borderRadius: "5px", fontSize: "0.72rem", padding: "0.15rem 0.35rem",
               cursor: busy ? "wait" : "pointer" }}>
      <option value="">✎ fix…</option>
      {ROLE_CHOICES.filter(r => r !== entry.role).map(r => (
        <option key={r} value={r}>{ROLE_META[r]?.icon} {r}</option>
      ))}
    </select>
  );
}

function RoutingLog() {
  const [log, setLog]                 = useState([]);
  const [corrections, setCorrections] = useState({});
  const [loading, setLoading]         = useState(true);
  const [busyId, setBusyId]           = useState(null);
  const [note, setNote]               = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [logData, corr] = await Promise.all([
        rget("/api/routing-log").catch(() => ({ entries: [] })),
        fetchCorrections(),
      ]);
      setLog(logData.entries || []);
      setCorrections(corr);
    } catch { /* router not running */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const correct = async (entry, role) => {
    setBusyId(entry.id); setNote(null);
    try {
      await postCorrection({ id: entry.id, corrected_role: role });
      setNote({ ok: true, msg: `Corrected → ${role}. This and similar messages now route there.` });
      await refresh();
    } catch (e) {
      setNote({ ok: false, msg: `Correction failed: ${e.message || e}` });
    } finally { setBusyId(null); }
  };

  const undo = async (message) => {
    setNote(null);
    try {
      await undoCorrection(message);
      setNote({ ok: true, msg: "Correction undone." });
      await refresh();
    } catch (e) {
      setNote({ ok: false, msg: `Undo failed: ${e.message || e}` });
    }
  };

  const tierColor = (tier) => ({
    signal:   C.purple,
    keyword:  C.accent2,
    llm:      C.yellow,
    fallback: C.red,
    override: C.green,
    utility:  C.dim,
    quota:    "#f0883e",
  })[tier] || C.dim;

  if (loading) return (
    <div style={{ color: C.dim, fontSize: "0.85rem", padding: "1rem 0" }}>Loading routing log…</div>
  );

  const activeCount = Object.keys(corrections).length;

  return (
    <>
      {note && (
        <div style={{
          background: note.ok ? "rgba(63,185,80,0.1)" : "rgba(248,81,73,0.1)",
          border: `1px solid ${note.ok ? "rgba(63,185,80,0.3)" : "rgba(248,81,73,0.3)"}`,
          borderRadius: "8px", padding: "0.55rem 0.9rem", marginBottom: "0.75rem",
          fontSize: "0.82rem", color: note.ok ? C.green : C.red,
        }}>{note.ok ? "✓" : "✗"} {note.msg}</div>
      )}

      <div style={{ fontSize: "0.8rem", color: C.dim, marginBottom: "0.75rem" }}>
        Wrong route? Use <strong style={{ color: C.text }}>✎ fix…</strong> to teach the router the
        correct role — it applies to that message and similar ones immediately, no restart.
        {activeCount > 0 && (
          <span style={{ marginLeft: "0.35rem" }}>
            <strong style={{ color: C.green }}>{activeCount}</strong> active correction{activeCount === 1 ? "" : "s"}.
          </span>
        )}
      </div>

      {log.length === 0 ? (
        <div style={{ color: C.dim, fontSize: "0.85rem", padding: "1rem 0" }}>
          No routing decisions yet. Send a message in Open WebUI to see routing in action.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.border}` }}>
              {["Time", "Tier", "Role", "Model", "Message", "Fix"].map(h => (
                <th key={h} style={{ padding: "0.4rem 0.6rem", color: C.dim, textAlign: "left",
                                      fontSize: "0.72rem", textTransform: "uppercase",
                                      letterSpacing: "0.04em", fontWeight: 600 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {log.map((entry, i) => {
              const corrected = entry.id ? corrections[normalizeMsg(entry.message)] : null;
              return (
                <tr key={entry.id || i} style={{ borderBottom: `1px solid ${C.border}20` }}>
                  <td style={{ padding: "0.4rem 0.6rem", color: C.dim, whiteSpace: "nowrap" }}>
                    {new Date(entry.ts * 1000).toLocaleTimeString()}
                  </td>
                  <td style={{ padding: "0.4rem 0.6rem" }}>
                    <span style={{
                      fontSize: "0.72rem", fontWeight: 600, color: tierColor(entry.tier),
                      background: `${tierColor(entry.tier)}18`,
                      padding: "0.15rem 0.5rem", borderRadius: "20px",
                    }}>{entry.tier}</span>
                  </td>
                  <td style={{ padding: "0.4rem 0.6rem", fontWeight: 600, color: C.text }}>
                    {ROLE_META[entry.role]?.icon} {entry.role}
                  </td>
                  <td style={{ padding: "0.4rem 0.6rem", fontFamily: "monospace",
                               fontSize: "0.78rem", color: entry.fallback ? C.yellow : C.accent2 }}>
                    {entry.model}
                    {entry.fallback && (
                      <span style={{ marginLeft: "0.4rem", fontSize: "0.67rem", fontWeight: 700,
                                     color: C.yellow, background: `${C.yellow}20`,
                                     padding: "0.1rem 0.4rem", borderRadius: "10px" }}>FB</span>
                    )}
                  </td>
                  <td style={{ padding: "0.4rem 0.6rem", color: C.dim, maxWidth: "280px",
                               overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {entry.message}
                  </td>
                  <td style={{ padding: "0.4rem 0.6rem", whiteSpace: "nowrap" }}>
                    <CorrectionControl
                      entry={entry} corrected={corrected}
                      busy={busyId === entry.id}
                      onCorrect={correct} onUndo={undo}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

// ── Tools panel ───────────────────────────────────────────────────────────────

const ALL_TOOLS = [
  { id: "filesystem",   icon: "📁", label: "Filesystem",   hint: "Read/write local files" },
  { id: "memory",       icon: "🧠", label: "Memory",       hint: "Persistent memory across sessions" },
  { id: "fetch",        icon: "🌐", label: "Fetch",        hint: "Read web pages and URLs" },
  { id: "brave-search", icon: "🦁", label: "Brave Search", hint: "Web search (needs API key)" },
  { id: "github",       icon: "🐙", label: "GitHub",       hint: "Read/write repos (needs token)" },
  { id: "sqlite",       icon: "📦", label: "SQLite",       hint: "Query local .db files" },
  { id: "postgres",     icon: "🗄", label: "PostgreSQL",   hint: "Query Postgres (needs URL)" },
];

function parseRoleTools(yaml) {
  const result = {};
  if (!yaml) return result;
  let curRole = null;
  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const roleM = line.match(/^(\w[\w-]*):\s*(\[.*\])?/);
    if (roleM && !line.startsWith(" ") && !line.startsWith("-")) {
      curRole = roleM[1];
      result[curRole] = roleM[2] ? [] : (result[curRole] || []);
      continue;
    }
    const itemM = line.match(/^\s+-\s+(.+)/);
    if (itemM && curRole) {
      if (!result[curRole]) result[curRole] = [];
      result[curRole].push(itemM[1].trim());
    }
  }
  return result;
}

function serializeRoleTools(roleTools) {
  const ROLE_ORDER = ["reasoning", "code", "fast", "general", "document", "image", "none"];
  const lines = [
    "# LLMSpaghetti — MCP tools enabled per routing role",
    "# Managed by the Routing → Tools panel.",
    "#",
    "# Warning: adding tools to the \"fast\" role increases response latency.",
    "",
  ];
  for (const role of ROLE_ORDER) {
    const tools = roleTools[role] || [];
    if (tools.length === 0) {
      lines.push(`${role}: []`);
    } else {
      lines.push(`${role}:`);
      for (const t of tools) lines.push(`  - ${t}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function ToolsPanel({ roleTools, mcpInstalled, onToolChange, onSave, saving }) {
  const ROLE_ORDER = ["reasoning", "code", "fast", "general", "document", "image", "none"];

  return (
    <div>
      <div style={{ background: "rgba(188,140,255,0.06)", border: "1px solid rgba(188,140,255,0.2)",
                    borderRadius: "8px", padding: "0.75rem 1rem",
                    fontSize: "0.85rem", color: C.dim, marginBottom: "1rem" }}>
        Enabled tools are injected into each request for that role. Install tools first in the{" "}
        <strong style={{ color: C.text }}>Services → MCP Tools</strong> section.
        Uninstalled tools are shown dimmed and cannot be enabled.
      </div>

      {ROLE_ORDER.map(role => {
        const meta    = ROLE_META[role] || { icon: "?", label: role, desc: "" };
        const enabled = roleTools[role] || [];
        const isFast  = role === "fast";

        return (
          <div key={role} style={{ background: C.surface, border: `1px solid ${C.border}`,
                                   borderRadius: "10px", padding: "1rem 1.25rem",
                                   marginBottom: "0.75rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem",
                          marginBottom: "0.75rem" }}>
              <span style={{ fontSize: "1.1rem" }}>{meta.icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: "0.9rem" }}>{meta.label}</div>
                <div style={{ fontSize: "0.74rem", color: C.dim }}>{meta.desc}</div>
              </div>
              {isFast && enabled.length > 0 && (
                <span style={{ fontSize: "0.72rem", color: C.yellow,
                               background: `${C.yellow}18`, padding: "0.15rem 0.5rem",
                               borderRadius: "20px", fontWeight: 600 }}>
                  ⚠ adds latency
                </span>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
                          gap: "0.4rem" }}>
              {ALL_TOOLS.map(tool => {
                const isInstalled = mcpInstalled[tool.id];
                const isEnabled   = enabled.includes(tool.id);
                return (
                  <label key={tool.id} style={{
                    display: "flex", alignItems: "center", gap: "0.5rem",
                    padding: "0.4rem 0.6rem",
                    background: isEnabled ? `${C.accent}12` : "transparent",
                    border: `1px solid ${isEnabled ? C.accent + "40" : C.border + "60"}`,
                    borderRadius: "6px",
                    opacity: isInstalled ? 1 : 0.4,
                    cursor: isInstalled ? "pointer" : "not-allowed",
                    fontSize: "0.8rem",
                  }}>
                    <input
                      type="checkbox"
                      checked={isEnabled}
                      disabled={!isInstalled}
                      onChange={e => onToolChange(role, tool.id, e.target.checked)}
                      style={{ accentColor: C.accent, cursor: isInstalled ? "pointer" : "not-allowed" }}
                    />
                    <span>{tool.icon}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, color: isInstalled ? C.text : C.dim }}>
                        {tool.label}
                      </div>
                      <div style={{ fontSize: "0.68rem", color: C.dim }}>{tool.hint}</div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "0.5rem" }}>
        <button onClick={onSave} disabled={saving} style={{
          display: "flex", alignItems: "center", gap: "0.4rem",
          padding: "0.45rem 1rem", background: C.accent, color: "white",
          border: "none", borderRadius: "6px", fontSize: "0.85rem",
          fontWeight: 600, cursor: saving ? "wait" : "pointer",
        }}>
          {saving
            ? <><div style={{ width: 14, height: 14, border: "2px solid rgba(255,255,255,0.3)",
                              borderTopColor: "white", borderRadius: "50%",
                              animation: "spin 0.7s linear infinite" }} /> Saving…</>
            : "Save"}
        </button>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN ROUTING TAB
// ═════════════════════════════════════════════════════════════════════════════
export default function Routing() {
  const [cfg, setCfg]               = useState({ mode: "auto", single_model: null, roles: {} });
  const [rawYaml, setRawYaml]       = useState("");
  const [availableModels, setAvail] = useState([]);
  const [health, setHealth]         = useState({});
  const [saving, setSaving]         = useState(false);
  const [alert, setAlert]           = useState(null);
  const [view, setView]             = useState("cards"); // cards | yaml | log | tools
  const [roleTools, setRoleTools]   = useState({});
  const [mcpInstalled, setMcpInstalled] = useState({});
  const [toolsSaving, setToolsSaving]   = useState(false);

  useEffect(() => {
    cockpit.file(ROLES_PATH, { superuser: "try" }).read().then(yaml => {
      setRawYaml(yaml || "");
      setCfg(parseConfig(yaml || ""));
    });
    cockpit.file(ROLE_TOOLS_PATH, { superuser: "try" }).read().then(yaml => {
      setRoleTools(parseRoleTools(yaml || ""));
    });
    // Assign roles by REAL model name: raw Ollama models (router forwards these
    // straight to Ollama) + cloud model_names from /v1/models. We filter out the
    // legacy local aliases (local-default / code-local) so you only ever pick a
    // model by its actual downloaded name.
    const LEGACY_ALIASES = new Set(["local-default", "code-local"]);
    Promise.all([
      rget("/v1/models").then(res => (res.data || []).map(m => m.id).filter(Boolean)).catch(() => []),
      run("ollama list 2>/dev/null | tail -n +2 | awk '{print $1}'")
        .then(raw => raw.split("\n").filter(Boolean)).catch(() => []),
    ]).then(([aliases, ollama]) => {
      const seen = new Set(), merged = [];
      for (const m of [...aliases, ...ollama])
        if (m && !seen.has(m) && !LEGACY_ALIASES.has(m)) { seen.add(m); merged.push(m); }
      setAvail(merged);
    });
    // Check which MCP servers are installed
    const MCP_PKGS = {
      filesystem:   "@modelcontextprotocol/server-filesystem",
      memory:       "@modelcontextprotocol/server-memory",
      fetch:        "@modelcontextprotocol/server-fetch",
      "brave-search": "@modelcontextprotocol/server-brave-search",
      github:       "@modelcontextprotocol/server-github",
      sqlite:       "@modelcontextprotocol/server-sqlite",
      postgres:     "@modelcontextprotocol/server-postgres",
    };
    Promise.all(
      Object.entries(MCP_PKGS).map(async ([id, pkg]) => {
        const pkgName = pkg.split("/").pop();
        const out = await run(
          `npm list -g --depth=0 "${pkg}" 2>/dev/null | grep -c "${pkgName}" || echo 0`
        );
        return [id, parseInt(out, 10) > 0];
      })
    ).then(results => setMcpInstalled(Object.fromEntries(results)));
  }, []);

  // Health check — ping all unique models every 15s
  const checkHealth = useCallback(async () => {
    const allModels = new Set();
    for (const entry of Object.values(cfg.roles)) {
      if (entry?.primary)  allModels.add(entry.primary);
      if (entry?.fallback) allModels.add(entry.fallback);
    }
    if (cfg.single_model) allModels.add(cfg.single_model);
    const results = await Promise.all([...allModels].map(async m => [m, await pingModel(m)]));
    setHealth(Object.fromEntries(results));
  }, [cfg]);

  useEffect(() => {
    if (Object.keys(cfg.roles).length || cfg.single_model) {
      checkHealth();
      const t = setInterval(checkHealth, 15000);
      return () => clearInterval(t);
    }
  }, [checkHealth]);

  const handleRoleChange = (role, field, value) => {
    const updated = {
      ...cfg,
      roles: {
        ...cfg.roles,
        [role]: { ...(cfg.roles[role] || { primary: null, fallback: null }), [field]: value },
      },
    };
    setCfg(updated);
    setRawYaml(serializeConfig(updated));
  };

  const handleModeChange = (mode) => {
    const updated = { ...cfg, mode };
    setCfg(updated);
    setRawYaml(serializeConfig(updated));
  };

  const handleSingleModelChange = (model) => {
    const updated = { ...cfg, single_model: model || null };
    setCfg(updated);
    setRawYaml(serializeConfig(updated));
  };

  const handleToolChange = (role, toolId, enabled) => {
    setRoleTools(prev => {
      const current = prev[role] || [];
      const updated  = enabled
        ? [...current.filter(t => t !== toolId), toolId]
        : current.filter(t => t !== toolId);
      return { ...prev, [role]: updated };
    });
  };

  const saveTools = async () => {
    setToolsSaving(true);
    setAlert(null);
    try {
      await cockpit.file(ROLE_TOOLS_PATH, { superuser: "try" }).replace(serializeRoleTools(roleTools));
      setAlert({ type: "ok", msg: "Tool assignments saved — active on the next request" });
    } catch (e) {
      setAlert({ type: "err", msg: `Save failed: ${e.message}` });
    } finally {
      setToolsSaving(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setAlert(null);
    try {
      const yaml = view === "yaml" ? rawYaml : serializeConfig(cfg);
      await cockpit.file(ROLES_PATH, { superuser: "try" }).replace(yaml);
      setAlert({ type: "ok", msg: "Saved — router picks up changes on the next request" });
      setCfg(parseConfig(yaml));
      setRawYaml(yaml);
    } catch (e) {
      setAlert({ type: "err", msg: `Save failed: ${e.message}` });
    } finally {
      setSaving(false);
    }
  };

  const roleOrder = ["image", "code", "reasoning", "fast", "document", "general", "none"];
  const isSingle  = cfg.mode === "single";

  const singleDotColor = () => {
    if (!cfg.single_model) return C.dim;
    const h = health?.[cfg.single_model];
    return h?.status === "ok" ? C.green : h?.status === "unreachable" ? C.red : C.yellow;
  };

  return (
    <div>
      {alert && (
        <div style={{
          background: alert.type === "ok" ? "rgba(63,185,80,0.1)" : "rgba(248,81,73,0.1)",
          border: `1px solid ${alert.type === "ok" ? "rgba(63,185,80,0.3)" : "rgba(248,81,73,0.3)"}`,
          borderRadius: "8px", padding: "0.75rem 1rem", marginBottom: "1rem",
          fontSize: "0.85rem", color: alert.type === "ok" ? C.green : C.red,
        }}>
          {alert.type === "ok" ? "✓" : "✗"} {alert.msg}
        </div>
      )}

      {/* ── Routing Mode toggle ── */}
      <div style={{ background: C.surface, border: `1px solid ${isSingle ? C.yellow + "60" : C.border}`,
                    borderRadius: "10px", padding: "1rem 1.25rem", marginBottom: "1rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.72rem", color: C.dim, fontWeight: 600,
                         textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Routing Mode
          </span>
          {/* Auto button */}
          <button onClick={() => handleModeChange("auto")} style={{
            padding: "0.35rem 0.85rem", borderRadius: "6px", fontWeight: 600,
            fontSize: "0.82rem", cursor: "pointer",
            background: !isSingle ? C.accent : "transparent",
            color:      !isSingle ? "white"  : C.dim,
            border:     !isSingle ? "none"   : `1px solid ${C.border}`,
          }}>🔀 Auto</button>
          {/* Single button */}
          <button onClick={() => handleModeChange("single")} style={{
            padding: "0.35rem 0.85rem", borderRadius: "6px", fontWeight: 600,
            fontSize: "0.82rem", cursor: "pointer",
            background: isSingle ? C.yellow + "20" : "transparent",
            color:      isSingle ? C.yellow          : C.dim,
            border:     `1px solid ${isSingle ? C.yellow + "60" : C.border}`,
          }}>📌 Single model</button>
          {/* Model picker (Single mode only) */}
          {isSingle && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flex: 1, minWidth: "200px" }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%",
                            background: singleDotColor(), flexShrink: 0 }} />
              <select
                value={cfg.single_model || ""}
                onChange={e => handleSingleModelChange(e.target.value)}
                style={{ flex: 1, background: C.bg, border: `1px solid ${C.yellow}60`,
                         borderRadius: "6px", color: C.text, padding: "0.4rem 0.65rem",
                         fontSize: "0.85rem" }}>
                <option value="">— pick a model —</option>
                {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          )}
        </div>
        {isSingle && (
          <div style={{ marginTop: "0.6rem", fontSize: "0.78rem", color: C.yellow }}>
            ⚠ All messages will go to{" "}
            <strong>{cfg.single_model || "the selected model"}</strong> — classification is bypassed.
            Role assignments below are ignored while Single mode is active.
          </div>
        )}
      </div>

      {/* Header + view toggle */}
      <div style={{ display: "flex", justifyContent: "space-between",
                    alignItems: "center", marginBottom: "1rem" }}>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          {[["cards", "Role cards"], ["yaml", "Raw YAML"], ["log", "Routing log"], ["tools", "MCP Tools"]].map(([v, l]) => (
            <button key={v} onClick={() => setView(v)} style={{
              padding: "0.4rem 0.9rem", borderRadius: "6px", fontSize: "0.82rem",
              fontWeight: 600, cursor: "pointer",
              border: view === v ? "none" : `1px solid ${C.border}`,
              background: view === v ? C.accent : "transparent",
              color: view === v ? "white" : C.dim,
            }}>{l}</button>
          ))}
        </div>
        {view !== "log" && view !== "tools" && (
          <button onClick={save} disabled={saving} style={{
            display: "flex", alignItems: "center", gap: "0.4rem",
            padding: "0.45rem 1rem", background: C.accent, color: "white",
            border: "none", borderRadius: "6px", fontSize: "0.85rem",
            fontWeight: 600, cursor: saving ? "wait" : "pointer",
          }}>
            {saving
              ? <><div style={{ width: 14, height: 14,
                                border: "2px solid rgba(255,255,255,0.3)",
                                borderTopColor: "white", borderRadius: "50%",
                                animation: "spin 0.7s linear infinite" }} /> Saving…</>
              : "Save"}
          </button>
        )}
      </div>

      {/* Cards view */}
      {view === "cards" && (
        <>
          <div style={{
            background: "rgba(47,129,247,0.08)", border: "1px solid rgba(47,129,247,0.2)",
            borderRadius: "8px", padding: "0.75rem 1rem",
            fontSize: "0.85rem", color: C.dim, marginBottom: "1rem",
            opacity: isSingle ? 0.4 : 1,
          }}>
            Assign a <strong style={{ color: C.accent2 }}>Primary</strong> model to each role and
            an optional <strong style={{ color: C.yellow }}>Fallback</strong> — used automatically
            if the primary returns a server error or times out.
            Changes take effect on the next request, no restart needed.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem",
                        opacity: isSingle ? 0.4 : 1,
                        pointerEvents: isSingle ? "none" : "auto" }}>
            {roleOrder.map(role => (
              <RoleCard
                key={role}
                role={role}
                entry={cfg.roles[role] || { primary: null, fallback: null }}
                availableModels={availableModels}
                onChange={handleRoleChange}
                health={health}
              />
            ))}
          </div>
        </>
      )}

      {/* Raw YAML view */}
      {view === "yaml" && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`,
                      borderRadius: "10px", padding: "1.25rem" }}>
          <div style={{ fontSize: "0.72rem", color: C.dim, fontWeight: 600,
                        textTransform: "uppercase", letterSpacing: "0.05em",
                        marginBottom: "0.75rem" }}>router_roles.yaml</div>
          <textarea
            value={rawYaml}
            onChange={e => setRawYaml(e.target.value)}
            style={{
              width: "100%", background: C.bg, border: `1px solid ${C.border}`,
              borderRadius: "6px", color: C.text, padding: "0.65rem 0.9rem",
              fontFamily: "monospace", fontSize: "0.82rem",
              minHeight: "320px", lineHeight: 1.6, resize: "vertical",
            }}
          />
        </div>
      )}

      {/* Routing log view */}
      {view === "log" && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`,
                      borderRadius: "10px", padding: "1.25rem" }}>
          <div style={{ fontSize: "0.72rem", color: C.dim, fontWeight: 600,
                        textTransform: "uppercase", letterSpacing: "0.05em",
                        marginBottom: "0.75rem" }}>
            Live routing decisions (last 50 · auto-refreshes every 3s)
          </div>
          <RoutingLog />
        </div>
      )}

      {/* MCP Tools view */}
      {view === "tools" && (
        <ToolsPanel
          roleTools={roleTools}
          mcpInstalled={mcpInstalled}
          onToolChange={handleToolChange}
          onSave={saveTools}
          saving={toolsSaving}
        />
      )}
    </div>
  );
}
