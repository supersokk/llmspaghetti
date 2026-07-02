#!/usr/bin/env python3
"""
LLMSpaghetti Router
Sits between Open WebUI and LiteLLM.
- Classifies each chat message and rewrites the model field silently
- Intercepts image-role requests, calls DALL-E, saves image, returns inline markdown
- Logs VRAM budget at startup
"""

import asyncio
import json
import logging
import math
import os
import re
import secrets
import socket
import sys
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator, Optional

import httpx
import yaml
from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
import uvicorn

# ── Paths & env ───────────────────────────────────────────────────────────────

INSTALL_DIR      = Path(os.environ.get("INSTALL_DIR", "/opt/llmspaghetti"))
CONFIG_PATH      = INSTALL_DIR / "config" / "router_roles.yaml"
LITELLM_CFG_PATH = INSTALL_DIR / "config" / "litellm_config.yaml"
QUOTAS_PATH      = INSTALL_DIR / "config" / "quotas.yaml"
QUOTA_STATE_PATH = INSTALL_DIR / "data"   / "quota_state.json"
MCP_CONFIG_PATH  = INSTALL_DIR / "config" / "mcp.json"
ROLE_TOOLS_PATH  = INSTALL_DIR / "config" / "role_tools.yaml"
API_KEYS_PATH    = INSTALL_DIR / "config" / "api_keys.env"
IMAGES_DIR       = INSTALL_DIR / "images"
LITELLM_URL      = os.environ.get("LITELLM_URL", "http://litellm:4000")
OLLAMA_URL       = os.environ.get("OLLAMA_URL", "http://host.docker.internal:11434")
OPENAI_API_KEY   = os.environ.get("OPENAI_API_KEY", "")
EMBED_MODEL      = os.environ.get("EMBED_MODEL", "nomic-embed-text")


def _server_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "localhost"


IMAGES_SERVE_URL = os.environ.get("IMAGES_SERVE_URL") or f"http://{_server_ip()}/images"

# In-memory routing log — last 50 decisions
_routing_log: deque = deque(maxlen=50)

# Quota tracking — persisted to QUOTA_STATE_PATH across restarts
_quota_cfg:        dict  = {}
_quota_cfg_mtime:  float = 0.0
_quota_state:      dict  = {"date": "", "counts": {}}

# MCP tool config — mtime-cached
_mcp_cfg:          dict  = {}
_mcp_cfg_mtime:    float = 0.0
_role_tools:       dict  = {}
_role_tools_mtime: float = 0.0

# Add eval/ to path so we can import classifier
sys.path.insert(0, str(Path(__file__).parent.parent / "eval"))
from classifier import classify, Context, Classification, VALID_ROLES  # noqa: E402

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [router] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("router")

# ── Role → model config ───────────────────────────────────────────────────────

_config_cache: dict = {}
_config_mtime: float = 0.0


def _load_config() -> dict:
    global _config_cache, _config_mtime
    try:
        mtime = CONFIG_PATH.stat().st_mtime
        if mtime != _config_mtime:
            with open(CONFIG_PATH) as f:
                _config_cache = yaml.safe_load(f) or {}
            _config_mtime = mtime
            log.info(f"loaded role config from {CONFIG_PATH}")
    except FileNotFoundError:
        pass
    return _config_cache


def _model_for_role(role: str) -> tuple[str, str | None]:
    """Returns (primary_model, fallback_model_or_None)."""
    roles = _load_config().get("roles", {})
    entry = roles.get(role)
    if entry is None or role == "none":
        entry = roles.get("general") or "local-default"
    if isinstance(entry, dict):
        primary  = entry.get("primary") or "local-default"
        fallback = entry.get("fallback") or None
        return str(primary), (str(fallback) if fallback else None)
    return (str(entry) if entry else "local-default"), None


# ── Utility / housekeeping detection ──────────────────────────────────────────
# Some requests aren't user intent: a client generating a chat title, tags, or
# follow-up suggestions, autocomplete, etc. They must not be classified, must not
# get MCP tools or a provenance tag (tagging a generated title would corrupt it),
# and belong on a cheap model.
#
# Primary signal — an explicit marker the client sets: `metadata.intent` in the
# body or the `X-LLMSpaghetti-Intent` header. This is what our own chat will send.
# Compatibility shim — Open WebUI marks title/tags/follow-up generation with a
# prompt that begins with "### Task:"; we detect that until we own the client.

_UTILITY_INTENTS = {"utility", "task", "housekeeping"}


def _is_utility_request(payload: dict, headers, last_msg: str) -> bool:
    # 1. Explicit, client-agnostic signal (preferred).
    meta = payload.get("metadata")
    if isinstance(meta, dict) and str(meta.get("intent", "")).lower() in _UTILITY_INTENTS:
        return True
    try:
        if str(headers.get("x-llmspaghetti-intent", "")).lower() in _UTILITY_INTENTS:
            return True
    except Exception:
        pass
    # 2. Open WebUI compatibility shim.
    if last_msg.lstrip().startswith("### Task:"):
        return True
    return False


def _utility_model() -> str:
    """Cheap model for housekeeping: explicit `utility` role wins, else reuse the
    `fast` model, else the local default."""
    roles = _load_config().get("roles", {})
    entry = roles.get("utility") or roles.get("fast") or "local-default"
    if isinstance(entry, dict):
        entry = entry.get("primary") or "local-default"
    return str(entry)


# ── Learned corrections (Flywheel, Phase 1) ───────────────────────────────────
# When a human says "this route was wrong, it should have been X", we store the
# correction and apply it to future identical messages — locally, instantly, no
# restart. See docs/PLANNED-routing-fixture-flywheel.md.
#
# Phase 1 is exact (normalized) text match, sitting ABOVE the keyword classifier:
# an explicit human correction is ground truth for that message and beats the
# keyword guess. Phase 1b will add embedding kNN so *similar* messages benefit.
# Storage is append-only JSONL (CORRECTION_SCHEMA in eval/classifier.py); undo is
# a tombstone record, never a hard delete — reversibility from day one.

OVERRIDES_PATH   = INSTALL_DIR / "data" / "overrides_local.jsonl"
_MSG_CAP         = 2000  # cap stored/displayed message length (local text)
_overrides_cache:   dict  = {}   # normalized message → corrected_role (exact, active)
_overrides_vectors: list  = []   # [{"role","vec"}] for fuzzy kNN (active, model-matched)
_overrides_mtime:   float = 0.0


def _normalize_msg(m: str) -> str:
    return " ".join((m or "").lower().split())


def _load_overrides() -> dict:
    """Replay the append-only log into the exact-match map {normalized: role} and
    the fuzzy vector index. Later records win, so a tombstone removes and a
    re-correction re-adds. Vectors are kept only when their embedding_model
    matches the current pin (cross-model vectors are incomparable)."""
    global _overrides_cache, _overrides_vectors, _overrides_mtime
    try:
        mtime = OVERRIDES_PATH.stat().st_mtime
        if mtime != _overrides_mtime:
            cache: dict = {}
            vecs:  dict = {}   # keyed by normalized message so tombstones can pop
            with open(OVERRIDES_PATH) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    key = _normalize_msg(rec.get("message", ""))
                    if not key:
                        continue
                    if rec.get("tombstoned"):
                        cache.pop(key, None)
                        vecs.pop(key, None)
                        continue
                    cache[key] = rec.get("corrected_role")
                    emb = rec.get("embedding")
                    if emb and rec.get("embedding_model") == EMBED_MODEL:
                        vecs[key] = {"role": rec.get("corrected_role"), "vec": emb}
                    else:
                        vecs.pop(key, None)  # re-correction without a usable vector
            _overrides_cache   = cache
            _overrides_vectors = list(vecs.values())
            _overrides_mtime   = mtime
    except FileNotFoundError:
        _overrides_cache, _overrides_vectors = {}, []
    return _overrides_cache


def _lookup_override(message: str) -> str | None:
    """Exact (normalized) match — the top-priority, human-is-ground-truth tier."""
    return _load_overrides().get(_normalize_msg(message)) if message else None


def _cosine(a: list, b: list) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na  = math.sqrt(sum(x * x for x in a))
    nb  = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


async def _embed(text: str) -> list | None:
    """Embed via Ollama (nomic-embed-text). Best-effort: returns None if the model
    isn't pulled or the call fails, so fuzzy matching degrades gracefully."""
    try:
        resp = await _ext_client.post(
            f"{OLLAMA_URL}/api/embeddings",
            json={"model": EMBED_MODEL, "prompt": (text or "")[:_MSG_CAP]},
            timeout=10.0,
        )
        resp.raise_for_status()
        return resp.json().get("embedding") or None
    except Exception as e:
        log.debug(f"embed failed ({e!r}) — fuzzy override skipped")
        return None


async def _fuzzy_override(message: str) -> str | None:
    """Fuzzy (embedding kNN) match against stored corrections. Runs ONLY when
    signal+keyword missed, so it never overrides a confident classification and
    only costs an embed call on otherwise-fallback messages."""
    _load_overrides()
    if not _overrides_vectors or not message:
        return None
    qv = await _embed(message)
    if not qv:
        return None
    threshold = float(_load_config().get("knn_threshold", 0.86))
    best_role, best_sim = None, 0.0
    for item in _overrides_vectors:
        sim = _cosine(qv, item["vec"])
        if sim > best_sim:
            best_sim, best_role = sim, item["role"]
    if best_role and best_sim >= threshold:
        log.info(f"fuzzy override  sim={best_sim:.3f} ≥ {threshold} → {best_role}")
        return best_role
    return None


def _make_correction(message: str, predicted_role: str, corrected_role: str,
                     context: dict, tier_that_fired: str = "",
                     tombstoned: bool = False) -> dict:
    """Build a record matching CORRECTION_SCHEMA. embedding is filled in Phase 1b."""
    return {
        "predicted_role":  predicted_role,
        "corrected_role":  corrected_role,
        "tier_that_fired": tier_that_fired,
        "context":         context or {},
        "embedding":       None,
        "embedding_model": None,
        "message":         (message or "")[:_MSG_CAP],
        "source":          "local",
        "created_at":      time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "corroboration":   1,
        "tombstoned":      tombstoned,
    }


def _append_override(rec: dict):
    global _overrides_mtime
    OVERRIDES_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OVERRIDES_PATH, "a") as f:
        f.write(json.dumps(rec) + "\n")
    _overrides_mtime = 0.0  # force reload on next lookup


def _ctx_to_dict(ctx: Context) -> dict:
    return {
        "has_file_attachment": ctx.has_file_attachment,
        "has_image":           ctx.has_image,
        "has_code_blocks":     ctx.has_code_blocks,
        "token_count":         ctx.token_count,
        "thread_role":         ctx.thread_role,
    }


def _route_log_entry(rm: dict, model: str | None, fallback: bool) -> dict:
    """A routing-log entry carries enough (id, message, context, predicted role)
    for a human to turn it into a correction."""
    return {
        "id":       rm["id"],
        "ts":       time.time(),
        "tier":     rm["tier"],
        "role":     rm["role"],
        "model":    model,
        "message":  rm["message"][:_MSG_CAP],
        "context":  rm["context"],
        "fallback": fallback,
    }


# ── Quota management ─────────────────────────────────────────────────────────

def _load_quotas() -> dict:
    global _quota_cfg, _quota_cfg_mtime
    try:
        mtime = QUOTAS_PATH.stat().st_mtime
        if mtime != _quota_cfg_mtime:
            with open(QUOTAS_PATH) as f:
                _quota_cfg = yaml.safe_load(f) or {}
            _quota_cfg_mtime = mtime
    except FileNotFoundError:
        pass
    return _quota_cfg


def _load_quota_state():
    global _quota_state
    try:
        if QUOTA_STATE_PATH.exists():
            with open(QUOTA_STATE_PATH) as f:
                _quota_state = json.load(f)
    except Exception:
        _quota_state = {"date": "", "counts": {}}


def _save_quota_state():
    try:
        QUOTA_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(QUOTA_STATE_PATH, "w") as f:
            json.dump(_quota_state, f)
    except Exception as e:
        log.debug(f"quota state save failed: {e}")


def _today_utc() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def _check_quota(model: str) -> str:
    """Returns 'ok', 'warn', or 'blocked'. Also resets counts on new day."""
    qcfg = _load_quotas()
    today = _today_utc()
    if _quota_state.get("date") != today:
        _quota_state["date"]   = today
        _quota_state["counts"] = {}
        _save_quota_state()
    model_cfg = qcfg.get("models", {}).get(model)
    if not model_cfg:
        return "ok"
    limit = model_cfg.get("max_requests")
    if not limit:
        return "ok"
    count    = _quota_state["counts"].get(model, 0)
    warn_pct = model_cfg.get("warn_pct", 80) / 100
    if count >= limit:
        return "blocked"
    if count >= limit * warn_pct:
        return "warn"
    return "ok"


def _increment_quota(model: str):
    today = _today_utc()
    if _quota_state.get("date") != today:
        _quota_state["date"]   = today
        _quota_state["counts"] = {}
    _quota_state["counts"][model] = _quota_state["counts"].get(model, 0) + 1
    _save_quota_state()


def _reset_quota(model: str | None):
    """Reset count for one model or all if model is None."""
    if model:
        _quota_state["counts"].pop(model, None)
    else:
        _quota_state["counts"] = {}
    _save_quota_state()


def _quota_json(content: str) -> dict:
    return {
        "id": f"chatcmpl-quota-{secrets.token_hex(6)}",
        "object": "chat.completion",
        "model": "quota-guard",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": content},
            "finish_reason": "stop",
        }],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


async def _quota_sse(content: str) -> AsyncIterator[bytes]:
    cid   = f"chatcmpl-quota-{secrets.token_hex(6)}"
    chunk = {
        "id": cid, "object": "chat.completion.chunk", "model": "quota-guard",
        "choices": [{"index": 0, "delta": {"role": "assistant", "content": content},
                     "finish_reason": None}],
    }
    yield f"data: {json.dumps(chunk)}\n\n".encode()
    done = {
        "id": cid, "object": "chat.completion.chunk", "model": "quota-guard",
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
    }
    yield f"data: {json.dumps(done)}\n\n".encode()
    yield b"data: [DONE]\n\n"


# ── API key hot-load from Settings tab ───────────────────────────────────────

def _load_api_keys():
    """Load api_keys.env into os.environ.

    Overwrites empty existing env vars so Settings-tab values always win
    over the blank placeholders Docker Compose may have injected.
    """
    try:
        with open(API_KEYS_PATH) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key and val:
                    os.environ[key] = val
    except FileNotFoundError:
        pass


# ── MCP tools ────────────────────────────────────────────────────────────────

def _load_mcp_config() -> dict:
    global _mcp_cfg, _mcp_cfg_mtime
    try:
        mtime = MCP_CONFIG_PATH.stat().st_mtime
        if mtime != _mcp_cfg_mtime:
            with open(MCP_CONFIG_PATH) as f:
                _mcp_cfg = json.load(f)
            _mcp_cfg_mtime = mtime
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return _mcp_cfg


def _load_role_tools() -> dict:
    global _role_tools, _role_tools_mtime
    try:
        mtime = ROLE_TOOLS_PATH.stat().st_mtime
        if mtime != _role_tools_mtime:
            with open(ROLE_TOOLS_PATH) as f:
                raw = yaml.safe_load(f) or {}
            # YAML gives us lists (or None for empty [])
            _role_tools = {
                role: (tools if isinstance(tools, list) else [])
                for role, tools in raw.items()
            }
            _role_tools_mtime = mtime
    except FileNotFoundError:
        pass
    return _role_tools


# Tool schemas for well-known MCP servers (injected into LiteLLM requests)
_MCP_SCHEMAS: dict[str, list[dict]] = {
    "filesystem": [
        {"type": "function", "function": {
            "name": "read_file",
            "description": "Read the contents of a file on the local filesystem.",
            "parameters": {"type": "object",
                           "properties": {"path": {"type": "string", "description": "Absolute file path"}},
                           "required": ["path"]},
        }},
        {"type": "function", "function": {
            "name": "write_file",
            "description": "Write or overwrite a file on the local filesystem.",
            "parameters": {"type": "object",
                           "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
                           "required": ["path", "content"]},
        }},
        {"type": "function", "function": {
            "name": "list_directory",
            "description": "List files and directories at a path.",
            "parameters": {"type": "object",
                           "properties": {"path": {"type": "string", "description": "Directory path"}},
                           "required": ["path"]},
        }},
    ],
    "memory": [
        {"type": "function", "function": {
            "name": "store_memory",
            "description": "Save a fact or note to persistent memory for future conversations.",
            "parameters": {"type": "object",
                           "properties": {"content": {"type": "string", "description": "The information to remember"}},
                           "required": ["content"]},
        }},
        {"type": "function", "function": {
            "name": "recall_memory",
            "description": "Search and retrieve stored memories.",
            "parameters": {"type": "object",
                           "properties": {"query": {"type": "string"}},
                           "required": ["query"]},
        }},
    ],
    "fetch": [
        {"type": "function", "function": {
            "name": "fetch_url",
            "description": "Fetch and return the text content of a web URL.",
            "parameters": {"type": "object",
                           "properties": {
                               "url": {"type": "string", "description": "URL to fetch"},
                               "max_length": {"type": "integer", "default": 5000},
                           },
                           "required": ["url"]},
        }},
    ],
    "brave-search": [
        {"type": "function", "function": {
            "name": "brave_search",
            "description": "Search the web using Brave Search and return results.",
            "parameters": {"type": "object",
                           "properties": {
                               "query": {"type": "string"},
                               "count": {"type": "integer", "default": 5},
                           },
                           "required": ["query"]},
        }},
    ],
    "github": [
        {"type": "function", "function": {
            "name": "github_search_repositories",
            "description": "Search GitHub repositories.",
            "parameters": {"type": "object",
                           "properties": {"query": {"type": "string"}},
                           "required": ["query"]},
        }},
        {"type": "function", "function": {
            "name": "github_get_file_contents",
            "description": "Get the content of a file from a GitHub repository.",
            "parameters": {"type": "object",
                           "properties": {
                               "owner": {"type": "string"},
                               "repo":  {"type": "string"},
                               "path":  {"type": "string"},
                           },
                           "required": ["owner", "repo", "path"]},
        }},
    ],
    "sqlite": [
        {"type": "function", "function": {
            "name": "sqlite_query",
            "description": "Run a read-only SQL query on a local SQLite database file.",
            "parameters": {"type": "object",
                           "properties": {
                               "database": {"type": "string", "description": "Path to .db file"},
                               "query":    {"type": "string"},
                           },
                           "required": ["database", "query"]},
        }},
    ],
    "postgres": [
        {"type": "function", "function": {
            "name": "postgres_query",
            "description": "Run a read-only SQL query on the configured PostgreSQL database.",
            "parameters": {"type": "object",
                           "properties": {"query": {"type": "string"}},
                           "required": ["query"]},
        }},
    ],
}

# Maps tool function names back to their server id for dispatch
_TOOL_TO_SERVER: dict[str, str] = {
    fn["function"]["name"]: sid
    for sid, fns in _MCP_SCHEMAS.items()
    for fn in fns
}


def _tools_for_role(role: str) -> list[dict]:
    """Return the merged list of tool schemas enabled for a role."""
    enabled_servers = _load_role_tools().get(role, [])
    mcp_cfg         = _load_mcp_config()
    installed       = set(mcp_cfg.get("mcpServers", {}).keys())
    schemas: list[dict] = []
    for sid in enabled_servers:
        if sid in installed and sid in _MCP_SCHEMAS:
            schemas.extend(_MCP_SCHEMAS[sid])
    return schemas


async def _call_mcp_tool(server_id: str, tool_name: str, arguments: dict) -> str:
    """Execute a tool via its MCP stdio server subprocess."""
    mcp_cfg    = _load_mcp_config()
    server_cfg = mcp_cfg.get("mcpServers", {}).get(server_id)
    if not server_cfg:
        return f"Error: MCP server '{server_id}' is not configured in mcp.json"

    cmd = [server_cfg["command"]] + server_cfg.get("args", [])
    env = {**os.environ, **server_cfg.get("env", {})}

    # MCP stdio protocol: send initialize then tools/call, read responses
    init_req = json.dumps({
        "jsonrpc": "2.0", "id": 0, "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "llmspaghetti-router", "version": "0.1.0"},
        },
    }) + "\n"
    call_req = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": tool_name, "arguments": arguments},
    }) + "\n"
    # initialized notification (required by spec before first call)
    initialized_notif = json.dumps({
        "jsonrpc": "2.0", "method": "notifications/initialized", "params": {},
    }) + "\n"

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=env,
        )
        stdin_data = (init_req + initialized_notif + call_req).encode()
        stdout_bytes, _ = await asyncio.wait_for(
            proc.communicate(input=stdin_data), timeout=30
        )
        # Find the response with id=1
        for line in stdout_bytes.decode(errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                resp = json.loads(line)
            except json.JSONDecodeError:
                continue
            if resp.get("id") == 1:
                if "error" in resp:
                    return f"Tool error: {resp['error'].get('message', resp['error'])}"
                content = resp.get("result", {}).get("content", [])
                texts = [c.get("text", "") for c in content if c.get("type") == "text"]
                return "\n".join(texts) if texts else str(resp.get("result", ""))
        return "Tool returned no output"
    except asyncio.TimeoutError:
        return f"Tool '{tool_name}' timed out after 30s"
    except Exception as e:
        return f"Tool execution error: {e}"


async def _resolve_tool_calls(messages: list, tool_calls: list, model: str, headers: dict) -> list:
    """Execute tool calls and return updated messages list with results appended."""
    tool_results = []
    for tc in tool_calls:
        fn_name  = tc.get("function", {}).get("name", "")
        try:
            args = json.loads(tc.get("function", {}).get("arguments", "{}"))
        except json.JSONDecodeError:
            args = {}
        server_id = _TOOL_TO_SERVER.get(fn_name, "")
        log.info(f"tool call: {fn_name}({args}) → server={server_id!r}")
        result = await _call_mcp_tool(server_id, fn_name, args) if server_id else f"Unknown tool: {fn_name}"
        tool_results.append({
            "role":         "tool",
            "tool_call_id": tc.get("id", ""),
            "content":      result,
        })
    return tool_results


# ── Context extraction ────────────────────────────────────────────────────────

_CODE_FENCE = re.compile(r"```")


def _extract(messages: list) -> tuple[str, Context]:
    last_user      = ""
    last_user_code = False   # code fence in the CURRENT user turn only
    has_file       = False
    has_image      = False
    tokens         = 0

    for msg in messages:
        role    = msg.get("role", "")
        content = msg.get("content", "")

        # Collect this message's plain text (may be split across parts).
        texts: list[str] = []
        if isinstance(content, list):
            for part in content:
                if not isinstance(part, dict):
                    continue
                ptype = part.get("type", "")
                if ptype == "image_url":
                    has_image = True
                elif ptype in ("file", "document"):
                    has_file = True
                elif ptype == "text":
                    texts.append(part.get("text", ""))
        elif isinstance(content, str):
            texts.append(content)

        joined = "\n".join(t for t in texts if t)
        tokens += len(joined) // 4

        # Code detection is scoped to the latest USER message. Assistant replies
        # routinely contain ```code``` fences; counting those made every follow-up
        # in a thread that once touched code stick to the code role (e.g. "write a
        # summary of this chat" → code). Only the user's current turn signals intent.
        if role == "user" and joined:
            last_user      = joined
            last_user_code = bool(_CODE_FENCE.search(joined))

    return last_user, Context(
        has_file_attachment=has_file,
        has_image=has_image,
        has_code_blocks=last_user_code,
        token_count=tokens,
    )


# ── Image generation ──────────────────────────────────────────────────────────

async def _generate_image(prompt: str) -> str:
    """Call DALL-E 3, save image locally, return public URL."""
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)

    gen = await _ext_client.post(
        "https://api.openai.com/v1/images/generations",
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
        },
        json={"model": "dall-e-3", "prompt": prompt, "n": 1, "size": "1024x1024"},
        timeout=60.0,
    )
    gen.raise_for_status()
    openai_url = gen.json()["data"][0]["url"]

    # Download so the URL doesn't expire
    img = await _ext_client.get(openai_url, timeout=30.0)
    img.raise_for_status()
    fname = f"{secrets.token_hex(8)}.png"
    (IMAGES_DIR / fname).write_bytes(img.content)

    return f"{IMAGES_SERVE_URL}/{fname}"


def _image_json(content: str) -> dict:
    return {
        "id": f"chatcmpl-img-{secrets.token_hex(6)}",
        "object": "chat.completion",
        "model": "dall-e-3",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": content},
            "finish_reason": "stop",
        }],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


async def _text_sse(content: str, model: str, prov: dict | None = None) -> AsyncIterator[bytes]:
    """Wrap a plain text response as an SSE stream (used after tool-call resolution)."""
    cid   = f"chatcmpl-tool-{secrets.token_hex(6)}"
    chunk = {
        "id": cid, "object": "chat.completion.chunk", "model": model,
        "choices": [{"index": 0, "delta": {"role": "assistant", "content": content}, "finish_reason": None}],
    }
    if prov:
        chunk["x_llmspaghetti"] = prov
    yield f"data: {json.dumps(chunk)}\n\n".encode()
    done = {
        "id": cid, "object": "chat.completion.chunk", "model": model,
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
    }
    yield f"data: {json.dumps(done)}\n\n".encode()
    yield b"data: [DONE]\n\n"


async def _image_sse(content: str) -> AsyncIterator[bytes]:
    cid = f"chatcmpl-img-{secrets.token_hex(6)}"
    chunk = {
        "id": cid, "object": "chat.completion.chunk", "model": "dall-e-3",
        "choices": [{"index": 0, "delta": {"role": "assistant", "content": content}, "finish_reason": None}],
    }
    yield f"data: {json.dumps(chunk)}\n\n".encode()
    done = {
        "id": cid, "object": "chat.completion.chunk", "model": "dall-e-3",
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
    }
    yield f"data: {json.dumps(done)}\n\n".encode()
    yield b"data: [DONE]\n\n"


# ── Provenance: "show your work" tag on every reply ────────────────────────────
# Core principle — nothing hidden. Every routed reply carries which model
# answered, both as a visible footer (any client, survives copy-paste) and a
# machine-readable field (tools can parse it). Router-side so it works
# everywhere without per-client glue. Toggle with show_provenance in
# router_roles.yaml (default on).

_alias_cache: dict  = {}
_alias_mtime: float = 0.0


def _resolve_model_name(model: str) -> str:
    """Resolve a LiteLLM alias (e.g. 'local-default') to the real model name.

    Reads litellm_config.yaml (mtime-cached) so the tag shows the actual model
    that answered — 'qwen2:0.5b' — not the internal alias. Provider prefix is
    stripped for readability (ollama/qwen2:0.5b → qwen2:0.5b).
    """
    global _alias_cache, _alias_mtime
    try:
        mtime = LITELLM_CFG_PATH.stat().st_mtime
        if mtime != _alias_mtime:
            with open(LITELLM_CFG_PATH) as f:
                cfg = yaml.safe_load(f) or {}
            _alias_cache = {
                e.get("model_name"): (e.get("litellm_params") or {}).get("model", "")
                for e in cfg.get("model_list", [])
                if e.get("model_name")
            }
            _alias_mtime = mtime
    except (FileNotFoundError, yaml.YAMLError):
        pass
    real = _alias_cache.get(model) or model
    return real.split("/", 1)[1] if "/" in real else real


def _provenance_enabled() -> bool:
    return _load_config().get("show_provenance", True) is not False


def _provenance_footer(model: str, role: str) -> str:
    """The visible footer line appended to an assistant reply."""
    role_part = f" · {role}" if role and role != "none" else ""
    return f"\n\n`↳ LLMSpaghetti → {_resolve_model_name(model)}{role_part}`"


def _provenance_meta(model: str, role: str, fallback: bool) -> dict:
    """The machine-readable provenance object added to the response body."""
    return {
        "router":   "llmspaghetti",
        "model":    _resolve_model_name(model),
        "role":     role,
        "fallback": fallback,
    }


# ── VRAM budget check ─────────────────────────────────────────────────────────

async def _check_vram_budget():
    """Log VRAM budget at startup. Non-blocking — failures are silently ignored."""
    try:
        gpu_file = INSTALL_DIR / "gpu-info.json"
        if not gpu_file.exists():
            return
        with open(gpu_file) as f:
            gpu = json.load(f)
        total_vram = gpu.get("total_vram_gb", 0)
        if total_vram == 0:
            log.info("CPU mode — no VRAM budget to track")
            return

        resp = await _ext_client.get(f"{OLLAMA_URL}/api/tags", timeout=5.0)
        model_sizes = {
            m["name"]: round(m.get("size", 0) / (1024 ** 3), 1)
            for m in resp.json().get("models", [])
        }

        roles      = _load_config().get("roles", {})
        assigned   = {m for m in roles.values() if m and m not in ("local-default", None)}
        used_gb    = sum(model_sizes.get(m, 0) for m in assigned)

        log.info(f"VRAM: {used_gb:.1f}GB assigned across roles / {total_vram}GB available")
        if assigned - model_sizes.keys():
            log.warning(f"models not yet in Ollama: {assigned - model_sizes.keys()}")
        if used_gb > total_vram * 0.9:
            log.warning(
                f"⚠ assigned models ({used_gb:.1f}GB) may exceed VRAM ({total_vram}GB) — "
                "consider reducing roles or using smaller models"
            )
    except Exception as e:
        log.debug(f"VRAM check skipped: {e}")


# ── App + HTTP clients ────────────────────────────────────────────────────────

_client:     Optional[httpx.AsyncClient] = None  # LiteLLM proxy
_ext_client: Optional[httpx.AsyncClient] = None  # external calls (DALL-E, Ollama)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _client, _ext_client
    _client = httpx.AsyncClient(
        base_url=LITELLM_URL,
        timeout=httpx.Timeout(600.0),
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
    )
    _ext_client = httpx.AsyncClient(
        timeout=httpx.Timeout(120.0),
        follow_redirects=True,
    )
    _load_api_keys()
    _load_config()
    _load_quota_state()
    await _check_vram_budget()
    log.info(f"router ready  →  {LITELLM_URL}")
    if OPENAI_API_KEY:
        log.info(f"image generation enabled  (saves to {IMAGES_DIR})")
    else:
        log.info("image generation disabled  (no OPENAI_API_KEY)")
    yield
    await _client.aclose()
    await _ext_client.aclose()


app = FastAPI(title="LLMSpaghetti Router", lifespan=lifespan)


# ── Management API ───────────────────────────────────────────────────────────

@app.get("/api/routing-log")
async def api_routing_log():
    return JSONResponse({"entries": list(_routing_log)})


@app.post("/api/correction")
async def api_add_correction(request: Request):
    """Record a human correction: 'this route was wrong, it should be <role>'.
    Accepts either a routing-log `id` (we look up that decision) or explicit
    `message`/`context`/`predicted_role`. Applies to future identical messages."""
    try:
        data = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "invalid JSON body"}, status_code=400)

    corrected = str(data.get("corrected_role", "")).strip()
    if corrected not in VALID_ROLES:
        return JSONResponse(
            {"ok": False, "error": f"corrected_role must be one of {sorted(VALID_ROLES)}"},
            status_code=400,
        )

    message   = data.get("message")
    predicted = data.get("predicted_role", "")
    context   = data.get("context") or {}
    tier      = data.get("tier_that_fired", "")

    # Resolve from a routing-log id if the caller referenced a decision.
    entry_id = data.get("id")
    if entry_id and not message:
        for e in _routing_log:
            if e.get("id") == entry_id:
                message, predicted = e.get("message"), e.get("role", "")
                context, tier      = e.get("context") or {}, e.get("tier", "")
                break

    if not message:
        return JSONResponse(
            {"ok": False, "error": "provide `message` (+context) or a known routing-log `id`"},
            status_code=400,
        )

    rec = _make_correction(message, predicted, corrected, context, tier)
    # Embed now so the fuzzy tier can match *similar* future messages (best-effort;
    # exact match still works if embedding is unavailable).
    emb = await _embed(message)
    if emb:
        rec["embedding"], rec["embedding_model"] = emb, EMBED_MODEL
    _append_override(rec)
    log.info(f"correction recorded: {predicted or '?'} → {corrected}"
             f"{' (embedded)' if emb else ''}  {message[:60]!r}")
    return JSONResponse({"ok": True, "corrected_role": corrected,
                         "embedded": bool(emb), "message": message[:_MSG_CAP]})


@app.get("/api/corrections")
async def api_list_corrections():
    """Active (non-tombstoned) local overrides."""
    active = _load_overrides()
    return JSONResponse({"count": len(active), "active": active})


@app.delete("/api/correction")
async def api_undo_correction(message: str = ""):
    """Undo a correction by tombstoning it (append-only, never hard-deleted)."""
    if not message:
        return JSONResponse({"ok": False, "error": "message query param required"}, status_code=400)
    current = _load_overrides().get(_normalize_msg(message))
    if current is None:
        return JSONResponse({"ok": False, "error": "no active override for that message"}, status_code=404)
    _append_override(_make_correction(message, "", current, {}, "", tombstoned=True))
    log.info(f"correction tombstoned: {message[:60]!r}")
    return JSONResponse({"ok": True, "tombstoned": message[:_MSG_CAP]})


@app.get("/api/routing-mode")
async def api_routing_mode():
    cfg = _load_config()
    return JSONResponse({
        "mode":         cfg.get("mode", "auto"),
        "single_model": cfg.get("single_model"),
    })


@app.get("/api/quota-status")
async def api_quota_status():
    qcfg  = _load_quotas()
    today = _today_utc()
    counts = _quota_state["counts"] if _quota_state.get("date") == today else {}
    result = {}
    for model, mcfg in qcfg.get("models", {}).items():
        limit    = mcfg.get("max_requests")
        count    = counts.get(model, 0)
        warn_pct = mcfg.get("warn_pct", 80)
        result[model] = {
            "count":     count,
            "limit":     limit,
            "remaining": (limit - count) if limit else None,
            "pct":       round(count / limit * 100) if limit else 0,
            "status":    (
                "blocked" if (limit and count >= limit) else
                "warn"    if (limit and count >= limit * warn_pct / 100) else
                "ok"
            ),
        }
    return JSONResponse({"date": today, "reset": qcfg.get("reset", "daily"), "models": result})


@app.delete("/api/quota-reset")
async def api_quota_reset(model: str = ""):
    _reset_quota(model or None)
    return JSONResponse({"ok": True, "reset": model or "all"})


@app.get("/api/mcp-status")
async def api_mcp_status():
    """Return which MCP servers are configured and their install state."""
    mcp_cfg    = _load_mcp_config()
    role_tools = _load_role_tools()
    servers    = mcp_cfg.get("mcpServers", {})
    result = {
        sid: {
            "configured": True,
            "command":    cfg.get("command", ""),
            "args":       cfg.get("args", []),
        }
        for sid, cfg in servers.items()
    }
    return JSONResponse({
        "servers":    result,
        "role_tools": role_tools,
        "total":      len(result),
    })


@app.get("/api/provider-health")
async def api_provider_health(model: str = ""):
    """Ping a single model via LiteLLM to check availability."""
    if not model:
        return JSONResponse({"status": "error", "detail": "model param required"}, status_code=400)
    t0 = time.monotonic()
    try:
        resp = await _client.post(
            "/v1/chat/completions",
            json={"model": model, "messages": [{"role": "user", "content": "ping"}],
                  "max_tokens": 1, "stream": False},
            timeout=8.0,
        )
        latency = round((time.monotonic() - t0) * 1000)
        status  = "ok" if resp.status_code < 500 else "error"
        return JSONResponse({"status": status, "latency_ms": latency, "http": resp.status_code})
    except Exception as e:
        return JSONResponse({"status": "unreachable", "detail": str(e)})


# ── Image file serving ────────────────────────────────────────────────────────

@app.get("/images/{filename}")
async def serve_image(filename: str):
    path = IMAGES_DIR / filename
    if not path.exists() or not path.is_file():
        return Response(status_code=404)
    return FileResponse(path, media_type="image/png")


# ── Proxy ─────────────────────────────────────────────────────────────────────

@app.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
)
async def proxy(request: Request, path: str):
    body = await request.body()

    # Classification state — set inside the chat completions block
    primary_model:   str | None  = None
    fallback_model:  str | None  = None
    route_meta:      dict | None = None  # {id,tier,role,message,context} — deferred log
    tools_injected:  bool         = False  # True when MCP tools were forced non-streaming

    if path == "v1/chat/completions" and request.method == "POST":
        try:
            payload      = json.loads(body)
            messages     = payload.get("messages", [])
            is_streaming = payload.get("stream", False)

            if messages:
                # LLMSpaghetti owns tool management (MCP, per-role) — see
                # docs/PLANNED-client-strategy.md. Strip any tools a client
                # injects (e.g. Open WebUI's built-in update_task). Small models
                # choke on unexpected tools, and in our architecture the client
                # never dictates tools to the model — the router decides. The
                # router re-injects its own MCP tools further down if the role
                # has installed servers.
                for _k in ("tools", "tool_choice", "functions", "function_call"):
                    payload.pop(_k, None)

                last_msg, _ctx = _extract(messages)
                original       = payload.get("model", "local-default")
                cfg            = _load_config()
                routing_mode   = cfg.get("mode", "auto")
                single_mdl     = cfg.get("single_model")
                is_utility     = _is_utility_request(payload, request.headers, last_msg)
                override_role  = None if is_utility else _lookup_override(last_msg)

                # ── Routing mode ─────────────────────────────────────────────
                if is_utility:
                    # Client housekeeping (title / tag / follow-up generation,
                    # autocomplete, …) — not user intent. Cheap model, and below
                    # we skip quota, tools, and the provenance tag; route_meta
                    # stays None so there's no footer and no routing-log entry.
                    primary  = _utility_model()
                    fallback = None
                    tier, role_name = "utility", "utility"
                    log.info(f"{'utility':<8} → {primary:<14} (housekeeping — classification skipped)")
                elif override_role:
                    # A human corrected this exact message before — ground truth,
                    # beats the keyword guess (Flywheel Phase 1).
                    primary, fallback = _model_for_role(override_role)
                    tier, role_name   = "override", override_role
                    log.info(f"{'override':<8} → {role_name:<10} ({original!r} → {primary!r})  learned correction")
                elif routing_mode == "single" and single_mdl:
                    primary  = str(single_mdl)
                    fallback = None
                    tier, role_name = "override", "general"
                    log.info(f"{'override':<8} → {'single':<10} ({original!r} → {primary!r})")
                else:
                    result: Classification = classify(last_msg, _ctx)
                    role_name, tier = result.role, result.tier
                    # Fuzzy correction tier: only when signal+keyword missed, so a
                    # learned correction can rescue an otherwise-general fallback
                    # without ever overriding a confident classification.
                    if tier == "fallback":
                        fuzzy = await _fuzzy_override(last_msg)
                        if fuzzy:
                            role_name, tier = fuzzy, "override"
                    primary, fallback = _model_for_role(role_name)
                    log.info(
                        f"{tier:<8} → {role_name:<10} "
                        f"({original!r} → {primary!r})  "
                        f"{result.latency_ms:.1f}ms  "
                        f"{last_msg[:70]!r}"
                    )

                # ── Quota check ───────────────────────────────────────────────
                qstatus = "ok" if is_utility else _check_quota(primary)
                if qstatus == "blocked":
                    if fallback:
                        log.warning(f"quota exhausted for {primary!r}, routing to fallback {fallback!r}")
                        primary, fallback = fallback, None
                    else:
                        msg = (
                            f"⚠️ Daily request quota exhausted for `{primary}`. "
                            "Adjust limits in the Gateway → Quota panel or wait until tomorrow (resets at midnight UTC)."
                        )
                        _routing_log.appendleft({
                            "ts": time.time(), "tier": "quota", "role": role_name,
                            "model": primary, "message": last_msg[:120], "fallback": False,
                        })
                        if is_streaming:
                            return StreamingResponse(
                                _quota_sse(msg),
                                media_type="text/event-stream",
                                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
                            )
                        return JSONResponse(_quota_json(msg))
                elif qstatus == "warn":
                    log.warning(f"quota warning for {primary!r}: approaching daily limit")

                # ── Image role: early return via DALL-E ───────────────────────
                if role_name == "image" and OPENAI_API_KEY:
                    try:
                        img_url = await _generate_image(last_msg)
                        content = f"![Generated image]({img_url})"
                        log.info(f"image saved → {img_url}")
                        _increment_quota("dall-e-3")
                        _routing_log.appendleft({
                            "ts": time.time(), "tier": tier,
                            "role": role_name, "model": "dall-e-3",
                            "message": last_msg[:120], "fallback": False,
                        })
                        if is_streaming:
                            return StreamingResponse(
                                _image_sse(content),
                                media_type="text/event-stream",
                                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
                            )
                        return JSONResponse(_image_json(content))
                    except Exception as e:
                        log.warning(f"DALL-E failed ({e!r}) — falling back to text model")

                if not is_utility:
                    _increment_quota(primary)
                payload["model"] = primary

                # ── MCP tool injection ────────────────────────────────────────
                tool_schemas = _tools_for_role(role_name)
                if tool_schemas:
                    payload["tools"]       = tool_schemas
                    payload["tool_choice"] = "auto"
                    # Tool-call resolution requires non-streaming; we re-wrap as SSE after.
                    if payload.get("stream"):
                        payload["stream"] = False
                        tools_injected    = True
                    log.info(f"injected {len(tool_schemas)} tools for role={role_name!r}")

                body             = json.dumps(payload).encode()
                primary_model    = primary
                fallback_model   = fallback
                if not is_utility:
                    route_meta   = {
                        "id":      secrets.token_hex(6),
                        "tier":    tier,
                        "role":    role_name,
                        "message": last_msg,
                        "context": _ctx_to_dict(_ctx),
                    }

        except Exception as e:
            log.warning(f"classify error ({e!r}) — passing through unchanged")

    fwd_headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in ("host", "content-length", "transfer-encoding", "connection")
    }

    is_streaming = False
    try:
        is_streaming = json.loads(body).get("stream", False)
    except Exception:
        pass

    # Pre-build fallback body so both streaming and non-streaming paths can use it
    fallback_body: bytes | None = None
    if fallback_model:
        try:
            fb_payload         = json.loads(body)
            fb_payload["model"] = fallback_model
            fallback_body       = json.dumps(fb_payload).encode()
        except Exception:
            pass

    if is_streaming:
        if route_meta:
            _routing_log.appendleft(_route_log_entry(route_meta, primary_model, False))
        fallback_log: dict | None = None
        if route_meta and fallback_model:
            fallback_log = {
                "id": route_meta["id"], "ts": time.time(), "tier": "fallback",
                "role": route_meta["role"], "model": fallback_model,
                "message": f"↳ fallback from {primary_model}",
                "context": route_meta["context"], "fallback": True,
            }
        prov: dict | None = None
        if route_meta and primary_model and _provenance_enabled():
            prov = {"primary": primary_model, "fallback": fallback_model, "role": route_meta["role"]}
        return StreamingResponse(
            _stream_with_fallback(
                request.method, path, fwd_headers, body,
                dict(request.query_params), fallback_body, fallback_log, prov,
            ),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # ── Non-streaming: try primary, retry with fallback on 5xx ────────────────
    upstream = await _client.request(
        method=request.method,
        url=f"/{path}",
        headers=fwd_headers,
        content=body,
        params=dict(request.query_params),
    )

    used_fallback = False
    if upstream.status_code >= 500 and fallback_body:
        log.warning(
            f"primary {primary_model!r} returned {upstream.status_code}, "
            f"retrying with fallback {fallback_model!r}"
        )
        try:
            upstream      = await _client.request(
                method=request.method,
                url=f"/{path}",
                headers=fwd_headers,
                content=fallback_body,
                params=dict(request.query_params),
            )
            used_fallback = True
        except Exception as fb_e:
            log.warning(f"fallback also failed: {fb_e!r}")

    # ── Tool call resolution loop (max 5 turns) ────────────────────────────────
    tool_loop_messages = None
    if upstream.status_code < 500:
        try:
            resp_data = upstream.json()
        except Exception:
            resp_data = {}
        tool_calls = (resp_data.get("choices", [{}])[0]
                      .get("message", {})
                      .get("tool_calls") or [])
        if tool_calls:
            try:
                orig_payload = json.loads(body)
            except Exception:
                orig_payload = {}
            loop_messages = list(orig_payload.get("messages", []))
            # Add the assistant's tool-call message
            loop_messages.append(resp_data["choices"][0]["message"])
            for _turn in range(5):
                tool_results = await _resolve_tool_calls(
                    loop_messages, tool_calls,
                    primary_model or "local-default", fwd_headers,
                )
                loop_messages.extend(tool_results)
                # Re-request without tools (let model formulate final answer)
                follow_payload = {**orig_payload,
                                  "messages": loop_messages,
                                  "stream": False}
                follow_payload.pop("tools", None)
                follow_payload.pop("tool_choice", None)
                follow_resp = await _client.request(
                    method="POST",
                    url=f"/{path}",
                    headers=fwd_headers,
                    content=json.dumps(follow_payload).encode(),
                )
                if follow_resp.status_code >= 500:
                    break
                try:
                    follow_data = follow_resp.json()
                except Exception:
                    follow_data = {}
                next_tool_calls = (follow_data.get("choices", [{}])[0]
                                   .get("message", {})
                                   .get("tool_calls") or [])
                if not next_tool_calls:
                    upstream = follow_resp
                    tool_loop_messages = loop_messages
                    break
                loop_messages.append(follow_data["choices"][0]["message"])
                tool_calls = next_tool_calls

    if route_meta:
        _routing_log.appendleft(_route_log_entry(
            route_meta, fallback_model if used_fallback else primary_model, used_fallback))

    resp_headers = {
        k: v for k, v in upstream.headers.items()
        if k.lower() not in ("content-encoding", "transfer-encoding", "content-length")
    }

    # Provenance: name the model that actually answered (fallback-aware)
    prov_role  = route_meta["role"] if route_meta else ""
    prov_model = fallback_model if used_fallback else primary_model
    add_prov   = bool(route_meta and prov_model and _provenance_enabled()
                      and upstream.status_code < 500)

    # If we converted streaming→non-streaming for tool resolution, re-wrap as SSE
    if tools_injected and tool_loop_messages is not None:
        try:
            final_content = (upstream.json()["choices"][0]["message"]["content"] or "")
        except Exception:
            final_content = upstream.text
        prov = None
        if add_prov:
            final_content += _provenance_footer(prov_model, prov_role)
            prov = _provenance_meta(prov_model, prov_role, used_fallback)
        return StreamingResponse(
            _text_sse(final_content, primary_model or "local-default", prov),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # Non-streaming: append footer to the reply content + attach machine-readable field
    if add_prov:
        try:
            data = upstream.json()
            msg  = data["choices"][0]["message"]
            msg["content"] = (msg.get("content") or "") + _provenance_footer(prov_model, prov_role)
            data["x_llmspaghetti"] = _provenance_meta(prov_model, prov_role, used_fallback)
            return JSONResponse(data, status_code=upstream.status_code, headers=resp_headers)
        except Exception as e:
            log.debug(f"provenance tag skipped (unparseable body): {e}")

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=resp_headers,
    )


async def _stream_with_fallback(
    method: str,
    path: str,
    headers: dict,
    body: bytes,
    params: dict,
    fallback_body: bytes | None = None,
    fallback_log: dict | None = None,
    prov: dict | None = None,
) -> AsyncIterator[bytes]:
    # prov = {"primary": <model>, "fallback": <model|None>, "role": <role>} or None.
    # When set, we intercept the SSE line stream and inject a provenance footer
    # event just before the terminal [DONE], naming whichever model actually
    # answered. Without prov we pass raw bytes through untouched.
    used_fallback = False

    def _footer_event() -> bytes:
        model  = prov["fallback"] if (used_fallback and prov.get("fallback")) else prov["primary"]
        footer = _provenance_footer(model, prov.get("role", ""))
        meta   = _provenance_meta(model, prov.get("role", ""), used_fallback)
        chunk  = {
            "id": f"chatcmpl-prov-{secrets.token_hex(6)}",
            "object": "chat.completion.chunk", "model": model,
            "choices": [{"index": 0, "delta": {"content": footer}, "finish_reason": None}],
            "x_llmspaghetti": meta,
        }
        return f"data: {json.dumps(chunk)}\n\n".encode()

    async def _relay(resp) -> AsyncIterator[bytes]:
        # Standard OpenAI/LiteLLM SSE is one `data:` line per event. Inject the
        # footer just BEFORE the first chunk carrying a finish_reason — clients
        # (Open WebUI) stop appending content once they see the stop, so anything
        # after it is silently dropped. Fall back to injecting before [DONE] if
        # no finish_reason is ever seen.
        injected = False
        async for line in resp.aiter_lines():
            if not line:
                continue
            s = line.strip()
            if s == "data: [DONE]":
                if prov and not injected:
                    yield _footer_event()
                    injected = True
                yield b"data: [DONE]\n\n"
                continue
            if prov and not injected and s.startswith("data:"):
                try:
                    obj     = json.loads(s[5:].strip())
                    choices = obj.get("choices") or []
                    if choices and choices[0].get("finish_reason") is not None:
                        yield _footer_event()
                        injected = True
                except (ValueError, AttributeError, IndexError):
                    pass
            yield (line + "\n\n").encode()

    async with _client.stream(
        method=method, url=f"/{path}", headers=headers, content=body, params=params,
    ) as resp:
        if resp.status_code >= 500 and fallback_body is not None:
            used_fallback = True
            log.warning(
                f"streaming primary returned {resp.status_code}, switching to fallback"
            )
            if fallback_log:
                _routing_log.appendleft(fallback_log)
            async with _client.stream(
                method=method, url=f"/{path}", headers=headers,
                content=fallback_body, params=params,
            ) as fb_resp:
                if prov:
                    async for chunk in _relay(fb_resp):
                        yield chunk
                else:
                    async for chunk in fb_resp.aiter_bytes():
                        yield chunk
            return
        if prov:
            async for chunk in _relay(resp):
                yield chunk
        else:
            async for chunk in resp.aiter_bytes():
                yield chunk


# ── Entrypoint ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 5000)),
        log_level="warning",
        access_log=False,
    )
