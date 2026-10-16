//! cc-switch 配置读取：优先直读其 SQLite 库（可指定 provider、且不依赖它运行），
//! 也保留读取 Claude Desktop profile 文件的方式（走它的本地网关）。
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

// node:sqlite 是内置模块（Node >= 22.5）；用 createRequire 以便在它缺席时优雅降级。
const requireBuiltin = createRequire(import.meta.url);

export function defaultDbPath() {
  return path.join(os.homedir(), ".cc-switch", "cc-switch.db");
}

/// apiFormat（cc-switch 的叫法）到本工具网关上游类型的映射。
function upstreamType(apiFormat) {
  return /openai|chat|responses/i.test(String(apiFormat || "")) ? "openai" : "anthropic";
}

/// meta.claudeDesktopModelRoutes -> 网关 models
/// 形如 { "claude-opus-5": { model, labelOverride, supports1m } }
function routesToModels(meta) {
  const routes = meta && meta.claudeDesktopModelRoutes;
  if (!routes || typeof routes !== "object") return [];
  return Object.keys(routes).map(function (id) {
    const route = routes[id] || {};
    return {
      id: id,
      displayName: route.labelOverride || route.model || id,
      upstream: route.model || id,
      supports1m: route.supports1m === true,
    };
  });
}

function parseJson(text) {
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}

/// 列出某类 app 下的 provider（凭据不返回）。
export function listProviders(app, dbPath) {
  const target = dbPath || defaultDbPath();
  if (!fs.existsSync(target)) return { ok: false, reason: "db-missing", available: [] };
  let db;
  try {
    const { DatabaseSync } = requireBuiltin("node:sqlite");
    db = new DatabaseSync(target, { readOnly: true });
  } catch (error) {
    return { ok: false, reason: "db-unreadable:" + (error && error.message), available: [] };
  }
  try {
    const rows = db.prepare(
      "select id, name, is_current, category, settings_config, meta from providers where app_type = ? order by sort_index",
    ).all(app);
    const available = rows.map(function (row) {
      const settings = parseJson(row.settings_config);
      const env = settings.env || {};
      const meta = parseJson(row.meta);
      return {
        id: row.id,
        name: row.name,
        isCurrent: row.is_current === 1,
        category: row.category,
        baseUrl: env.ANTHROPIC_BASE_URL || "",
        hasToken: Boolean(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY),
        apiFormat: meta.apiFormat || "",
        models: routesToModels(meta),
        _env: env,
      };
    });
    return { ok: true, available: available };
  } catch (error) {
    return { ok: false, reason: "query-failed:" + (error && error.message), available: [] };
  } finally {
    try { db.close(); } catch { /* 忽略 */ }
  }
}

/// 解析要使用的 provider：current / 按 id / 按 name。
export function resolveProvider(app, selector, dbPath) {
  const listed = listProviders(app, dbPath);
  if (!listed.ok) return { ok: false, reason: listed.reason, available: [] };
  const wanted = String(selector || "first").trim();
  // first：与 cc-switch 界面第一行一致（按 sort_index 升序，listProviders 已排好序）
  if (!wanted || wanted.toLowerCase() === "first") {
    if (!listed.available.length) return { ok: false, reason: "no-provider", available: [] };
    return { ok: true, provider: listed.available[0] };
  }
  if (wanted.toLowerCase() === "current") {
    const current = listed.available.find(function (p) { return p.isCurrent; });
    if (!current) return { ok: false, reason: "no-current", available: listed.available };
    return { ok: true, provider: current };
  }
  const byId = listed.available.find(function (p) { return p.id === wanted; });
  if (byId) return { ok: true, provider: byId };
  const lower = wanted.toLowerCase();
  const byName = listed.available.filter(function (p) { return String(p.name).toLowerCase() === lower; });
  if (byName.length === 1) return { ok: true, provider: byName[0] };
  if (byName.length > 1) return { ok: false, reason: "ambiguous-name", available: listed.available };
  return { ok: false, reason: "not-found", available: listed.available };
}

/// provider -> 本工具网关的上游配置（direct：直连该 provider 自己的端点）。
export function providerToUpstream(provider) {
  const env = provider._env || {};
  const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || "";
  return {
    type: upstreamType(provider.apiFormat),
    baseUrl: provider.baseUrl,
    apiKey: token,
    bearerToken: token,
    // direct 模式必须按 provider 的角色映射重写模型名，否则 claude-* 会被原样发给上游。
    rewriteModel: true,
    passthroughModels: false,
    models: provider.models,
  };
}

/// 读取 cc-switch 写到 Claude Desktop 的 profile（走它本地网关，需 cc-switch 运行）。
export function readGatewayProfile() {
  const bases = [
    path.join(process.env.LOCALAPPDATA || "", "Claude-3p", "configLibrary"),
    path.join(process.env.LOCALAPPDATA || "", "Claude", "configLibrary"),
    path.join(os.homedir(), "Library", "Application Support", "Claude", "configLibrary"),
  ];
  for (const dir of bases) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      let profile;
      try { profile = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { continue; }
      const baseUrl = profile.inferenceGatewayBaseUrl;
      const token = profile.inferenceGatewayApiKey;
      if (typeof baseUrl === "string" && typeof token === "string") {
        const models = (Array.isArray(profile.inferenceModels) ? profile.inferenceModels : []).map(function (m) {
          return {
            id: m.name,
            displayName: m.labelOverride || m.name,
            upstream: m.name,
            supports1m: m.supports1m === true,
          };
        });
        return { baseUrl: baseUrl, token: token, models: models, source: path.join(dir, name) };
      }
    }
  }
  return null;
}
