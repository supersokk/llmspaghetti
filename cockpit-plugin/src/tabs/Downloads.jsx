/*
 * Downloads tab — one place for every download in flight, plus a history log.
 *
 * Reads the module-level `downloads` manager (src/downloads.js), which both the
 * Models tab (Ollama pulls) and the Image Generator tab (checkpoint files) push
 * into. Because the manager lives outside React, active downloads and their live
 * progress survive tab switches and webview refreshes — the whole reason this
 * exists.
 */
import React, { useState, useEffect } from "react";
import { downloads } from "../downloads.js";

const C = {
  bg: "#0d1117", surface: "#161b22", border: "#30363d",
  accent: "#2f81f7", accent2: "#58a6ff",
  green: "#3fb950", yellow: "#d29922", red: "#f85149",
  text: "#e6edf3", dim: "#8b949e", purple: "#bc8cff",
};

const KIND = {
  model: { icon: "🧠", label: "Model" },
  file:  { icon: "🖼", label: "Checkpoint" },
  job:   { icon: "⚙", label: "Node install" },
};

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function Bar({ pct }) {
  const known = typeof pct === "number";
  return (
    <div style={{ height: 8, background: C.border, borderRadius: 5, overflow: "hidden", marginTop: 6 }}>
      <div style={{
        height: "100%",
        width: known ? `${pct}%` : "35%",
        background: C.accent,
        borderRadius: 5,
        transition: "width .3s",
        opacity: known ? 1 : 0.5,
      }} />
    </div>
  );
}

export default function Downloads() {
  const [state, setState] = useState(downloads._snapshot());
  useEffect(() => downloads.subscribe(setState), []);

  const { active, history } = state;

  return (
    <div style={{ color: C.text }}>
      <h2 style={{ fontSize: "1.05rem", fontWeight: 700, marginBottom: "0.25rem" }}>Downloads</h2>
      <div style={{ fontSize: "0.82rem", color: C.dim, marginBottom: "1.25rem" }}>
        Model pulls and image checkpoints. Progress keeps running — and stays visible here —
        even if you switch tabs or refresh.
      </div>

      {/* ── Active ── */}
      <div style={{ fontSize: "0.75rem", fontWeight: 700, color: C.dim,
                    textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.6rem" }}>
        Active {active.length > 0 && `(${active.length})`}
      </div>
      {active.length === 0 ? (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                      padding: "1.25rem", color: C.dim, fontSize: "0.85rem", marginBottom: "1.5rem" }}>
          Nothing downloading right now. Start a pull from the <strong>Models</strong> tab or a
          checkpoint from the <strong>Image</strong> tab.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginBottom: "1.5rem" }}>
          {active.map(job => {
            const k = KIND[job.kind] || KIND.model;
            return (
              <div key={job.id} style={{ background: C.surface, border: `1px solid ${C.accent}40`,
                                         borderRadius: 10, padding: "0.9rem 1.1rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", minWidth: 0 }}>
                    <span>{k.icon}</span>
                    <span style={{ fontWeight: 600, fontSize: "0.9rem", overflow: "hidden",
                                   textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{job.name}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexShrink: 0 }}>
                    <span style={{ fontSize: "0.8rem", color: C.accent2, fontWeight: 700 }}>
                      {typeof job.pct === "number" ? `${job.pct}%` : "…"}
                    </span>
                    <button onClick={() => downloads.cancel(job.id)}
                      style={{ background: "transparent", color: C.dim, border: `1px solid ${C.border}`,
                               borderRadius: 6, fontSize: "0.72rem", padding: "0.2rem 0.5rem", cursor: "pointer" }}>
                      Cancel
                    </button>
                  </div>
                </div>
                <Bar pct={job.pct} />
                <div style={{ fontSize: "0.72rem", color: C.dim, marginTop: 5 }}>
                  {k.label} · {job.label || "working…"}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── History ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.6rem" }}>
        <div style={{ fontSize: "0.75rem", fontWeight: 700, color: C.dim,
                      textTransform: "uppercase", letterSpacing: "0.05em" }}>
          History {history.length > 0 && `(${history.length})`}
        </div>
        {history.length > 0 && (
          <button onClick={() => downloads.clearHistory()}
            style={{ background: "transparent", color: C.dim, border: `1px solid ${C.border}`,
                     borderRadius: 6, fontSize: "0.72rem", padding: "0.25rem 0.6rem", cursor: "pointer" }}>
            Clear history
          </button>
        )}
      </div>
      {history.length === 0 ? (
        <div style={{ color: C.dim, fontSize: "0.82rem" }}>No finished downloads yet.</div>
      ) : (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
          {history.map((h, i) => {
            const k = KIND[h.kind] || KIND.model;
            const ok = h.phase === "done";
            return (
              <div key={h.id} style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem",
                                       padding: "0.7rem 1rem",
                                       borderTop: i === 0 ? "none" : `1px solid ${C.border}` }}>
                <span style={{ color: ok ? C.green : C.red, fontWeight: 700, flexShrink: 0 }}>
                  {ok ? "✓" : "✕"}
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: "0.85rem", fontWeight: 600 }}>
                    {k.icon} {h.name}
                  </div>
                  <div style={{ fontSize: "0.72rem", color: C.dim, marginTop: 2 }}>{h.msg}</div>
                </div>
                <span style={{ fontSize: "0.7rem", color: C.dim, flexShrink: 0 }}>{ago(h.endedAt)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
