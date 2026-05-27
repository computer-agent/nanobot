import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net as electronNet,
  protocol,
  shell,
} from "electron";

type EngineStatus = "starting" | "ready" | "restarting" | "stopped" | "crashed";

type DesktopRuntime = {
  apiBase: string;
  configPath: string;
  gateway: ChildProcess;
  logsDir: string;
  port: number;
  python: string;
  secret: string;
  status: EngineStatus;
  workspacePath: string;
};

let runtime: DesktopRuntime | null = null;
let mainWindow: BrowserWindow | null = null;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "nanobot-app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
    },
  },
]);

function repoRoot(): string {
  return process.env.NANOBOT_DESKTOP_REPO_ROOT
    ? path.resolve(process.env.NANOBOT_DESKTOP_REPO_ROOT)
    : path.resolve(app.getAppPath(), "..");
}

function bundledResourcePath(name: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(repoRoot(), "desktop", "resources", name);
}

function webDistPath(root: string): string {
  if (process.env.NANOBOT_DESKTOP_WEB_DIST) {
    return path.resolve(process.env.NANOBOT_DESKTOP_WEB_DIST);
  }
  const bundled = path.join(process.resourcesPath, "nanobot-webui");
  if (app.isPackaged && existsSync(path.join(bundled, "index.html"))) {
    return bundled;
  }
  return path.join(root, "nanobot", "web", "dist");
}

function userDataPath(name: string): string {
  return path.join(app.getPath("userData"), name);
}

function pythonExecutable(): string {
  if (process.env.NANOBOT_DESKTOP_PYTHON) {
    return path.resolve(process.env.NANOBOT_DESKTOP_PYTHON);
  }
  const bundled = path.join(bundledResourcePath("nanobot-engine"), "bin", "python3");
  if (existsSync(bundled)) return bundled;
  return "python3";
}

async function pickLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address?.port) {
          resolve(address.port);
        } else {
          reject(new Error("could not allocate a loopback port"));
        }
      });
    });
  });
}

async function ensureDesktopDirs(): Promise<{
  configPath: string;
  logsDir: string;
  workspacePath: string;
}> {
  const dataDir = app.getPath("userData");
  const logsDir = userDataPath("logs");
  const workspacePath = userDataPath("workspace");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(logsDir, { recursive: true }),
    mkdir(workspacePath, { recursive: true }),
  ]);
  return {
    configPath: userDataPath("config.json"),
    logsDir,
    workspacePath,
  };
}

function appendGatewayLogs(gateway: ChildProcess, logsDir: string): void {
  const logPath = path.join(logsDir, "engine.log");
  const stream = createWriteStream(logPath, { flags: "a" });
  gateway.stdout?.on("data", (chunk) => {
    stream.write(chunk);
    process.stdout.write(`[nanobot] ${chunk}`);
  });
  gateway.stderr?.on("data", (chunk) => {
    stream.write(chunk);
    process.stderr.write(`[nanobot] ${chunk}`);
  });
  gateway.once("exit", (code, signal) => {
    stream.write(`\n[nanobot] engine exited code=${code ?? ""} signal=${signal ?? ""}\n`);
    stream.end();
  });
}

function notifyRuntimeStatus(status: EngineStatus): void {
  if (runtime) runtime.status = status;
  mainWindow?.webContents.send("nanobot:runtime-status", status);
}

async function startGateway(port?: number): Promise<DesktopRuntime> {
  const root = repoRoot();
  const dirs = await ensureDesktopDirs();
  const actualPort = port ?? await pickLoopbackPort();
  const secret = randomBytes(32).toString("base64url");
  const python = pythonExecutable();
  const args = [
    "-m",
    "nanobot",
    "desktop-gateway",
    "--config",
    dirs.configPath,
    "--workspace",
    dirs.workspacePath,
    "--webui-port",
    String(actualPort),
    "--token-issue-secret",
    secret,
  ];
  const gateway = spawn(python, args, {
    cwd: root,
    env: {
      ...process.env,
      PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  appendGatewayLogs(gateway, dirs.logsDir);
  gateway.once("exit", () => {
    if (runtime?.gateway === gateway && runtime.status !== "restarting" && runtime.status !== "stopped") {
      notifyRuntimeStatus("crashed");
    }
  });
  return {
    apiBase: `http://127.0.0.1:${actualPort}`,
    configPath: dirs.configPath,
    gateway,
    logsDir: dirs.logsDir,
    port: actualPort,
    python,
    secret,
    status: "starting",
    workspacePath: dirs.workspacePath,
  };
}

async function bootstrapFromGateway(current: DesktopRuntime): Promise<Record<string, unknown>> {
  const response = await fetch(`${current.apiBase}/webui/bootstrap`, {
    headers: {
      "X-Nanobot-Auth": current.secret,
    },
  });
  if (!response.ok) {
    throw new Error(`desktop bootstrap failed: HTTP ${response.status}`);
  }
  return await response.json() as Record<string, unknown>;
}

async function waitForGateway(current: DesktopRuntime): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (current.gateway.exitCode !== null) {
      throw new Error(`desktop gateway exited with code ${current.gateway.exitCode}`);
    }
    try {
      await bootstrapFromGateway(current);
      notifyRuntimeStatus("ready");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("desktop gateway did not become ready");
}

async function stopGateway(current: DesktopRuntime | null): Promise<void> {
  if (!current || current.gateway.exitCode !== null) return;
  current.status = "stopped";
  current.gateway.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (current.gateway.exitCode === null) current.gateway.kill("SIGKILL");
      resolve();
    }, 2500);
    current.gateway.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function startRuntime(port?: number): Promise<void> {
  notifyRuntimeStatus("starting");
  runtime = await startGateway(port);
  await waitForGateway(runtime);
}

async function restartRuntime(): Promise<void> {
  const previous = runtime;
  notifyRuntimeStatus("restarting");
  await stopGateway(previous);
  await startRuntime(previous?.port);
}

async function proxyToGateway(request: Request): Promise<Response> {
  if (!runtime) {
    return new Response("Engine unavailable", { status: 503 });
  }
  const requestUrl = new URL(request.url);
  const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, runtime.apiBase);
  const headers = new Headers(request.headers);
  headers.delete("host");
  if (requestUrl.pathname === "/webui/bootstrap") {
    headers.set("X-Nanobot-Auth", runtime.secret);
  }
  const init: RequestInit = {
    method: request.method,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  const response = await fetch(target, {
    ...init,
  });
  if (requestUrl.pathname !== "/webui/bootstrap" || !response.ok) {
    return response;
  }
  const body = await response.json() as Record<string, unknown>;
  const wsPath = typeof body.ws_path === "string" ? body.ws_path : "/";
  return Response.json({
    ...body,
    ws_url: `${runtime.apiBase.replace(/^http/i, "ws")}${wsPath}`,
    runtime_surface: "desktop",
  });
}

function resolveStaticAsset(webDist: string, requestUrl: string): string | null {
  const url = new URL(requestUrl);
  const rawPath = decodeURIComponent(url.pathname);
  const relativePath = rawPath === "/" ? "index.html" : rawPath.replace(/^\/+/, "");
  const resolved = path.resolve(webDist, relativePath);
  if (resolved !== webDist && !resolved.startsWith(`${webDist}${path.sep}`)) {
    return null;
  }
  if (existsSync(resolved)) return resolved;
  if (!path.extname(relativePath)) return path.join(webDist, "index.html");
  return null;
}

function registerDesktopProtocol(webDist: string): void {
  protocol.handle("nanobot-app", async (request) => {
    const requestUrl = new URL(request.url);
    if (
      requestUrl.pathname === "/webui/bootstrap"
      || requestUrl.pathname.startsWith("/api/")
    ) {
      return proxyToGateway(request);
    }

    const assetPath = resolveStaticAsset(webDist, request.url);
    if (!assetPath) {
      return new Response("Not Found", { status: 404 });
    }
    return electronNet.fetch(pathToFileURL(assetPath).toString());
  });
}

function createWindow(): BrowserWindow {
  const preload = path.join(app.getAppPath(), "dist", "preload.js");
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 920,
    minHeight: 640,
    title: "nanobot",
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("nanobot-app://app/")) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  return win;
}

function runtimeInfo() {
  return {
    surface: "desktop" as const,
    app_version: app.getVersion(),
    engine_status: runtime?.status ?? "stopped",
    data_dir: app.getPath("userData"),
    logs_dir: runtime?.logsDir ?? userDataPath("logs"),
    config_path: runtime?.configPath ?? userDataPath("config.json"),
    workspace_path: runtime?.workspacePath ?? userDataPath("workspace"),
    python: runtime?.python ?? pythonExecutable(),
    api_base: runtime?.apiBase,
  };
}

function registerIpcHandlers(): void {
  ipcMain.handle("nanobot:get-runtime-info", () => runtimeInfo());
  ipcMain.handle("nanobot:restart-engine", async () => {
    await restartRuntime();
  });
  ipcMain.handle("nanobot:pick-folder", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return path.resolve(result.filePaths[0]);
  });
  ipcMain.handle("nanobot:open-logs", async () => {
    const logsDir = runtime?.logsDir ?? userDataPath("logs");
    await mkdir(logsDir, { recursive: true });
    await shell.openPath(logsDir);
  });
  ipcMain.handle("nanobot:export-diagnostics", async () => {
    const diagnosticsPath = path.join(
      app.getPath("temp"),
      `nanobot-diagnostics-${Date.now()}.json`,
    );
    await writeFile(
      diagnosticsPath,
      JSON.stringify(runtimeInfo(), null, 2),
      "utf8",
    );
    return diagnosticsPath;
  });
  ipcMain.handle("nanobot:check-for-updates", () => ({
    supported: false,
    message: "Auto update is not configured for this build.",
  }));
}

app.whenReady().then(async () => {
  const root = repoRoot();
  const webDist = webDistPath(root);
  if (!existsSync(path.join(webDist, "index.html"))) {
    throw new Error(`WebUI dist not found at ${webDist}. Run npm run build:webui first.`);
  }

  registerIpcHandlers();
  registerDesktopProtocol(webDist);
  await startRuntime();

  mainWindow = createWindow();
  await mainWindow.loadURL("nanobot-app://app/index.html");

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      void mainWindow.loadURL("nanobot-app://app/index.html");
    }
  });
}).catch((error) => {
  console.error(error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (runtime) runtime.status = "stopped";
  if (runtime?.gateway.exitCode === null) {
    runtime.gateway.kill("SIGTERM");
  }
});
