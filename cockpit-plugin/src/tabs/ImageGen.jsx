/**
 * LLMSpaghetti Image Generator Tab
 * - Engine catalog by tier (Low / Better / Best) with VRAM needs + GPU-fit hints
 * - Activate an installed engine, or download one (with progress)
 * - Advanced render params (steps / size / cfg / negative)
 * - Test prompt → inline preview (read back via cockpit.file, no mixed-content)
 * The user chooses; the tab informs. Writes config/image.yaml (router hot-reloads).
 */

import React, { useState, useEffect, useCallback } from "react";

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
  const [dl, setDl]             = useState(null);          // {id,pct,label} active download
  const [alert, setAlert]       = useState(null);
  const [testPrompt, setTestPrompt] = useState("a red fox in a snowy forest, cinematic");
  const [testing, setTesting]   = useState(false);
  const [testImg, setTestImg]   = useState(null);
  const [testMsg, setTestMsg]   = useState("");

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

  // Download an engine's file(s) into <comfy_dir>/models/<dest> with a progress bar.
  const download = (eng) => {
    if (dl) { setAlert({ type: "err", msg: `Already downloading ${dl.id} — let it finish.` }); return; }
    const comfyDir = (cfg && cfg.comfy_dir) || "~/ComfyUI";
    setDl({ id: eng.id, pct: null, label: "starting…" });
    setAlert(null);
    // One file per engine in the catalog today; loop kept for multi-file engines.
    const f = eng.files[0];
    const cmd =
      `d="${comfyDir}"; d="\${d/#\\~/$HOME}"; ` +
      `out="$d/models/${f.dest}"; mkdir -p "\$(dirname "$out")"; ` +
      `wget --progress=dot:mega -O "$out" '${f.url}'`;
    // No superuser: run as the logged-in user so ~/ComfyUI resolves to THEIR home
    // (ComfyUI lives in user space) and the files are owned correctly.
    const proc = cockpit.spawn(["bash", "-c", PATHFIX + cmd], { err: "out" });
    proc.stream(d => {
      const tail = d.replace(/\r/g, "\n").split("\n").filter(Boolean).slice(-1)[0] || "";
      const m = tail.match(/(\d+)%/);
      setDl(prev => ({ id: eng.id, pct: m ? parseInt(m[1], 10) : (prev ? prev.pct : null),
                       label: `${f.size_gb ? f.size_gb + " GB" : ""}` }));
    });
    const finish = (ok, err) => {
      setDl(null);
      setAlert(ok ? { type: "ok", msg: `${eng.name} downloaded — click Activate to use it.` }
                  : { type: "err", msg: `Download failed: ${err && err.message || err}` });
      loadAll();
    };
    proc.then(() => finish(true), (e) => finish(false, e));
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
                ? "Start ComfyUI on the host (port 8188) — engine cards can't verify fit until it's up."
                : ""}
          </div>
        </div>
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
                const dling = dl && dl.id === eng.id;
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
                        <button disabled={!!dl} onClick={() => download(eng)}
                          style={{ padding: "0.32rem 0.85rem", fontSize: "0.78rem", fontWeight: 600,
                                   border: `1px solid ${C.border}`, borderRadius: 6,
                                   cursor: dl ? "not-allowed" : "pointer",
                                   background: "transparent", color: C.text, opacity: dl ? 0.6 : 1 }}>
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
