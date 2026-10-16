//! 停止本工具启动的网关与 Claude Science。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PID_FILE = path.join(ROOT, "gateway.pid");
const MITM_PID_FILE = path.join(ROOT, "mitm.pid");

if (fs.existsSync(PID_FILE)) {
  const pid = fs.readFileSync(PID_FILE, "utf8").trim();
  spawnSync("taskkill", ["/PID", pid, "/F"], { stdio: "ignore" });
  fs.rmSync(PID_FILE, { force: true });
  console.log("[网关] 已停止 pid=" + pid);
} else {
  console.log("[网关] 没有记录在案的进程");
}

if (fs.existsSync(MITM_PID_FILE)) {
  const pid = fs.readFileSync(MITM_PID_FILE, "utf8").trim();
  spawnSync("taskkill", ["/PID", pid, "/F"], { stdio: "ignore" });
  fs.rmSync(MITM_PID_FILE, { force: true });
  console.log("[MITM] 已停止 pid=" + pid);
} else {
  console.log("[MITM] 没有记录在案的进程");
}

const base = process.env.LOCALAPPDATA || "";
const exe = path.join(base, "Programs", "ClaudeScience", "claude-science.exe");
const current = path.join(os.homedir(), ".claude-science");
const r = spawnSync(exe, ["stop", "--data-dir", current], { encoding: "utf8" });
console.log("[Science] " + (r.stdout || r.stderr || "").trim());
