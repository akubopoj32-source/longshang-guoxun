const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require("electron");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { createInterface } = require("node:readline");

const project = join(__dirname, "..");
const sharedUrl = process.env.ORCHARD_SHARED_URL;
const token = sharedUrl ? process.env.ORCHARD_LOCAL_TOKEN : randomBytes(32).toString("hex");
let backend;
let window;
let stopping = false;

function startBackend(port = 0) {
  const database = process.env.ORCHARD_DESKTOP_DB
    ? resolve(process.env.ORCHARD_DESKTOP_DB)
    : join(app.getPath("userData"), "records.sqlite3");
  const args = ["--port", String(port), "--db", database, "--exit-on-stdin-close"];
  const executable = app.isPackaged
    ? join(process.resourcesPath, "backend", "orchard-backend.exe")
    : (process.env.ORCHARD_PYTHON || "python");
  if (!app.isPackaged) args.unshift(join(project, "app.py"));

  const child = spawn(executable, args, {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ORCHARD_LOCAL_TOKEN: token, PYTHONIOENCODING: "utf-8" },
  });
  backend = child;
  child.stdin.on("error", () => {});
  child.stderr.pipe(process.stderr, { end: false });
  child.once("close", () => {
    if (backend === child) backend = undefined;
  });

  return new Promise((ready, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timeout = setTimeout(() => {
      child.stdin.end();
      reject(new Error("等待巡查服务启动超时。"));
    }, 20000);
    const fail = (error) => {
      clearTimeout(timeout);
      reject(error);
    };
    child.once("error", () => fail(new Error("无法启动本地巡查服务，请检查 Python 或客户端文件。")));
    child.once("close", (code) => fail(new Error(`巡查服务已退出（代码 ${code ?? "未知"}）。`)));
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

async function checkService(origin) {
  let health;
  try {
    health = await fetch(`${origin}/api/health`, {
      headers: { "X-Orchard-Token": token },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
  } catch {
    throw new Error("无法连接巡查服务，请检查服务是否已启动。");
  }
  if (health.status === 403) throw new Error("巡查服务拒绝访问，请检查联调令牌。");
  if (!health.ok || (await health.json().catch(() => null))?.status !== "ok") {
    throw new Error("巡查服务未通过健康检查，请检查服务和记录库。");
  }
}

async function prepareService() {
  if (sharedUrl) {
    if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(sharedUrl) || !token) {
      throw new Error("共享模式需要本机巡查服务地址和访问令牌。请检查 ORCHARD_SHARED_URL 与 ORCHARD_LOCAL_TOKEN。");
    }
    const origin = new URL(sharedUrl).origin;
    await checkService(origin);
    return origin;
  }
  const origin = await startBackend();
  await checkService(origin);
  return origin;
}

async function openWorkbench() {
  let origin;
  while (!stopping) {
    try {
      origin = await prepareService();
      break;
    } catch (error) {
      if (backend) {
        const child = backend;
        const closed = new Promise((resolve) => child.once("close", resolve));
        child.kill();
        await closed;
      }
      const result = await dialog.showMessageBox({
        type: "error", title: "陇上果巡", message: "无法打开巡查工作台",
        detail: error.message, buttons: ["重新连接", "退出"], defaultId: 0, cancelId: 1,
      });
      if (result.response !== 0) {
        app.quit();
        return;
      }
    }
  }
  if (!origin || stopping) return;

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
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      session: desktopSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: join(__dirname, "preload.cjs"),
      additionalArguments: sharedUrl ? ["--orchard-shared"] : [],
    },
  });
  const guardNavigation = (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  };
  window.webContents.on("will-navigate", guardNavigation);
  window.webContents.on("will-redirect", guardNavigation);
  window.webContents.setWindowOpenHandler(({ url }) => {
    const target = new URL(url);
    if (target.origin === origin && target.pathname === "/api/knowledge/source") {
      fetch(target, { headers: { "X-Orchard-Token": token }, redirect: "manual", signal: AbortSignal.timeout(5000) })
        .then((response) => {
          const location = response.headers.get("location");
          if (response.status !== 302 || !location || new URL(location).protocol !== "https:") {
            throw new Error("资料原文地址不可用。");
          }
          return shell.openExternal(location);
        })
        .catch(() => dialog.showErrorBox("知识库", "无法打开资料原文，请稍后重试。"));
    }
    return { action: "deny" };
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    showFailure(`工作台界面已停止（${details.reason}）。请重新启动陇上果巡。`);
  });
  window.on("closed", () => { window = null; });
  window.once("ready-to-show", () => window?.show());
  const isWorkbenchFrame = (event) => window && event.sender === window.webContents
    && event.senderFrame && !event.senderFrame.parent && new URL(event.senderFrame.url).origin === origin;
  let reconnecting;
  ipcMain.handle("orchard:reconnect", async (event) => {
    if (!isWorkbenchFrame(event)) throw new Error("无法从此窗口重新连接。");
    if (!reconnecting) {
      reconnecting = (async () => {
        try {
          if (!sharedUrl && !backend) await startBackend(Number(new URL(origin).port));
          await checkService(origin);
          return {ok: true};
        } catch (error) {
          return {ok: false, message: error.message};
        }
      })().finally(() => { reconnecting = undefined; });
    }
    return reconnecting;
  });
  ipcMain.handle("orchard:output-checklist", async (event, format, filename) => {
    const owner = window;
    if (!isWorkbenchFrame(event)) {
      throw new Error("无法输出当前复查单。");
    }
    const previewOpen = await owner.webContents.executeJavaScript(
      "Boolean(document.querySelector('#print-preview[open]'))"
    );
    if (!previewOpen) throw new Error("请先打开复查单预览。");
    if (format === "print") {
      return new Promise((resolve) => {
        owner.webContents.print({ pageSize: "A4" }, (success) => resolve(success));
      });
    }
    if (format !== "pdf" || typeof filename !== "string" || !/^巡查复查单-[a-f0-9]{8}-v\d+\.pdf$/.test(filename)) {
      throw new Error("复查单文件名无效。");
    }
    const pdf = await owner.webContents.printToPDF({ pageSize: "A4", preferCSSPageSize: true });
    const { canceled, filePath } = await dialog.showSaveDialog(owner, {
      title: "保存巡查复查单",
      defaultPath: filename,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (canceled || !filePath) return false;
    await writeFile(filePath, pdf);
    return true;
  });
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
