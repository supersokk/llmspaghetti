/*
 * Shared download manager — module-level singleton.
 *
 * Cockpit unmounts a tab's React component when you switch tabs (or refresh the
 * webview), which kills any download state held in component `useState`. That's
 * why the Models-tab pull bars used to vanish. This manager lives OUTSIDE React,
 * so the spawned process AND its progress survive tab switches. Both the Models
 * tab (Ollama pulls) and the Image Generator tab (checkpoint files) push jobs
 * here; the Downloads tab renders active jobs + a history log with Clear.
 *
 * Components `subscribe(fn)` to get `{active, history}` snapshots while mounted.
 */

const PATHFIX =
  "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; ";

// Real Cockpit exposes `window.cockpit`; fall back to a no-op for dev/build.
const _ck =
  (typeof window !== "undefined" && window.cockpit)
    ? window.cockpit
    : { spawn: () => ({ stream() {}, then(f) { f && f(""); return { catch() {} }; }, catch() {}, close() {} }) };

let _seq = 0;
const MAX_HISTORY = 100;
// Reload-unique id (the _seq counter resets on refresh, but restored history keeps
// old ids — a timestamp prefix keeps new ids from colliding as React keys).
function _nextId() { return `${Date.now().toString(36)}-${(++_seq).toString(36)}`; }

// History persists to localStorage so it survives a full page refresh (the
// in-memory manager is re-created on reload). Active downloads can't survive a
// reload — their spawned process channel dies with the page — so only history is
// stored.
const HISTORY_KEY = "spag-downloads-history";
function _loadHistory() {
  try {
    const raw = (typeof localStorage !== "undefined") && localStorage.getItem(HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.slice(0, MAX_HISTORY) : [];
  } catch { return []; }
}
function _saveHistory(history) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch { /* quota / unavailable — ignore */ }
}

// Human-readable bytes, e.g. 2684354560 → "2.5 GB". Whole numbers for bytes and
// for values ≥ 10 in a unit; one decimal otherwise, so a bar reads "2.6 / 6.9 GB".
function fmtBytes(n) {
  if (!n || n < 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 || v >= 10 ? 0 : 1)} ${u[i]}`;
}

// Ollama /api/pull JSON stream → {pct, label}. Each NDJSON line is one of:
//   {"status":"pulling <digest>","total":N,"completed":M}   ← byte progress
//   {"status":"pulling manifest" | "verifying …" | "success"}  ← phase only
// Byte-exact and TTY-independent — the CLI's text bar froze ~1/3 in when piped
// through cockpit.spawn (no TTY), regardless of model. pct is null on
// status-only lines so the caller keeps the last known percentage.
function parsePull(chunk) {
  let pct = null, label = null;
  for (const ln of chunk.split("\n")) {
    if (!ln.trim()) continue;
    let j; try { j = JSON.parse(ln); } catch { continue; }
    if (typeof j.total === "number" && typeof j.completed === "number" && j.total > 0) {
      pct   = Math.min(100, Math.round(j.completed / j.total * 100));
      label = `${fmtBytes(j.completed)} / ${fmtBytes(j.total)}`;
    } else if (j.status) {
      label = j.status;
    }
  }
  return { pct, label };
}

// aria2c/wget stream → percent (both emit an "NN%").
function parseFile(chunk) {
  const tail = chunk.replace(/\r/g, "\n").split("\n").filter(Boolean).slice(-1)[0] || "";
  const m = tail.match(/(\d+)%/);
  return { pct: m ? Math.min(100, parseInt(m[1], 10)) : null };
}

export const downloads = {
  active: [],              // [{id, kind:"model"|"file", name, pct, label, phase:"run", startedAt, _proc, _out}]
  history: _loadHistory(), // [{id, kind, name, phase:"done"|"error", msg, endedAt}]  newest first
  listeners: new Set(),

  subscribe(fn) {
    this.listeners.add(fn);
    fn(this._snapshot());
    return () => this.listeners.delete(fn);
  },
  _snapshot() {
    // Strip the live process handle before handing state to React.
    const active = this.active.map(({ _proc, _out, ...rest }) => rest);
    return { active, history: this.history };
  },
  _emit() {
    const s = this._snapshot();
    this.listeners.forEach(fn => { try { fn(s); } catch { /* ignore */ } });
  },

  isActive(name) { return this.active.some(j => j.name === name); },
  busy() { return this.active.length > 0; },

  _patch(id, fields) {
    const j = this.active.find(x => x.id === id);
    if (!j) return;
    for (const k in fields) if (fields[k] !== undefined) j[k] = fields[k];
    this._emit();
  },
  _finish(id, phase, msg) {
    const i = this.active.findIndex(x => x.id === id);
    if (i === -1) return;
    const [j] = this.active.splice(i, 1);
    const entry = { id: j.id, kind: j.kind, name: j.name, phase, msg, endedAt: Date.now() };
    // Keep a node job's output — these finish in a second (a no-op `git fetch`), so
    // without this the log flashes past and there's no way to see what it did.
    // Capped: history is persisted to localStorage.
    if (j.node) entry.node = j.node;
    if (j._out) entry.out = j._out.slice(-2000);
    this.history.unshift(entry);
    this.history = this.history.slice(0, MAX_HISTORY);
    _saveHistory(this.history);
    this._emit();
  },
  clearHistory() { this.history = []; _saveHistory(this.history); this._emit(); },

  cancel(id) {
    const j = this.active.find(x => x.id === id);
    if (j && j._proc) { try { j._proc.close("terminated"); } catch { /* mock */ } }
    this._finish(id, "error", "Cancelled");
  },

  // ── Ollama model pull ──────────────────────────────────────────────────────
  // Uses the local Ollama /api/pull JSON stream (not `ollama pull`) so progress
  // is byte-exact — the CLI's text bar froze partway when piped through
  // cockpit.spawn. Same endpoint/parse as node pulls, so both show "M / N GB".
  startOllamaPull(modelId) {
    if (this.isActive(modelId)) return false;
    const id = _nextId();
    const cmd = `curl -sN -X POST http://localhost:11434/api/pull ` +
                `-d '{"model":${JSON.stringify(modelId)}}'`;
    const proc = _ck.spawn(["bash", "-c", PATHFIX + cmd], { err: "message" });
    this.active.push({ id, kind: "model", name: modelId, pct: null,
      label: "starting…", phase: "run", startedAt: Date.now(), _proc: proc });
    this._emit();
    proc.stream(d => {
      const p = parsePull(d);
      this._patch(id, { pct: p.pct != null ? p.pct : undefined, label: p.label || undefined });
    });
    proc.then(
      () => this._finish(id, "done", `${modelId} downloaded`),
      (e) => this._finish(id, "error", `Pull failed: ${(e && e.message) || e}`),
    );
    return true;
  },

  // ── Model pull onto a remote node — via the node's Ollama /api/pull (no SSH) ─
  startNodePull({ nodeId, nodeUrl, model }) {
    const name = `${model} → ${nodeId}`;   // dedup key: same model can pull on 2 nodes
    if (this.isActive(name)) return false;
    const id = _nextId();
    const cmd = `curl -sN -X POST ${nodeUrl}/api/pull -d '{"model":"${model}"}'`;
    const proc = _ck.spawn(["bash", "-c", PATHFIX + cmd], { err: "message" });
    this.active.push({ id, kind: "model", name, node: nodeId, model, pct: null,
      label: "starting…", phase: "run", startedAt: Date.now(), _proc: proc });
    this._emit();
    proc.stream(d => {
      const p = parsePull(d);
      this._patch(id, { pct: p.pct != null ? p.pct : undefined, label: p.label || undefined });
    });
    proc.then(
      () => this._finish(id, "done",  `${model} pulled onto ${nodeId}`),
      (e) => this._finish(id, "error", `Pull failed on ${nodeId}: ${(e && e.message) || e}`),
    );
    return true;
  },

  // ── Generic long-running job (e.g. an SSH push-install on a node) ───────────
  // Lives here for the same reason downloads do: the manager is module-level, so a
  // multi-minute install keeps running (and keeps its log) when Cockpit unmounts the
  // tab. err:"out" folds stderr into the stream — apt/driver installers talk there.
  startJob({ name, node, cmd, doneMsg }) {
    if (this.isActive(name)) return false;
    const id = _nextId();
    const proc = _ck.spawn(["bash", "-c", PATHFIX + cmd], { superuser: "try", err: "out" });
    const job = { id, kind: "job", name, node, pct: null, label: "running…",
                  phase: "run", startedAt: Date.now(), _proc: proc, _out: "" };
    this.active.push(job);
    this._emit();
    proc.stream(d => {
      job._out = (job._out + d).slice(-4000);          // rolling tail for the log view
      const last = d.split("\n").map(s => s.trim()).filter(Boolean).pop();
      if (last) this._patch(id, { label: last.slice(0, 70) });
    });
    proc.then(
      () => this._finish(id, "done",  doneMsg || `${name} finished`),
      (e) => this._finish(id, "error", `${name} failed: ${(e && e.message) || e}`),
    );
    return true;
  },

  // Rolling output of an active job (for a live log panel).
  jobOutput(id) {
    const j = this.active.find(x => x.id === id);
    return j ? (j._out || "") : "";
  },

  // ── Checkpoint download ONTO A NODE (image gen outsourced there) ────────────
  // The node downloads straight from the source — no double-hop through the core.
  // We ssh as root, locate the node's ComfyUI (whichever user owns it), download
  // into its models/<sub>/ and chown back to that user. Gated-repo token resolve
  // happens on the CORE first (existing pattern), then the node gets the signed
  // CDN URL. Quoting note: the remote script sits in DOUBLE quotes so the core
  // shell expands $URL into it, while \$-escaped vars run on the node.
  startNodeCheckpoint({ name, nodeId, host, keyPath, sub, outBase, url, sizeLabel, doneMsg, token }) {
    const jobName = `${name} → ${nodeId}`;
    if (this.isActive(jobName)) return false;
    const id = _nextId();
    const resolve = token
      ? `R=$(curl -sIL -H 'Authorization: Bearer ${token}' -o /dev/null -w '%{url_effective}' "$URL" 2>/dev/null); [ -n "$R" ] && URL="$R"; `
      : "";
    const ssh = `ssh -i ${keyPath} -o IdentitiesOnly=yes -o BatchMode=yes ` +
                `-o StrictHostKeyChecking=accept-new -o ConnectTimeout=6 root@${host}`;
    const remote =
      `C=\\$(ls -d /home/*/ComfyUI /root/ComfyUI 2>/dev/null | head -1); ` +
      `[ -n \\"\\$C\\" ] || { echo NOCOMFY; exit 9; }; ` +
      `O=\\$(stat -c %U \\"\\$C\\"); D=\\"\\$C/models/${sub}\\"; mkdir -p \\"\\$D\\"; ` +
      `if command -v wget >/dev/null 2>&1; then wget --progress=dot:mega -O \\"\\$D/${outBase}\\" \\"$URL\\"; ` +
      `else curl -fL -o \\"\\$D/${outBase}\\" \\"$URL\\"; fi ` +
      `&& chown -R \\"\\$O\\" \\"\\$D\\"`;
    const cmd = `URL='${url}'; ${resolve}${ssh} "${remote}"`;
    const proc = _ck.spawn(["bash", "-c", PATHFIX + cmd], { superuser: "try", err: "out" });
    const job = { id, kind: "file", name: jobName, node: nodeId, pct: null,
                  label: sizeLabel || "", phase: "run", startedAt: Date.now(), _proc: proc, _out: "" };
    this.active.push(job);
    this._emit();
    proc.stream(d => {
      job._out = (job._out + d).slice(-2000);
      const p = parseFile(d);
      this._patch(id, { pct: p.pct });
    });
    proc.then(
      () => this._finish(id, "done", doneMsg || `${name} downloaded onto ${nodeId}`),
      (e) => {
        const noComfy = /NOCOMFY/.test(job._out);
        const gated   = /\b(401|403)\b|unauthor|forbidden|gated/i.test(job._out);
        this._finish(id, "error", noComfy
          ? `ComfyUI isn't installed on ${nodeId} yet — Nodes → ${nodeId} → 🖼 Install ComfyUI first.`
          : gated
            ? "Download failed — this model looks gated. Add your HuggingFace token in Settings, accept the model's licence, then retry."
            : `Download onto ${nodeId} failed: ${(e && e.message) || e}`);
      },
    );
    return true;
  },

  // ── File download (image checkpoints) — aria2c/wget, HF-token resolve ───────
  // For GATED repos, resolve the token'd HF redirect to its signed CDN URL FIRST,
  // then download that plain URL (the signed URL rejects an Authorization header,
  // which otherwise stalls the transfer). aria2c (16 conns) when present, else wget.
  startFileDownload({ name, dir, outBase, url, sizeLabel, doneMsg, token }) {
    if (this.isActive(name)) return false;
    const id = _nextId();
    const resolve = token
      ? `R=$(curl -sIL -H 'Authorization: Bearer ${token}' -o /dev/null -w '%{url_effective}' "$URL" 2>/dev/null); [ -n "$R" ] && URL="$R"; `
      : "";
    const cmd =
      `dir=${JSON.stringify(dir)}; dir="\${dir/#\\~/$HOME}"; mkdir -p "$dir"; ` +
      `URL='${url}'; ${resolve}` +
      `if command -v aria2c >/dev/null 2>&1; then ` +
      `aria2c -x16 -s16 -k1M --console-log-level=warn --summary-interval=1 --allow-overwrite=true -d "$dir" -o ${JSON.stringify(outBase)} "$URL"; ` +
      `else wget --progress=dot:mega -O "$dir/${outBase}" "$URL"; fi`;
    const proc = _ck.spawn(["bash", "-c", PATHFIX + cmd], { err: "out" });
    const job = { id, kind: "file", name, pct: null, label: sizeLabel || "",
      phase: "run", startedAt: Date.now(), _proc: proc, _out: "" };
    this.active.push(job);
    this._emit();
    proc.stream(d => {
      job._out = (job._out + d).slice(-2000);
      const p = parseFile(d);
      this._patch(id, { pct: p.pct });
    });
    proc.then(
      () => this._finish(id, "done", doneMsg || `${name} downloaded`),
      (e) => {
        const gated = /\b(401|403)\b|unauthor|forbidden|gated|restricted/i.test(job._out);
        const msg = gated
          ? "Download failed — this model looks gated. Add your HuggingFace token in Settings, accept the model's licence on huggingface.co, then retry."
          : `Download failed: ${(e && e.message) || e}`;
        this._finish(id, "error", msg);
      },
    );
    return true;
  },
};
