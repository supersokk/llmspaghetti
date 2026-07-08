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
// Every command gets a hard timeout. Without it, a curl to a busy/thrashing
// Ollama (common right when a model is loading) never returns, the promise never
// resolves, and the 4s poll keeps stacking hung superuser processes until the
// whole Cockpit bridge wedges ("hangs like crazy"). On timeout we kill the proc
// and resolve what we have so the UI keeps moving. Callers that legitimately take
// a while (a model load) pass a longer timeoutMs.
const run = (cmd, timeoutMs = 15000) => new Promise((res) => {
  let out = "", done = false;
  const finish = (v) => { if (!done) { done = true; res(v); } };
  const proc = cockpit.spawn(["bash", "-c", PATHFIX + cmd], { superuser: "try", err: "message" });
  const timer = setTimeout(() => { try { proc.close("terminated"); } catch { /* mock */ } finish(out.trim()); }, timeoutMs);
  proc.stream(d => { out += d; });
  proc.then(() => { clearTimeout(timer); finish(out.trim()); })
      .catch(() => { clearTimeout(timer); finish(""); });
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
  const [pullProg, setPullProg]     = useState(null);  // {pct,label,status} live download bar
  const [customModel, setCustomModel] = useState("");
  const [filter, setFilter]         = useState("all");
  const [alert, setAlert]           = useState(null);
  const [busy, setBusy]             = useState({});  // {modelName: action}
  // HuggingFace GGUF search (Ollama pulls GGUF straight from HF via hf.co/<repo>)
  const [hfQuery, setHfQuery]       = useState("");
  const [hfResults, setHfResults]   = useState(null); // null=idle, []=no hits, [...]=hits
  const [hfSearching, setHfSearching] = useState(false);
  const [hfOpen, setHfOpen]         = useState({});    // {repo: [quant,...]} expanded quant lists
  const [openConfig, setOpenConfig] = useState(null);
  const intervalRef = useRef(null);
  const runningInFlight = useRef(false);  // guard so the 4s poll can't stack up

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
    // /api/ps = models currently resident in VRAM. On a TRANSIENT fetch failure
    // (empty output / parse error — common right when a model is loading and
    // Ollama is busy) KEEP the last known state. Blanking to [] made every model
    // flicker to grey. A genuine "nothing loaded" comes back as {"models":[]}.
    if (runningInFlight.current) return;  // a previous poll is still running — skip
    runningInFlight.current = true;
    try {
      const raw = await run("curl -sf --max-time 4 http://localhost:11434/api/ps 2>/dev/null", 6000);
      if (!raw) return;
      try {
        const data = JSON.parse(raw);
        setRunning(Array.isArray(data.models) ? data.models : []);
      } catch { /* keep last known state */ }
    } finally {
      runningInFlight.current = false;
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
      // Load and KEEP it resident (keep_alive:-1). A per-request keep_alive
      // overrides OLLAMA_KEEP_ALIVE, so a fixed duration here would fight the
      // user's "keep loaded" policy — "Load" means load and hold.
      await run(`curl -sf --max-time 175 -X POST http://localhost:11434/api/generate \\
        -d '{"model":"${name}","keep_alive":-1}' > /dev/null 2>&1`, 180000);
      await loadRunning();
      setAlert({ type: "ok", msg: `${name} loaded into VRAM (kept resident)` });
    } finally {
      setBusy(b => { const n = { ...b }; delete n[name]; return n; });
    }
  };

  const stopModel = async (name) => {
    setBusy(b => ({ ...b, [name]: "stopping" }));
    setAlert(null);
    try {
      await run(`curl -sf --max-time 55 -X POST http://localhost:11434/api/generate \\
        -d '{"model":"${name}","keep_alive":0}' > /dev/null 2>&1`, 60000);
      await loadRunning();
      setAlert({ type: "ok", msg: `${name} unloaded from memory (VRAM + RAM)` });
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

  // Parse Ollama's pull stream into a progress bar. Ollama emits lines like
  // "pulling <digest>:  45% ▕███ ▏ 2.1 GB/4.7 GB  35 MB/s  1m2s" (carriage-return
  // updated), plus phase lines ("pulling manifest", "verifying", "success").
  const parseProgress = (chunk) => {
    const tail = chunk.replace(/\r/g, "\n").split("\n").filter(Boolean).slice(-1)[0] || "";
    const pctM  = tail.match(/(\d+)%/);
    const sizeM = tail.match(/([\d.]+\s*[KMGT]?B)\s*\/\s*([\d.]+\s*[KMGT]?B)/);
    const phase = tail.match(/^\s*(pulling manifest|verifying|writing|success|pulling\b[^:]*)/i);
    return {
      pct:   pctM ? Math.min(100, parseInt(pctM[1], 10)) : null,
      label: sizeM ? `${sizeM[1]} / ${sizeM[2]}` : (phase ? phase[1].trim() : tail.trim().slice(0, 48)),
      status: /success/i.test(tail) ? "done" : "run",
    };
  };

  // Non-blocking pull: kicks off the download and returns immediately. The search
  // field and the rest of the panel stay live; progress shows in its own strip.
  const pullModel = (modelId) => {
    if (pulling) {                       // one download at a time — Ollama serialises anyway
      setAlert({ type: "err", msg: `Already downloading ${pulling} — let it finish first.` });
      return;
    }
    setPulling(modelId);
    setPullLog("");
    setPullProg({ pct: null, label: "starting…", status: "run" });
    setAlert(null);
    const proc = cockpit.spawn(["bash", "-c", `${PATHFIX} ollama pull '${modelId}'`],
      { superuser: "try", err: "message" });
    proc.stream(d => {
      setPullLog(prev => (prev + d).slice(-4000));
      const p = parseProgress(d);
      setPullProg(prev => ({
        pct:   p.pct != null ? p.pct : (prev ? prev.pct : null),
        label: p.label || (prev ? prev.label : ""),
        status: p.status,
      }));
    });
    // Cleanup runs on both success and failure. Uses the two-arg then() form —
    // cockpit's process promise doesn't reliably implement .finally().
    const finish = () => { setPulling(null); setPullProg(null); setPullLog(""); refresh(); };
    proc.then(
      () => { setAlert({ type: "ok",  msg: `${modelId} downloaded` }); finish(); },
      (err) => { setAlert({ type: "err", msg: `Pull failed: ${err && err.message || err}` }); finish(); },
    );
  };

  // ── HuggingFace GGUF search ────────────────────────────────────────────────
  // Ollama pulls GGUF models straight from HF (`ollama pull hf.co/<repo>:<quant>`),
  // so we search HF's public API server-side (via spawn+curl — no CORS) and pull
  // the chosen quant through the same path above.
  const searchHF = async () => {
    const q = hfQuery.trim();
    if (!q || hfSearching) return;
    setHfSearching(true);
    setHfResults(null);
    try {
      const url = `https://huggingface.co/api/models?search=${encodeURIComponent(q)}`
                + `&filter=gguf&sort=downloads&direction=-1&limit=15`;
      const raw = await run(`curl -sf --max-time 20 '${url}'`);
      let list = [];
      try { list = JSON.parse(raw || "[]"); } catch { list = []; }
      setHfResults(list.map(m => ({
        id: m.id || m.modelId,
        downloads: m.downloads || 0,
        likes: m.likes || 0,
      })).filter(m => m.id));
    } catch {
      setHfResults([]);
    } finally {
      setHfSearching(false);
    }
  };

  // Lazily fetch a repo's available GGUF quants (from its file list).
  const loadQuants = async (repo) => {
    if (hfOpen[repo]) { setHfOpen(o => ({ ...o, [repo]: undefined })); return; }  // toggle closed
    setHfOpen(o => ({ ...o, [repo]: [] }));
    const raw = await run(`curl -sf --max-time 20 'https://huggingface.co/api/models/${repo}'`);
    let quants = [];
    try {
      const info = JSON.parse(raw || "{}");
      const ggufs = (info.siblings || [])
        .map(s => s.rfilename || "")
        .filter(f => /\.gguf$/i.test(f));
      const seen = new Set();
      for (const f of ggufs) {
        const m = f.match(/(IQ\d[\w]*|Q\d[\w]*|BF16|F16|F32)/i);
        const tag = m ? m[1].toUpperCase() : f.replace(/\.gguf$/i, "");
        if (!seen.has(tag)) { seen.add(tag); quants.push(tag); }
      }
    } catch { /* leave empty */ }
    setHfOpen(o => ({ ...o, [repo]: quants }));
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

      {/* Search HuggingFace (GGUF) — Ollama pulls these directly via hf.co/<repo> */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`,
                    borderRadius: "10px", padding: "1rem 1.25rem", marginBottom: "1rem" }}>
        <div style={{ fontSize: "0.72rem", fontWeight: 600, color: C.dim,
                      textTransform: "uppercase", letterSpacing: "0.05em",
                      marginBottom: "0.75rem" }}>Search HuggingFace 🤗 <span style={{
                      fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>· GGUF models Ollama can pull</span></div>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <input type="text" placeholder="e.g. qwen2.5 coder, llama 3.1, mistral nemo…"
            value={hfQuery}
            onChange={e => setHfQuery(e.target.value)}
            onKeyDown={e => e.key === "Enter" && searchHF()}
            style={{ flex: 1, background: C.bg, border: `1px solid ${C.border}`,
                     borderRadius: "6px", color: C.text, padding: "0.5rem 0.75rem",
                     fontSize: "0.88rem" }} />
          <button disabled={!hfQuery.trim() || hfSearching} onClick={searchHF}
            style={{ padding: "0.5rem 1.1rem", background: C.accent, color: "white",
                     border: "none", borderRadius: "6px", fontSize: "0.85rem",
                     fontWeight: 600, cursor: !hfQuery.trim() || hfSearching ? "not-allowed" : "pointer",
                     display: "flex", alignItems: "center", gap: "0.4rem",
                     opacity: !hfQuery.trim() || hfSearching ? 0.6 : 1 }}>
            {hfSearching
              ? <><div style={{ width: 13, height: 13, border: "2px solid rgba(255,255,255,0.3)",
                                borderTopColor: "white", borderRadius: "50%",
                                animation: "spin 0.7s linear infinite" }} /> Searching…</>
              : "🔍 Search"}
          </button>
        </div>

        {hfResults != null && hfResults.length === 0 && !hfSearching && (
          <div style={{ fontSize: "0.8rem", color: C.dim, marginTop: "0.75rem" }}>
            No GGUF models found for that search. Try broader terms.
          </div>
        )}

        {hfResults && hfResults.length > 0 && (
          <div style={{ marginTop: "0.85rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {hfResults.map(r => {
              const quants = hfOpen[r.id];
              const dl = r.downloads >= 1000 ? `${(r.downloads / 1000).toFixed(1)}k` : `${r.downloads}`;
              return (
                <div key={r.id} style={{ background: C.bg, border: `1px solid ${C.border}`,
                                         borderRadius: "8px", padding: "0.6rem 0.8rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                    <span style={{ flex: 1, fontFamily: "monospace", fontSize: "0.82rem",
                                   color: C.text, overflow: "hidden", textOverflow: "ellipsis",
                                   whiteSpace: "nowrap" }}>{r.id}</span>
                    <span style={{ fontSize: "0.72rem", color: C.dim }}>↓ {dl}</span>
                    <a href={`https://huggingface.co/${r.id}`} target="_blank" rel="noreferrer"
                       style={{ fontSize: "0.72rem", color: C.accent2 }}>view</a>
                    <button onClick={() => loadQuants(r.id)}
                      style={{ padding: "0.28rem 0.7rem", fontSize: "0.76rem", fontWeight: 600,
                               border: `1px solid ${C.border}`, borderRadius: "6px", cursor: "pointer",
                               background: quants ? C.border : "transparent", color: C.text }}>
                      {quants ? "quants ▴" : "quants ▾"}
                    </button>
                  </div>
                  {quants && quants.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.6rem" }}>
                      {quants.map(q => {
                        const target = `hf.co/${r.id}:${q}`;
                        return (
                          <button key={q} disabled={!!pulling} onClick={() => pullModel(target)}
                            style={{ padding: "0.28rem 0.7rem", fontSize: "0.75rem", fontWeight: 600,
                                     border: "none", borderRadius: "6px",
                                     cursor: pulling ? "not-allowed" : "pointer",
                                     opacity: pulling ? 0.5 : 1,
                                     background: C.accent, color: "white" }}>
                            ↓ {q}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {quants && quants.length === 0 && (
                    <div style={{ fontSize: "0.74rem", color: C.dim, marginTop: "0.5rem" }}>
                      Loading quants… (or none listed — try “view” on HF)
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Download progress — non-blocking; search stays usable while this runs */}
      {pulling && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`,
                      borderRadius: "10px", padding: "1rem 1.25rem", marginBottom: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between",
                        alignItems: "center", marginBottom: "0.55rem" }}>
            <span style={{ fontSize: "0.85rem", fontWeight: 600, color: C.text }}>
              ↓ Downloading <span style={{ fontFamily: "monospace", color: C.accent2 }}>{pulling}</span>
            </span>
            <span style={{ fontSize: "0.78rem", color: C.dim, fontFamily: "monospace" }}>
              {pullProg && pullProg.label}
              {pullProg && pullProg.pct != null ? `  ·  ${pullProg.pct}%` : ""}
            </span>
          </div>
          <div style={{ height: 8, background: C.bg, borderRadius: 5, overflow: "hidden",
                        border: `1px solid ${C.border}` }}>
            <div style={{
              height: "100%",
              width: pullProg && pullProg.pct != null ? `${pullProg.pct}%` : "100%",
              background: pullProg && pullProg.status === "done" ? C.green : C.accent,
              transition: "width 0.3s ease",
              // indeterminate shimmer while we have no % yet (e.g. "pulling manifest")
              opacity: pullProg && pullProg.pct == null ? 0.5 : 1,
            }} />
          </div>
          <div style={{ fontSize: "0.72rem", color: C.dim, marginTop: "0.45rem" }}>
            Runs in the background — you can keep searching and queue the next one after.
          </div>
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
