//! 把本地 CA 加入/移出当前用户的 Windows 根证书库（无需管理员）。
//! daemon 的原生 TLS 路径信任来源是系统证书库导出，因此账号仿真需要这一步。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureCa } from "./ca.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CA_PEM = path.join(ROOT, "certs", "ca.pem");
const CN = "Claude Science Local MITM CA";

const mode = process.argv[2] || "add";

function certutil(args) {
  return execFileSync("certutil", args, { encoding: "utf8" });
}

try {
  if (mode === "add") {
    ensureCa();
    certutil(["-user", "-addstore", "Root", CA_PEM]);
    console.log("[信任] 已把本地 CA 加入当前用户的根证书库：" + CA_PEM);
    console.log("[信任] 现在可以在 config.json 里把 accountEmulation.enabled 设为 true。");
  } else {
    const out = certutil(["-user", "-delstore", "Root", CN]);
    console.log("[取消信任] 已从当前用户的根证书库移除 " + CN);
  }
} catch (error) {
  console.error("[失败] " + (error.stderr || error.message));
  process.exit(1);
}
