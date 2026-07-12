/**
 * LLMSpaghetti Cockpit Plugin
 * A React app embedded in Cockpit that provides:
 *   Dashboard   — service health, GPU stats, quick actions
 *   Models      — browse, pull, delete local Ollama models
 *   API Gateway — LiteLLM route editor, API key management
 *   Terminal    — embedded ttyd terminal (llmspaghetti user)
 *   Power Shell — link to Cockpit's own terminal (root capable)
 *
 * Build: webpack --config webpack.config.js
 * Install: cp -r dist/ /usr/share/cockpit/llmspaghetti/
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import Dashboard from "./tabs/Dashboard.jsx";
import Models    from "./tabs/Models.jsx";
import Routing   from "./tabs/Routing.jsx";
import ImageGen  from "./tabs/ImageGen.jsx";
import Downloads from "./tabs/Downloads.jsx";
import Nodes     from "./tabs/Nodes.jsx";
import Services  from "./tabs/Services.jsx";

// ── Cockpit API (available in Cockpit context) ────────────────────────────────
const cockpit = window.cockpit || {
  spawn:   (cmd, opts) => ({ stream: () => {}, then: () => {}, catch: () => {} }),
  file:    (path)      => ({ read: () => Promise.resolve(""), replace: () => Promise.resolve() }),
  http:    ()          => ({ get: () => Promise.resolve("{}"), request: () => Promise.resolve("{}") }),
};

// Router API via Cockpit's server-side bridge (not browser fetch — the router
// binds 127.0.0.1:5000 on the server, unreachable from a remote browser and
// CORS-blocked even locally).
const ROUTER_PORT = 5000;
const rget = (path) =>
  cockpit.http(ROUTER_PORT).get(path).then(b => JSON.parse(b || "{}"));
const rrequest = (method, path) =>
  cockpit.http(ROUTER_PORT).request({ method, path });

// ── Helpers ───────────────────────────────────────────────────────────────────
// cockpit.spawn has a minimal PATH without /usr/local/bin (ollama), so prepend one.
const PATHFIX = "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; ";
const run = (cmd) => new Promise((res, rej) => {
  let out = "";
  const proc = cockpit.spawn(["bash", "-c", PATHFIX + cmd], { superuser: "try", err: "message" });
  proc.stream(data => { out += data; });
  proc.then(() => res(out.trim())).catch(rej);
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Colour tokens (matching LLMSpaghetti dark theme) ─────────────────────────────────
const C = {
  bg:       "#0d1117",
  surface:  "#161b22",
  border:   "#30363d",
  accent:   "#2f81f7",
  accent2:  "#58a6ff",
  green:    "#3fb950",
  yellow:   "#d29922",
  red:      "#f85149",
  text:     "#e6edf3",
  dim:      "#8b949e",
  purple:   "#bc8cff",
};

// ── Global styles injected once ───────────────────────────────────────────────
const STYLES = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: ${C.bg}; color: ${C.text};
         font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track  { background: ${C.bg}; }
  ::-webkit-scrollbar-thumb  { background: ${C.border}; border-radius: 3px; }

  .llmspaghetti-app { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

  /* Nav */
  .nav { display: flex; align-items: center; gap: 0;
         background: ${C.surface}; border-bottom: 1px solid ${C.border};
         padding: 0 1.5rem; height: 52px; flex-shrink: 0; }
  .nav-logo { font-size: 1.1rem; font-weight: 800; letter-spacing: 0.12em;
              color: ${C.accent2}; margin-right: 2rem; }
  .nav-tab { padding: 0 1rem; height: 52px; display: flex; align-items: center;
             color: ${C.dim}; font-size: 0.88rem; font-weight: 500;
             cursor: pointer; border-bottom: 2px solid transparent;
             transition: color 0.15s, border-color 0.15s; white-space: nowrap; }
  .nav-tab:hover   { color: ${C.text}; }
  .nav-tab.active  { color: ${C.accent2}; border-bottom-color: ${C.accent}; }
  .nav-spacer      { flex: 1; }
  .nav-status-dot  { width: 8px; height: 8px; border-radius: 50%;
                     background: ${C.green}; margin-right: 0.5rem; }

  /* Content */
  .content { flex: 1; overflow-y: auto; padding: 1.5rem; }
  .content.no-pad { padding: 0; overflow: hidden; }

  /* Cards */
  .card { background: ${C.surface}; border: 1px solid ${C.border};
          border-radius: 10px; padding: 1.25rem 1.5rem; margin-bottom: 1rem; }
  .card-title { font-size: 0.78rem; font-weight: 600; color: ${C.dim};
                text-transform: uppercase; letter-spacing: 0.06em;
                margin-bottom: 1rem; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
  .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; }

  /* Stat tiles */
  .stat { }
  .stat-value { font-size: 1.6rem; font-weight: 700; color: ${C.text}; line-height: 1; }
  .stat-label { font-size: 0.78rem; color: ${C.dim}; margin-top: 0.3rem; }

  /* Buttons */
  .btn { display: inline-flex; align-items: center; gap: 0.4rem;
         padding: 0.45rem 1rem; border-radius: 6px; font-size: 0.85rem;
         font-weight: 600; cursor: pointer; border: none;
         transition: opacity 0.15s, transform 0.1s; text-decoration: none; }
  .btn:active { transform: scale(0.96); }
  .btn-primary { background: ${C.accent}; color: white; }
  .btn-primary:hover { opacity: 0.85; }
  .btn-ghost { background: transparent; border: 1px solid ${C.border}; color: ${C.text}; }
  .btn-ghost:hover { border-color: ${C.accent2}; color: ${C.accent2}; }
  .btn-danger { background: rgba(248,81,73,0.15); color: ${C.red};
                border: 1px solid rgba(248,81,73,0.3); }
  .btn-danger:hover { background: rgba(248,81,73,0.25); }
  .btn-sm { padding: 0.3rem 0.7rem; font-size: 0.78rem; }

  /* Badge / dot */
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .dot-green  { background: ${C.green}; }
  .dot-yellow { background: ${C.yellow}; }
  .dot-red    { background: ${C.red}; }
  .dot-grey   { background: ${C.dim}; }

  .badge { display: inline-flex; align-items: center; gap: 0.35rem;
           padding: 0.2rem 0.6rem; border-radius: 20px; font-size: 0.75rem; font-weight: 600; }
  .badge-green  { background: rgba(63,185,80,0.12);  color: ${C.green}; }
  .badge-yellow { background: rgba(210,153,34,0.15); color: ${C.yellow}; }
  .badge-red    { background: rgba(248,81,73,0.12);  color: ${C.red}; }
  .badge-blue   { background: rgba(47,129,247,0.12); color: ${C.accent2}; }
  .badge-grey   { background: rgba(139,148,158,0.15);color: ${C.dim}; }

  /* Progress bar */
  .bar-track { background: ${C.border}; border-radius: 3px; height: 6px; overflow: hidden; }
  .bar-fill  { height: 100%; border-radius: 3px; transition: width 0.4s; }
  .bar-green  { background: ${C.green}; }
  .bar-yellow { background: ${C.yellow}; }
  .bar-red    { background: ${C.red}; }
  .bar-blue   { background: ${C.accent}; }

  /* Table */
  .tbl { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  .tbl th { color: ${C.dim}; font-size: 0.75rem; text-transform: uppercase;
             letter-spacing: 0.05em; padding: 0.5rem 0.75rem;
             border-bottom: 1px solid ${C.border}; text-align: left; font-weight: 600; }
  .tbl td { padding: 0.65rem 0.75rem; border-bottom: 1px solid ${C.border}; }
  .tbl tr:last-child td { border-bottom: none; }
  .tbl tr:hover td { background: rgba(255,255,255,0.02); }

  /* Forms */
  input[type=text], input[type=password], textarea, select {
    width: 100%; background: ${C.bg}; border: 1px solid ${C.border};
    border-radius: 6px; color: ${C.text}; padding: 0.5rem 0.75rem;
    font-size: 0.88rem; outline: none; }
  input:focus, textarea:focus, select:focus { border-color: ${C.accent}; }
  textarea { resize: vertical; min-height: 120px; font-family: monospace; }
  label { display: block; font-size: 0.82rem; font-weight: 600;
          color: ${C.dim}; margin-bottom: 0.35rem; }
  .field { margin-bottom: 1rem; }
  .hint  { font-size: 0.76rem; color: ${C.dim}; margin-top: 0.25rem; }

  /* Terminal frame */
  .terminal-frame { width: 100%; height: 100%; border: none; display: block; }
  .terminal-wrap  { display: flex; flex-direction: column; height: 100%; }
  .terminal-bar   { display: flex; align-items: center; gap: 0.75rem;
                    background: ${C.surface}; border-bottom: 1px solid ${C.border};
                    padding: 0.5rem 1rem; font-size: 0.82rem; flex-shrink: 0; }
  .terminal-dot   { width: 12px; height: 12px; border-radius: 50%; }

  /* Spinner */
  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner { width: 18px; height: 18px; border: 2px solid ${C.border};
             border-top-color: ${C.accent}; border-radius: 50%;
             animation: spin 0.7s linear infinite; display: inline-block; }

  /* Code block */
  .code { background: ${C.bg}; border: 1px solid ${C.border}; border-radius: 6px;
          padding: 0.75rem 1rem; font-family: 'JetBrains Mono', 'Fira Code', monospace;
          font-size: 0.82rem; color: ${C.accent2}; word-break: break-all; }

  /* Info box */
  .info-box { background: rgba(47,129,247,0.08); border: 1px solid rgba(47,129,247,0.2);
              border-radius: 8px; padding: 0.75rem 1rem; font-size: 0.85rem;
              color: ${C.dim}; line-height: 1.5; margin-bottom: 1rem; }

  /* Alert */
  .alert { border-radius: 8px; padding: 0.75rem 1rem; font-size: 0.85rem;
           margin-bottom: 1rem; display: flex; align-items: flex-start; gap: 0.6rem; }
  .alert-warn { background: rgba(210,153,34,0.1); border: 1px solid rgba(210,153,34,0.25);
                color: ${C.yellow}; }
  .alert-err  { background: rgba(248,81,73,0.1); border: 1px solid rgba(248,81,73,0.25);
                color: ${C.red}; }
  .alert-ok   { background: rgba(63,185,80,0.1); border: 1px solid rgba(63,185,80,0.25);
                color: ${C.green}; }

  @media (max-width: 768px) {
    .grid-2, .grid-3, .grid-4 { grid-template-columns: 1fr; }
    .content { padding: 1rem; }
  }
`;

// ── Shared bar component ──────────────────────────────────────────────────────
function Bar({ value, max = 100, width = "100%" }) {
  const pct = max === 0 ? 0 : Math.min(100, (value / max) * 100);
  const cls = pct > 85 ? "bar-red" : pct > 65 ? "bar-yellow" : "bar-green";
  return (
    <div className="bar-track" style={{ width }}>
      <div className={`bar-fill ${cls}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ── Status badge ──────────────────────────────────────────────────────────────
function StatusBadge({ state }) {
  const map = {
    running:  ["badge-green",  "● running"],
    active:   ["badge-green",  "● active"],
    starting: ["badge-yellow", "◐ starting"],
    stopping: ["badge-yellow", "◑ stopping"],
    stopped:  ["badge-grey",   "○ stopped"],
    inactive: ["badge-grey",   "○ inactive"],
    failed:   ["badge-red",    "✗ failed"],
  };
  const [cls, label] = map[state] || ["badge-grey", `? ${state}`];
  return <span className={`badge ${cls}`}>{label}</span>;
}


// ── Quota panel (used inside Gateway tab) ────────────────────────────────────
function QuotaPanel() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setData(await rget("/api/quota-status"));
    } catch { /* router not running */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, [refresh]);

  const resetModel = async (model) => {
    setResetting(model);
    try {
      await rrequest("DELETE",
        `/api/quota-reset${model ? `?model=${encodeURIComponent(model)}` : ""}`);
      await refresh();
    } finally { setResetting(null); }
  };

  const statusColour = (s) =>
    s === "blocked" ? C.red : s === "warn" ? C.yellow : C.green;

  if (loading) return (
    <div style={{ color: C.dim, fontSize: "0.85rem" }}>Loading quota status…</div>
  );
  if (!data) return (
    <div style={{ color: C.dim, fontSize: "0.85rem" }}>Router not reachable — start the stack first.</div>
  );

  const models = Object.entries(data.models || {});

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between",
                    alignItems: "center", marginBottom: "0.75rem" }}>
        <div style={{ fontSize: "0.72rem", color: C.dim }}>
          Resets <strong>{data.reset || "daily"}</strong> at midnight UTC
          {data.date && ` · today: ${data.date}`}
        </div>
        <button
          onClick={() => resetModel("")}
          disabled={!!resetting}
          style={{ fontSize: "0.72rem", color: C.dim, background: "transparent",
                   border: `1px solid ${C.border}`, borderRadius: "5px",
                   padding: "0.25rem 0.6rem", cursor: "pointer" }}>
          Reset all
        </button>
      </div>

      {models.length === 0 ? (
        <div style={{ color: C.dim, fontSize: "0.85rem" }}>
          No quotas configured. Edit <code>config/quotas.yaml</code> to add limits.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.65rem" }}>
          {models.map(([model, info]) => {
            const pct = info.pct || 0;
            const barColour = statusColour(info.status);
            return (
              <div key={model}>
                <div style={{ display: "flex", justifyContent: "space-between",
                              alignItems: "center", marginBottom: "0.25rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span style={{ fontFamily: "monospace", fontSize: "0.82rem",
                                   color: C.accent2 }}>{model}</span>
                    <span style={{ fontSize: "0.7rem", fontWeight: 700,
                                   color: barColour, background: `${barColour}18`,
                                   padding: "0.1rem 0.4rem", borderRadius: "10px" }}>
                      {info.status}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                    <span style={{ fontSize: "0.75rem", color: C.dim }}>
                      {info.count} / {info.limit ?? "∞"}
                    </span>
                    <button
                      onClick={() => resetModel(model)}
                      disabled={resetting === model}
                      style={{ fontSize: "0.68rem", color: C.dim, background: "transparent",
                               border: `1px solid ${C.border}30`, borderRadius: "4px",
                               padding: "0.15rem 0.45rem", cursor: "pointer" }}>
                      ↺
                    </button>
                  </div>
                </div>
                <div style={{ background: C.border, borderRadius: "3px",
                              height: 5, overflow: "hidden" }}>
                  <div style={{ width: `${Math.min(pct, 100)}%`, height: "100%",
                                background: barColour,
                                transition: "width 0.4s, background 0.4s",
                                borderRadius: "3px" }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// TAB: API GATEWAY
// ═════════════════════════════════════════════════════════════════════════════
function Gateway() {
  const CONFIG_PATH = "/opt/llmspaghetti/config/litellm_config.yaml";
  const KEY_PATH    = "/opt/llmspaghetti/config/master_key";

  const [config, setConfig]   = useState("");
  const [key, setKey]         = useState("");
  const [saving, setSaving]   = useState(false);
  const [alert, setAlert]     = useState(null);
  const [routes, setRoutes]   = useState([]);

  useEffect(() => {
    cockpit.file(CONFIG_PATH, { superuser: "try" }).read().then(setConfig);
    cockpit.file(KEY_PATH, { superuser: "try" }).read().then(k => setKey(k?.trim() || ""));
  }, []);

  // Parse model_name entries from yaml for quick display
  useEffect(() => {
    const matches = [...(config.matchAll(/model_name:\s*(.+)/g))];
    setRoutes(matches.map(m => m[1].trim()));
  }, [config]);

  const save = async () => {
    setSaving(true);
    setAlert(null);
    try {
      await cockpit.file(CONFIG_PATH, { superuser: "try" }).replace(config);
      await run("docker restart llmspaghetti-litellm");
      setAlert({ type: "ok", msg: "Config saved — LiteLLM restarted" });
    } catch (e) {
      setAlert({ type: "err", msg: `Save failed: ${e.message}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {alert && (
        <div className={`alert alert-${alert.type}`}>
          {alert.type === "ok" ? "✓" : "✗"} {alert.msg}
        </div>
      )}

      {/* API Key */}
      <div className="card">
        <div className="card-title">API Master Key</div>
        <div className="info-box">
          Use this key in your IDE or CLI. Point it at <code>http://your-server/api/v1</code>.
        </div>
        <div className="code">{key || "not found"}</div>
        <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem" }}>
          <button className="btn btn-ghost btn-sm"
            onClick={() => navigator.clipboard.writeText(key)}>Copy key</button>
          <button className="btn btn-ghost btn-sm"
            onClick={() => navigator.clipboard.writeText("http://localhost/api/v1")}>Copy URL</button>
        </div>
      </div>

      {/* Quick route summary */}
      <div className="card">
        <div className="card-title">Active routes ({routes.length})</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          {routes.length === 0
            ? <span style={{ color: C.dim, fontSize: "0.85rem" }}>No routes parsed</span>
            : routes.map(r => (
              <span key={r} className="badge badge-blue">{r}</span>
            ))}
        </div>
      </div>

      {/* Quota usage */}
      <div className="card">
        <div className="card-title">Request Quotas</div>
        <QuotaPanel />
      </div>

      {/* Config editor */}
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between",
                      alignItems: "center", marginBottom: "0.75rem" }}>
          <div className="card-title" style={{ marginBottom: 0 }}>litellm_config.yaml</div>
          <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
            {saving ? <><div className="spinner" /> Saving…</> : "Save & restart"}
          </button>
        </div>
        <textarea
          value={config}
          onChange={e => setConfig(e.target.value)}
          style={{ fontFamily: "monospace", fontSize: "0.82rem",
                   minHeight: "420px", lineHeight: 1.5 }}
        />
        <div className="hint" style={{ marginTop: "0.4rem" }}>
          Full LiteLLM config docs: <a href="https://docs.litellm.ai/docs/proxy/configs"
            target="_blank" rel="noreferrer" style={{ color: C.accent2 }}>
            docs.litellm.ai/docs/proxy/configs</a>
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// TAB: TERMINAL (embedded ttyd)
// ═════════════════════════════════════════════════════════════════════════════
function Terminal() {
  const [ip, setIp] = useState("");

  useEffect(() => {
    run("hostname -I | awk '{print $1}'").then(v => v && setIp(v));
  }, []);

  // Can't embed the terminal: ttyd is proxied on :80 while Cockpit serves this
  // page on :9090 — a different origin (and http↔https), so the browser blocks
  // the iframe (X-Frame-Options / CSP / mixed content). Launch it instead.
  const ttyUrl     = ip ? `http://${ip}/terminal/` : null;
  const cockpitUrl = "/system/terminal";

  const btn = (primary) => ({
    display: "inline-flex", alignItems: "center", gap: "0.4rem",
    padding: "0.6rem 1.1rem", borderRadius: "8px", fontSize: "0.9rem",
    fontWeight: 600, textDecoration: "none", cursor: "pointer",
    background: primary ? C.accent : "transparent",
    color: primary ? "white" : C.text,
    border: primary ? "none" : `1px solid ${C.border}`,
  });

  return (
    <div style={{ maxWidth: 620, margin: "3rem auto", textAlign: "center",
                  padding: "0 1.5rem" }}>
      <div style={{ fontSize: "2.2rem", fontWeight: 800, color: C.accent2,
                    letterSpacing: "0.1em", marginBottom: "0.5rem" }}>＞_</div>
      <div style={{ fontSize: "1.15rem", fontWeight: 700, color: C.text,
                    marginBottom: "0.6rem" }}>Terminal</div>
      <p style={{ color: C.dim, fontSize: "0.9rem", lineHeight: 1.6,
                  marginBottom: "1.5rem" }}>
        Cockpit sandboxes plugin pages, so the terminal opens in its own tab
        rather than embedded here.
      </p>
      <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center",
                    flexWrap: "wrap" }}>
        <a href={ttyUrl || "#"} target="_blank" rel="noreferrer"
           style={{ ...btn(true), opacity: ttyUrl ? 1 : 0.5,
                    pointerEvents: ttyUrl ? "auto" : "none" }}>
          Open web terminal ↗
        </a>
        <a href={cockpitUrl} target="_blank" rel="noreferrer" style={btn(false)}>
          Open Cockpit terminal (root) ↗
        </a>
      </div>
      <div style={{ marginTop: "1.75rem", fontSize: "0.78rem", color: C.dim }}>
        Web terminal (ttyd) runs as{" "}
        <strong style={{ color: C.text }}>llmspaghetti</strong>
        {ip && <> at <span style={{ fontFamily: "monospace" }}>{ip}</span></>} ·
        the Cockpit terminal can elevate to root.
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// TAB: SETTINGS
// ═════════════════════════════════════════════════════════════════════════════
const API_KEYS_PATH = "/opt/llmspaghetti/config/api_keys.env";

// Explicit input styling — the global stylesheet's `input{}` rule collides with
// Cockpit's CSS, so style inline: dark infill matching the rest of the UI,
// readable light text, and a touch larger.
const SETTINGS_INPUT_STYLE = {
  width: "100%", background: C.bg, border: `1px solid ${C.border}`,
  borderRadius: "6px", color: C.text, padding: "0.6rem 0.85rem",
  fontSize: "0.9rem", outline: "none",
};

const API_KEY_FIELDS = [
  { key: "OPENAI_API_KEY",     label: "OpenAI API Key",     hint: "Enables GPT-4o, DALL-E 3, and other OpenAI models" },
  { key: "ANTHROPIC_API_KEY",  label: "Anthropic API Key",  hint: "Enables Claude Sonnet, Claude Opus" },
  { key: "GROQ_API_KEY",       label: "Groq API Key",       hint: "Enables Groq (ultra-fast inference — llama3, mixtral)" },
  { key: "CEREBRAS_API_KEY",   label: "Cerebras API Key",   hint: "Enables Cerebras (ultra-fast cloud Llama — free tier at cloud.cerebras.ai)" },
  { key: "COHERE_API_KEY",     label: "Cohere API Key",     hint: "Enables Cohere Command models" },
  { key: "GEMINI_API_KEY",     label: "Google Gemini Key",  hint: "Enables Gemini Pro / Flash" },
  { key: "BRAVE_API_KEY",      label: "Brave Search Key",   hint: "Used by the Brave Search MCP tool" },
  { key: "GITHUB_PERSONAL_ACCESS_TOKEN", label: "GitHub Token", hint: "Used by the GitHub MCP tool" },
  { key: "HF_TOKEN",           label: "HuggingFace Token",  hint: "Optional — unlocks gated/private models (Flux.1-dev, etc.) for downloads. Get one at huggingface.co/settings/tokens" },
];

function parseEnvFile(raw) {
  const result = {};
  for (const line of (raw || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    result[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, "");
  }
  return result;
}

function serializeEnvFile(keys) {
  const lines = ["# LLMSpaghetti — API keys", "# Managed by Settings tab.", ""];
  for (const [k, v] of Object.entries(keys)) {
    if (v) lines.push(`${k}=${v}`);
  }
  return lines.join("\n") + "\n";
}

function Settings() {
  const [hostname, setHostname]   = useState("");
  const [timezone, setTimezone]   = useState("");
  const [apiKeys, setApiKeys]     = useState({});
  const [showKey, setShowKey]     = useState({});
  const [saving, setSaving]       = useState(false);
  const [updating, setUpdating]   = useState(false);
  const [updateLog, setUpdateLog] = useState("");
  const [alert, setAlert]         = useState(null);

  useEffect(() => {
    run("hostname").then(setHostname);
    run("timedatectl show -p Timezone --value").then(setTimezone);
    cockpit.file(API_KEYS_PATH, { superuser: "try" }).read().then(raw => {
      setApiKeys(parseEnvFile(raw || ""));
    }).catch(() => {});
  }, []);

  const saveSystem = async () => {
    setSaving(true);
    setAlert(null);
    try {
      if (hostname) await run(`hostnamectl set-hostname "${hostname}"`);
      if (timezone) await run(`timedatectl set-timezone "${timezone}"`);
      setAlert({ type: "ok", msg: "System settings saved" });
    } catch (e) {
      setAlert({ type: "err", msg: String(e) });
    } finally {
      setSaving(false);
    }
  };

  const saveApiKeys = async () => {
    setSaving(true);
    setAlert(null);
    try {
      await cockpit.file(API_KEYS_PATH, { superuser: "try" }).replace(serializeEnvFile(apiKeys));
      // Restart router + LiteLLM so both pick up new keys from env_file
      await run(
        "docker restart llmspaghetti-litellm llmspaghetti-router 2>&1 || " +
        "docker compose -f /opt/llmspaghetti/docker-compose.yml up -d litellm router 2>&1 || true"
      );
      setAlert({ type: "ok", msg: "API keys saved — LiteLLM and router restarted" });
    } catch (e) {
      setAlert({ type: "err", msg: String(e) });
    } finally {
      setSaving(false);
    }
  };

  const runUpdate = async () => {
    setUpdating(true);
    setUpdateLog("");
    setAlert(null);
    const append = (line) => setUpdateLog(prev => prev + line);
    try {
      append("▸ Updating system packages…\n");
      await run("apt-get update -qq && apt-get upgrade -y 2>&1 | tail -5").then(append);
      append("\n▸ Updating Ollama…\n");
      await run("curl -fsSL https://ollama.com/install.sh | sh 2>&1 | tail -3").then(append);
      append("\n▸ Updating Python dependencies…\n");
      await run(
        "/opt/llmspaghetti/.venv/bin/pip install -q --upgrade fastapi uvicorn jinja2 python-multipart httpx pyyaml 2>&1 | tail -3"
      ).then(append);
      append("\n▸ Pulling latest stack images…\n");
      await run(
        "docker compose -f /opt/llmspaghetti/docker-compose.yml pull 2>&1 | tail -10"
      ).then(append);
      append("\n▸ Restarting stack…\n");
      await run(
        "docker compose -f /opt/llmspaghetti/docker-compose.yml up -d 2>&1 | tail -5"
      ).then(append);
      append("\n✓ Update complete\n");
      setAlert({ type: "ok", msg: "Update complete" });
    } catch (e) {
      append(`\n✗ ${e}\n`);
      setAlert({ type: "err", msg: String(e) });
    } finally {
      setUpdating(false);
    }
  };

  const setKey = (k) => (e) =>
    setApiKeys(prev => ({ ...prev, [k]: e.target.value }));

  const toggleShow = (k) =>
    setShowKey(prev => ({ ...prev, [k]: !prev[k] }));

  return (
    <div>
      {alert && (
        <div className={`alert alert-${alert.type}`}>
          {alert.type === "ok" ? "✓" : "✗"} {alert.msg}
        </div>
      )}

      {/* API keys */}
      <div className="card">
        <div className="card-title">API Keys — cloud providers</div>
        <p style={{ fontSize: "0.85rem", color: C.dim, marginBottom: "1rem", lineHeight: 1.5 }}>
          Keys are stored in <code style={{ color: C.accent2 }}>{API_KEYS_PATH}</code>.
          Only enter keys for providers you use — local Ollama models need no keys.
        </p>
        {API_KEY_FIELDS.map(({ key, label, hint }) => (
          <div className="field" key={key}>
            <label>{label}</label>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <input
                type={showKey[key] ? "text" : "password"}
                value={apiKeys[key] || ""}
                onChange={setKey(key)}
                placeholder={`${key}=…`}
                style={{ ...SETTINGS_INPUT_STYLE, flex: 1 }}
              />
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => toggleShow(key)}
                style={{ flexShrink: 0 }}>
                {showKey[key] ? "Hide" : "Show"}
              </button>
            </div>
            <div className="hint">{hint}</div>
          </div>
        ))}
        <button className="btn btn-primary" onClick={saveApiKeys} disabled={saving}>
          {saving ? <><div className="spinner" /> Saving…</> : "Save keys"}
        </button>
      </div>

      {/* System */}
      <div className="card">
        <div className="card-title">System</div>
        <div className="grid-2">
          <div className="field">
            <label>Hostname</label>
            <input type="text" value={hostname}
              onChange={e => setHostname(e.target.value)}
              style={SETTINGS_INPUT_STYLE} />
          </div>
          <div className="field">
            <label>Timezone</label>
            <input type="text" value={timezone}
              onChange={e => setTimezone(e.target.value)}
              placeholder="e.g. Europe/Oslo"
              style={SETTINGS_INPUT_STYLE} />
            <div className="hint">Run <code>timedatectl list-timezones</code> to list options</div>
          </div>
        </div>
        <button className="btn btn-primary" onClick={saveSystem} disabled={saving}>
          {saving ? <><div className="spinner" /> Saving…</> : "Save"}
        </button>
      </div>

      {/* Updates */}
      <div className="card">
        <div className="card-title">Update</div>
        <p style={{ fontSize: "0.88rem", color: C.dim, marginBottom: "1rem" }}>
          Updates system packages, Ollama, and Docker images. Models and config are preserved.
          This may take a few minutes.
        </p>
        <button className="btn btn-primary" onClick={runUpdate} disabled={updating}>
          {updating ? <><div className="spinner" /> Updating…</> : "↑ Update everything"}
        </button>
        {updateLog && (
          <pre style={{
            marginTop: "1rem", background: C.bg, border: `1px solid ${C.border}`,
            borderRadius: "6px", padding: "0.75rem 1rem", fontSize: "0.78rem",
            color: C.dim, maxHeight: "220px", overflow: "auto",
            fontFamily: "monospace", whiteSpace: "pre-wrap",
          }}>{updateLog}</pre>
        )}
      </div>

      {/* Links */}
      <div className="card">
        <div className="card-title">External links</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          <a className="btn btn-ghost" href="https://ollama.com/library"
            target="_blank" rel="noreferrer">Ollama model library ↗</a>
          <a className="btn btn-ghost" href="https://docs.litellm.ai/docs/proxy/configs"
            target="_blank" rel="noreferrer">LiteLLM docs ↗</a>
          <a className="btn btn-ghost" href="https://github.com/open-webui/open-webui"
            target="_blank" rel="noreferrer">Open WebUI GitHub ↗</a>
          <a className="btn btn-ghost" href="https://github.com/llmspaghetti/llmspaghetti"
            target="_blank" rel="noreferrer">LLMSpaghetti GitHub ↗</a>
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// ROOT APP
// ═════════════════════════════════════════════════════════════════════════════
const TABS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "models",    label: "Models" },
  { id: "routing",   label: "Routing" },
  { id: "imagegen",  label: "🖼 Image" },
  { id: "downloads", label: "↓ Downloads" },
  { id: "gateway",   label: "API Gateway" },
  { id: "services",  label: "Services" },
  { id: "nodes",     label: "Nodes" },
  { id: "terminal",  label: "＞_ Terminal" },
  { id: "settings",  label: "Settings" },
];

function App() {
  const [tab, setTab] = useState("dashboard");

  // Inject global styles once
  useEffect(() => {
    const el = document.createElement("style");
    el.textContent = STYLES;
    document.head.appendChild(el);
    return () => el.remove();
  }, []);

  const isTerminal = tab === "terminal";

  return (
    <div className="llmspaghetti-app"
      style={{ background: C.bg, color: C.text, minHeight: "100vh" }}>
      {/* Navigation — inline styles so the dark theme holds regardless of
          Cockpit's bundled CSS (generic classes like .nav/.card/.btn collide). */}
      <nav style={{ display: "flex", alignItems: "center", background: C.surface,
                    borderBottom: `1px solid ${C.border}`, padding: "0 1.5rem",
                    height: 52, flexShrink: 0 }}>
        <span style={{ fontSize: "1.1rem", fontWeight: 800, letterSpacing: "0.12em",
                       color: C.accent2, marginRight: "2rem" }}>LLMSpaghetti</span>
        {TABS.map(t => {
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              style={{ height: 52, padding: "0 1rem", background: "transparent",
                       border: "none",
                       borderBottom: `2px solid ${active ? C.accent : "transparent"}`,
                       color: active ? C.accent2 : C.dim, fontSize: "0.88rem",
                       fontWeight: active ? 700 : 500, cursor: "pointer",
                       whiteSpace: "nowrap" }}>
              {t.label}
            </button>
          );
        })}
        <span style={{ flex: 1 }} />
        <span style={{ width: 8, height: 8, borderRadius: "50%",
                       background: C.green, marginRight: "0.5rem" }} />
        <span style={{ fontSize: "0.78rem", color: C.dim }}>live</span>
      </nav>

      {/* Content */}
      <div className={`content ${isTerminal ? "no-pad" : ""}`}>
        {tab === "dashboard" && <Dashboard onTabChange={setTab} />}
        {tab === "models"    && <Models />}
        {tab === "routing"   && <Routing />}
        {tab === "imagegen"  && <ImageGen />}
        {tab === "downloads" && <Downloads />}
        {tab === "gateway"   && <Gateway />}
        {tab === "services"  && <Services />}
        {tab === "nodes"     && <Nodes />}
        {tab === "terminal"  && <Terminal />}
        {tab === "settings"  && <Settings />}
      </div>
    </div>
  );
}

// Mount
const root = createRoot(document.getElementById("root"));
root.render(<App />);
