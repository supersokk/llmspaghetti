/**
 * LLMSpaghetti Image Generator Tab
 * - Engine catalog by tier (Low / Better / Best) with VRAM needs + GPU-fit hints
 * - Activate an installed engine, or download one (with progress)
 * - Advanced render params (steps / size / cfg / negative)
 * - Test prompt → inline preview (read back via cockpit.file, no mixed-content)
 * The user chooses; the tab informs. Writes config/image.yaml (router hot-reloads).
 */

import React, { useState, useEffect, useCallback, useRef } from "react";

const cockpit = window.cockpit || {
  spawn: () => ({ stream: () => {}, then: (f) => { f(""); return { catch: () => {} }; }, catch: () => {} }),
  file: () => ({ read: () => Promise.resolve(""), replace: () => Promise.resolve() }),
  http: () => ({ get: () => Promise.resolve("{}"), request: () => Promise.resolve("{}") }),
};

const C = {
  bg: "#0d1117", surface: "#161b22", surface2: "#1c2230", border: "#30363d",
  accent: "#2f81f7", accent2: "#58a6ff",
  green: "#3fb950", yellow: "#d29922", red: "#f85149",
  text: "#e6edf3", dim: "#8b949e", purple: "#bc8cff",
};

const PATHFIX = "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; ";
const ROUTER_PORT = 5000;
const COMFY_PORT  = 8188;
const IMAGE_CFG_FILE = "/opt/llmspaghetti/config/image.yaml";
const IMAGES_DIR = "/opt/llmspaghetti/images";

const rget = (p) => cockpit.http(ROUTER_PORT).get(p).then(b => JSON.parse(b || "{}")).catch(() => ({}));
const cget = (p) => cockpit.http(COMFY_PORT).get(p).then(b => JSON.parse(b || "{}")).catch(() => null);

const GB = 1024 ** 3;
const TIER_ORDER = ["low", "better", "best"];
const TIER_ICON  = { low: "🟢", better: "🔵", best: "🟣" };

// GPU-fit verdict: informs, never blocks (models spill to RAM when they overflow).
function fit(vramGb, totalGb) {
  if (!totalGb) return { badge: "—", color: C.dim, note: "GPU unknown" };
  if (vramGb <= totalGb * 0.9) return { badge: "✅ fits", color: C.green, note: "comfortable" };
  if (vramGb <= totalGb)       return { badge: "⚠ tight", color: C.yellow, note: "will spill to RAM, slower" };
  return { badge: "🛑 over", color: C.red, note: "exceeds VRAM — heavy RAM spill / may be very slow" };
}

// Uint8Array → data URI (chunked so large PNGs don't blow the call stack).
function bytesToDataUri(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return "data:image/png;base64," + btoa(bin);
}

// Collect a server-side command's output (used for the HuggingFace API call).
const run = (cmd) => new Promise((res) => {
  let out = "";
  const p = cockpit.spawn(["bash", "-c", PATHFIX + cmd], { err: "message" });
  p.stream(d => { out += d; });
  p.then(() => res(out.trim())).catch(() => res(""));
});

// Sensible render defaults per family, applied when activating a custom checkpoint.
const FAMILY_DEFAULTS = {
  sd15: { size: 512,  steps: 20, cfg: 7.0, guidance: 3.5 },
  sdxl: { size: 1024, steps: 30, cfg: 7.0, guidance: 3.5 },
  flux: { size: 1024, steps: 20, cfg: 1.0, guidance: 3.5 },
};

// Infer where a HuggingFace file belongs in ComfyUI, and whether it stands alone.
function comfyDest(path) {
  const p = path.toLowerCase();
  if (/(^|\/)vae\//.test(p))                                 return { folder: "vae",              standalone: false, kind: "VAE" };
  if (/(^|\/)(text_encoder|clip)\//.test(p))                 return { folder: "clip",             standalone: false, kind: "text encoder" };
  if (/(^|\/)lora/.test(p))                                  return { folder: "loras",            standalone: false, kind: "LoRA" };
  if (/(^|\/)(unet|transformer|diffusion_models)\//.test(p)) return { folder: "diffusion_models", standalone: false, kind: "diffusion-only" };
  return { folder: "checkpoints", standalone: true, kind: "checkpoint" };   // aio/, checkpoints/, or repo root
}

// Module-level download manager. Cockpit UNMOUNTS a tab's component when you switch
// away, which would destroy per-component download state (and the progress bar)
// even though the wget keeps running. Living at module scope, this singleton and
// its running process survive tab switches, so the bar and the completion result
// persist. Components subscribe to get live updates while they're mounted.
const downloadMgr = {
  state: null,               // {id, pct, label, phase:"run"|"done"|"error", msg} | null
  listeners: new Set(),
  subscribe(fn) { this.listeners.add(fn); fn(this.state); return () => this.listeners.delete(fn); },
  _set(s) { this.state = s; this.listeners.forEach(fn => { try { fn(s); } catch {} }); },
  busy() { return !!(this.state && this.state.phase === "run"); },
  clear() { if (this.state && this.state.phase !== "run") this._set(null); },
  start(comfyDir, id, destRel, url, sizeLabel, doneMsg) {
    if (this.busy()) return false;
    this._set({ id, pct: null, label: "starting…", phase: "run" });
    const cmd =
      `d="${comfyDir}"; d="\${d/#\\~/$HOME}"; ` +
      `out="$d/models/${destRel}"; mkdir -p "\$(dirname "$out")"; ` +
      `wget --progress=dot:mega -O "$out" '${url}'`;
    const proc = cockpit.spawn(["bash", "-c", PATHFIX + cmd], { err: "out" });
    proc.stream(d => {
      const tail = d.replace(/\r/g, "\n").split("\n").filter(Boolean).slice(-1)[0] || "";
      const m = tail.match(/(\d+)%/);
      this._set({ id, pct: m ? parseInt(m[1], 10) : (this.state ? this.state.pct : null),
                  label: sizeLabel || "", phase: "run" });
    });
    proc.then(
      () => { this._set({ id, pct: 100, phase: "done", msg: doneMsg || "Downloaded." });
              setTimeout(() => this.clear(), 12000); },
      (e) => { this._set({ id, phase: "error", msg: `Download failed: ${e && e.message || e}` });
               setTimeout(() => this.clear(), 12000); },
    );
    return true;
  },
};

function serializeConfig(c) {
  return [
    "# LLMSpaghetti — Active image-generation settings",
    "# Managed by the Image Generator tab. Hot-reloaded by the router (no restart).",
    "",
    `enabled: ${c.enabled ? "true" : "false"}`,
    `engine: ${c.engine || ""}`,
    `family: ${c.family || "sd15"}`,
    `model_file: ${c.model_file || ""}`,
    `steps: ${c.steps || 20}`,
    `size: ${c.size || 512}`,
    `cfg: ${c.cfg != null ? c.cfg : 7.0}`,
    `guidance: ${c.guidance != null ? c.guidance : 3.5}`,
    `negative: ${JSON.stringify(c.negative || "")}`,
    `timeout: ${c.timeout || 300}`,
    `comfy_dir: ${JSON.stringify(c.comfy_dir || "~/ComfyUI")}`,
    "",
  ].join("\n");
}

export default function ImageGen() {
  const [catalog, setCatalog]   = useState({ tiers: {}, engines: [] });
  const [cfg, setCfg]           = useState(null);          // active config (raw file)
  const [comfy, setComfy]       = useState({ ok: null, vramGb: 0, gpu: "" });
  const [installed, setInstalled] = useState(new Set());   // ckpt filenames ComfyUI sees
  const [dl, setDl]             = useState(downloadMgr.state);  // from the module-level manager (survives tab switches)
  const [alert, setAlert]       = useState(null);
  const [testPrompt, setTestPrompt] = useState("a red fox in a snowy forest, cinematic");
  const [testing, setTesting]   = useState(false);
  const [testImg, setTestImg]   = useState(null);
  const [testMsg, setTestMsg]   = useState("");
  const [hfRepo, setHfRepo]     = useState("");           // "Add from HuggingFace" input
  const [hfFiles, setHfFiles]   = useState(null);         // {repo, files:[...]} | null
  const [hfLoading, setHfLoading] = useState(false);
  const [customFamily, setCustomFamily] = useState({});   // {modelFile: family} for Installed section

  const loadAll = useCallback(async () => {
    const [cat, conf] = await Promise.all([rget("/api/image-engines"), rget("/api/image-config")]);
    setCatalog(cat && cat.engines ? cat : { tiers: {}, engines: [] });
    if (conf && conf.config) setCfg(conf.config);

    const stats = await cget("/system_stats");
    if (stats) {
      const dev = (stats.devices || [])[0] || {};
      setComfy({ ok: true, vramGb: (dev.vram_total || 0) / GB, gpu: dev.name || "GPU" });
    } else {
      setComfy({ ok: false, vramGb: 0, gpu: "" });
    }
    const info = await cget("/object_info/CheckpointLoaderSimple");
    try {
      const list = info.CheckpointLoaderSimple.input.required.ckpt_name[0] || [];
      setInstalled(new Set(list));
    } catch { /* ComfyUI down or shape changed */ }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Subscribe to the module-level download manager so the progress bar reappears
  // (with live %) whenever this tab is mounted, even after switching away and back.
  useEffect(() => downloadMgr.subscribe(setDl), []);

  // When a download finishes, surface the result and refresh the installed list.
  const prevPhase = useRef(null);
  useEffect(() => {
    const phase = dl ? dl.phase : null;
    if (prevPhase.current === "run" && (phase === "done" || phase === "error")) {
      setAlert(phase === "done" ? { type: "ok", msg: dl.msg } : { type: "err", msg: dl.msg });
      loadAll();
    }
    prevPhase.current = phase;
  }, [dl, loadAll]);

  const saveCfg = async (next) => {
    setCfg(next);
    try {
      await cockpit.file(IMAGE_CFG_FILE, { superuser: "try" }).replace(serializeConfig(next));
    } catch (e) {
      setAlert({ type: "err", msg: `Could not save: ${e.message || e}` });
    }
  };

  const activate = (eng) => {
    saveCfg({
      ...cfg, enabled: true, engine: eng.id, family: eng.family,
      model_file: eng.model_file, steps: eng.steps, size: eng.res,
      cfg: eng.cfg != null ? eng.cfg : (cfg ? cfg.cfg : 7.0),
      guidance: eng.guidance != null ? eng.guidance : (cfg ? cfg.guidance : 3.5),
    });
    setAlert({ type: "ok", msg: `Activated ${eng.name} — the image role uses it now.` });
  };

  // Download a file into <comfy_dir>/models/<destRel> with a progress bar. Runs as
  // the logged-in user (no superuser) so ~/ComfyUI resolves to THEIR home and the
  // files are owned correctly. Shared by the catalog cards and the HuggingFace box.
  const downloadFile = (id, destRel, url, sizeLabel, doneMsg) => {
    if (downloadMgr.busy()) {
      setAlert({ type: "err", msg: `Already downloading ${dl && dl.id} — let it finish.` });
      return;
    }
    const comfyDir = (cfg && cfg.comfy_dir) || "~/ComfyUI";
    setAlert(null);
    downloadMgr.start(comfyDir, id, destRel, url, sizeLabel, doneMsg);
  };

  const download = (eng) => {
    const f = eng.files[0];
    downloadFile(eng.id, f.dest, f.url, f.size_gb ? `${f.size_gb} GB` : "",
                 `${eng.name} downloaded — click Activate to use it.`);
  };

  // Inspect a HuggingFace repo → list its .safetensors with inferred ComfyUI folder.
  const fetchHF = async () => {
    if (!hfRepo.trim() || hfLoading) return;
    const repo = hfRepo.trim()
      .replace(/^https?:\/\/huggingface\.co\//i, "")
      .replace(/\/(tree|blob)\/.*$/, "")
      .replace(/\/+$/, "");
    setHfLoading(true); setHfFiles(null);
    const raw = await run(`curl -sf --max-time 25 'https://huggingface.co/api/models/${repo}'`);
    let files = [];
    try {
      const info = JSON.parse(raw || "{}");
      files = (info.siblings || [])
        .map(s => s.rfilename || "")
        .filter(f => /\.safetensors$/i.test(f))
        .map(path => ({ path, name: path.split("/").pop(), ...comfyDest(path),
                        url: `https://huggingface.co/${repo}/resolve/main/${path}` }));
    } catch { files = []; }
    setHfFiles({ repo, files });
    setHfLoading(false);
  };

  // Activate an installed-but-not-in-catalog checkpoint under a chosen family.
  const activateCustom = (modelFile, family) => {
    const d = FAMILY_DEFAULTS[family] || FAMILY_DEFAULTS.sd15;
    saveCfg({ ...cfg, enabled: true, engine: "custom", family, model_file: modelFile,
              steps: d.steps, size: d.size, cfg: d.cfg, guidance: d.guidance });
    setAlert({ type: "ok", msg: `Activated ${modelFile} as ${family} — the image role uses it now.` });
  };

  // Start the ComfyUI systemd service (installed via `spag comfyui install`).
  const startComfy = () => {
    setAlert({ type: "ok", msg: "Starting ComfyUI service…" });
    const proc = cockpit.spawn(["bash", "-c", PATHFIX + "systemctl start comfyui"],
      { superuser: "try", err: "message" });
    proc.then(
      () => { setAlert({ type: "ok", msg: "ComfyUI starting — give it ~10s, then it'll connect." });
              setTimeout(loadAll, 8000); },
      (e) => setAlert({ type: "err",
              msg: `Couldn't start the service (${e && e.message || e}). Not installed yet? Run on the box:  spag comfyui install` }),
    );
  };

  const runTest = async () => {
    if (testing || !testPrompt.trim()) return;
    setTesting(true); setTestImg(null); setTestMsg("Generating… (first run loads the model)");
    const t0 = Date.now();
    try {
      const body = JSON.stringify({
        model: "local-default", stream: false,
        messages: [{ role: "user", content: `generate an image of ${testPrompt.trim()}` }],
      });
      const raw = await cockpit.http(ROUTER_PORT).request({
        method: "POST", path: "/v1/chat/completions",
        body, headers: { "Content-Type": "application/json", "Authorization": "Bearer sk-llmspaghetti" },
      });
      const data = JSON.parse(raw || "{}");
      const content = ((data.choices || [{}])[0].message || {}).content || "";
      const m = content.match(/\/images\/([A-Za-z0-9_.-]+\.png)/);
      if (!m) throw new Error(content.slice(0, 160) || "no image returned");
      // Read the saved PNG straight off disk — no network / mixed-content issues.
      const bytes = await cockpit.file(`${IMAGES_DIR}/${m[1]}`, { binary: true, superuser: "try" }).read();
      if (!bytes || !bytes.length) throw new Error("image generated but couldn't be read from disk");
      setTestImg(bytesToDataUri(bytes));
      setTestMsg(`✓ Generated in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      setTestMsg(`⚠ ${e.message || e}`);
    } finally {
      setTesting(false);
    }
  };

  const engById = (id) => catalog.engines.find(e => e.id === id);
  const activeEng = cfg ? engById(cfg.engine) : null;

  // Checkpoints ComfyUI sees that aren't preset catalog engines (downloaded/custom).
  const catalogFiles = new Set(catalog.engines.map(e => e.model_file));
  const customModels = [...installed].filter(m => m && !catalogFiles.has(m));
  const downloading = !!(dl && dl.phase === "run");

  // ── Render ──────────────────────────────────────────────────────────────────
  const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                 padding: "1rem 1.25rem", marginBottom: "1rem" };
  const label = { fontSize: "0.72rem", fontWeight: 600, color: C.dim,
                  textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.75rem" };

  return (
    <div style={{ padding: "1.5rem", maxWidth: 1000, margin: "0 auto" }}>
      <h2 style={{ fontSize: "1.15rem", fontWeight: 700, color: C.text, marginBottom: "0.35rem" }}>
        🖼 Image Generator
      </h2>
      <p style={{ fontSize: "0.85rem", color: C.dim, marginBottom: "1.25rem" }}>
        Pick a text-to-image engine. Each shows what it needs — the tab recommends by
        hardware class, you make the call. The <code>image</code> role routes here.
      </p>

      {alert && (
        <div style={{ ...card, borderColor: alert.type === "ok" ? C.green : C.red,
                      color: alert.type === "ok" ? C.green : C.red, fontSize: "0.85rem" }}>
          {alert.msg}
        </div>
      )}

      {/* Persistent download banner — reads the module-level manager, so it's here
          with live progress (or the ✓/⚠ result) even after switching tabs and back. */}
      {dl && (
        <div style={{ ...card, borderColor: dl.phase === "error" ? C.red
                                          : dl.phase === "done"  ? C.green : C.accent }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.7rem",
                        marginBottom: dl.phase === "run" ? "0.55rem" : 0 }}>
            <span style={{ flex: 1, fontSize: "0.85rem", fontWeight: 600, color: C.text }}>
              {dl.phase === "run" ? "↓ Downloading " : dl.phase === "done" ? "✓ " : "⚠ "}
              <span style={{ fontFamily: "monospace",
                             color: dl.phase === "error" ? C.red : C.accent2 }}>{dl.id}</span>
            </span>
            {dl.phase === "run" && (
              <span style={{ fontSize: "0.8rem", color: C.dim, fontFamily: "monospace" }}>
                {dl.pct != null ? `${dl.pct}%` : ""} {dl.label}
              </span>
            )}
          </div>
          {dl.phase === "run" && (
            <div style={{ height: 8, background: C.bg, borderRadius: 5, overflow: "hidden",
                          border: `1px solid ${C.border}` }}>
              <div style={{ height: "100%", width: dl.pct != null ? `${dl.pct}%` : "100%",
                            background: C.accent, transition: "width 0.3s ease",
                            opacity: dl.pct == null ? 0.5 : 1 }} />
            </div>
          )}
          {dl.phase === "run" && (
            <div style={{ fontSize: "0.72rem", color: C.dim, marginTop: "0.4rem" }}>
              Runs in the background — safe to switch tabs; this bar is here when you come back.
            </div>
          )}
          {dl.phase !== "run" && (
            <div style={{ fontSize: "0.8rem", color: dl.phase === "error" ? C.red : C.dim }}>{dl.msg}</div>
          )}
        </div>
      )}

      {/* ComfyUI status */}
      <div style={{ ...card, display: "flex", alignItems: "center", gap: "1rem" }}>
        <span style={{ width: 10, height: 10, borderRadius: "50%",
                       background: comfy.ok ? C.green : comfy.ok === false ? C.red : C.dim }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: "0.9rem", fontWeight: 600, color: C.text }}>
            ComfyUI {comfy.ok ? "connected" : comfy.ok === false ? "unreachable" : "checking…"}
          </div>
          <div style={{ fontSize: "0.78rem", color: C.dim }}>
            {comfy.ok
              ? `${comfy.gpu} · ${comfy.vramGb.toFixed(1)} GB VRAM`
              : comfy.ok === false
                ? "Not running on :8188. Start it below, or set it up once with  spag comfyui install"
                : ""}
          </div>
        </div>
        {comfy.ok === false && (
          <button onClick={startComfy}
            style={{ padding: "0.4rem 0.9rem", background: C.accent, color: "white", border: "none",
                     borderRadius: 6, fontSize: "0.82rem", fontWeight: 600, cursor: "pointer" }}>
            Start ComfyUI
          </button>
        )}
        {cfg && (
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem",
                          fontSize: "0.82rem", color: C.text, cursor: "pointer" }}>
            <input type="checkbox" checked={!!cfg.enabled}
              onChange={e => saveCfg({ ...cfg, enabled: e.target.checked })} />
            Image generation on
          </label>
        )}
      </div>

      {/* Active engine summary */}
      {activeEng && (
        <div style={{ ...card, borderColor: C.accent }}>
          <div style={{ fontSize: "0.72rem", color: C.dim, marginBottom: "0.3rem" }}>ACTIVE ENGINE</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", flexWrap: "wrap" }}>
            <span style={{ fontSize: "1.05rem", fontWeight: 700, color: C.accent2 }}>{activeEng.name}</span>
            <span style={{ fontSize: "0.78rem", color: C.dim }}>
              {cfg.family} · {cfg.size}px · {cfg.steps} steps{cfg.family !== "flux" ? ` · cfg ${cfg.cfg}` : ` · guidance ${cfg.guidance}`}
            </span>
          </div>
        </div>
      )}

      {/* Engine catalog by tier */}
      {TIER_ORDER.map(tierId => {
        const tier = (catalog.tiers || {})[tierId] || {};
        const engines = catalog.engines.filter(e => e.tier === tierId);
        if (!engines.length) return null;
        return (
          <div key={tierId} style={card}>
            <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", marginBottom: "0.2rem" }}>
              <span style={{ fontSize: "0.95rem", fontWeight: 700, color: C.text }}>
                {TIER_ICON[tierId]} {tier.label || tierId}
              </span>
              <span style={{ fontSize: "0.76rem", color: C.purple }}>{tier.recommended_gpu}</span>
            </div>
            <div style={{ fontSize: "0.8rem", color: C.dim, marginBottom: "0.9rem" }}>{tier.blurb}</div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "0.6rem" }}>
              {engines.map(eng => {
                const isInstalled = installed.has(eng.model_file);
                const isActive = cfg && cfg.engine === eng.id;
                const f = fit(eng.vram_gb, comfy.vramGb);
                const dling = dl && dl.id === eng.id && dl.phase === "run";
                return (
                  <div key={eng.id} style={{ background: C.bg, border: `1px solid ${isActive ? C.accent : C.border}`,
                                             borderRadius: 8, padding: "0.75rem 0.9rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                      <span style={{ fontSize: "0.92rem", fontWeight: 600, color: C.text }}>{eng.name}</span>
                      <span style={{ fontSize: "0.72rem", fontWeight: 600, color: f.color }}>{f.badge}</span>
                      <span style={{ fontSize: "0.72rem", color: C.dim }}>~{eng.vram_gb} GB · {eng.res}px</span>
                      <span style={{ flex: 1 }} />
                      {isActive && <span style={{ fontSize: "0.72rem", fontWeight: 700, color: C.accent2 }}>● active</span>}
                      {isInstalled ? (
                        <button disabled={isActive} onClick={() => activate(eng)}
                          style={{ padding: "0.32rem 0.85rem", fontSize: "0.78rem", fontWeight: 600,
                                   border: "none", borderRadius: 6, cursor: isActive ? "default" : "pointer",
                                   background: isActive ? C.border : C.accent, color: "white",
                                   opacity: isActive ? 0.6 : 1 }}>
                          {isActive ? "in use" : "Activate"}
                        </button>
                      ) : (
                        <button disabled={downloading} onClick={() => download(eng)}
                          style={{ padding: "0.32rem 0.85rem", fontSize: "0.78rem", fontWeight: 600,
                                   border: `1px solid ${C.border}`, borderRadius: 6,
                                   cursor: downloading ? "not-allowed" : "pointer",
                                   background: "transparent", color: C.text, opacity: downloading ? 0.6 : 1 }}>
                          ↓ Download {eng.files[0] && eng.files[0].size_gb ? `(${eng.files[0].size_gb} GB)` : ""}
                        </button>
                      )}
                    </div>
                    <div style={{ fontSize: "0.78rem", color: C.dim, marginTop: "0.4rem" }}>
                      {eng.blurb} <span style={{ color: f.color }}>· {f.note}</span>
                    </div>
                    {dling && (
                      <div style={{ marginTop: "0.6rem" }}>
                        <div style={{ height: 7, background: C.surface, borderRadius: 4, overflow: "hidden",
                                      border: `1px solid ${C.border}` }}>
                          <div style={{ height: "100%", width: dl.pct != null ? `${dl.pct}%` : "100%",
                                        background: C.accent, transition: "width 0.3s ease",
                                        opacity: dl.pct == null ? 0.5 : 1 }} />
                        </div>
                        <div style={{ fontSize: "0.72rem", color: C.dim, marginTop: "0.3rem" }}>
                          Downloading… {dl.pct != null ? `${dl.pct}%` : ""} {dl.label}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Installed models not in the catalog — pick a family + activate */}
      {customModels.length > 0 && (
        <div style={card}>
          <div style={label}>Installed models (not preset)</div>
          <div style={{ fontSize: "0.78rem", color: C.dim, marginBottom: "0.8rem" }}>
            Checkpoints ComfyUI sees that aren't catalog engines — anything you downloaded or dropped
            into <code>models/checkpoints/</code>. Pick the family so the router builds the right workflow, then activate.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {customModels.map(m => {
              const fam = customFamily[m] || "sd15";
              const isActive = cfg && cfg.model_file === m;
              return (
                <div key={m} style={{ background: C.bg, border: `1px solid ${isActive ? C.accent : C.border}`,
                                      borderRadius: 8, padding: "0.55rem 0.8rem", display: "flex",
                                      alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                  <span style={{ flex: 1, fontFamily: "monospace", fontSize: "0.82rem", color: C.text,
                                 overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m}</span>
                  {isActive && <span style={{ fontSize: "0.72rem", fontWeight: 700, color: C.accent2 }}>● active</span>}
                  <select value={fam} onChange={e => setCustomFamily(o => ({ ...o, [m]: e.target.value }))}
                    style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text,
                             borderRadius: 6, fontSize: "0.78rem", padding: "0.25rem 0.4rem", cursor: "pointer" }}>
                    <option value="sd15">SD 1.5</option>
                    <option value="sdxl">SDXL</option>
                    <option value="flux">Flux</option>
                  </select>
                  <button disabled={isActive} onClick={() => activateCustom(m, fam)}
                    style={{ padding: "0.3rem 0.8rem", fontSize: "0.78rem", fontWeight: 600, border: "none",
                             borderRadius: 6, cursor: isActive ? "default" : "pointer",
                             background: isActive ? C.border : C.accent, color: "white", opacity: isActive ? 0.6 : 1 }}>
                    {isActive ? "in use" : "Activate"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Add from HuggingFace — paste a repo, download any .safetensors to the right folder */}
      <div style={card}>
        <div style={label}>Add from HuggingFace 🤗</div>
        <div style={{ fontSize: "0.78rem", color: C.dim, marginBottom: "0.75rem" }}>
          Paste a model repo URL. We list its <code>.safetensors</code>, show where each goes and whether
          it's a ready checkpoint or a component, and download the one you pick.
        </div>
        <div style={{ display: "flex", gap: "0.7rem" }}>
          <input type="text" value={hfRepo} onChange={e => setHfRepo(e.target.value)}
            onKeyDown={e => e.key === "Enter" && fetchHF()}
            placeholder="https://huggingface.co/USER/MODEL"
            style={{ flex: 1, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6,
                     color: C.text, padding: "0.5rem 0.75rem", fontSize: "0.88rem" }} />
          <button disabled={!hfRepo.trim() || hfLoading} onClick={fetchHF}
            style={{ padding: "0.5rem 1.1rem", background: C.accent, color: "white", border: "none",
                     borderRadius: 6, fontSize: "0.85rem", fontWeight: 600,
                     cursor: !hfRepo.trim() || hfLoading ? "not-allowed" : "pointer",
                     opacity: !hfRepo.trim() || hfLoading ? 0.6 : 1 }}>
            {hfLoading ? "Loading…" : "Fetch"}
          </button>
        </div>

        {hfFiles && hfFiles.files.length === 0 && (
          <div style={{ fontSize: "0.8rem", color: C.dim, marginTop: "0.75rem" }}>
            No <code>.safetensors</code> found in that repo (it may be diffusers-format only, or a bad URL).
          </div>
        )}

        {hfFiles && hfFiles.files.length > 0 && (
          <div style={{ marginTop: "0.85rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {hfFiles.files.map(f => {
              const dling = dl && dl.id === f.path && dl.phase === "run";
              return (
                <div key={f.path} style={{ background: C.bg, border: `1px solid ${C.border}`,
                                           borderRadius: 8, padding: "0.55rem 0.8rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                    <span style={{ flex: 1, fontFamily: "monospace", fontSize: "0.8rem", color: C.text,
                                   overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path}</span>
                    <span style={{ fontSize: "0.72rem", fontWeight: 600, color: f.standalone ? C.green : C.yellow }}>
                      {f.standalone ? "✅ ready" : `⚠ ${f.kind}`}
                    </span>
                    <span style={{ fontSize: "0.72rem", color: C.dim }}>→ models/{f.folder}/</span>
                    <button disabled={downloading} onClick={() => downloadFile(
                        f.path, `${f.folder}/${f.name}`, f.url, "",
                        f.standalone
                          ? `${f.name} → models/${f.folder}/. Activate it under “Installed models”.`
                          : `${f.name} → models/${f.folder}/ (a ${f.kind} component — needs its siblings + a workflow).`)}
                      style={{ padding: "0.28rem 0.75rem", fontSize: "0.76rem", fontWeight: 600, border: "none",
                               borderRadius: 6, cursor: downloading ? "not-allowed" : "pointer",
                               background: C.accent, color: "white", opacity: downloading ? 0.5 : 1 }}>
                      ↓ Download
                    </button>
                  </div>
                  {dling && (
                    <div style={{ marginTop: "0.5rem", height: 7, background: C.surface, borderRadius: 4,
                                  overflow: "hidden", border: `1px solid ${C.border}` }}>
                      <div style={{ height: "100%", width: dl.pct != null ? `${dl.pct}%` : "100%",
                                    background: C.accent, transition: "width 0.3s ease",
                                    opacity: dl.pct == null ? 0.5 : 1 }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Advanced params for the active engine */}
      {cfg && activeEng && (
        <div style={card}>
          <div style={label}>Advanced — {activeEng.name}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0.9rem" }}>
            {[
              { k: "steps", label: "Steps", min: 1, max: 60 },
              { k: "size", label: "Size (px)", min: 256, max: 1536, step: 64 },
            ].concat(cfg.family !== "flux"
              ? [{ k: "cfg", label: "CFG", min: 1, max: 20, step: 0.5 }]
              : [{ k: "guidance", label: "Guidance", min: 0, max: 10, step: 0.5 }]).map(fld => (
              <label key={fld.k} style={{ fontSize: "0.78rem", color: C.dim }}>
                {fld.label}
                <input type="number" value={cfg[fld.k]} min={fld.min} max={fld.max} step={fld.step || 1}
                  onChange={e => saveCfg({ ...cfg, [fld.k]: Number(e.target.value) })}
                  style={{ width: "100%", marginTop: "0.25rem", background: C.bg,
                           border: `1px solid ${C.border}`, borderRadius: 6, color: C.text,
                           padding: "0.4rem 0.55rem", fontSize: "0.85rem" }} />
              </label>
            ))}
          </div>
          <label style={{ fontSize: "0.78rem", color: C.dim, display: "block", marginTop: "0.9rem" }}>
            Negative prompt {cfg.family === "flux" ? "(ignored by Flux)" : ""}
            <input type="text" value={cfg.negative || ""}
              onChange={e => saveCfg({ ...cfg, negative: e.target.value })}
              style={{ width: "100%", marginTop: "0.25rem", background: C.bg,
                       border: `1px solid ${C.border}`, borderRadius: 6, color: C.text,
                       padding: "0.4rem 0.55rem", fontSize: "0.85rem" }} />
          </label>
        </div>
      )}

      {/* Test */}
      <div style={card}>
        <div style={label}>Test</div>
        <div style={{ display: "flex", gap: "0.7rem" }}>
          <input type="text" value={testPrompt} onChange={e => setTestPrompt(e.target.value)}
            onKeyDown={e => e.key === "Enter" && runTest()}
            placeholder="describe an image…"
            style={{ flex: 1, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6,
                     color: C.text, padding: "0.5rem 0.75rem", fontSize: "0.88rem" }} />
          <button disabled={testing || !testPrompt.trim()} onClick={runTest}
            style={{ padding: "0.5rem 1.1rem", background: C.accent, color: "white", border: "none",
                     borderRadius: 6, fontSize: "0.85rem", fontWeight: 600,
                     cursor: testing ? "not-allowed" : "pointer", opacity: testing ? 0.6 : 1 }}>
            {testing ? "Generating…" : "Generate"}
          </button>
        </div>
        {testMsg && <div style={{ fontSize: "0.8rem", color: testMsg[0] === "⚠" ? C.red : C.dim,
                                  marginTop: "0.6rem" }}>{testMsg}</div>}
        {testImg && (
          <img src={testImg} alt="test result"
            style={{ marginTop: "0.75rem", maxWidth: "100%", borderRadius: 8, border: `1px solid ${C.border}` }} />
        )}
      </div>
    </div>
  );
}
