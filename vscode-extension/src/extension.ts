import * as vscode from "vscode";
import * as https from "https";
import * as http from "http";

// ── Types ─────────────────────────────────────────────────────────────────────

interface HealthResponse {
  status?: string;
  mode?: string;
  single_model?: string | null;
}

type ConnectionStatus = "ok" | "error" | "unconfigured" | "checking";

// ── Status bar ────────────────────────────────────────────────────────────────

let statusBarItem: vscode.StatusBarItem;
let connectionStatus: ConnectionStatus = "unconfigured";

function updateStatusBar(status: ConnectionStatus, detail?: string): void {
  if (!vscode.workspace.getConfiguration("llmspaghetti").get<boolean>("showStatusBar")) {
    statusBarItem.hide();
    return;
  }
  connectionStatus = status;
  switch (status) {
    case "ok":
      statusBarItem.text    = "$(check) LLMSpaghetti";
      statusBarItem.tooltip = detail || "Connected to LLMSpaghetti";
      statusBarItem.color   = new vscode.ThemeColor("statusBarItem.prominentForeground");
      break;
    case "error":
      statusBarItem.text    = "$(warning) LLMSpaghetti";
      statusBarItem.tooltip = detail || "Cannot reach LLMSpaghetti server";
      statusBarItem.color   = new vscode.ThemeColor("statusBarItem.errorForeground");
      break;
    case "checking":
      statusBarItem.text    = "$(sync~spin) LLMSpaghetti";
      statusBarItem.tooltip = "Checking connection…";
      statusBarItem.color   = undefined;
      break;
    default:
      statusBarItem.text    = "$(server) LLMSpaghetti";
      statusBarItem.tooltip = "Click to set server URL";
      statusBarItem.color   = undefined;
  }
  statusBarItem.show();
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function fetchJson(url: string, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    const req = transport.get(url, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("Invalid JSON response")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
  });
}

// ── Server URL ────────────────────────────────────────────────────────────────

function getServerUrl(): string {
  return (
    vscode.workspace
      .getConfiguration("llmspaghetti")
      .get<string>("serverUrl") || ""
  ).replace(/\/$/, "");
}

async function promptForUrl(): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: "LLMSpaghetti server URL",
    placeHolder: "http://192.168.1.100",
    value: getServerUrl(),
    validateInput: (v) => {
      if (!v) return "URL cannot be empty";
      try { new URL(v); return null; }
      catch { return "Enter a valid URL, e.g. http://192.168.1.100"; }
    },
  });
}

async function ensureUrl(): Promise<string | undefined> {
  const url = getServerUrl();
  if (url) return url;
  const entered = await promptForUrl();
  if (!entered) return undefined;
  await vscode.workspace
    .getConfiguration("llmspaghetti")
    .update("serverUrl", entered, vscode.ConfigurationTarget.Global);
  return entered;
}

// ── Connection check ──────────────────────────────────────────────────────────

async function checkConnection(silent = false): Promise<void> {
  const url = getServerUrl();
  if (!url) {
    updateStatusBar("unconfigured");
    if (!silent) {
      const pick = await vscode.window.showInformationMessage(
        "LLMSpaghetti server URL is not set.",
        "Set URL"
      );
      if (pick === "Set URL") {
        await vscode.commands.executeCommand("llmspaghetti.setServerUrl");
      }
    }
    return;
  }

  updateStatusBar("checking");
  try {
    const data = (await fetchJson(`${url}/api/routing-mode`)) as HealthResponse;
    const mode = data.mode === "single"
      ? `single → ${data.single_model || "?"}`
      : "auto routing";
    updateStatusBar("ok", `LLMSpaghetti — ${mode}`);
    if (!silent) {
      vscode.window.showInformationMessage(
        `Connected to LLMSpaghetti at ${url} (${mode})`,
        "Open Dashboard"
      ).then((pick) => {
        if (pick === "Open Dashboard") {
          vscode.env.openExternal(vscode.Uri.parse(`${url}:9090`));
        }
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    updateStatusBar("error", `Cannot reach ${url}: ${msg}`);
    if (!silent) {
      vscode.window.showWarningMessage(
        `Cannot reach LLMSpaghetti at ${url}. Is the server running?`,
        "Retry",
        "Set URL"
      ).then((pick) => {
        if (pick === "Retry") checkConnection(false);
        else if (pick === "Set URL") vscode.commands.executeCommand("llmspaghetti.setServerUrl");
      });
    }
  }
}

// ── Setup guide panel ─────────────────────────────────────────────────────────

function showSetupPanel(context: vscode.ExtensionContext, serverUrl: string): void {
  const panel = vscode.window.createWebviewPanel(
    "llmspaghetti.setup",
    "LLMSpaghetti Setup",
    vscode.ViewColumn.One,
    { enableScripts: false }
  );

  const apiBase = `${serverUrl}/v1`;

  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LLMSpaghetti Setup</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); padding: 2rem; max-width: 700px; }
  h1   { font-size: 1.4rem; margin-bottom: 0.25rem; }
  h2   { font-size: 1rem; margin-top: 2rem; border-bottom: 1px solid var(--vscode-panel-border);
         padding-bottom: 0.4rem; }
  code { background: var(--vscode-textCodeBlock-background); padding: 0.15em 0.4em;
         border-radius: 4px; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
  pre  { background: var(--vscode-textCodeBlock-background); padding: 1rem; border-radius: 6px;
         overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: 0.88em; }
  .url { color: var(--vscode-textLink-foreground); font-weight: bold; }
  p    { line-height: 1.6; }
  .tool-section { margin-top: 1rem; padding: 0.75rem 1rem;
                  background: var(--vscode-sideBar-background);
                  border-left: 3px solid var(--vscode-activityBar-activeBorder);
                  border-radius: 0 6px 6px 0; }
</style>
</head>
<body>
<h1>🍝 LLMSpaghetti</h1>
<p>Your server is at <span class="url">${serverUrl}</span></p>
<p>Use the values below in any OpenAI-compatible AI tool.
   Routing happens automatically — the right model answers every message.</p>

<h2>Connection details</h2>
<pre>Base URL:  ${apiBase}
API Key:   <em>(get yours: ${serverUrl}:9090 → API Gateway → Master Key)</em>
Model:     use any name — the router selects the right one automatically</pre>

<h2>Continue.dev</h2>
<div class="tool-section">
  <p>Add to <code>~/.continue/config.json</code> under <code>models</code>:</p>
  <pre>{
  "title": "LLMSpaghetti",
  "provider": "openai",
  "model": "local-default",
  "apiBase": "${apiBase}",
  "apiKey": "YOUR_MASTER_KEY"
}</pre>
</div>

<h2>Cline</h2>
<div class="tool-section">
  <p>In Cline settings: set <strong>API Provider</strong> to <em>OpenAI Compatible</em>,
     then paste <code>${apiBase}</code> as the Base URL.</p>
</div>

<h2>Cursor / Aider / any OpenAI-compatible tool</h2>
<div class="tool-section">
  <p>Set <code>OPENAI_BASE_URL=${apiBase}</code> or use <code>${apiBase}</code>
     as your OpenAI API base. The routing layer handles the rest.</p>
</div>

<h2>Dashboard</h2>
<p>Manage models, routing rules, and services at
   <span class="url">${serverUrl}:9090</span> (Cockpit).</p>
</body>
</html>`;
}

// ── Activation ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "llmspaghetti.checkConnection";
  context.subscriptions.push(statusBarItem);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("llmspaghetti.setServerUrl", async () => {
      const entered = await promptForUrl();
      if (!entered) return;
      await vscode.workspace
        .getConfiguration("llmspaghetti")
        .update("serverUrl", entered, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`LLMSpaghetti server set to ${entered}`);
      checkConnection(true);
    }),

    vscode.commands.registerCommand("llmspaghetti.checkConnection", () => {
      checkConnection(false);
    }),

    vscode.commands.registerCommand("llmspaghetti.openDashboard", async () => {
      const url = await ensureUrl();
      if (!url) return;
      vscode.env.openExternal(vscode.Uri.parse(`${url}:9090`));
    }),

    vscode.commands.registerCommand("llmspaghetti.showSetup", async () => {
      const url = await ensureUrl();
      if (!url) return;
      showSetupPanel(context, url);
    }),

    vscode.commands.registerCommand("llmspaghetti.copyApiUrl", async () => {
      const url = await ensureUrl();
      if (!url) return;
      const apiUrl = `${url}/v1`;
      await vscode.env.clipboard.writeText(apiUrl);
      vscode.window.showInformationMessage(`Copied: ${apiUrl}`);
    }),
  );

  // Re-check on config change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("llmspaghetti.serverUrl") ||
          e.affectsConfiguration("llmspaghetti.showStatusBar")) {
        checkConnection(true);
      }
    })
  );

  // Initial connection check (silent — don't nag on every startup)
  updateStatusBar("unconfigured");
  const url = getServerUrl();
  if (url) {
    checkConnection(true);
    // Re-ping every 60s
    const interval = setInterval(() => checkConnection(true), 60_000);
    context.subscriptions.push({ dispose: () => clearInterval(interval) });
  } else {
    // First install: prompt once
    vscode.window.showInformationMessage(
      "LLMSpaghetti: paste your server URL to connect.",
      "Set URL"
    ).then((pick) => {
      if (pick === "Set URL") {
        vscode.commands.executeCommand("llmspaghetti.setServerUrl");
      }
    });
  }
}

export function deactivate(): void {
  statusBarItem?.dispose();
}
