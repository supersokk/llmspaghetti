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
 * problem). SSH control (host-side, as root@node with a core key) adds diagnostics
 * now — push-installs (GPU drivers/ComfyUI) build on the same channel next.
 */
import React, { useState, useEffect, useCallback, useRef } from "react";
import { downloads } from "../downloads.js";

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

const ROUTER_PORT = 5000;
const NODES_PATH  = "/opt/llmspaghetti/config/nodes.yaml";
const PATHFIX = "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; ";

// The core's SSH identity for pushing to nodes (installs run as root@node). One key
// for all nodes; generated on demand, authorized on each node once (node-bootstrap's
// CORE_SSH_KEY hook, or the one-liner this tab shows).
const KEY_PATH = "/opt/llmspaghetti/config/node_ssh_key";
const PUB_PATH = KEY_PATH + ".pub";

// Keep ONLY the actual key line. The pubkey gets interpolated into a command the
// user pastes as root on a node, so never trust stray output (ssh-keygen's banner,
// a warning line) to be part of it.
function parsePubkey(out) {
  const line = (out || "").split("\n").map(s => s.trim()).find(s => /^ssh-[a-z0-9-]+ \S+/i.test(s));
  return line || "";
}

const rget = (path) => cockpit.http(ROUTER_PORT).get(path).then(b => JSON.parse(b || "{}")).catch(() => ({}));
const run  = (cmd, opts = {}) => cockpit.spawn(["bash", "-c", PATHFIX + cmd], { superuser: "try", err: "message", ...opts });

const REPO = "https://github.com/supersokk/llmspaghetti";
const NODE_SRC = "/opt/llmspaghetti-src";

// Installs run the node's OWN checkout of our scripts — install-gpu-drivers.sh
// sources gpu-detect.sh, so piping a lone script over stdin would break. Freshen
// (or clone) the source first, then run the script from it. Keep these free of
// single quotes: they're passed inside ssh '…'.
const SRC_FRESH =
  `set -e; if [ -d ${NODE_SRC}/.git ]; then ` +
  `git -C ${NODE_SRC} fetch --depth 1 origin main && git -C ${NODE_SRC} reset --hard origin/main; ` +
  `else rm -rf ${NODE_SRC} && git clone --depth 1 ${REPO} ${NODE_SRC}; fi`;

// Ollama URL (http://host:11434) → bare host for SSH.
const hostFromUrl = (url) => (url || "").replace(/^https?:\/\//, "").replace(/[:/].*$/, "");

// Hardware stats over SSH. Emits raw lines under markers and we parse here — awk
// would need single quotes, and the whole command rides inside ssh '…'.
const STATS_CMD =
  "echo @VRAM; nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | head -1; " +
  "echo @RAM; free -m | grep -i ^Mem:; " +
  "echo @DISK; df -BG / | tail -1";

function parseStats(out) {
  const sec = { VRAM: "", RAM: "", DISK: "" };
  let cur = null;
  for (const raw of (out || "").split("\n")) {
    const l = raw.trim();
    if (l.startsWith("@")) { cur = l.slice(1); continue; }
    if (cur && l && !sec[cur]) sec[cur] = l;
  }
  const s = {};
  // "3200, 8192" (MiB)
  const v = sec.VRAM.split(",").map(x => parseInt(x, 10));
  if (v.length === 2 && !isNaN(v[0]) && !isNaN(v[1]) && v[1] > 0)
    s.vram = { used: v[0] / 1024, total: v[1] / 1024 };
  // "Mem:  15872  1234  ..."  → total used
  const m = sec.RAM.split(/\s+/);
  if (m.length >= 3 && !isNaN(+m[1]) && +m[1] > 0)
    s.ram = { used: +m[2] / 1024, total: +m[1] / 1024 };
  // "/dev/sda1  234G  40G  183G  18% /" → size used
  const d = sec.DISK.split(/\s+/);
  if (d.length >= 4) {
    const size = parseFloat(d[1]), used = parseFloat(d[2]);
    if (!isNaN(size) && !isNaN(used) && size > 0) s.disk = { used, total: size };
  }
  return s;
}
// SSH to a node as root with the core key. accept-new auto-trusts a new LAN host key
// (avoids an interactive prompt that would hang); BatchMode fails fast if unauthorized.
const sshBase = (host) =>
  `ssh -i ${KEY_PATH} -o IdentitiesOnly=yes -o BatchMode=yes ` +
  `-o StrictHostKeyChecking=accept-new -o ConnectTimeout=6 root@${host}`;

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
  // Pull progress lives in the shared, module-level downloads manager so it
  // survives this tab being unmounted on tab-switch (Cockpit does that) — and
  // node pulls also show up in the Downloads tab.
  const [dl, setDl]         = useState({ active: [], history: [] });
  const [pubkey, setPubkey] = useState(null);   // core SSH pubkey, "" = none yet, null = loading
  const [showSsh, setShowSsh] = useState(false);
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    const res = await rget("/api/nodes");
    setNodes(Array.isArray(res.nodes) ? res.nodes : []);
    setLoading(false);
  }, []);

  const loadKey = useCallback(() => {
    run(`cat ${PUB_PATH} 2>/dev/null || true`).then(k => setPubkey(parsePubkey(k))).catch(() => setPubkey(""));
  }, []);

  // Generate the core's SSH keypair (once) so it can push installs to nodes as root.
  // -q + >/dev/null: ssh-keygen otherwise prints a banner/fingerprint/randomart on
  // stdout, which would end up inside the authorize command we tell the user to run
  // as root on a node. </dev/null so an existing key can't hang on an overwrite prompt.
  const genKey = async () => {
    setBusy(true);
    try {
      await run(
        `install -d -m 700 "$(dirname ${KEY_PATH})" && ` +
        `ssh-keygen -q -t ed25519 -N '' -C llmspaghetti-core -f ${KEY_PATH} </dev/null >/dev/null && ` +
        `chmod 600 ${KEY_PATH}`);
      const k = await run(`cat ${PUB_PATH}`);
      setPubkey(parsePubkey(k));
      setAlert({ type: "ok", msg: "Core SSH key generated — authorize it on each node (command below)." });
    } catch (e) {
      setAlert({ type: "err", msg: `Key generation failed: ${e.message || e}` });
    } finally { setBusy(false); }
  };

  useEffect(() => {
    load();
    loadKey();
    pollRef.current = setInterval(load, 10000);   // refresh status
    const unsub = downloads.subscribe(setDl);
    return () => { clearInterval(pollRef.current); unsub(); };
  }, [load, loadKey]);

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

  // Pull a model onto a node — handed to the shared manager so progress persists
  // across tab switches (and appears in the Downloads tab).
  const pullModel = (node, model) => {
    model = model.trim();
    if (!model) return;
    if (!downloads.startNodePull({ nodeId: node.id, nodeUrl: node.url, model }))
      setAlert({ type: "err", msg: `${model} is already pulling on ${node.id}` });
  };

  // Delete a model from a node — Ollama's DELETE /api/delete, so no SSH needed.
  // If the node was serving it, drop it from nodes.yaml too, or routing would keep
  // sending that model to a node that no longer has it.
  const deleteModel = async (node, model) => {
    if (!confirm(`Delete ${model} from ${node.id}?\n\nRemoves the model files from the node's disk. It can be pulled again later.`))
      return;
    setBusy(true);
    try {
      await run(`curl -sf -X DELETE ${node.url}/api/delete -d '{"model":"${model}"}'`);
      if ((node.models || []).includes(model)) {
        await cockpit.file(NODES_PATH, { superuser: "try" }).replace(serializeNodes(
          nodes.map(n => n.id !== node.id ? stripLive(n)
            : { id: n.id, url: n.url, models: (n.models || []).filter(m => m !== model) })));
      }
      setAlert({ type: "ok", msg: `${model} deleted from ${node.id}` });
      await load();
    } catch (e) {
      setAlert({ type: "err", msg: `Could not delete ${model} from ${node.id}: ${e.message || e}` });
    } finally { setBusy(false); }
  };

  // Push an install/control action to a node over SSH. Runs through the shared job
  // manager so a multi-minute driver install survives a tab switch and shows in
  // the Downloads tab.
  const pushAction = (node, label, remote, doneMsg) => {
    const cmd = `${sshBase(hostFromUrl(node.url))} '${remote}'`;
    if (!downloads.startJob({ name: `${label} → ${node.id}`, node: node.id, cmd, doneMsg }))
      setAlert({ type: "err", msg: `${label} is already running on ${node.id}` });
  };

  // When a node pull finishes (active job count for nodes drops), refresh so the
  // freshly-pulled model shows up in the node's installed list.
  const prevNodeJobs = useRef(0);
  useEffect(() => {
    const n = dl.active.filter(j => j.node).length;
    if (n < prevNodeJobs.current) load();
    prevNodeJobs.current = n;
  }, [dl, load]);

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

      <SshBanner pubkey={pubkey} show={showSsh} onToggle={() => setShowSsh(v => !v)}
        onGen={genKey} busy={busy} />

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
            <NodeCard key={node.id} node={node} busy={busy} hasKey={!!pubkey}
              pull={dl.active.find(j => j.node === node.id && j.kind === "model")}
              job={dl.active.find(j => j.node === node.id && j.kind === "job")}
              lastJob={dl.history.find(h => h.node === node.id && h.kind === "job")}
              onRemove={() => removeNode(node.id)} onToggle={m => toggleServe(node, m)}
              onPull={m => pullModel(node, m)} onDelete={m => deleteModel(node, m)}
              onAction={(label, remote, doneMsg) => pushAction(node, label, remote, doneMsg)} />
          ))}
        </div>
      )}
    </div>
  );
}

function NodeCard({ node, pull, job, lastJob, busy, hasKey, onRemove, onToggle, onPull, onDelete, onAction }) {
  const [pm, setPm] = useState("");
  const [ssh, setSsh] = useState(null);   // null | "testing" | { ok, out }
  const [stats, setStats] = useState(null);
  const served = new Set(node.models || []);
  const installed = node.installed || [];
  // Resident RIGHT NOW (node's /api/ps) — distinct from served (routing config) and
  // installed (on disk). Ollama only loads a model when a request arrives, so a
  // served+installed model shows nothing here until it's actually used.
  const loaded = new Map((node.loaded || []).map(l => [l.name, l.vram_mb]));
  // Models the node is set to serve but hasn't actually pulled yet — worth flagging.
  const missing = (node.models || []).filter(m => !installed.includes(m));

  const host = hostFromUrl(node.url);

  // Hardware stats need SSH (Ollama's API can't report total VRAM / RAM / disk).
  // Poll slowly — it's a login per refresh.
  useEffect(() => {
    if (!hasKey || !node.reachable) { setStats(null); return; }
    let alive = true;
    const tick = () => run(`${sshBase(host)} '${STATS_CMD}'`)
      .then(out => { if (alive) setStats(parseStats(out)); })
      .catch(() => { if (alive) setStats(null); });
    tick();
    const t = setInterval(tick, 30000);
    return () => { alive = false; clearInterval(t); };
  }, [hasKey, node.reachable, host]);
  const testSsh = () => {
    setSsh("testing");
    run(sshBase(host) +
      " 'echo SSHOK; uname -sr; nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -1; ollama --version 2>/dev/null | head -1'")
      .then(out => setSsh({ ok: out.includes("SSHOK"), out: out.trim() }))
      .catch(e   => setSsh({ ok: false, out: (e && e.message) || String(e) }));
  };

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

      {/* Hardware — what the node actually has left */}
      {stats && (
        <div style={{ display: "flex", gap: "1.2rem", flexWrap: "wrap", marginBottom: "0.8rem" }}>
          {stats.vram && <Meter label="VRAM" used={stats.vram.used} total={stats.vram.total} unit="GB" />}
          {stats.ram  && <Meter label="RAM"  used={stats.ram.used}  total={stats.ram.total}  unit="GB" />}
          {stats.disk && <Meter label="Disk" used={stats.disk.used} total={stats.disk.total} unit="GB" />}
        </div>
      )}

      <div style={{ fontSize: "0.72rem", color: C.dim, textTransform: "uppercase",
                    letterSpacing: "0.05em", marginBottom: "0.4rem" }}>
        Models on this node {node.reachable ? `(${installed.length})` : "(node unreachable)"}
      </div>
      {installed.length === 0 ? (
        <div style={{ fontSize: "0.82rem", color: C.dim, marginBottom: "0.6rem" }}>
          {node.reachable ? "No models pulled on this node yet — pull one below." : "—"}
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.4rem" }}>
            {installed.map(m => {
              const on = served.has(m);
              const vram = loaded.get(m);
              return (
                <span key={m} style={{ display: "inline-flex", alignItems: "center",
                                       borderRadius: 16, overflow: "hidden",
                                       background: on ? "rgba(47,129,247,.16)" : C.bg,
                                       border: `1px solid ${on ? C.accent : C.border}` }}>
                  <button onClick={() => onToggle(m)} disabled={busy}
                    title={on ? "Serving — click to stop routing here" : "Click to serve (route this model to this node)"}
                    style={{ ...pill, background: "transparent", border: "none",
                             cursor: busy ? "wait" : "pointer",
                             color: on ? C.accent2 : C.dim }}>
                    {on ? "✓ " : ""}{m}
                    {vram != null && (
                      <span style={{ color: C.green, marginLeft: 6 }}>
                        ● {(vram / 1024).toFixed(1)}GB
                      </span>
                    )}
                  </button>
                  <button onClick={() => onDelete(m)} disabled={busy} title={`Delete ${m} from the node`}
                    style={{ background: "transparent", border: "none", color: C.dim,
                             cursor: busy ? "wait" : "pointer", fontSize: "0.8rem",
                             padding: "0.22rem 0.5rem 0.22rem 0.1rem", fontFamily: "inherit" }}>
                    ✕
                  </button>
                </span>
              );
            })}
          </div>
          <div style={{ fontSize: "0.72rem", color: C.dim, marginBottom: "0.7rem" }}>
            <span style={{ color: C.accent2 }}>✓ serving</span> = the router routes this model here ·{" "}
            <span style={{ color: C.green }}>● loaded</span> = in the node's VRAM right now
            (Ollama loads a model on first request) · <strong>✕</strong> deletes it from the node
          </div>
        </>
      )}

      {/* Pull a model onto this node */}
      {pull ? (
        <div style={{ marginTop: "0.4rem" }}>
          <div style={{ fontSize: "0.78rem", color: C.dim, marginBottom: 4 }}>
            ↓ {pull.model} — {pull.label}{pull.pct != null ? ` · ${pull.pct}%` : ""}
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

      {/* SSH control — diagnostics now; push-installs land here next */}
      <div style={{ marginTop: "0.85rem", paddingTop: "0.7rem", borderTop: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <span style={{ fontSize: "0.72rem", color: C.dim, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            SSH control
          </span>
          <button onClick={testSsh} disabled={!hasKey || ssh === "testing"}
            style={{ ...btn(C.surface2, C.text), border: `1px solid ${C.border}`,
                     opacity: hasKey ? 1 : 0.5, cursor: hasKey ? "pointer" : "not-allowed" }}>
            {ssh === "testing" ? "Testing…" : "Test SSH"}
          </button>
          {ssh && ssh !== "testing" && (
            <span style={{ fontSize: "0.75rem", color: ssh.ok ? C.green : C.red }}>
              {ssh.ok ? "✓ connected" : "✗ failed"}
            </span>
          )}
        </div>
        {!hasKey && (
          <div style={{ fontSize: "0.75rem", color: C.dim, marginTop: 5 }}>
            Generate a core key (🔑 SSH control, top) and authorize it on this node to enable push-installs.
          </div>
        )}
        {ssh && ssh !== "testing" && (
          <pre style={{ ...preBox, marginTop: 6, color: ssh.ok ? C.dim : C.red }}>{ssh.out || "(no output)"}</pre>
        )}

        {/* Push-installs — run the node's own scripts over SSH */}
        {hasKey && (job ? (
          <div style={{ marginTop: "0.7rem" }}>
            <div style={{ fontSize: "0.78rem", color: C.accent2, marginBottom: 4 }}>
              ⚙ {job.name} — <span style={{ color: C.dim }}>{job.label}</span>
            </div>
            <pre style={{ ...preBox, maxHeight: 160, overflowY: "auto", color: C.dim }}>
              {downloads.jobOutput(job.id) || "starting…"}
            </pre>
            <div style={{ fontSize: "0.72rem", color: C.dim, marginTop: 4 }}>
              Keeps running if you switch tabs — also listed in the Downloads tab.
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.6rem" }}>
            <button style={actionBtn} disabled={busy}
              onClick={() => onAction("Update source", SRC_FRESH, "Node source updated")}>
              ↻ Update source
            </button>
            <button style={actionBtn} disabled={busy}
              onClick={() => confirm(
                `Install GPU drivers on ${node.id}?\n\nThis takes several minutes and the node must REBOOT afterwards.`)
                && onAction("Install GPU drivers",
                     `${SRC_FRESH}; bash ${NODE_SRC}/scripts/install-gpu-drivers.sh`,
                     "GPU drivers installed — reboot the node")}>
              🎮 Install GPU drivers
            </button>
            <button style={actionBtn} disabled={busy}
              onClick={() => confirm(
                `Install ComfyUI on ${node.id}?\n\nClones ComfyUI + a torch venv (several GB, takes a while) and runs it as a service on port 8188.\n\nAfterwards: Image tab → "Run on" → ${node.id} to send image generation there.`)
                && onAction("Install ComfyUI",
                     `${SRC_FRESH}; bash ${NODE_SRC}/scripts/comfyui-setup.sh`,
                     `ComfyUI installed on ${node.id} — set Image tab → Run on → ${node.id}`)}>
              🖼 Install ComfyUI
            </button>
            <button style={actionBtn} disabled={busy}
              onClick={() => onAction("Restart Ollama",
                "systemctl restart ollama && sleep 1 && systemctl is-active ollama",
                "Ollama restarted")}>
              ↻ Restart Ollama
            </button>
            <button style={{ ...actionBtn, color: C.yellow }} disabled={busy}
              onClick={() => confirm(`Reboot ${node.id}? It will be unreachable for a minute.`)
                && onAction("Reboot node",
                     "(sleep 1 && systemctl reboot) >/dev/null 2>&1 & echo rebooting",
                     "Reboot sent")}>
              ⏻ Reboot node
            </button>
          </div>
        ))}

        {/* Result of the last push — these finish in ~1s, so the live log alone is
            unreadable. Keep the outcome (and its output) visible until the next run. */}
        {hasKey && !job && lastJob && (
          <div style={{ marginTop: "0.6rem" }}>
            <div style={{ fontSize: "0.78rem", color: lastJob.phase === "done" ? C.green : C.red }}>
              {lastJob.phase === "done" ? "✓" : "✗"} {lastJob.msg}
              <span style={{ color: C.dim }}> · {new Date(lastJob.endedAt).toLocaleTimeString()}</span>
            </div>
            {lastJob.out && (
              <details style={{ marginTop: 4 }}>
                <summary style={{ fontSize: "0.75rem", color: C.dim, cursor: "pointer" }}>
                  show output
                </summary>
                <pre style={{ ...preBox, maxHeight: 200, overflowY: "auto", color: C.dim }}>{lastJob.out}</pre>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SshBanner({ pubkey, show, onToggle, onGen, busy }) {
  const authorizeCmd = pubkey
    ? `sudo install -d -m700 /root/.ssh && echo '${pubkey}' | sudo tee -a /root/.ssh/authorized_keys >/dev/null && sudo chmod 600 /root/.ssh/authorized_keys`
    : "";
  return (
    <div style={{ ...card, marginBottom: "1rem", padding: "0.7rem 1rem" }}>
      <div onClick={onToggle}
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
        <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>
          🔑 SSH control{" "}
          {pubkey
            ? <span style={{ color: C.green, fontWeight: 400 }}>· key ready</span>
            : <span style={{ color: C.dim,   fontWeight: 400 }}>· no key yet</span>}
        </span>
        <span style={{ color: C.dim }}>{show ? "▾" : "▸"}</span>
      </div>
      {show && (
        <div style={{ marginTop: "0.7rem", fontSize: "0.82rem", color: C.dim, lineHeight: 1.5 }}>
          The core pushes installs to nodes as <code style={{ color: C.accent2 }}>root</code> over SSH.
          Generate one key here, then authorize it on each node once.
          {pubkey === "" && (
            <div style={{ marginTop: 8 }}>
              <button onClick={onGen} disabled={busy} style={btn(C.accent, "#fff")}>Generate core SSH key</button>
            </div>
          )}
          {pubkey && (
            <>
              <div style={{ marginTop: 10, color: C.text, fontWeight: 600, fontSize: "0.75rem" }}>Core public key</div>
              <pre style={preBox}>{pubkey}</pre>
              <div style={{ marginTop: 10, color: C.text, fontWeight: 600, fontSize: "0.75rem" }}>
                Run once on each node (as a sudo user) to authorize the core:
              </div>
              <pre style={preBox}>{authorizeCmd}</pre>
              <div style={{ marginTop: 6, fontSize: "0.75rem" }}>
                …or set up the node with <code style={{ color: C.accent2 }}>CORE_SSH_KEY=…</code> and it's authorized from the start.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Meter({ label, used, total, unit }) {
  const pct = total > 0 ? Math.min(100, Math.round(used / total * 100)) : 0;
  const color = pct >= 90 ? C.red : pct >= 75 ? C.yellow : C.green;
  return (
    <div style={{ minWidth: 140, flex: "0 1 170px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.72rem",
                    color: C.dim, marginBottom: 3 }}>
        <span>{label}</span>
        <span style={{ fontFamily: "monospace", color: C.text }}>
          {used.toFixed(1)}/{total.toFixed(1)} {unit}
        </span>
      </div>
      <div style={{ height: 5, background: C.border, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, transition: "width .3s" }} />
      </div>
    </div>
  );
}

// Drop the router's live-status fields before writing back to nodes.yaml.
function stripLive(n) { return { id: n.id, url: n.url, models: n.models || [] }; }

const card  = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "1.1rem 1.25rem" };
const input = { background: C.bg, border: `1px solid ${C.border}`, color: C.text, borderRadius: 6,
                padding: "0.4rem 0.6rem", fontSize: "0.85rem", fontFamily: "inherit", outline: "none", marginTop: 4 };
const pill  = { borderRadius: 16, padding: "0.22rem 0.6rem", fontSize: "0.76rem", fontWeight: 600, fontFamily: "monospace" };
const actionBtn = { background: C.surface2, color: C.text, border: `1px solid ${C.border}`,
                    borderRadius: 7, padding: "0.35rem 0.7rem", fontSize: "0.78rem", fontWeight: 600,
                    cursor: "pointer", fontFamily: "inherit" };
const preBox = { marginTop: 4, padding: "0.5rem 0.6rem", background: C.bg, border: `1px solid ${C.border}`,
                 borderRadius: 6, fontSize: "0.72rem", color: C.text, whiteSpace: "pre-wrap",
                 wordBreak: "break-all", overflowX: "auto", fontFamily: "monospace" };
function btn(bg, color) {
  return { background: bg, color, border: "none", borderRadius: 7, padding: "0.4rem 0.8rem",
           fontSize: "0.82rem", fontWeight: 600, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 };
}
