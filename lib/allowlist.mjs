import fs from "node:fs";
import path from "node:path";

/// 默认放行的域名：Anthropic/claude 账户与文档，外加 update 用的发布桶。
export const DEFAULT_ALLOWED_DOMAINS = [
  "api.anthropic.com",
  "claude.ai",
  "claude.com",
  "console.anthropic.com",
  "platform.claude.com",
  "docs.anthropic.com",
  "storage.googleapis.com",
];

/// Science 把偏好写在 per-org 目录：<dataDir>/orgs/<org_uuid>/preferences.json，
/// 由 <dataDir>/active-org.json 决定是哪个 org。
export function preferencesPath(dataDir) {
  const activeOrg = path.join(dataDir, "active-org.json");
  if (!fs.existsSync(activeOrg)) return null;
  let org;
  try { org = JSON.parse(fs.readFileSync(activeOrg, "utf8")).org_uuid; } catch { return null; }
  if (!org) return null;
  const dir = path.join(dataDir, "orgs", org);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "preferences.json");
}

/// 把域名并入 userAllowedDomains（Science 的网络放行规则）。
export function allowDomains(dataDir, domains) {
  const file = preferencesPath(dataDir);
  if (!file) return null;
  let prefs = {};
  if (fs.existsSync(file)) {
    try { prefs = JSON.parse(fs.readFileSync(file, "utf8")); } catch { prefs = {}; }
  }
  const current = Array.isArray(prefs.userAllowedDomains) ? prefs.userAllowedDomains : [];
  const merged = current.slice();
  const added = [];
  for (const d of domains) {
    if (!merged.includes(d)) { merged.push(d); added.push(d); }
  }
  prefs.userAllowedDomains = merged;
  fs.writeFileSync(file, JSON.stringify(prefs, null, 2));
  return { file: file, added: added, total: merged.length };
}
