const { spawnSync } = require("node:child_process");
const { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } = require("node:fs");
const { dirname, join } = require("node:path");

if (process.platform !== "win32") throw new Error("此打包脚本需要 Windows。");

const root = join(__dirname, "..");
const release = join(root, "dist");
const name = `LongshangGuoxun-win32-${process.arch}`;
const target = join(release, name);
if (existsSync(target)) throw new Error(`构建目录已存在，请先归档：${target}`);

mkdirSync(release, { recursive: true });
const releaseRoot = realpathSync(release);
const build = mkdtempSync(join(releaseRoot, ".orchard-python-"));
const staging = mkdtempSync(join(releaseRoot, ".orchard-build-"));

function cleanup(path, parent) {
  if (!existsSync(path)) return;
  const absolute = realpathSync(path);
  if (dirname(absolute) !== parent) throw new Error(`临时目录位置不符：${absolute}`);
  rmSync(absolute, { recursive: true });
}

try {
  const result = spawnSync(process.env.ORCHARD_PYTHON || "python", [
    "-m", "PyInstaller", "--noconfirm", "--onedir", "--name", "orchard-backend",
    "--workpath", join(build, "work"), "--distpath", join(build, "dist"),
    "--specpath", build, "--add-data", `${join(root, "orchard_workbench", "web")}:orchard_workbench/web`,
    "--add-data", `${join(root, "orchard_workbench", "knowledge.json")}:orchard_workbench`, "app.py",
  ], { cwd: root, stdio: "inherit" });
  if (result.error || result.status !== 0) throw result.error || new Error("Python 服务打包失败。");

  const electron = require("electron");
  cpSync(dirname(electron), staging, { recursive: true });
  renameSync(join(staging, "electron.exe"), join(staging, "LongshangGuoxun.exe"));
  const resources = join(staging, "resources");
  rmSync(join(resources, "default_app.asar"), { force: true });
  const main = join(resources, "app");
  mkdirSync(main, { recursive: true });
  for (const file of ["package.json", "main.cjs", "preload.cjs"]) {
    copyFileSync(join(__dirname, file), join(main, file));
  }
  cpSync(join(build, "dist", "orchard-backend"), join(resources, "backend"), { recursive: true });
  renameSync(staging, target);
  console.log(join(target, "LongshangGuoxun.exe"));
} finally {
  cleanup(build, releaseRoot);
  cleanup(staging, releaseRoot);
}
