//! 列出可用的 cc-switch provider 与内置预设（凭据一律不显示）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listProviders, defaultDbPath } from "./ccswitch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LINE = "  ";

console.log("cc-switch 数据库: " + defaultDbPath());
if (!fs.existsSync(defaultDbPath())) {
  console.log(LINE + "（不存在：看来没装 cc-switch。请把 config.json 的 source 设为 custom，并用 preset + apiKey + model）");
}

for (const app of ["claude-desktop", "claude"]) {
  const listed = listProviders(app);
  console.log("");
  console.log("== app_type = " + app + " ==");
  if (!listed.ok) { console.log(LINE + "不可用: " + listed.reason); continue; }
  if (!listed.available.length) { console.log(LINE + "（无）"); continue; }
  for (const p of listed.available) {
    const flags = [];
    if (p.isCurrent) flags.push("current");
    if (!p.hasToken) flags.push("无凭据");
    console.log(LINE + "- " + p.name + (flags.length ? "  [" + flags.join(", ") + "]" : ""));
    console.log(LINE + "    baseUrl  : " + (p.baseUrl || "(空)"));
    console.log(LINE + "    apiFormat: " + (p.apiFormat || "(未标注)"));
    if (p.models.length) {
      console.log(LINE + "    模型映射 : " + p.models.map(function (m) { return m.id + " -> " + m.upstream; }).join(", "));
    }
  }
}

console.log("");
console.log("== 内置 preset（不需要 cc-switch）==");
let presets = {};
try { presets = JSON.parse(fs.readFileSync(path.join(ROOT, "presets.json"), "utf8")); } catch (e) { presets = {}; }
for (const key of Object.keys(presets)) {
  if (key.indexOf("_") === 0) continue;
  const p = presets[key];
  console.log(LINE + "- " + key + "  " + p.label + "  [" + p.type + "]  " + p.baseUrl);
}

console.log("");
console.log("用法：把上面某个 provider 的名字或 id 填到 config.json 的 ccswitch.provider；");
console.log("      若要完全不依赖 cc-switch，改成 source=custom，并填 custom.preset / apiKey / model。");
