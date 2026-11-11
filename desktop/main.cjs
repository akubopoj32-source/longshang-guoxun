const { app, BrowserWindow, Menu, dialog, session } = require("electron");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { join, resolve } = require("node:path");
const { createInterface } = require("node:readline");

const project = join(__dirname, "..");
const token = randomBytes(32).toString("hex");
let backend;
let window;
let stopping = false;

function startBackend() {
  const database = process.env.ORCHARD_DESKTOP_DB
    ? resolve(process.env.ORCHARD_DESKTOP_DB)
    : join(app.getPath("userData"), "records.sqlite3");
  const args = ["--port", "0", "--db", database, "--exit-on-stdin-close"];
  const executable = app.isPackaged
    ? join(process.resourcesPath, "backend", "orchard-backend.exe")
    : (process.env.ORCHARD_PYTHON || "python");
  if (!app.isPackaged) args.unshift(join(project, "app.py"));

  backend = spawn(executable, args, {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ORCHARD_LOCAL_TOKEN: token, PYTHONIOENCODING: "utf-8" },
  });
  backend.stdin.on("error", () => {});
  backend.stderr.pipe(process.stderr, { end: false });

  return new Promise((ready, reject) => {
    const lines = createInterface({ input: backend.stdout });
    const timeout = setTimeout(() => reject(new Error("等待巡查服务启动超时。")), 20000);
    const fail = (error) => {
      clearTimeout(timeout);
      reject(error);
    };
    backend.once("error", fail);
    backend.once("exit", (code) => {
      fail(new Error(`巡查服务已退出（代码 ${code ?? "未知"}）。`));
      if (window && !stopping) showFailure("巡查服务已停止。请重新启动陇上果巡。");
    });
    lines.on("line", (line) => {
      const origin = line.trim();
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) return;
      clearTimeout(timeout);
      ready(origin);
    });
  });
}

function showFailure(message) {
  if (stopping) return;
  dialog.showErrorBox("陇上果巡", message);
  app.quit();
}

async function openWorkbench() {
  const origin = await startBackend();
  const health = await fetch(`${origin}/api/health`, {
    headers: { "X-Orchard-Token": token },
    signal: AbortSignal.timeout(5000),
  });
  if (!health.ok) throw new Error("巡查服务未通过健康检查。");

  const desktopSession = session.fromPartition("orchard-workbench");
  desktopSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  desktopSession.setPermissionCheckHandler(() => false);
  desktopSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    if (new URL(details.url).origin === origin) headers["X-Orchard-Token"] = token;
    callback({ requestHeaders: headers });
  });
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    title: "陇上果巡",
    width: 1400,
    height: 900,
    minWidth: 820,
    minHeight: 600,
    backgroundColor: "#f3f5ef",
    show: false,
    webPreferences: {
      session: desktopSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const guardNavigation = (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  };
  window.webContents.on("will-navigate", guardNavigation);
  window.webContents.on("will-redirect", guardNavigation);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("render-process-gone", (_event, details) => {
    showFailure(`工作台界面已停止（${details.reason}）。请重新启动陇上果巡。`);
  });
  window.on("closed", () => { window = null; });
  window.once("ready-to-show", () => window?.show());
  await window.loadURL(origin);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    stopping = true;
    backend?.stdin.end();
  });
  app.whenReady().then(openWorkbench).catch((error) => showFailure(error.message));
}
