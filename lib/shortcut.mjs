//! 把「开始菜单 -> Claude Science」快捷方式改为经本工具启动：一次安装，之后每次正常启动。
//! 用法: node lib/shortcut.mjs install | uninstall
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureCa } from "./ca.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKUP_DIR = path.join(ROOT, "backup");
const BACKUP_LNK = path.join(BACKUP_DIR, "Claude Science.lnk.orig");
const PS1 = path.join(ROOT, "runtime-shortcut.ps1");
const CA_PEM = path.join(ROOT, "certs", "ca.pem");
const CA_CN = "Claude Science Local MITM CA";

/// 把本地 CA 加入当前用户的根证书库：daemon 的原生 TLS 只认系统证书库，账号仿真需要它。
function trustCa() {
  ensureCa();
  execFileSync("certutil", ["-user", "-addstore", "Root", CA_PEM], { stdio: "ignore" });
  console.log("[安装] 已把本地 CA 加入当前用户的根证书库（账号仿真需要；可用 uninstall.cmd 移除）");
}

function untrustCa() {
  try {
    execFileSync("certutil", ["-user", "-delstore", "Root", CA_CN], { stdio: "ignore" });
    console.log("[卸载] 已从当前用户的根证书库移除本地 CA");
  } catch { /* 本来就没装 */ }
}

const PS_TEMPLATE = [
  "$sh = New-Object -ComObject WScript.Shell",
  "$lnk = '__LNK__'",
  "$s = $sh.CreateShortcut($lnk)",
  "$icon = $s.IconLocation",
  "if (-not $icon) { $icon = $s.TargetPath + ',0' }",
  "$s.TargetPath = (Join-Path $env:WINDIR 'System32\\wscript.exe')",
  "$s.Arguments = '\"__VBS__\"'",
  "$s.WorkingDirectory = '__ROOT__'",
  "$s.IconLocation = $icon",
  "$s.Save()",
  "Write-Output ('OK target=' + $s.TargetPath)",
  "Write-Output ('OK args=' + $s.Arguments)",
].join("\n");

function runPowerShell(script) {
  fs.writeFileSync(PS1, script);
  try {
    return execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1], { encoding: "utf8" });
  } finally {
    try { fs.rmSync(PS1, { force: true }); } catch { /* 忽略 */ }
  }
}

function startMenuShortcut() {
  const out = execFileSync("powershell", ["-NoProfile", "-Command", "Write-Output (Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs')"], { encoding: "utf8" });
  return path.join(out.trim(), "Claude Science.lnk");
}

function render(lnk, vbs) {
  return PS_TEMPLATE.replace("__LNK__", lnk).replace("__VBS__", vbs).replace("__ROOT__", ROOT);
}

export function install() {
  const lnk = startMenuShortcut();
  if (!fs.existsSync(lnk)) throw new Error("找不到开始菜单快捷方式: " + lnk + "（请先装好并运行过一次 Claude Science）");
  const vbs = path.join(ROOT, "launch-hidden.vbs");
  if (!fs.existsSync(vbs)) throw new Error("缺少 launch-hidden.vbs");

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (!fs.existsSync(BACKUP_LNK)) {
    fs.copyFileSync(lnk, BACKUP_LNK);
    console.log("[安装] 已备份原快捷方式 -> backup/Claude Science.lnk.orig");
  } else {
    console.log("[安装] 备份已存在，保留最初那份（不覆盖）");
  }

  process.stdout.write(runPowerShell(render(lnk, vbs)));
  trustCa();
  console.log("[安装] 完成：以后从开始菜单点 Claude Science 会自动经本工具启动。");
  console.log("[安装] 想还原：双击 uninstall.cmd");
}

export function uninstall() {
  if (!fs.existsSync(BACKUP_LNK)) throw new Error("没有备份可还原（backup/Claude Science.lnk.orig 不存在）");
  const lnk = startMenuShortcut();
  fs.copyFileSync(BACKUP_LNK, lnk);
  console.log("[卸载] 已还原开始菜单快捷方式: " + lnk);
  untrustCa();
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("lib/shortcut.mjs")) {
  try {
    if ((process.argv[2] || "install") === "uninstall") uninstall(); else install();
  } catch (error) {
    console.error("[失败] " + error.message);
    process.exit(1);
  }
}
