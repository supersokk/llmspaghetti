/**
 * LLMSpaghetti Services Tab
 * Docker services: Runtimes, Image Generation, Data & Search, Automation
 * MCP Tools: tap-to-install npm-based MCP servers
 */

import React, { useState, useEffect, useCallback } from "react";

const cockpit = window.cockpit || {
  spawn: (cmd, opts) => ({ stream: () => {}, then: (f) => { f(""); return { catch: () => {} }; }, catch: () => {} }),
  file:  (p) => ({ read: () => Promise.resolve(""), replace: () => Promise.resolve() }),
};

const C = {
  bg: "#0d1117", surface: "#161b22", border: "#30363d",
  accent: "#2f81f7", accent2: "#58a6ff",
  green: "#3fb950", yellow: "#d29922", red: "#f85149",
  text: "#e6edf3", dim: "#8b949e", purple: "#bc8cff",
};

const run = (cmd) => new Promise((res) => {
  let out = "";
  const proc = cockpit.spawn(["bash", "-c", cmd], { superuser: "try", err: "message" });
  proc.stream(d => { out += d; });
  proc.then(() => res(out.trim())).catch(() => res(""));
});

const MCP_JSON_PATH   = "/opt/llmspaghetti/config/mcp.json";

// ── Docker service definitions ────────────────────────────────────────────────

const SERVICES = [
  // Runtimes
  {
    id:          "llamacpp",
    name:        "llama.cpp Server",
    icon:        "⚡",
    desc:        "Direct GGUF inference — zero overhead, OpenAI-compatible API. Fastest option for local models.",
    port:        8080,
    container:   "llmspaghetti-llamacpp",
    category:    "Runtimes",
    install_cmd: "docker run -d --name llmspaghetti-llamacpp -p 8080:8080 -v /opt/llmspaghetti/models:/models ghcr.io/ggerganov/llama.cpp:server --host 0.0.0.0 --port 8080 -c 4096",
  },
  {
    id:          "vllm",
    name:        "vLLM",
    icon:        "🚀",
    desc:        "High-throughput production serving for NVIDIA GPUs. PagedAttention + continuous batching.",
    port:        8000,
    container:   "llmspaghetti-vllm",
    category:    "Runtimes",
    install_cmd: "docker run -d --gpus all --name llmspaghetti-vllm -p 8000:8000 -v /opt/llmspaghetti/models:/root/.cache/huggingface vllm/vllm-openai:latest --host 0.0.0.0 --model meta-llama/Llama-3.2-1B-Instruct",
    requires_gpu: true,
  },
  // Image Generation
  {
    id:          "comfyui",
    name:        "ComfyUI",
    icon:        "🎨",
    desc:        "Local image generation — pairs with the image routing role. Installs natively (host service, uses the GPU directly like Ollama).",
    port:        8188,
    category:    "Image Generation",
    // Native (host systemd service), not Docker: consistent with Ollama, uses the
    // GPU directly (no nvidia-container-toolkit). Status/actions go through
    // systemctl; install runs our idempotent setup script.
    native:      true,
    service:     "comfyui",
    install_cmd: "bash /opt/llmspaghetti/scripts/comfyui-setup.sh 2>&1 | tail -15",
    requires_gpu: true,
  },
  {
    id:          "automatic1111",
    name:        "Automatic1111",
    icon:        "✏️",
    desc:        "Stable Diffusion web UI — alternative to ComfyUI with a different workflow style.",
    port:        7860,
    container:   "llmspaghetti-a1111",
    category:    "Image Generation",
    install_cmd: "docker run -d --gpus all --name llmspaghetti-a1111 -p 7860:7860 -v /opt/llmspaghetti/a1111:/data universalml/auto1111-docker:latest",
    requires_gpu: true,
  },
  // Data & Search
  {
    id:          "searxng",
    name:        "SearXNG",
    icon:        "🔍",
    desc:        "Self-hosted metasearch engine for RAG and web-aware responses.",
    port:        8080,
    container:   "llmspaghetti-searxng",
    category:    "Data & Search",
    install_cmd: "docker run -d --name llmspaghetti-searxng -p 8080:8080 -e BASE_URL=http://localhost:8080 -e INSTANCE_NAME=llmspaghetti searxng/searxng:latest",
  },
  {
    id:          "whisper",
    name:        "Whisper",
    icon:        "🎤",
    desc:        "Local speech-to-text — transcribe audio without sending it to the cloud.",
    port:        9000,
    container:   "llmspaghetti-whisper",
    category:    "Data & Search",
    install_cmd: "docker run -d --name llmspaghetti-whisper -p 9000:9000 onerahmet/openai-whisper-asr-webservice:latest",
  },
  {
    id:          "qdrant",
    name:        "Qdrant",
    icon:        "🗃",
    desc:        "Vector database for RAG — store and search document embeddings locally.",
    port:        6333,
    container:   "llmspaghetti-qdrant",
    category:    "Data & Search",
    install_cmd: "docker run -d --name llmspaghetti-qdrant -p 6333:6333 -p 6334:6334 -v /opt/llmspaghetti/qdrant:/qdrant/storage qdrant/qdrant:latest",
  },
  // Automation
  {
    id:          "n8n",
    name:        "n8n",
    icon:        "⚙️",
    desc:        "Workflow automation — connect your AI models to any tool or API.",
    port:        5678,
    container:   "llmspaghetti-n8n",
    category:    "Automation",
    install_cmd: "docker run -d --name llmspaghetti-n8n -p 5678:5678 -v /opt/llmspaghetti/n8n:/home/node/.n8n n8nio/n8n:latest",
  },
  {
    id:          "flowise",
    name:        "Flowise",
    icon:        "🌊",
    desc:        "Visual LLM chain builder — drag-and-drop AI workflows.",
    port:        3001,
    container:   "llmspaghetti-flowise",
    category:    "Automation",
    install_cmd: "docker run -d --name llmspaghetti-flowise -p 3001:3000 -v /opt/llmspaghetti/flowise:/root/.flowise flowiseai/flowise:latest",
  },
];

const DOCKER_CATEGORIES = ["Runtimes", "Image Generation", "Data & Search", "Automation"];

// ── MCP server definitions ─────────────────────────────────────────────────────

const MCP_SERVERS = [
  {
    id:          "filesystem",
    name:        "Filesystem",
    icon:        "📁",
    desc:        "Read and write local files. Models can browse directories, read, create, and edit files.",
    pkg:         "@modelcontextprotocol/server-filesystem",
    defaultArgs: ["/home", "/opt/llmspaghetti/data"],
    isDefault:   true,
  },
  {
    id:          "memory",
    name:        "Memory",
    icon:        "🧠",
    desc:        "Persistent memory across conversations. Models remember facts between sessions.",
    pkg:         "@modelcontextprotocol/server-memory",
    isDefault:   true,
  },
  {
    id:          "fetch",
    name:        "Fetch",
    icon:        "🌐",
    desc:        "Read any URL. Models can access live web content, documentation, and APIs.",
    pkg:         "@modelcontextprotocol/server-fetch",
    isDefault:   true,
  },
  {
    id:          "brave-search",
    name:        "Brave Search",
    icon:        "🦁",
    desc:        "Web search via Brave Search API. Free tier: 2,000 searches/month.",
    pkg:         "@modelcontextprotocol/server-brave-search",
    requiresKey: "BRAVE_API_KEY",
  },
  {
    id:          "github",
    name:        "GitHub",
    icon:        "🐙",
    desc:        "Read and write GitHub repos. Issues, PRs, commits, files.",
    pkg:         "@modelcontextprotocol/server-github",
    requiresKey: "GITHUB_PERSONAL_ACCESS_TOKEN",
  },
  {
    id:          "sqlite",
    name:        "SQLite",
    icon:        "📦",
    desc:        "Query local SQLite databases. Read schema, run read-only queries on .db files.",
    pkg:         "@modelcontextprotocol/server-sqlite",
    defaultArgs: ["/opt/llmspaghetti/data"],
  },
  {
    id:          "postgres",
    name:        "PostgreSQL",
    icon:        "🗄",
    desc:        "Query PostgreSQL databases. Models can explore schemas and run read-only queries.",
    pkg:         "@modelcontextprotocol/server-postgres",
    requiresKey: "POSTGRES_URL",
  },
];

// ── Docker service card ───────────────────────────────────────────────────────

function ServiceCard({ svc, status, onAction, busy, serverIp }) {
  const isRunning      = status === "running";
  const isInstalled    = status === "running" || status === "stopped" || status === "exited";
  const isNotInstalled = !isInstalled && status !== "loading";

  const statusColour = isRunning   ? C.green
                     : isInstalled ? C.yellow
                     : C.dim;

  const statusLabel = status === "loading"   ? "…"
                    : status === "running"   ? "Running"
                    : status === "stopped"
                   || status === "exited"    ? "Stopped"
                    : status === "not-found" ? "Not installed"
                    : status;

  const openUrl = `http://${serverIp || "localhost"}:${svc.port}`;

  return (
    <div style={{
      background: C.surface, border: `1px solid ${isRunning ? C.green + "30" : C.border}`,
      borderRadius: "10px", padding: "1.25rem",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between",
                    alignItems: "flex-start", marginBottom: "0.6rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <span style={{ fontSize: "1.4rem" }}>{svc.icon}</span>
          <div>
            <div style={{ fontWeight: 700, fontSize: "0.95rem" }}>{svc.name}</div>
            {svc.requires_gpu && (
              <span style={{ fontSize: "0.65rem", color: C.purple,
                             background: `${C.purple}18`, padding: "0.1rem 0.4rem",
                             borderRadius: "10px", fontWeight: 700 }}>GPU</span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: statusColour }} />
          <span style={{ fontSize: "0.75rem", color: statusColour, fontWeight: 600 }}>
            {statusLabel}
          </span>
        </div>
      </div>

      <div style={{ fontSize: "0.82rem", color: C.dim, marginBottom: "0.9rem",
                    lineHeight: 1.5 }}>{svc.desc}</div>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        {isNotInstalled && (
          <button onClick={() => onAction(svc, "install")} disabled={busy}
            style={{ flex: 1, padding: "0.4rem 0.75rem", background: C.accent,
                     color: "white", border: "none", borderRadius: "6px",
                     fontSize: "0.82rem", fontWeight: 600, cursor: busy ? "wait" : "pointer" }}>
            {busy ? "Installing…" : "↓ Install"}
          </button>
        )}
        {isInstalled && !isRunning && (
          <button onClick={() => onAction(svc, "start")} disabled={busy}
            style={{ padding: "0.4rem 0.75rem", background: `${C.green}18`,
                     color: C.green, border: `1px solid ${C.green}40`,
                     borderRadius: "6px", fontSize: "0.82rem", fontWeight: 600,
                     cursor: busy ? "wait" : "pointer" }}>
            ▶ Start
          </button>
        )}
        {isRunning && (
          <>
            <button onClick={() => onAction(svc, "stop")} disabled={busy}
              style={{ padding: "0.4rem 0.75rem", background: `${C.yellow}18`,
                       color: C.yellow, border: `1px solid ${C.yellow}40`,
                       borderRadius: "6px", fontSize: "0.82rem", fontWeight: 600,
                       cursor: busy ? "wait" : "pointer" }}>
              ⏸ Stop
            </button>
            <a href={openUrl} target="_blank" rel="noreferrer"
              style={{ padding: "0.4rem 0.75rem", background: "transparent",
                       color: C.accent2, border: `1px solid ${C.border}`,
                       borderRadius: "6px", fontSize: "0.82rem", fontWeight: 600,
                       textDecoration: "none", display: "inline-flex",
                       alignItems: "center", gap: "0.3rem" }}>
              Open ↗
            </a>
          </>
        )}
        {isInstalled && (
          <button onClick={() => onAction(svc, "remove")} disabled={busy}
            style={{ padding: "0.4rem 0.75rem", background: "transparent",
                     color: C.dim, border: `1px solid ${C.border}30`,
                     borderRadius: "6px", fontSize: "0.75rem",
                     cursor: busy ? "wait" : "pointer" }}>
            Remove
          </button>
        )}
      </div>

      <div style={{ marginTop: "0.6rem", fontSize: "0.72rem", color: C.dim }}>
        Port {svc.port} · {openUrl}
      </div>
    </div>
  );
}

// ── MCP server card ───────────────────────────────────────────────────────────

function McpCard({ server, installed, onInstall, onUninstall, busy }) {
  return (
    <div style={{
      background: C.surface,
      border: `1px solid ${installed ? C.green + "30" : C.border}`,
      borderRadius: "10px", padding: "1.25rem",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between",
                    alignItems: "flex-start", marginBottom: "0.6rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <span style={{ fontSize: "1.4rem" }}>{server.icon}</span>
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
            <div style={{ fontWeight: 700, fontSize: "0.95rem" }}>{server.name}</div>
            {server.isDefault && (
              <span style={{ fontSize: "0.62rem", color: C.green,
                             background: `${C.green}18`, padding: "0.1rem 0.4rem",
                             borderRadius: "10px", fontWeight: 700 }}>DEFAULT</span>
            )}
            {server.requiresKey && (
              <span style={{ fontSize: "0.62rem", color: C.yellow,
                             background: `${C.yellow}18`, padding: "0.1rem 0.4rem",
                             borderRadius: "10px", fontWeight: 700 }}>KEY</span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%",
                        background: installed ? C.green : C.dim }} />
          <span style={{ fontSize: "0.75rem", color: installed ? C.green : C.dim, fontWeight: 600 }}>
            {installed ? "Installed" : "Not installed"}
          </span>
        </div>
      </div>

      <div style={{ fontSize: "0.82rem", color: C.dim, marginBottom: "0.9rem",
                    lineHeight: 1.5 }}>{server.desc}</div>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        {!installed ? (
          <button onClick={() => onInstall(server)} disabled={busy}
            style={{ flex: 1, padding: "0.4rem 0.75rem", background: C.accent,
                     color: "white", border: "none", borderRadius: "6px",
                     fontSize: "0.82rem", fontWeight: 600, cursor: busy ? "wait" : "pointer" }}>
            {busy ? "Installing…" : "↓ Install"}
          </button>
        ) : (
          <button onClick={() => onUninstall(server)} disabled={busy}
            style={{ padding: "0.4rem 0.75rem", background: "transparent",
                     color: C.dim, border: `1px solid ${C.border}30`,
                     borderRadius: "6px", fontSize: "0.75rem",
                     cursor: busy ? "wait" : "pointer" }}>
            Remove
          </button>
        )}
      </div>

      <div style={{ marginTop: "0.6rem", fontSize: "0.72rem", color: C.dim }}>
        <code style={{ color: C.accent2 + "cc" }}>{server.pkg}</code>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN SERVICES TAB
// ═════════════════════════════════════════════════════════════════════════════
export default function Services() {
  const [statuses, setStatuses]       = useState({});
  const [busy, setBusy]               = useState(null);
  const [mcpStatuses, setMcpStatuses] = useState({});
  const [busyMcp, setBusyMcp]         = useState(null);
  const [log, setLog]                 = useState([]);
  const [serverIp, setServerIp]       = useState("localhost");

  useEffect(() => {
    run("hostname -I | awk '{print $1}'").then(ip => { if (ip) setServerIp(ip); });
  }, []);

  // ── Docker container status poll ──────────────────────────────────────────

  const refresh = useCallback(async () => {
    const checks = await Promise.all(
      SERVICES.map(async svc => {
        if (svc.native) {
          // Host systemd service (e.g. ComfyUI): active → running, unit present but
          // stopped → exited (installed), no unit → not-found (not installed).
          const active = await run(`systemctl is-active ${svc.service} 2>/dev/null`);
          if (active === "active") return [svc.id, "running"];
          const exists = await run(
            `systemctl list-unit-files ${svc.service}.service --no-legend 2>/dev/null | grep -c ${svc.service} || echo 0`
          );
          return [svc.id, parseInt(exists, 10) > 0 ? "exited" : "not-found"];
        }
        const out = await run(
          `docker inspect --format '{{.State.Status}}' ${svc.container} 2>/dev/null`
        );
        const status = out === "running" ? "running"
                     : out === "exited"  ? "exited"
                     : out === "paused"  ? "stopped"
                     : out              ? out
                     : "not-found";
        return [svc.id, status];
      })
    );
    setStatuses(Object.fromEntries(checks));
  }, []);

  useEffect(() => {
    setStatuses(Object.fromEntries(SERVICES.map(s => [s.id, "loading"])));
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [refresh]);

  // ── MCP status check ──────────────────────────────────────────────────────

  const checkMcpStatus = useCallback(async () => {
    const checks = await Promise.all(
      MCP_SERVERS.map(async s => {
        const pkgName = s.pkg.split("/").pop();
        const out = await run(
          `npm list -g --depth=0 "${s.pkg}" 2>/dev/null | grep -c "${pkgName}" || echo 0`
        );
        return [s.id, parseInt(out, 10) > 0];
      })
    );
    setMcpStatuses(Object.fromEntries(checks));
  }, []);

  useEffect(() => { checkMcpStatus(); }, [checkMcpStatus]);

  const appendLog = (msg) =>
    setLog(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev.slice(0, 49)]);

  // ── Docker actions ────────────────────────────────────────────────────────

  const handleAction = async (svc, action) => {
    setBusy(svc.id);
    appendLog(`${action} ${svc.name}…`);
    try {
      let cmd;
      if (svc.native) {
        // Host systemd service — install runs our setup script; the rest are systemctl.
        // Removing keeps the ComfyUI files (GBs), just tears down the service.
        switch (action) {
          case "install": cmd = svc.install_cmd; break;
          case "start":   cmd = `systemctl start ${svc.service}`; break;
          case "stop":    cmd = `systemctl stop ${svc.service}`; break;
          case "remove":  cmd = `systemctl disable --now ${svc.service} 2>/dev/null; rm -f /etc/systemd/system/${svc.service}.service; systemctl daemon-reload`; break;
          default: return;
        }
      } else {
        switch (action) {
          case "install": cmd = svc.install_cmd; break;
          case "start":   cmd = `docker start ${svc.container}`; break;
          case "stop":    cmd = `docker stop ${svc.container}`; break;
          case "remove":  cmd = `docker stop ${svc.container} 2>/dev/null; docker rm ${svc.container}`; break;
          default: return;
        }
      }
      const out = await run(cmd);
      appendLog(`${svc.name} ${action} complete${out ? `: ${out}` : ""}`);
      await refresh();
    } catch (e) {
      appendLog(`${svc.name} ${action} failed: ${e}`);
    } finally {
      setBusy(null);
    }
  };

  // ── MCP actions ───────────────────────────────────────────────────────────

  const updateMcpJson = async (server, isInstall) => {
    const raw = await run(`cat "${MCP_JSON_PATH}" 2>/dev/null || echo "{}"`);
    let config = {};
    try { config = JSON.parse(raw); } catch {}
    if (!config.mcpServers) config.mcpServers = {};

    if (isInstall) {
      const args = ["-y", server.pkg, ...(server.defaultArgs || [])];
      config.mcpServers[server.id] = { command: "npx", args, env: {} };
    } else {
      delete config.mcpServers[server.id];
    }

    await cockpit.file(MCP_JSON_PATH, { superuser: "try" }).replace(JSON.stringify(config, null, 2) + "\n");
  };

  const handleMcpInstall = async (server) => {
    setBusyMcp(server.id);
    appendLog(`Installing ${server.name} (${server.pkg})…`);
    try {
      const out = await run(`npm install -g "${server.pkg}" 2>&1 | tail -3`);
      appendLog(`${server.name} installed${out ? `: ${out}` : ""}`);
      await updateMcpJson(server, true);
      await checkMcpStatus();
    } catch (e) {
      appendLog(`${server.name} install failed: ${e}`);
    } finally {
      setBusyMcp(null);
    }
  };

  const handleMcpUninstall = async (server) => {
    setBusyMcp(server.id);
    appendLog(`Removing ${server.name}…`);
    try {
      await run(`npm uninstall -g "${server.pkg}" 2>&1`);
      appendLog(`${server.name} removed`);
      await updateMcpJson(server, false);
      await checkMcpStatus();
    } catch (e) {
      appendLog(`${server.name} remove failed: ${e}`);
    } finally {
      setBusyMcp(null);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const grouped = DOCKER_CATEGORIES.map(cat => ({
    cat,
    services: SERVICES.filter(s => s.category === cat),
  }));

  return (
    <div>
      {/* Docker services info */}
      <div style={{ background: "rgba(47,129,247,0.08)", border: "1px solid rgba(47,129,247,0.2)",
                    borderRadius: "8px", padding: "0.75rem 1rem",
                    fontSize: "0.85rem", color: C.dim, marginBottom: "1.25rem" }}>
        Optional services run as Docker containers alongside the main stack.
        GPU-tagged services require an NVIDIA or AMD GPU.
        Data is persisted in <code style={{ color: C.accent2 }}>/opt/llmspaghetti/&lt;service&gt;</code>.
      </div>

      {/* Docker service groups */}
      {grouped.map(({ cat, services: svcs }) => (
        <div key={cat} style={{ marginBottom: "1.5rem" }}>
          <div style={{ fontSize: "0.72rem", color: C.dim, fontWeight: 600,
                        textTransform: "uppercase", letterSpacing: "0.06em",
                        marginBottom: "0.75rem" }}>{cat}</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            {svcs.map(svc => (
              <ServiceCard
                key={svc.id}
                svc={svc}
                status={statuses[svc.id] || "loading"}
                onAction={handleAction}
                busy={busy === svc.id}
                serverIp={serverIp}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Divider */}
      <div style={{ borderTop: `1px solid ${C.border}`, margin: "0.5rem 0 1.5rem" }} />

      {/* MCP Tools section */}
      <div style={{ fontSize: "0.72rem", color: C.dim, fontWeight: 600,
                    textTransform: "uppercase", letterSpacing: "0.06em",
                    marginBottom: "0.75rem" }}>MCP Tools</div>

      <div style={{ background: "rgba(188,140,255,0.06)", border: "1px solid rgba(188,140,255,0.2)",
                    borderRadius: "8px", padding: "0.75rem 1rem",
                    fontSize: "0.85rem", color: C.dim, marginBottom: "1rem" }}>
        MCP tools let models read files, search the web, query databases, and more.
        DEFAULT tools are recommended for most setups. KEY tools need an API key — configure in
        <code style={{ color: C.accent2 }}> /opt/llmspaghetti/config/mcp.json</code>.
        Enable per role in the <strong style={{ color: C.text }}>Routing → Tools</strong> tab.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem",
                    marginBottom: "1.5rem" }}>
        {MCP_SERVERS.map(server => (
          <McpCard
            key={server.id}
            server={server}
            installed={mcpStatuses[server.id] || false}
            onInstall={handleMcpInstall}
            onUninstall={handleMcpUninstall}
            busy={busyMcp === server.id}
          />
        ))}
      </div>

      {/* Action log */}
      {log.length > 0 && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`,
                      borderRadius: "10px", padding: "1rem 1.25rem" }}>
          <div style={{ fontSize: "0.72rem", color: C.dim, fontWeight: 600,
                        textTransform: "uppercase", letterSpacing: "0.05em",
                        marginBottom: "0.5rem" }}>Action log</div>
          <div style={{ fontFamily: "monospace", fontSize: "0.78rem",
                        color: C.dim, lineHeight: 1.7 }}>
            {log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </div>
      )}
    </div>
  );
}
