/**
 * LLMSpaghetti Image Generator Tab
 * - Engine catalog by tier (Low / Better / Best) with VRAM needs + GPU-fit hints
 * - Activate an installed engine, or download one (with progress)
 * - Advanced render params (steps / size / cfg / negative)
 * - Test prompt → inline preview (read back via cockpit.file, no mixed-content)
 * The user chooses; the tab informs. Writes config/image.yaml (router hot-reloads).
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { downloads } from "../downloads.js";

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
const IMAGE_CFG_FILE = "/opt/llmspaghetti/config/image.yaml";
const IMAGES_DIR = "/opt/llmspaghetti/images";

const rget = (p) => cockpit.http(ROUTER_PORT).get(p).then(b => JSON.parse(b || "{}")).catch(() => ({}));
// The core's SSH identity (Nodes tab generates it) — used to start ComfyUI on a node.
const NODE_KEY = "/opt/llmspaghetti/config/node_ssh_key";

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
// Pass { superuser: "try" } for anything that reads the node SSH key (root-owned).
const run = (cmd, opts = {}) => new Promise((res) => {
  let out = "";
  const p = cockpit.spawn(["bash", "-c", PATHFIX + cmd], { err: "message", ...opts });
  p.stream(d => { out += d; });
  p.then(() => res(out.trim())).catch(() => res(""));
});

// ── ComfyUI workflow import ───────────────────────────────────────────────────
// The router drives ComfyUI by filling a template (config/image-workflows/<family>
// .json) with {{TOKENS}} — so ANY graph you can build in ComfyUI can become an
// engine. These turn a raw ComfyUI "Export (API)" file into such a template.

const FILE_RE = /\.(safetensors|ckpt|pt|pth|bin|sft|gguf)$/i;

// Auto-tokenise a ComfyUI API graph. Which CLIPTextEncode is the positive prompt
// is NOT guessable from the node itself — we resolve it from the sampler's
// positive/negative links, which is exact.
function tokenizeWorkflow(g) {
  const wf = JSON.parse(JSON.stringify(g));
  const applied = new Set();
  const set = (node, key, token) => {
    if (node && node.inputs && key in node.inputs && !Array.isArray(node.inputs[key])) {
      node.inputs[key] = token; applied.add(token);
    }
  };
  const linked = (v) => (Array.isArray(v) ? wf[v[0]] : null);

  for (const node of Object.values(wf)) {
    const ct = node.class_type || "";
    if (/KSampler|SamplerCustom/i.test(ct)) {
      set(node, "seed", "{{SEED}}"); set(node, "noise_seed", "{{SEED}}");
      set(node, "steps", "{{STEPS}}"); set(node, "cfg", "{{CFG}}");
      // Positive/negative resolved through the sampler's own links — exact.
      const pos = linked(node.inputs && node.inputs.positive);
      const neg = linked(node.inputs && node.inputs.negative);
      if (pos && /CLIPTextEncode/i.test(pos.class_type || "")) set(pos, "text", "{{PROMPT}}");
      if (neg && /CLIPTextEncode/i.test(neg.class_type || "")) set(neg, "text", "{{NEGATIVE}}");
    }
    if (/CheckpointLoaderSimple|CheckpointLoader/i.test(ct)) set(node, "ckpt_name", "{{MODEL}}");
    if (/EmptyLatentImage|EmptySD3LatentImage/i.test(ct)) {
      set(node, "width", "{{WIDTH}}"); set(node, "height", "{{HEIGHT}}");
    }
    if (/FluxGuidance/i.test(ct)) set(node, "guidance", "{{GUIDANCE}}");
  }
  return { wf, applied: [...applied] };
}

// Validate + report. We refuse to import a graph that silently ignores the user's
// prompt or returns no image — those fail at render time with a baffling message.
function inspectWorkflow(raw, installedSet) {
  const r = { errors: [], warnings: [], applied: [], models: [], missing: [], wf: null };
  let g;
  try { g = JSON.parse(raw); } catch (e) { r.errors.push(`Not valid JSON: ${e.message}`); return r; }
  if (!g || typeof g !== "object" || Array.isArray(g)) { r.errors.push("Expected a JSON object."); return r; }
  const nodes = Object.values(g);
  if (!nodes.length || !nodes.every(n => n && n.class_type && n.inputs)) {
    r.errors.push(
      "This isn't a ComfyUI API graph. In ComfyUI use Workflow → Export (API) — " +
      "the normal Save exports the UI graph, which has a different shape and won't run.");
    return r;
  }
  const already = /\{\{PROMPT\}\}/.test(raw);
  const t = already ? { wf: g, applied: [] } : tokenizeWorkflow(g);
  r.wf = t.wf; r.applied = t.applied;
  const filled = JSON.stringify(r.wf);

  if (!/\{\{PROMPT\}\}/.test(filled))
    r.errors.push("No {{PROMPT}} — the chat message would be ignored and every image would be the same. " +
                  "Couldn't auto-detect the positive prompt; set it by hand.");
  if (!Object.values(r.wf).some(n => /SaveImage/i.test(n.class_type || "")))
    r.errors.push("No SaveImage node — the router reads the result from ComfyUI's history, so nothing would come back.");
  if (!/\{\{MODEL\}\}/.test(filled))
    r.warnings.push("No {{MODEL}} — this graph pins its own checkpoint, so the Image tab's active model won't apply to it.");
  if (!/\{\{SEED\}\}/.test(filled))
    r.warnings.push("No {{SEED}} — the seed is fixed, so repeated prompts will return an identical image.");

  // Model files this graph needs, and which are missing on the ComfyUI host.
  for (const n of Object.values(r.wf))
    for (const v of Object.values(n.inputs || {}))
      if (typeof v === "string" && FILE_RE.test(v) && !r.models.includes(v)) r.models.push(v);
  r.missing = r.models.filter(m => !installedSet.has(m));
  return r;
}

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

// Downloads run through the shared module-level manager (src/downloads.js) so
// they survive Cockpit unmounting this tab, and appear in the Downloads tab
// alongside Ollama model pulls.

function serializeConfig(c) {
  return [
    "# LLMSpaghetti — Active image-generation settings",
    "# Managed by the Image Generator tab. Hot-reloaded by the router (no restart).",
    "",
    `enabled: ${c.enabled ? "true" : "false"}`,
    // Where image gen RUNS: "local" or a node id from nodes.yaml. Must be emitted
    // here — this function rewrites the whole file, so omitting it would silently
    // reset an outsourced node back to local on the next save from this tab.
    `host: ${c.host || "local"}`,
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
  const [archs, setArchs]       = useState([]);            // architecture packs (installed/available)
  const [installingArch, setInstallingArch] = useState(null);
  const [hfToken, setHfToken]   = useState("");            // optional HF token for gated downloads
  const [dlSnap, setDlSnap]     = useState(downloads._snapshot());  // shared manager (survives tab switches)
  const [alert, setAlert]       = useState(null);
  const [testPrompt, setTestPrompt] = useState("a red fox in a snowy forest, cinematic");
  const [testing, setTesting]   = useState(false);
  const [testImg, setTestImg]   = useState(null);
  const [testMsg, setTestMsg]   = useState("");
  const [hfRepo, setHfRepo]     = useState("");           // "Add from HuggingFace" input
  const [hfFiles, setHfFiles]   = useState(null);         // {repo, files:[...]} | null
  const [hfLoading, setHfLoading] = useState(false);
  const [customFamily, setCustomFamily] = useState({});   // {modelFile: family} for Installed section
  const [nodes, setNodes]       = useState([]);           // compute nodes image gen can be sent to
  const [pendingHost, setPendingHost] = useState(null);   // "Run on" pick awaiting 💾 Save
  const [families, setFamilies] = useState([]);           // workflow templates the router can drive
  const [wfOpen, setWfOpen]     = useState(false);        // import-workflow panel
  const [wfName, setWfName]     = useState("");
  const [wfUrl, setWfUrl]       = useState("");
  const [wfJson, setWfJson]     = useState("");
  const [wfReport, setWfReport] = useState(null);         // inspectWorkflow() result

  const loadAll = useCallback(async () => {
    const [cat, conf, arch, nds, wfs] = await Promise.all([
      rget("/api/image-engines"), rget("/api/image-config"), rget("/api/image-architectures"),
      rget("/api/nodes"), rget("/api/image-workflows"),
    ]);
    setCatalog(cat && cat.engines ? cat : { tiers: {}, engines: [] });
    if (conf && conf.config) setCfg(conf.config);
    setArchs((arch && arch.architectures) || []);
    setNodes((nds && nds.nodes) || []);
    // Families = the templates actually on disk, so an imported workflow shows up
    // in the family picker (arch packs are only one way a template gets there).
    setFamilies((wfs && wfs.families) || []);

    // Optional HuggingFace token (from Settings) — attached to downloads to unlock
    // gated/private repos. Read best-effort; absent for public models is fine.
    cockpit.file("/opt/llmspaghetti/config/api_keys.env", { superuser: "try" }).read()
      .then(raw => {
        const m = (raw || "").match(/^\s*HF_TOKEN\s*=\s*(.+?)\s*$/m);
        setHfToken(m ? m[1].replace(/^["']|["']$/g, "") : "");
      }).catch(() => {});

    // Ask the router which ComfyUI is actually in play (local or a node's) — polling
    // localhost:8188 here would keep reporting THIS box's ComfyUI, GPU and
    // checkpoints even when image gen has been outsourced to a node.
    const st = await rget("/api/image-status");
    if (st && st.reachable) {
      setComfy({ ok: true, vramGb: ((st.gpu && st.gpu.vram_total) || 0) / GB,
                 gpu: (st.gpu && st.gpu.name) || "GPU", host: st.host, url: st.url });
      setInstalled(new Set(st.checkpoints || []));
    } else {
      setComfy({ ok: false, vramGb: 0, gpu: "",
                 host: (st && st.host) || "local", url: st && st.url });
      setInstalled(new Set());
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Subscribe to the shared download manager so the progress bar reappears (with
  // live %) whenever this tab is mounted, even after switching away and back.
  useEffect(() => downloads.subscribe(setDlSnap), []);

  // Derive this tab's banner from the shared state: the active checkpoint download
  // if one is running, else the most recent finished one (shown briefly). Shape
  // matches what the banner below already renders: {id, pct, label, phase, msg}.
  const _fileActive = (dlSnap.active || []).find(j => j.kind === "file");
  const _fileRecent = (dlSnap.history || []).find(
    h => h.kind === "file" && (Date.now() - h.endedAt) < 15000);
  const dl = _fileActive
    ? { id: _fileActive.name, pct: _fileActive.pct, label: _fileActive.label, phase: "run" }
    : _fileRecent
    ? { id: _fileRecent.name, phase: _fileRecent.phase, msg: _fileRecent.msg }
    : null;

  // When a download finishes, surface the result and refresh the installed list.
  const dlPhase = dl ? dl.phase : null;
  const prevPhase = useRef(null);
  useEffect(() => {
    if (prevPhase.current === "run" && (dlPhase === "done" || dlPhase === "error")) {
      setAlert(dlPhase === "done" ? { type: "ok", msg: dl.msg } : { type: "err", msg: dl.msg });
      loadAll();
    }
    prevPhase.current = dlPhase;
  }, [dlPhase]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveCfg = async (next) => {
    setCfg(next);
    try {
      await cockpit.file(IMAGE_CFG_FILE, { superuser: "try" }).replace(serializeConfig(next));
    } catch (e) {
      setAlert({ type: "err", msg: `Could not save: ${e.message || e}` });
    }
  };

  // Apply the pending "Run on" pick, then refresh the whole tab — status, GPU and
  // checkpoint list all describe a different box after a host switch.
  const applyHost = async () => {
    const h = pendingHost;
    await saveCfg({ ...cfg, host: h });
    setPendingHost(null);
    setAlert({ type: "ok", msg: h === "local"
      ? "Image generation runs on this box — refreshing status…"
      : `Image generation now runs on ${h} — refreshing status…` });
    await loadAll();
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

  // The node image gen is outsourced to, or null when running locally.
  const imageNode = () =>
    (cfg && cfg.host && cfg.host !== "local" && nodes.find(n => n.id === cfg.host)) || null;

  // Download a file into <comfy_dir>/models/<destRel> with a progress bar. When
  // image gen is outsourced, the checkpoint must land on the NODE — its ComfyUI
  // reads its own models/ dir, so a local download would just produce "model not
  // found" at render time. Locally it runs as the logged-in user (no superuser)
  // so ~/ComfyUI resolves to THEIR home and files are owned correctly.
  const downloadFile = (id, destRel, url, sizeLabel, doneMsg) => {
    if ((dlSnap.active || []).some(j => j.kind === "file")) {
      setAlert({ type: "err", msg: `A checkpoint is already downloading — let it finish.` });
      return;
    }
    const slash = destRel.lastIndexOf("/");
    const sub   = slash >= 0 ? destRel.slice(0, slash) : "";
    const base  = slash >= 0 ? destRel.slice(slash + 1) : destRel;
    setAlert(null);

    const node = imageNode();
    if (node) {
      const host = (node.url || "").replace(/^https?:\/\//, "").replace(/[:/].*$/, "");
      downloads.startNodeCheckpoint({
        name: id, nodeId: node.id, host, keyPath: NODE_KEY,
        sub: sub || "checkpoints", outBase: base, url, sizeLabel,
        doneMsg: `${id} downloaded onto ${node.id} — click Activate to use it.`,
        token: hfToken,
      });
      return;
    }
    const comfyDir = (cfg && cfg.comfy_dir) || "~/ComfyUI";
    downloads.startFileDownload({
      name: id, dir: `${comfyDir}/models/${sub}`, outBase: base,
      url, sizeLabel, doneMsg, token: hfToken,
    });
  };

  const download = (eng) => {
    const f = eng.files[0];
    downloadFile(eng.id, f.dest, f.url, f.size_gb ? `${f.size_gb} GB` : "",
                 `${eng.name} downloaded — click Activate to use it.`);
  };

  // ── Import a ComfyUI workflow as a routable family ──────────────────────────
  // Fetch a workflow JSON by URL (server-side curl — no CORS, and it handles the
  // raw links people paste from GitHub/Civitai/OpenArt).
  const fetchWorkflowUrl = async () => {
    const u = wfUrl.trim();
    if (!u) return;
    setAlert(null);
    const raw = await run(`curl -sfL --max-time 25 '${u.replace(/'/g, "")}'`);
    if (!raw) { setAlert({ type: "err", msg: "Couldn't fetch that URL (or it returned nothing)." }); return; }
    setWfJson(raw);
    setWfReport(inspectWorkflow(raw, installed));
    if (!wfName.trim()) {
      const guess = (u.split("/").pop() || "").replace(/\.json.*$/i, "").replace(/[^A-Za-z0-9._-]/g, "-");
      if (guess) setWfName(guess.toLowerCase());
    }
  };

  const readWorkflowFile = (file) => {
    if (!file) return;
    const fr = new FileReader();
    fr.onload = () => {
      const raw = String(fr.result || "");
      setWfJson(raw);
      setWfReport(inspectWorkflow(raw, installed));
      if (!wfName.trim())
        setWfName(file.name.replace(/\.json$/i, "").replace(/[^A-Za-z0-9._-]/g, "-").toLowerCase());
    };
    fr.readAsText(file);
  };

  const importWorkflow = async () => {
    const name = wfName.trim().toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(name)) {
      setAlert({ type: "err", msg: "Family name: lowercase letters, digits, dots, dashes, underscores." });
      return;
    }
    const rep = wfReport && wfReport.wf ? wfReport : inspectWorkflow(wfJson, installed);
    if (!rep.wf || rep.errors.length) {
      setWfReport(rep);
      setAlert({ type: "err", msg: "Fix the problems below before importing." });
      return;
    }
    try {
      await cockpit.file(`/opt/llmspaghetti/config/image-workflows/${name}.json`, { superuser: "try" })
        .replace(JSON.stringify(rep.wf, null, 2) + "\n");
      setAlert({ type: "ok", msg: rep.missing.length
        ? `Imported "${name}". It still needs: ${rep.missing.join(", ")} — fetch them with “Add from HuggingFace” above (they go to the box running ComfyUI).`
        : `Imported "${name}" — pick it as the family on a checkpoint below to use it.` });
      setWfOpen(false); setWfJson(""); setWfUrl(""); setWfReport(null); setWfName("");
      await loadAll();
    } catch (e) {
      setAlert({ type: "err", msg: `Could not write the template: ${(e && e.message) || e}` });
    }
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

  // Delete a checkpoint file from disk — on the node when image gen is outsourced
  // (the checkpoint list shown is the node's, so deleting locally would be a no-op).
  const deleteModel = async (m) => {
    const node = imageNode();
    const where = node ? ` from ${node.id}` : "";
    if (!window.confirm(`Delete "${m}"${where}? This frees the space but can't be undone.`)) return;
    if (node) {
      const host = (node.url || "").replace(/^https?:\/\//, "").replace(/[:/].*$/, "");
      await run(
        `ssh -i ${NODE_KEY} -o IdentitiesOnly=yes -o BatchMode=yes ` +
        `-o StrictHostKeyChecking=accept-new -o ConnectTimeout=6 root@${host} ` +
        `"rm -f \\"\\$(ls -d /home/*/ComfyUI /root/ComfyUI 2>/dev/null | head -1)/models/checkpoints/${m}\\""`,
        { superuser: "try" });
      setAlert({ type: "ok", msg: `Deleted ${m} from ${node.id}.` });
      loadAll();
      return;
    }
    const comfyDir = (cfg && cfg.comfy_dir) || "~/ComfyUI";
    await run(`d="${comfyDir}"; d="\${d/#\\~/$HOME}"; rm -f "$d/models/checkpoints/${m}"`);
    setAlert({ type: "ok", msg: `Deleted ${m}. If the disk space doesn't free up, run "spag comfyui restart" (ComfyUI may still hold the file open).` });
    loadAll();
  };

  // Rename a downloaded checkpoint to something memorable. If it's the active
  // engine, update image.yaml so the router still finds it.
  const renameModel = async (m) => {
    let nn = window.prompt("Rename checkpoint to (a .safetensors filename):", m);
    if (!nn || nn.trim() === m) return;
    nn = nn.trim().replace(/[^A-Za-z0-9._-]/g, "_");     // safe filename
    if (!/\.safetensors$/i.test(nn)) nn += ".safetensors";
    const comfyDir = (cfg && cfg.comfy_dir) || "~/ComfyUI";
    await run(`d="${comfyDir}"; d="\${d/#\\~/$HOME}"; mv -n "$d/models/checkpoints/${m}" "$d/models/checkpoints/${nn}"`);
    if (cfg && cfg.model_file === m) await saveCfg({ ...cfg, model_file: nn });
    setAlert({ type: "ok", msg: `Renamed ${m} → ${nn}.` });
    loadAll();
  };

  const spawnRoot = (cmd) => new Promise((res, rej) => {
    const p = cockpit.spawn(["bash", "-c", PATHFIX + cmd], { superuser: "try", err: "message" });
    let out = ""; p.stream(d => { out += d; });
    p.then(() => res(out), rej);
  });

  // Install an architecture pack: clone its ComfyUI custom nodes (as the user, into
  // <comfy_dir>/custom_nodes), drop its workflow template into image-workflows/, and
  // restart ComfyUI so the nodes load. The router then routes that family.
  const installArch = async (pack) => {
    if (installingArch) return;
    setInstallingArch(pack.id);
    setAlert({ type: "ok", msg: `Installing ${pack.name}… (custom nodes can take a minute)` });
    try {
      const comfyDir = (cfg && cfg.comfy_dir) || "~/ComfyUI";
      for (const node of (pack.comfy_nodes || [])) {
        // Runs as the logged-in user so ~/ComfyUI is writable; idempotent (skips clone if present).
        await run(
          `d="${comfyDir}"; d="\${d/#\\~/$HOME}"; cd "$d/custom_nodes" 2>/dev/null && ` +
          `{ [ -d "${node.name}" ] || git clone --depth 1 '${node.repo}' "${node.name}"; ` +
          `[ -f "${node.name}/requirements.txt" ] && "$d/venv/bin/pip" install -q -r "${node.name}/requirements.txt"; true; }`
        );
      }
      // Drop the workflow template into the router's families dir (root-owned /opt).
      const tmpl = await cockpit.file(`/opt/llmspaghetti/config/image-architectures/${pack.id}.json`,
        { superuser: "try" }).read();
      if (!tmpl) throw new Error("pack template not found on disk (deploy config/image-architectures/)");
      await cockpit.file(`/opt/llmspaghetti/config/image-workflows/${pack.id}.json`,
        { superuser: "try" }).replace(tmpl);
      // Restart ComfyUI so newly-cloned nodes are picked up.
      if ((pack.comfy_nodes || []).length) await spawnRoot("systemctl restart comfyui");
      setAlert({ type: "ok", msg: `${pack.name} installed — it's now a selectable architecture.` });
    } catch (e) {
      setAlert({ type: "err", msg: `Install failed: ${e && e.message || e}` });
    } finally {
      setInstallingArch(null);
      setTimeout(loadAll, 6000);   // give ComfyUI a moment to come back
    }
  };

  // Uninstall: drop the workflow template (family stops routing). Custom nodes are
  // left in place (harmless) — remove them from custom_nodes/ manually if desired.
  const uninstallArch = async (pack) => {
    if (installingArch) return;
    setInstallingArch(pack.id);
    try {
      await spawnRoot(`rm -f /opt/llmspaghetti/config/image-workflows/${pack.id}.json`);
      setAlert({ type: "ok", msg: `${pack.name} removed. (Custom nodes left in place.)` });
    } catch (e) {
      setAlert({ type: "err", msg: `Remove failed: ${e && e.message || e}` });
    } finally {
      setInstallingArch(null);
      loadAll();
    }
  };

  // Start the ComfyUI systemd service — on THIS box, or on the node image gen is
  // outsourced to. Starting it locally when the work happens on a node is useless
  // (and confusing: "Unit comfyui.service not found" on a core that never had it).
  const startComfy = () => {
    const onNode = cfg && cfg.host && cfg.host !== "local";
    const node   = onNode && nodes.find(n => n.id === cfg.host);
    if (onNode && !node) {
      setAlert({ type: "err", msg: `Node '${cfg.host}' is not in nodes.yaml — check the Nodes tab.` });
      return;
    }
    const where = onNode ? `on ${node.id}` : "";
    const host  = onNode ? (node.url || "").replace(/^https?:\/\//, "").replace(/[:/].*$/, "") : "";
    const cmd   = onNode
      ? `ssh -i ${NODE_KEY} -o IdentitiesOnly=yes -o BatchMode=yes ` +
        `-o StrictHostKeyChecking=accept-new -o ConnectTimeout=6 root@${host} 'systemctl start comfyui'`
      : "systemctl start comfyui";

    setAlert({ type: "ok", msg: `Starting ComfyUI ${where}…` });
    cockpit.spawn(["bash", "-c", PATHFIX + cmd], { superuser: "try", err: "message" }).then(
      () => { setAlert({ type: "ok", msg: `ComfyUI starting ${where} — give it ~10s, then it'll connect.` });
              setTimeout(loadAll, 8000); },
      (e) => setAlert({ type: "err", msg: onNode
              ? `Couldn't start ComfyUI on ${node.id} (${(e && e.message) || e}). Not installed there yet? Cockpit → Nodes → ${node.id} → 🖼 Install ComfyUI.`
              : `Couldn't start the service (${(e && e.message) || e}). Not installed yet? Run on the box:  spag comfyui install` }),
    );
  };

  const runTest = async () => {
    if (testing || !testPrompt.trim()) return;
    setTesting(true); setTestImg(null); setTestMsg("Generating… (first run loads the model)");
    const t0 = Date.now();
    try {
      // Force the image role with the //image command so this doesn't depend on
      // classification (or on any model alias). The router intercepts image-role
      // requests before touching the `model` field, so it's just a placeholder.
      const body = JSON.stringify({
        model: "spag-image-test", stream: false,
        messages: [{ role: "user", content: `//image ${testPrompt.trim()}` }],
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
  const inputStyle = { background: C.bg, border: `1px solid ${C.border}`, color: C.text,
                       borderRadius: 6, padding: "0.4rem 0.6rem", fontSize: "0.8rem",
                       fontFamily: "inherit", outline: "none" };

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
            ComfyUI{comfy.host && comfy.host !== "local" ? ` on ${comfy.host}` : ""}{" "}
            {comfy.ok ? "connected" : comfy.ok === false ? "unreachable" : "checking…"}
          </div>
          <div style={{ fontSize: "0.78rem", color: C.dim }}>
            {comfy.ok
              ? `${comfy.gpu} · ${comfy.vramGb.toFixed(1)} GB VRAM${comfy.url ? ` · ${comfy.url}` : ""}`
              : comfy.ok === false
                ? (comfy.host && comfy.host !== "local"
                    ? `Not running at ${comfy.url || comfy.host}. Install it on that node: Nodes → ${comfy.host} → 🖼 Install ComfyUI (then Start below).`
                    : "Not running on :8188. Start it below, or set it up once with  spag comfyui install")
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
        {/* Outsource rendering to a node's GPU. Explicit Save (not save-on-change):
            switching hosts re-points status, checkpoints and downloads at another
            box, so apply deliberately — and refresh the whole tab right after. */}
        {cfg && nodes.length > 0 && (
          <label style={{ display: "flex", alignItems: "center", gap: "0.45rem",
                          fontSize: "0.82rem", color: C.text }}>
            Run on
            <select value={pendingHost != null ? pendingHost : (cfg.host || "local")}
              onChange={e => setPendingHost(e.target.value)}
              style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}`,
                       borderRadius: 6, padding: "0.3rem 0.5rem", fontSize: "0.82rem",
                       fontFamily: "inherit" }}>
              <option value="local">this box (local)</option>
              {nodes.map(n => (
                <option key={n.id} value={n.id} disabled={!n.reachable}>
                  {n.id}{n.reachable ? "" : " (unreachable)"}
                </option>
              ))}
            </select>
            {pendingHost != null && pendingHost !== (cfg.host || "local") && (
              <button onClick={applyHost}
                style={{ background: C.green, color: "#fff", border: "none", borderRadius: 6,
                         padding: "0.32rem 0.75rem", fontSize: "0.8rem", fontWeight: 600,
                         cursor: "pointer", fontFamily: "inherit" }}>
                💾 Save
              </button>
            )}
          </label>
        )}
      </div>

      {/* Outsourced: the local GPU panel above describes the WRONG card, so say so. */}
      {cfg && cfg.host && cfg.host !== "local" && (
        <div style={{ ...card, borderColor: C.accent, fontSize: "0.85rem", color: C.text }}>
          🖼 Image generation runs on node <strong>{cfg.host}</strong> — this box's GPU stays free for chat.
          <div style={{ fontSize: "0.78rem", color: C.dim, marginTop: 4 }}>
            ComfyUI must be installed on that node (Cockpit → <strong>Nodes</strong> → 🖼 Install ComfyUI).
            Checkpoint downloads and the installed list below follow the node — the node
            downloads straight from the source onto its own disk.
          </div>
        </div>
      )}

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
                        <>
                          <button title="Delete from disk (frees the space)"
                            onClick={() => deleteModel(eng.model_file)}
                            style={{ padding: "0.28rem 0.5rem", fontSize: "0.8rem",
                                     border: `1px solid ${C.red}40`, borderRadius: 6,
                                     background: "transparent", cursor: "pointer", color: C.red }}>🗑</button>
                          <button disabled={isActive} onClick={() => activate(eng)}
                            style={{ padding: "0.32rem 0.85rem", fontSize: "0.78rem", fontWeight: 600,
                                     border: "none", borderRadius: 6, cursor: isActive ? "default" : "pointer",
                                     background: isActive ? C.border : C.accent, color: "white",
                                     opacity: isActive ? 0.6 : 1 }}>
                            {isActive ? "in use" : "Activate"}
                          </button>
                        </>
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

      {/* Import a ComfyUI workflow → a routable family */}
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={label}>Import ComfyUI workflow</div>
          <button onClick={() => setWfOpen(v => !v)}
            style={{ background: wfOpen ? C.surface2 : C.accent, color: wfOpen ? C.text : "#fff",
                     border: wfOpen ? `1px solid ${C.border}` : "none", borderRadius: 6,
                     padding: "0.35rem 0.8rem", fontSize: "0.8rem", fontWeight: 600,
                     cursor: "pointer", fontFamily: "inherit" }}>
            {wfOpen ? "Close" : "+ Import workflow"}
          </button>
        </div>
        <div style={{ fontSize: "0.78rem", color: C.dim, marginTop: "0.4rem" }}>
          Build a graph in ComfyUI{comfy.url ? ` (${comfy.url})` : ""}, then{" "}
          <strong>Workflow → Export (API)</strong> and drop the JSON here. We tokenise it
          ({"{{PROMPT}}"}, {"{{MODEL}}"}, {"{{SEED}}"}…) so the router can drive it — it becomes a
          family you can pick on any checkpoint. Custom nodes must be installed on the box
          running ComfyUI.
          {families.length > 0 && (
            <div style={{ marginTop: 6 }}>
              Installed families:{" "}
              <span style={{ fontFamily: "monospace", color: C.accent2 }}>{families.join(" · ")}</span>
            </div>
          )}
        </div>

        {wfOpen && (
          <div style={{ marginTop: "0.9rem", display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
              <input value={wfName} onChange={e => setWfName(e.target.value)}
                placeholder="family name (e.g. my-sdxl-hires)"
                style={{ ...inputStyle, flex: "0 1 240px" }} />
              <input type="file" accept=".json,application/json"
                onChange={e => readWorkflowFile(e.target.files && e.target.files[0])}
                style={{ fontSize: "0.78rem", color: C.dim }} />
            </div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <input value={wfUrl} onChange={e => setWfUrl(e.target.value)}
                onKeyDown={e => e.key === "Enter" && fetchWorkflowUrl()}
                placeholder="…or paste a URL to a workflow API .json (raw GitHub, Civitai, …)"
                style={{ ...inputStyle, flex: 1 }} />
              <button onClick={fetchWorkflowUrl} disabled={!wfUrl.trim()}
                style={{ background: C.surface2, color: C.text, border: `1px solid ${C.border}`,
                         borderRadius: 6, padding: "0.4rem 0.8rem", fontSize: "0.8rem",
                         fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                Fetch
              </button>
            </div>
            <textarea value={wfJson}
              onChange={e => { setWfJson(e.target.value); setWfReport(null); }}
              onBlur={() => wfJson.trim() && setWfReport(inspectWorkflow(wfJson, installed))}
              placeholder="…or paste the exported API JSON here"
              rows={7}
              style={{ ...inputStyle, fontFamily: "monospace", fontSize: "0.74rem", resize: "vertical" }} />

            {wfReport && (
              <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8,
                            padding: "0.7rem 0.85rem", fontSize: "0.78rem" }}>
                {wfReport.errors.map((e, i) => (
                  <div key={`e${i}`} style={{ color: C.red, marginBottom: 4 }}>✗ {e}</div>
                ))}
                {wfReport.warnings.map((w, i) => (
                  <div key={`w${i}`} style={{ color: C.yellow, marginBottom: 4 }}>⚠ {w}</div>
                ))}
                {!wfReport.errors.length && (
                  <div style={{ color: C.green, marginBottom: 4 }}>
                    ✓ Valid ComfyUI API graph — ready to import
                  </div>
                )}
                {wfReport.applied.length > 0 && (
                  <div style={{ color: C.dim, marginBottom: 4 }}>
                    Tokenised:{" "}
                    <span style={{ fontFamily: "monospace", color: C.accent2 }}>
                      {wfReport.applied.join(" ")}
                    </span>
                  </div>
                )}
                {wfReport.models.length > 0 && (
                  <div style={{ color: C.dim }}>
                    Needs on {comfy.host && comfy.host !== "local" ? comfy.host : "this box"}:{" "}
                    {wfReport.models.map(m => (
                      <span key={m} style={{ fontFamily: "monospace",
                                             color: wfReport.missing.includes(m) ? C.yellow : C.green }}>
                        {wfReport.missing.includes(m) ? "⚠ " : "✓ "}{m}{" "}
                      </span>
                    ))}
                    {wfReport.missing.length > 0 && (
                      <div style={{ color: C.yellow, marginTop: 4 }}>
                        Missing files — grab them with “Add from HuggingFace” below; they download
                        to the box running ComfyUI. (A checkpoint bound to {"{{MODEL}}"} is supplied
                        by the Image tab, so it needn't be listed here.)
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div>
              <button onClick={importWorkflow}
                disabled={!wfJson.trim() || !wfName.trim() || !!(wfReport && wfReport.errors.length)}
                style={{ background: C.green, color: "#fff", border: "none", borderRadius: 6,
                         padding: "0.45rem 1rem", fontSize: "0.82rem", fontWeight: 600,
                         cursor: "pointer", fontFamily: "inherit",
                         opacity: (!wfJson.trim() || !wfName.trim() || (wfReport && wfReport.errors.length)) ? 0.5 : 1 }}>
                Import as family
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Architecture packs — install support for a model family (nodes + template) */}
      {archs.length > 0 && (
        <div style={card}>
          <div style={label}>Architectures</div>
          <div style={{ fontSize: "0.78rem", color: C.dim, marginBottom: "0.85rem" }}>
            The model families the router can drive. Install a pack to add a new one —
            it clones any ComfyUI custom nodes and drops in the workflow. Built-ins are always available.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {archs.map(a => {
              const busy = installingArch === a.id;
              return (
                <div key={a.id} style={{ background: C.bg,
                                         border: `1px solid ${a.installed ? C.green + "40" : C.border}`,
                                         borderRadius: 8, padding: "0.65rem 0.85rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "0.9rem", fontWeight: 600, color: C.text }}>{a.name}</span>
                    {a.builtin && <span style={{ fontSize: "0.68rem", fontWeight: 700, color: C.dim,
                      background: C.surface, border: `1px solid ${C.border}`, borderRadius: 20,
                      padding: "0.1rem 0.45rem" }}>built-in</span>}
                    {a.experimental && <span style={{ fontSize: "0.68rem", fontWeight: 700, color: C.yellow,
                      background: `${C.yellow}18`, borderRadius: 20, padding: "0.1rem 0.45rem" }}>experimental</span>}
                    <span style={{ fontSize: "0.72rem", color: C.dim }}>~{a.vram_gb} GB</span>
                    <span style={{ flex: 1 }} />
                    {a.installed
                      ? (a.builtin
                          ? <span style={{ fontSize: "0.75rem", fontWeight: 600, color: C.green }}>✓ installed</span>
                          : <button disabled={busy} onClick={() => uninstallArch(a)}
                              style={{ padding: "0.28rem 0.75rem", fontSize: "0.76rem", fontWeight: 600,
                                       border: `1px solid ${C.border}`, borderRadius: 6, background: "transparent",
                                       color: C.dim, cursor: busy ? "default" : "pointer" }}>
                              {busy ? "…" : "Remove"}
                            </button>)
                      : <button disabled={!!installingArch} onClick={() => installArch(a)}
                          style={{ padding: "0.28rem 0.8rem", fontSize: "0.76rem", fontWeight: 600, border: "none",
                                   borderRadius: 6, background: C.accent, color: "white",
                                   cursor: installingArch ? "not-allowed" : "pointer",
                                   opacity: installingArch ? 0.5 : 1 }}>
                          {busy ? "Installing…" : "↓ Install"}
                        </button>}
                  </div>
                  <div style={{ fontSize: "0.78rem", color: C.dim, marginTop: "0.35rem" }}>{a.blurb}</div>
                  {a.note && (a.installed || a.experimental) && (
                    <div style={{ fontSize: "0.72rem", color: C.yellow, marginTop: "0.35rem" }}>⚠ {a.note}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

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
              const isActive = cfg && cfg.model_file === m;
              // Default the dropdown to the SAVED family when this is the active
              // engine — so the choice visibly persists across reloads.
              const fam = customFamily[m] || (isActive && cfg.family) || "sd15";
              const dirty = isActive && fam !== cfg.family;   // changed but not yet saved
              const iconBtn = { padding: "0.28rem 0.5rem", fontSize: "0.8rem", border: `1px solid ${C.border}`,
                                borderRadius: 6, background: "transparent", cursor: "pointer", color: C.dim };
              return (
                <div key={m} style={{ background: C.bg, border: `1px solid ${isActive ? C.accent : C.border}`,
                                      borderRadius: 8, padding: "0.55rem 0.8rem", display: "flex",
                                      alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                  <span style={{ flex: 1, fontFamily: "monospace", fontSize: "0.82rem", color: C.text,
                                 overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m}</span>
                  {isActive && <span style={{ fontSize: "0.72rem", fontWeight: 700, color: C.accent2 }}>● active</span>}
                  <select value={fam} onChange={e => setCustomFamily(o => ({ ...o, [m]: e.target.value }))}
                    style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text,
                             borderRadius: 6, fontSize: "0.78rem", padding: "0.25rem 0.4rem", cursor: "pointer" }}>
                    {/* Every template on disk — arch packs AND imported workflows. Sourced
                        from /api/image-workflows so an import shows up here immediately. */}
                    {(families.length
                        ? families.map(id => {
                            const a = archs.find(x => x.id === id);
                            return { id, name: (a && a.name) || id };
                          })
                        : [{ id: "sd15", name: "SD 1.5" }, { id: "sdxl", name: "SDXL" }, { id: "flux", name: "Flux" }]
                     ).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <button title="Rename" onClick={() => renameModel(m)} style={iconBtn}>✎</button>
                  <button title="Delete from disk" onClick={() => deleteModel(m)}
                    style={{ ...iconBtn, color: C.red, borderColor: `${C.red}40` }}>🗑</button>
                  <button disabled={isActive && !dirty} onClick={() => activateCustom(m, fam)}
                    style={{ padding: "0.3rem 0.8rem", fontSize: "0.78rem", fontWeight: 600, border: "none",
                             borderRadius: 6, cursor: (isActive && !dirty) ? "default" : "pointer",
                             background: (isActive && !dirty) ? C.border : C.accent, color: "white",
                             opacity: (isActive && !dirty) ? 0.6 : 1 }}>
                    {isActive ? (dirty ? "Save" : "in use") : "Activate"}
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
