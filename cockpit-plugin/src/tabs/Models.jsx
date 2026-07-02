/**
 * LLMSpaghetti Models Tab — Phase 3
 * - VRAM budget bar (live, updates as models load/unload)
 * - Load / Stop / Eject per installed model
 * - Per-model config panel (system prompt, temperature, top-p, top-k, etc.)
 * - Modelfile snapshot → Restore defaults
 * - Pull new models + library browser
 */

import React, { useState, useEffect, useCallback, useRef } from "react";

const cockpit = window.cockpit || {
  spawn: (cmd, opts) => ({ stream: () => {}, then: (f) => { f(""); return { catch: () => {} }; }, catch: () => {} }),
  file: (p) => ({ read: () => Promise.resolve(""), replace: () => Promise.resolve() }),
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

const SNAPSHOTS_DIR = "/opt/llmspaghetti/config/modelfiles";

const POPULAR_MODELS = [
  { id: "llama3:8b",           name: "Llama 3 8B",           size: "4.7GB",  tag: "general", desc: "Meta's best small model" },
  { id: "llama3:70b",          name: "Llama 3 70B",          size: "40GB",   tag: "large",   desc: "Best quality, needs 40GB+ VRAM" },
  { id: "mistral:7b",          name: "Mistral 7B",           size: "4.1GB",  tag: "general", desc: "Fast and capable" },
  { id: "mixtral:8x7b",        name: "Mixtral 8×7B",         size: "26GB",   tag: "large",   desc: "MoE, great all-rounder" },
  { id: "deepseek-coder:6.7b", name: "DeepSeek Coder 6.7B",  size: "3.8GB",  tag: "code",    desc: "Excellent for coding" },
  { id: "codellama:13b",       name: "CodeLlama 13B",        size: "7.4GB",  tag: "code",    desc: "Meta's coding model" },
  { id: "codellama:34b",       name: "CodeLlama 34B",        size: "19GB",   tag: "code",    desc: "Best coding, needs VRAM" },
  { id: "phi3:mini",           name: "Phi-3 Mini",           size: "2.3GB",  tag: "small",   desc: "Tiny but smart, great on CPU" },
  { id: "gemma:2b",            name: "Gemma 2B",             size: "1.4GB",  tag: "small",   desc: "Smallest usable model" },
  { id: "gemma:7b",            name: "Gemma 7B",             size: "4.8GB",  tag: "general", desc: "Google's capable 7B" },
  { id: "qwen2:7b",            name: "Qwen 2 7B",            size: "4.4GB",  tag: "general", desc: "Alibaba, strong multilingual" },
  { id: "starcoder2:7b",       name: "StarCoder2 7B",        size: "4.0GB",  tag: "code",    desc: "Code generation specialist" },
  { id: "deepseek-r1:7b",      name: "DeepSeek R1 7B",       size: "4.7GB",  tag: "code",    desc: "Reasoning model, great for logic" },
  { id: "llama3.1:8b",         name: "Llama 3.1 8B",         size: "4.9GB",  tag: "general", desc: "Improved Llama 3 with longer context" },
];

const TAG_COLOURS = { general: "badge-green", code: "badge-blue", large: "badge-yellow", small: "badge-grey" };

// Models LLMSpaghetti installs for its own use — annotated so users know what
// they are (and that they're not stray chat models to delete).
const SYSTEM_MODELS = {
  "nomic-embed-text": {
    label: "router",
    hint: "Embedding model used by the router for fuzzy correction matching (the routing flywheel) — not a chat model. Keep it for smarter routing.",
  },
};
const systemInfo = (name) => {
  const key = Object.keys(SYSTEM_MODELS).find(k => (name || "").startsWith(k));
  return key ? SYSTEM_MODELS[key] : null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmtBytes = (b) => {
  if (!b) return "—";
  const gb = b / 1024 / 1024 / 1024;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(b / 1024 / 1024).toFixed(0)} MB`;
};

function parseModelfile(mf) {
  const params = {};
  let system = "";
  for (const line of (mf || "").split("\n")) {
    const p = line.match(/^PARAMETER\s+(\S+)\s+(.+)/i);
    if (p) params[p[1].toLowerCase()] = p[2].trim();
    const s = line.match(/^SYSTEM\s+"(.+)"/i);
    if (s) system = s[1];
    const sm = line.match(/^SYSTEM\s+"""([\s\S]*?)"""/im);
    if (sm) system = sm[1].trim();
  }
  return { params, system };
}

function buildModelfile(original, edits) {
  // Rebuild the Modelfile: keep FROM + any lines we're not overriding,
  // then inject edited PARAMETER/SYSTEM directives at the end.
  const lines = (original || "").split("\n");
  const kept = lines.filter(l => {
    const u = l.toUpperCase().trim();
    if (u.startsWith("PARAMETER TEMPERATURE")) return false;
    if (u.startsWith("PARAMETER TOP_P"))       return false;
    if (u.startsWith("PARAMETER TOP_K"))       return false;
    if (u.startsWith("PARAMETER REPEAT_PENALTY")) return false;
    if (u.startsWith("PARAMETER NUM_CTX"))     return false;
    if (u.startsWith("SYSTEM"))                return false;
    return true;
  });

  const out = kept.join("\n").trimEnd();
  const additions = [];

  if (edits.temperature !== "") additions.push(`PARAMETER temperature ${edits.temperature}`);
  if (edits.top_p       !== "") additions.push(`PARAMETER top_p ${edits.top_p}`);
  if (edits.top_k       !== "") additions.push(`PARAMETER top_k ${edits.top_k}`);
  if (edits.repeat_penalty !== "") additions.push(`PARAMETER repeat_penalty ${edits.repeat_penalty}`);
  if (edits.num_ctx     !== "") additions.push(`PARAMETER num_ctx ${edits.num_ctx}`);
  if (edits.system.trim())      additions.push(`SYSTEM """${edits.system.trim()}"""`);

  return [out, ...additions].filter(Boolean).join("\n") + "\n";
}

// ── VRAM Budget Bar ───────────────────────────────────────────────────────────

function VRAMBar({ running, gpuVram }) {
  if (!gpuVram) return null;

  const usedBytes = running.reduce((s, m) => s + (m.size_vram || 0), 0);
  const totalBytes = gpuVram * 1024 * 1024 * 1024;
  const pct = totalBytes > 0 ? Math.min(100, (usedBytes / totalBytes) * 100) : 0;
  const colour = pct > 90 ? C.red : pct > 70 ? C.yellow : C.green;

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`,
                  borderRadius: "10px", padding: "1rem 1.25rem", marginBottom: "1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between",
                    alignItems: "center", marginBottom: "0.5rem" }}>
        <div style={{ fontSize: "0.72rem", fontWeight: 600, color: C.dim,
                      textTransform: "uppercase", letterSpacing: "0.05em" }}>
          VRAM Budget
        </div>
        <div style={{ fontSize: "0.85rem", fontWeight: 700, color: pct > 90 ? C.red : C.text }}>
          {fmtBytes(usedBytes)} / {gpuVram} GB
          <span style={{ color: C.dim, fontWeight: 400, marginLeft: "0.5rem" }}>
            ({pct.toFixed(0)}%)
          </span>
        </div>
      </div>

      {/* Bar */}
      <div style={{ background: C.border, borderRadius: "4px", height: "10px", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: colour,
                      borderRadius: "4px", transition: "width 0.5s ease" }} />
      </div>

      {/* Loaded model chips */}
      {running.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.6rem" }}>
          {running.map(m => (
            <span key={m.name} style={{
              fontSize: "0.74rem", fontWeight: 600,
              background: `${C.green}18`, color: C.green,
              border: `1px solid ${C.green}30`,
              borderRadius: "20px", padding: "0.15rem 0.6rem",
            }}>
              ● {m.name} {m.size_vram ? `(${fmtBytes(m.size_vram)})` : ""}
            </span>
          ))}
        </div>
      )}
      {running.length === 0 && (
        <div style={{ fontSize: "0.78rem", color: C.dim, marginTop: "0.5rem" }}>
          No models loaded in VRAM
        </div>
      )}
    </div>
  );
}

// ── Per-model config panel ────────────────────────────────────────────────────

function ConfigPanel({ name, onClose, onAlert }) {
  const [modelfile, setModelfile] = useState("");
  const [loading, setLoading]    = useState(true);
  const [saving, setSaving]      = useState(false);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [edits, setEdits] = useState({
    temperature: "", top_p: "", top_k: "",
    repeat_penalty: "", num_ctx: "", system: "",
  });

  const snapshotPath = `${SNAPSHOTS_DIR}/${name.replace(":", "_")}.Modelfile`;

  useEffect(() => {
    (async () => {
      const mf  = await run(`ollama show "${name}" --modelfile 2>/dev/null`);
      const snap = await run(`test -f "${snapshotPath}" && echo yes || echo no`);
      setModelfile(mf);
      setHasSnapshot(snap === "yes");
      const { params, system } = parseModelfile(mf);
      setEdits({
        temperature:    params.temperature    || "",
        top_p:          params.top_p          || "",
        top_k:          params.top_k          || "",
        repeat_penalty: params.repeat_penalty || "",
        num_ctx:        params.num_ctx        || "",
        system,
      });
      setLoading(false);
    })();
  }, [name]);

  const set = (k) => (e) => setEdits(prev => ({ ...prev, [k]: e.target.value }));

  const snapshot = async () => {
    await run(`mkdir -p "${SNAPSHOTS_DIR}"`);
    await run(`ollama show "${name}" --modelfile > "${snapshotPath}"`);
    setHasSnapshot(true);
    onAlert({ type: "ok", msg: `Snapshot saved for ${name}` });
  };

  const restore = async () => {
    if (!hasSnapshot) return;
    setSaving(true);
    try {
      await run(`ollama create "${name}" -f "${snapshotPath}"`);
      onAlert({ type: "ok", msg: `${name} restored from snapshot` });
      onClose();
    } catch (e) {
      onAlert({ type: "err", msg: `Restore failed: ${e}` });
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const newMf = buildModelfile(modelfile, edits);
      const tmp   = `/tmp/llmspaghetti-modelfile-${Date.now()}`;
      await run(`cat > "${tmp}" << 'LLMSEOF'\n${newMf}\nLLMSEOF`);
      await run(`ollama create "${name}" -f "${tmp}" && rm -f "${tmp}"`);
      onAlert({ type: "ok", msg: `${name} updated — reload it in VRAM to apply` });
      onClose();
    } catch (e) {
      onAlert({ type: "err", msg: `Save failed: ${e}` });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return (
    <div style={{ padding: "1rem", color: C.dim, fontSize: "0.85rem" }}>Loading Modelfile…</div>
  );

  const field = (label, key, placeholder, hint) => (
    <div style={{ marginBottom: "0.9rem" }}>
      <label style={{ fontSize: "0.78rem", color: C.dim, fontWeight: 600,
                      display: "block", marginBottom: "0.3rem" }}>{label}</label>
      <input type="text" value={edits[key]} onChange={set(key)} placeholder={placeholder}
        style={{ width: "100%", background: C.bg, border: `1px solid ${C.border}`,
                 borderRadius: "6px", color: C.text, padding: "0.45rem 0.7rem",
                 fontSize: "0.85rem" }} />
      {hint && <div style={{ fontSize: "0.72rem", color: C.dim, marginTop: "0.2rem" }}>{hint}</div>}
    </div>
  );

  return (
    <div style={{ borderTop: `1px solid ${C.border}`, padding: "1rem 1.25rem",
                  background: `${C.accent}06` }}>
      <div style={{ display: "flex", justifyContent: "space-between",
                    alignItems: "center", marginBottom: "1rem" }}>
        <div style={{ fontWeight: 700, fontSize: "0.9rem" }}>Configure {name}</div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button onClick={snapshot}
            style={{ padding: "0.35rem 0.8rem", fontSize: "0.78rem", fontWeight: 600,
                     background: "transparent", border: `1px solid ${C.border}`,
                     borderRadius: "6px", color: C.dim, cursor: "pointer" }}>
            📸 Snapshot
          </button>
          {hasSnapshot && (
            <button onClick={restore} disabled={saving}
              style={{ padding: "0.35rem 0.8rem", fontSize: "0.78rem", fontWeight: 600,
                       background: "transparent", border: `1px solid ${C.yellow}40`,
                       borderRadius: "6px", color: C.yellow, cursor: "pointer" }}>
              ↺ Restore
            </button>
          )}
          <button onClick={onClose}
            style={{ padding: "0.35rem 0.8rem", fontSize: "0.78rem", fontWeight: 600,
                     background: "transparent", border: `1px solid ${C.border}`,
                     borderRadius: "6px", color: C.dim, cursor: "pointer" }}>✕</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0 1rem" }}>
        {field("Temperature", "temperature", "0.8", "Creativity (0 = deterministic, 1 = creative)")}
        {field("Top-P", "top_p", "0.9", "Nucleus sampling threshold")}
        {field("Top-K", "top_k", "40", "Vocabulary size cap per step")}
        {field("Repeat Penalty", "repeat_penalty", "1.1", "Penalise repeated tokens")}
        {field("Context Length", "num_ctx", "4096", "Max tokens in context window")}
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <label style={{ fontSize: "0.78rem", color: C.dim, fontWeight: 600,
                        display: "block", marginBottom: "0.3rem" }}>System Prompt</label>
        <textarea value={edits.system} onChange={set("system")}
          placeholder="You are a helpful assistant…"
          style={{ width: "100%", background: C.bg, border: `1px solid ${C.border}`,
                   borderRadius: "6px", color: C.text, padding: "0.5rem 0.75rem",
                   fontFamily: "monospace", fontSize: "0.82rem",
                   minHeight: "80px", resize: "vertical" }} />
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
        <button onClick={onClose}
          style={{ padding: "0.45rem 1rem", fontSize: "0.85rem", fontWeight: 600,
                   background: "transparent", border: `1px solid ${C.border}`,
                   borderRadius: "6px", color: C.text, cursor: "pointer" }}>
          Cancel
        </button>
        <button onClick={save} disabled={saving}
          style={{ padding: "0.45rem 1rem", fontSize: "0.85rem", fontWeight: 600,
                   background: C.accent, color: "white", border: "none",
                   borderRadius: "6px", cursor: saving ? "wait" : "pointer",
                   display: "flex", alignItems: "center", gap: "0.4rem" }}>
          {saving
            ? <><div style={{ width: 13, height: 13, border: "2px solid rgba(255,255,255,0.3)",
                              borderTopColor: "white", borderRadius: "50%",
                              animation: "spin 0.7s linear infinite" }} /> Saving…</>
            : "Save"}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN MODELS TAB
// ─────────────────────────────────────────────────────────────────────────────
export default function Models() {
  const [installed, setInstalled]   = useState([]);
  const [running, setRunning]       = useState([]);  // loaded in VRAM
  const [gpuVram, setGpuVram]       = useState(null);
  const [pulling, setPulling]       = useState(null);
  const [pullLog, setPullLog]       = useState("");
  const [customModel, setCustomModel] = useState("");
  const [filter, setFilter]         = useState("all");
  const [alert, setAlert]           = useState(null);
  const [busy, setBusy]             = useState({});  // {modelName: action}
  const [openConfig, setOpenConfig] = useState(null);
  const intervalRef = useRef(null);

  // ── Data fetchers ──────────────────────────────────────────────────────────

  const loadInstalled = useCallback(async () => {
    const raw = await run("ollama list 2>/dev/null | tail -n +2");
    const rows = raw.split("\n").filter(Boolean).map(line => {
      const parts = line.split(/\s+/);
      return { name: parts[0], size: parts[2] + " " + parts[3], modified: parts.slice(4).join(" ") };
    });
    setInstalled(rows);
  }, []);

  const loadRunning = useCallback(async () => {
    try {
      const raw = await run("curl -sf http://localhost:11434/api/ps 2>/dev/null");
      if (!raw) { setRunning([]); return; }
      const data = JSON.parse(raw);
      setRunning(data.models || []);
    } catch {
      setRunning([]);
    }
  }, []);

  const loadGpuInfo = useCallback(async () => {
    try {
      const raw = await run("cat /opt/llmspaghetti/gpu-info.json 2>/dev/null");
      if (raw) {
        const data = JSON.parse(raw);
        setGpuVram(data.total_vram_gb || null);
      }
    } catch { /* CPU mode — no VRAM bar */ }
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([loadInstalled(), loadRunning()]);
  }, [loadInstalled, loadRunning]);

  useEffect(() => {
    loadGpuInfo();
    refresh();
    intervalRef.current = setInterval(loadRunning, 4000); // VRAM bar live-updates
    return () => clearInterval(intervalRef.current);
  }, []);

  // ── Actions ────────────────────────────────────────────────────────────────

  const loadModel = async (name) => {
    setBusy(b => ({ ...b, [name]: "loading" }));
    setAlert(null);
    try {
      // Preload via Ollama API (keep alive 10 min)
      await run(`curl -sf -X POST http://localhost:11434/api/generate \\
        -d '{"model":"${name}","keep_alive":"10m"}' > /dev/null 2>&1`);
      await loadRunning();
      setAlert({ type: "ok", msg: `${name} loaded into VRAM` });
    } finally {
      setBusy(b => { const n = { ...b }; delete n[name]; return n; });
    }
  };

  const stopModel = async (name) => {
    setBusy(b => ({ ...b, [name]: "stopping" }));
    setAlert(null);
    try {
      await run(`curl -sf -X POST http://localhost:11434/api/generate \\
        -d '{"model":"${name}","keep_alive":0}' > /dev/null 2>&1`);
      await loadRunning();
      setAlert({ type: "ok", msg: `${name} unloaded from VRAM` });
    } finally {
      setBusy(b => { const n = { ...b }; delete n[name]; return n; });
    }
  };

  const deleteModel = async (name) => {
    const sys = systemInfo(name);
    const msg = sys
      ? `⚠ ${name} is a system model used by the router (${sys.label}).\n\n${sys.hint}\n\nDeleting it breaks that feature until you re-pull it. Delete anyway?`
      : `Delete ${name}? This cannot be undone.`;
    if (!confirm(msg)) return;
    setBusy(b => ({ ...b, [name]: "deleting" }));
    try {
      await run(`ollama rm "${name}"`);
      setAlert({ type: "ok", msg: `${name} deleted` });
      if (openConfig === name) setOpenConfig(null);
      refresh();
    } finally {
      setBusy(b => { const n = { ...b }; delete n[name]; return n; });
    }
  };

  const pullModel = async (modelId) => {
    setPulling(modelId);
    setPullLog("");
    setAlert(null);
    try {
      await new Promise((res, rej) => {
        const proc = cockpit.spawn(["bash", "-c", `${PATHFIX} ollama pull '${modelId}'`],
          { superuser: "try", err: "message" });
        proc.stream(d => setPullLog(prev => prev + d));
        proc.then(() => {
          setAlert({ type: "ok", msg: `${modelId} downloaded` });
          res();
        }).catch(err => {
          setAlert({ type: "err", msg: `Pull failed: ${err.message}` });
          rej(err);
        });
      });
    } finally {
      setPulling(null);
      setPullLog("");
      refresh();
    }
  };

  // ── Derived state ──────────────────────────────────────────────────────────

  const runningNames  = new Set(running.map(m => m.name));
  const installedNames = installed.map(m => m.name);
  const filtered = filter === "all" ? POPULAR_MODELS
    : POPULAR_MODELS.filter(m => m.tag === filter);

  // ── Render ─────────────────────────────────────────────────────────────────

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

      {/* VRAM budget bar */}
      <VRAMBar running={running} gpuVram={gpuVram} />

      {/* Installed models */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`,
                    borderRadius: "10px", marginBottom: "1rem", overflow: "hidden" }}>
        <div style={{ padding: "1rem 1.25rem 0.75rem",
                      fontSize: "0.72rem", fontWeight: 600, color: C.dim,
                      textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Installed models ({installed.length})
        </div>

        {installed.length === 0 ? (
          <div style={{ padding: "0 1.25rem 1rem", color: C.dim, fontSize: "0.88rem" }}>
            No models downloaded yet. Pull one below.
          </div>
        ) : (
          <div>
            {installed.map(m => {
              const isRunning = runningNames.has(m.name);
              const action    = busy[m.name];
              const isOpen    = openConfig === m.name;
              const sysInfo   = systemInfo(m.name);

              return (
                <div key={m.name} style={{ borderTop: `1px solid ${C.border}` }}>
                  <div style={{ display: "flex", alignItems: "center",
                                padding: "0.7rem 1.25rem", gap: "0.75rem" }}>
                    {/* Status dot */}
                    <div style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                                  background: isRunning ? C.green : C.dim }} />

                    {/* Name + size (+ system-model badge/note) */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                        <span style={{ fontWeight: 600, fontFamily: "monospace",
                                       fontSize: "0.88rem", color: C.text }}>{m.name}</span>
                        {sysInfo && (
                          <span title={sysInfo.hint}
                            style={{ fontSize: "0.66rem", fontWeight: 700, color: C.purple,
                                     background: `${C.purple}18`, border: `1px solid ${C.purple}30`,
                                     padding: "0.1rem 0.45rem", borderRadius: "20px",
                                     cursor: "help", whiteSpace: "nowrap", flexShrink: 0 }}>
                            🔁 {sysInfo.label}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: "0.74rem", color: C.dim }}>
                        {sysInfo ? sysInfo.hint : m.size}
                      </div>
                    </div>

                    {/* VRAM size if running */}
                    {isRunning && (() => {
                      const ri = running.find(r => r.name === m.name);
                      return ri?.size_vram ? (
                        <span style={{ fontSize: "0.74rem", color: C.green,
                                       background: `${C.green}15`,
                                       padding: "0.15rem 0.5rem", borderRadius: "20px" }}>
                          {fmtBytes(ri.size_vram)} in VRAM
                        </span>
                      ) : null;
                    })()}

                    {/* Actions */}
                    <div style={{ display: "flex", gap: "0.4rem", flexShrink: 0 }}>
                      {!isRunning ? (
                        <button onClick={() => loadModel(m.name)} disabled={!!action}
                          style={{ padding: "0.3rem 0.7rem", fontSize: "0.78rem", fontWeight: 600,
                                   background: `${C.green}20`, color: C.green,
                                   border: `1px solid ${C.green}40`, borderRadius: "6px",
                                   cursor: action ? "wait" : "pointer" }}>
                          {action === "loading" ? "Loading…" : "▶ Load"}
                        </button>
                      ) : (
                        <button onClick={() => stopModel(m.name)} disabled={!!action}
                          style={{ padding: "0.3rem 0.7rem", fontSize: "0.78rem", fontWeight: 600,
                                   background: `${C.yellow}15`, color: C.yellow,
                                   border: `1px solid ${C.yellow}40`, borderRadius: "6px",
                                   cursor: action ? "wait" : "pointer" }}>
                          {action === "stopping" ? "Stopping…" : "⏹ Eject"}
                        </button>
                      )}

                      <button onClick={() => setOpenConfig(isOpen ? null : m.name)}
                        style={{ padding: "0.3rem 0.7rem", fontSize: "0.78rem", fontWeight: 600,
                                 background: isOpen ? `${C.accent}25` : "transparent",
                                 color: isOpen ? C.accent2 : C.dim,
                                 border: `1px solid ${isOpen ? C.accent + "50" : C.border}`,
                                 borderRadius: "6px", cursor: "pointer" }}>
                        ⚙ Config
                      </button>

                      <button onClick={() => deleteModel(m.name)} disabled={!!action}
                        style={{ padding: "0.3rem 0.7rem", fontSize: "0.78rem", fontWeight: 600,
                                 background: "rgba(248,81,73,0.08)", color: C.red,
                                 border: "1px solid rgba(248,81,73,0.25)", borderRadius: "6px",
                                 cursor: action ? "wait" : "pointer" }}>
                        {action === "deleting" ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </div>

                  {/* Inline config panel */}
                  {isOpen && (
                    <ConfigPanel
                      name={m.name}
                      onClose={() => setOpenConfig(null)}
                      onAlert={setAlert}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pull by name */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`,
                    borderRadius: "10px", padding: "1rem 1.25rem", marginBottom: "1rem" }}>
        <div style={{ fontSize: "0.72rem", fontWeight: 600, color: C.dim,
                      textTransform: "uppercase", letterSpacing: "0.05em",
                      marginBottom: "0.75rem" }}>Pull model</div>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <input type="text" placeholder="e.g. phi3:mini or llama3:70b"
            value={customModel}
            onChange={e => setCustomModel(e.target.value)}
            onKeyDown={e => e.key === "Enter" && customModel && pullModel(customModel)}
            style={{ flex: 1, background: C.bg, border: `1px solid ${C.border}`,
                     borderRadius: "6px", color: C.text, padding: "0.5rem 0.75rem",
                     fontSize: "0.88rem" }} />
          <button disabled={!customModel || !!pulling} onClick={() => pullModel(customModel)}
            style={{ padding: "0.5rem 1.1rem", background: C.accent, color: "white",
                     border: "none", borderRadius: "6px", fontSize: "0.85rem",
                     fontWeight: 600, cursor: !customModel || pulling ? "not-allowed" : "pointer",
                     display: "flex", alignItems: "center", gap: "0.4rem", opacity: !customModel || pulling ? 0.6 : 1 }}>
            {pulling === customModel
              ? <><div style={{ width: 13, height: 13, border: "2px solid rgba(255,255,255,0.3)",
                                borderTopColor: "white", borderRadius: "50%",
                                animation: "spin 0.7s linear infinite" }} /> Pulling…</>
              : "↓ Pull"}
          </button>
        </div>
        <div style={{ fontSize: "0.74rem", color: C.dim, marginTop: "0.35rem" }}>
          Any model from{" "}
          <a href="https://ollama.com/library" target="_blank" rel="noreferrer"
            style={{ color: C.accent2 }}>ollama.com/library</a>
        </div>
      </div>

      {/* Pull log */}
      {pullLog && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`,
                      borderRadius: "10px", padding: "1rem 1.25rem", marginBottom: "1rem" }}>
          <div style={{ fontSize: "0.72rem", fontWeight: 600, color: C.dim,
                        textTransform: "uppercase", letterSpacing: "0.05em",
                        marginBottom: "0.5rem" }}>Pull progress</div>
          <pre style={{ fontSize: "0.78rem", color: C.dim, maxHeight: "180px",
                        overflow: "auto", whiteSpace: "pre-wrap", margin: 0 }}>{pullLog}</pre>
        </div>
      )}

      {/* Library browser */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`,
                    borderRadius: "10px", padding: "1rem 1.25rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between",
                      alignItems: "center", marginBottom: "0.75rem" }}>
          <div style={{ fontSize: "0.72rem", fontWeight: 600, color: C.dim,
                        textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Model library
          </div>
          <div style={{ display: "flex", gap: "0.35rem" }}>
            {["all", "general", "code", "small", "large"].map(f => (
              <button key={f} onClick={() => setFilter(f)}
                style={{ padding: "0.25rem 0.65rem", fontSize: "0.75rem", fontWeight: 600,
                         borderRadius: "6px", border: "none", cursor: "pointer",
                         background: filter === f ? C.accent : C.border,
                         color: filter === f ? "white" : C.dim }}>{f}</button>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.65rem" }}>
          {filtered.map(m => {
            const isInstalled = installedNames.some(n => n.startsWith(m.id.split(":")[0]));
            const isPulling   = pulling === m.id;
            return (
              <div key={m.id} style={{
                border: `1px solid ${isInstalled ? C.green + "30" : C.border}`,
                borderRadius: "8px", padding: "0.8rem",
                background: isInstalled ? `${C.green}05` : "transparent",
                display: "flex", flexDirection: "column", gap: "0.25rem",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ fontWeight: 700, fontSize: "0.88rem" }}>{m.name}</div>
                  <span style={{ fontSize: "0.7rem", fontWeight: 600,
                                 padding: "0.1rem 0.45rem", borderRadius: "20px",
                                 background: TAG_COLOURS[m.tag] === "badge-blue"
                                   ? "rgba(47,129,247,0.15)" : TAG_COLOURS[m.tag] === "badge-yellow"
                                   ? "rgba(210,153,34,0.15)" : TAG_COLOURS[m.tag] === "badge-grey"
                                   ? "rgba(139,148,158,0.15)" : "rgba(63,185,80,0.15)",
                                 color: TAG_COLOURS[m.tag] === "badge-blue" ? C.accent2
                                   : TAG_COLOURS[m.tag] === "badge-yellow" ? C.yellow
                                   : TAG_COLOURS[m.tag] === "badge-grey" ? C.dim : C.green,
                  }}>{m.tag}</span>
                </div>
                <div style={{ fontSize: "0.76rem", color: C.dim }}>{m.desc}</div>
                <div style={{ display: "flex", justifyContent: "space-between",
                              alignItems: "center", marginTop: "0.25rem" }}>
                  <span style={{ fontSize: "0.76rem", color: C.yellow, fontWeight: 600 }}>{m.size}</span>
                  {isInstalled ? (
                    <span style={{ fontSize: "0.72rem", color: C.green }}>✓ installed</span>
                  ) : (
                    <button disabled={!!pulling} onClick={() => pullModel(m.id)}
                      style={{ padding: "0.25rem 0.65rem", fontSize: "0.76rem", fontWeight: 600,
                               background: C.accent, color: "white", border: "none",
                               borderRadius: "6px", cursor: pulling ? "not-allowed" : "pointer",
                               opacity: pulling ? 0.6 : 1, display: "flex",
                               alignItems: "center", gap: "0.3rem" }}>
                      {isPulling
                        ? <><div style={{ width: 10, height: 10, border: "2px solid rgba(255,255,255,0.3)",
                                          borderTopColor: "white", borderRadius: "50%",
                                          animation: "spin 0.7s linear infinite" }} /> Pulling…</>
                        : "↓ Pull"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
