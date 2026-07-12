/*
 * Nodes tab — manage LLMSpaghetti compute nodes (multi-node).
 *
 * A node is a separate box running Ollama on the LAN (see node-bootstrap.sh). This
 * tab lists them with live status, lets you add/remove them, choose which of a
 * node's installed models it *serves* (that drives routing — the router forwards
 * those models to this node), and pull models onto a node via its Ollama HTTP API
 * (no SSH needed). Writes config/nodes.yaml (the router hot-reloads it).
 *
 * Data comes from the router's /api/nodes (server-side, so node status has no CORS
 * problem). SSH-push installs (ComfyUI/drivers on a node) are a later addition.
 */
import React, { useState, useEffect, useCallback, useRef } from "react";

const cockpit = window.cockpit || {
  spawn: () => ({ stream: () => {}, then: (f) => { f(""); return { catch: () => {} }; }, catch: () => {}, close: () => {} }),
  file:  () => ({ read: () => Promise.resolve(""), replace: () => Promise.resolve() }),
  http:  () => ({ get: () => Promise.resolve("{}"), request: () => Promise.resolve("{}") }),
};

const C = {
  bg: "#0d1117", surface: "#161b22", surface2: "#1c2230", border: "#30363d",
  accent: "#2f81f7", accent2: "#58a6ff", green: "#3fb950", yellow: "#d29922",
  red: "#f85149", text: "#e6edf3", dim: "#8b949e", purple: "#bc8cff",
};

const PATHFIX = "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; ";
const ROUTER_PORT = 5000;
const NODES_PATH  = "/opt/llmspaghetti/config/nodes.yaml";

const rget = (path) => cockpit.http(ROUTER_PORT).get(path).then(b => JSON.parse(b || "{}")).catch(() => ({}));

// Serialize nodes → nodes.yaml (matches the router's parser: nodes: [{id,url,models}]).
function serializeNodes(nodes) {
  const lines = [
    "# LLMSpaghetti — compute nodes (multi-node). Managed by the Nodes tab.",
    "# A model listed under a node is served there (router forwards it to the node).",
    "",
  ];
  if (!nodes.length) { lines.push("nodes: []"); }
  else {
    lines.push("nodes:");
    for (const n of nodes) {
      lines.push(`  - id: ${n.id}`);
      lines.push(`    url: ${n.url}`);
      if (n.models && n.models.length) {
        lines.push("    models:");
        for (const m of n.models) lines.push(`      - ${m}`);
      } else {
        lines.push("    models: []");
      }
    }
  }
  return lines.join("\n") + "\n";
}

export default function Nodes() {
  const [nodes, setNodes]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy]     = useState(false);
  const [alert, setAlert]   = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm]     = useState({ id: "", url: "" });
  const [pull, setPull]     = useState({});   // {nodeUrl: {model, pct, status}}
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    const res = await rget("/api/nodes");
    setNodes(Array.isArray(res.nodes) ? res.nodes : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    pollRef.current = setInterval(load, 10000);   // refresh status
    return () => clearInterval(pollRef.current);
  }, [load]);

  // Persist the current node list to nodes.yaml, then reload from the router.
  const save = async (next) => {
    setBusy(true);
    try {
      await cockpit.file(NODES_PATH, { superuser: "try" }).replace(serializeNodes(next));
      await load();
    } catch (e) {
      setAlert({ type: "err", msg: `Could not save nodes.yaml: ${e.message || e}` });
    } finally {
      setBusy(false);
    }
  };

  const addNode = async () => {
    const id  = form.id.trim();
    let url = form.url.trim();
    if (!id || !url) { setAlert({ type: "err", msg: "Give the node an id and a URL." }); return; }
    if (!/^https?:\/\//.test(url)) url = "http://" + url;      // default scheme
    if (!/:\d+/.test(url)) url = url.replace(/\/+$/, "") + ":11434"; // default Ollama port
    if (nodes.some(n => n.id === id || n.url === url)) {
      setAlert({ type: "err", msg: "A node with that id or URL already exists." }); return;
    }
    setAlert(null);
    await save([...nodes.map(stripLive), { id, url, models: [] }]);
    setForm({ id: "", url: "" }); setShowAdd(false);
  };

  const removeNode = async (id) => {
    if (!confirm(`Remove node "${id}"? Models it served fall back to the local Ollama.`)) return;
    await save(nodes.filter(n => n.id !== id).map(stripLive));
  };

  // Toggle whether a node SERVES an installed model (adds/removes it from models[]).
  const toggleServe = async (node, model) => {
    const serves = (node.models || []).includes(model);
    const next = nodes.map(n => n.id !== node.id ? stripLive(n) : {
      id: n.id, url: n.url,
      models: serves ? n.models.filter(m => m !== model) : [...(n.models || []), model],
    });
    await save(next);
  };

  // Pull a model onto a node via its Ollama /api/pull (streamed JSON progress).
  const pullModel = (node, model) => {
    model = model.trim();
    if (!model) return;
    setPull(p => ({ ...p, [node.url]: { model, pct: null, status: "starting…" } }));
    const cmd = `curl -sN -X POST ${node.url}/api/pull -d '{"model":"${model}"}'`;
    const proc = cockpit.spawn(["bash", "-c", PATHFIX + cmd], { err: "message" });
    proc.stream(d => {
      for (const ln of d.split("\n").filter(Boolean)) {
        let j; try { j = JSON.parse(ln); } catch { continue; }
        const pct = (j.total && j.completed) ? Math.round(j.completed / j.total * 100) : null;
        setPull(p => ({ ...p, [node.url]: { model, pct: pct != null ? pct : (p[node.url] || {}).pct, status: j.status || "…" } }));
      }
    });
    proc.then(
      () => { setPull(p => { const n = { ...p }; delete n[node.url]; return n; });
              setAlert({ type: "ok", msg: `${model} pulled onto ${node.id}` }); load(); },
      (e) => { setPull(p => { const n = { ...p }; delete n[node.url]; return n; });
               setAlert({ type: "err", msg: `Pull failed on ${node.id}: ${e.message || e}` }); },
    );
  };

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.4rem" }}>
        <h2 style={{ fontSize: "1.05rem", fontWeight: 700 }}>Compute Nodes</h2>
        <button onClick={() => setShowAdd(v => !v)} disabled={busy}
          style={btn(C.accent, "#fff")}>+ Add node</button>
      </div>
      <div style={{ fontSize: "0.82rem", color: C.dim, marginBottom: "1.1rem", lineHeight: 1.5 }}>
        Separate GPU/CPU boxes running Ollama on the LAN. Pick which models each node
        <strong> serves</strong> — the router forwards those to the node instead of localhost.
        Set up a node with <code style={{ color: C.accent2 }}>node-bootstrap.sh</code>.
      </div>

      {alert && (
        <div style={{ padding: "0.6rem 0.9rem", borderRadius: 8, marginBottom: "1rem",
                      fontSize: "0.85rem",
                      background: alert.type === "ok" ? "rgba(63,185,80,.12)" : "rgba(248,81,73,.12)",
                      border: `1px solid ${alert.type === "ok" ? C.green : C.red}40`,
                      color: alert.type === "ok" ? C.green : C.red }}>{alert.msg}</div>
      )}

      {showAdd && (
        <div style={{ ...card, marginBottom: "1rem", display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ fontSize: "0.78rem", color: C.dim }}>Node id
            <input value={form.id} onChange={e => setForm(f => ({ ...f, id: e.target.value }))}
              placeholder="node1" style={input} />
          </label>
          <label style={{ fontSize: "0.78rem", color: C.dim, flex: 1, minWidth: 220 }}>Ollama URL
            <input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
              placeholder="10.22.22.163  (→ http://…:11434)" style={{ ...input, width: "100%" }} />
          </label>
          <button onClick={addNode} disabled={busy} style={btn(C.green, "#fff")}>Add</button>
        </div>
      )}

      {loading ? (
        <div style={{ color: C.dim, padding: "2rem", fontSize: "0.9rem" }}>Loading nodes…</div>
      ) : nodes.length === 0 ? (
        <div style={{ ...card, color: C.dim, fontSize: "0.88rem" }}>
          No compute nodes yet — you're in single-box mode (everything runs on the local Ollama).
          Add one to route specific models to a GPU box on your LAN.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {nodes.map(node => (
            <NodeCard key={node.id} node={node} pull={pull[node.url]} busy={busy}
              onRemove={() => removeNode(node.id)} onToggle={m => toggleServe(node, m)}
              onPull={m => pullModel(node, m)} />
          ))}
        </div>
      )}
    </div>
  );
}

function NodeCard({ node, pull, busy, onRemove, onToggle, onPull }) {
  const [pm, setPm] = useState("");
  const served = new Set(node.models || []);
  const installed = node.installed || [];
  // Models the node is set to serve but hasn't actually pulled yet — worth flagging.
  const missing = (node.models || []).filter(m => !installed.includes(m));

  return (
    <div style={{ ...card, borderColor: node.reachable ? C.green + "40" : C.red + "40" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.6rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.55rem" }}>
          <span style={{ width: 9, height: 9, borderRadius: "50%", background: node.reachable ? C.green : C.red }} />
          <span style={{ fontWeight: 700 }}>{node.id}</span>
          <span style={{ fontFamily: "monospace", fontSize: "0.78rem", color: C.dim }}>{node.url}</span>
          <span style={{ fontSize: "0.72rem", color: node.reachable ? C.green : C.red }}>
            {node.reachable ? "reachable" : "unreachable"}
          </span>
        </div>
        <button onClick={onRemove} disabled={busy} style={{ ...btn("transparent", C.dim), border: `1px solid ${C.border}` }}>
          Remove
        </button>
      </div>

      {missing.length > 0 && (
        <div style={{ fontSize: "0.75rem", color: C.yellow, marginBottom: "0.5rem" }}>
          ⚠ Served but not installed on the node: {missing.join(", ")} — pull them below.
        </div>
      )}

      <div style={{ fontSize: "0.72rem", color: C.dim, textTransform: "uppercase",
                    letterSpacing: "0.05em", marginBottom: "0.4rem" }}>
        Installed models {node.reachable ? `(${installed.length})` : "(node unreachable)"}
      </div>
      {installed.length === 0 ? (
        <div style={{ fontSize: "0.82rem", color: C.dim, marginBottom: "0.6rem" }}>
          {node.reachable ? "No models pulled on this node yet — pull one below." : "—"}
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.7rem" }}>
          {installed.map(m => {
            const on = served.has(m);
            return (
              <button key={m} onClick={() => onToggle(m)} disabled={busy} title={on ? "Serving — click to stop" : "Click to serve (route this model here)"}
                style={{ ...pill, cursor: busy ? "wait" : "pointer",
                         background: on ? "rgba(47,129,247,.16)" : C.bg,
                         border: `1px solid ${on ? C.accent : C.border}`,
                         color: on ? C.accent2 : C.dim }}>
                {on ? "✓ " : ""}{m}
              </button>
            );
          })}
        </div>
      )}

      {/* Pull a model onto this node */}
      {pull ? (
        <div style={{ marginTop: "0.4rem" }}>
          <div style={{ fontSize: "0.78rem", color: C.dim, marginBottom: 4 }}>
            ↓ {pull.model} — {pull.status}{pull.pct != null ? ` · ${pull.pct}%` : ""}
          </div>
          <div style={{ height: 6, background: C.border, borderRadius: 4, overflow: "hidden" }}>
            <div style={{ height: "100%", width: pull.pct != null ? `${pull.pct}%` : "100%",
                          background: C.accent, opacity: pull.pct == null ? 0.5 : 1, transition: "width .3s" }} />
          </div>
        </div>
      ) : node.reachable && (
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.3rem" }}>
          <input value={pm} onChange={e => setPm(e.target.value)}
            onKeyDown={e => e.key === "Enter" && pm.trim() && onPull(pm)}
            placeholder="pull a model onto this node… e.g. qwen2.5-coder:3b"
            style={{ ...input, flex: 1 }} />
          <button onClick={() => pm.trim() && onPull(pm)} disabled={busy || !pm.trim()}
            style={btn(C.accent, "#fff")}>↓ Pull</button>
        </div>
      )}
    </div>
  );
}

// Drop the router's live-status fields before writing back to nodes.yaml.
function stripLive(n) { return { id: n.id, url: n.url, models: n.models || [] }; }

const card  = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "1.1rem 1.25rem" };
const input = { background: C.bg, border: `1px solid ${C.border}`, color: C.text, borderRadius: 6,
                padding: "0.4rem 0.6rem", fontSize: "0.85rem", fontFamily: "inherit", outline: "none", marginTop: 4 };
const pill  = { borderRadius: 16, padding: "0.22rem 0.6rem", fontSize: "0.76rem", fontWeight: 600, fontFamily: "monospace" };
function btn(bg, color) {
  return { background: bg, color, border: "none", borderRadius: 7, padding: "0.4rem 0.8rem",
           fontSize: "0.82rem", fontWeight: 600, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 };
}
