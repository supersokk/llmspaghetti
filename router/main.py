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
QUOTAS_PATH      = INSTALL_DIR / "config" / "quotas.yaml"
QUOTA_STATE_PATH = INSTALL_DIR / "data"   / "quota_state.json"
MCP_CONFIG_PATH  = INSTALL_DIR / "config" / "mcp.json"
ROLE_TOOLS_PATH  = INSTALL_DIR / "config" / "role_tools.yaml"
API_KEYS_PATH    = INSTALL_DIR / "config" / "api_keys.env"
IMAGES_DIR       = INSTALL_DIR / "images"
LITELLM_URL      = os.environ.get("LITELLM_URL", "http://litellm:4000")
OLLAMA_URL       = os.environ.get("OLLAMA_URL", "http://host.docker.internal:11434")
OPENAI_API_KEY   = os.environ.get("OPENAI_API_KEY", "")


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
from classifier import classify, Context, Classification  # noqa: E402

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
    last_user = ""
    has_code  = False
    has_file  = False
    has_image = False
    tokens    = 0

    for msg in messages:
        role    = msg.get("role", "")
        content = msg.get("content", "")

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
                    text = part.get("text", "")
                    tokens += len(text) // 4
                    if _CODE_FENCE.search(text):
                        has_code = True
                    if role == "user":
                        last_user = text
        elif isinstance(content, str):
            tokens += len(content) // 4
            if _CODE_FENCE.search(content):
                has_code = True
            if role == "user":
                last_user = content

    return last_user, Context(
        has_file_attachment=has_file,
        has_image=has_image,
        has_code_blocks=has_code,
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


async def _text_sse(content: str, model: str) -> AsyncIterator[bytes]:
    """Wrap a plain text response as an SSE stream (used after tool-call resolution)."""
    cid   = f"chatcmpl-tool-{secrets.token_hex(6)}"
    chunk = {
        "id": cid, "object": "chat.completion.chunk", "model": model,
        "choices": [{"index": 0, "delta": {"role": "assistant", "content": content}, "finish_reason": None}],
    }
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
    route_meta:      tuple | None = None  # (tier, role, last_msg) — deferred log
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

                # ── Routing mode ─────────────────────────────────────────────
                if routing_mode == "single" and single_mdl:
                    primary  = str(single_mdl)
                    fallback = None
                    tier, role_name = "override", "general"
                    log.info(f"{'override':<8} → {'single':<10} ({original!r} → {primary!r})")
                else:
                    result: Classification = classify(last_msg, _ctx)
                    primary, fallback      = _model_for_role(result.role)
                    tier, role_name        = result.tier, result.role
                    log.info(
                        f"{result.tier:<8} → {result.role:<10} "
                        f"({original!r} → {primary!r})  "
                        f"{result.latency_ms:.1f}ms  "
                        f"{last_msg[:70]!r}"
                    )

                # ── Quota check ───────────────────────────────────────────────
                qstatus = _check_quota(primary)
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
                route_meta       = (tier, role_name, last_msg)

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
            tier, role, last_msg = route_meta
            _routing_log.appendleft({
                "ts": time.time(), "tier": tier, "role": role,
                "model": primary_model, "message": last_msg[:120], "fallback": False,
            })
        fallback_log: dict | None = None
        if route_meta and fallback_model:
            tier, role, last_msg = route_meta
            fallback_log = {
                "ts": time.time(), "tier": "fallback", "role": role,
                "model": fallback_model,
                "message": f"↳ fallback from {primary_model}",
                "fallback": True,
            }
        return StreamingResponse(
            _stream_with_fallback(
                request.method, path, fwd_headers, body,
                dict(request.query_params), fallback_body, fallback_log,
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
        tier, role, last_msg = route_meta
        _routing_log.appendleft({
            "ts":       time.time(),
            "tier":     tier,
            "role":     role,
            "model":    fallback_model if used_fallback else primary_model,
            "message":  last_msg[:120],
            "fallback": used_fallback,
        })

    resp_headers = {
        k: v for k, v in upstream.headers.items()
        if k.lower() not in ("content-encoding", "transfer-encoding", "content-length")
    }

    # If we converted streaming→non-streaming for tool resolution, re-wrap as SSE
    if tools_injected and tool_loop_messages is not None:
        try:
            final_content = (upstream.json()["choices"][0]["message"]["content"] or "")
        except Exception:
            final_content = upstream.text
        return StreamingResponse(
            _text_sse(final_content, primary_model or "local-default"),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

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
) -> AsyncIterator[bytes]:
    async with _client.stream(
        method=method, url=f"/{path}", headers=headers, content=body, params=params,
    ) as resp:
        if resp.status_code >= 500 and fallback_body is not None:
            log.warning(
                f"streaming primary returned {resp.status_code}, switching to fallback"
            )
            if fallback_log:
                _routing_log.appendleft(fallback_log)
            async with _client.stream(
                method=method, url=f"/{path}", headers=headers,
                content=fallback_body, params=params,
            ) as fb_resp:
                async for chunk in fb_resp.aiter_bytes():
                    yield chunk
            return
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
