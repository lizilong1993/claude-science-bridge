//! 一键让 Claude Science 走第三方模型：写虚拟登录 -> 起本地网关 -> 带 base URL 启动 app。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeVirtualLogin } from "./forge.mjs";
import { readGatewayProfile, resolveProvider, providerToUpstream } from "./ccswitch.mjs";
import { allowDomains, DEFAULT_ALLOWED_DOMAINS } from "./allowlist.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const PID_FILE = path.join(ROOT, "gateway.pid");
const MITM_PID_FILE = path.join(ROOT, "mitm.pid");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    // config.json 不入库（可能含 API Key），首次运行从示例生成。
    const example = path.join(ROOT, "config.example.json");
    if (!fs.existsSync(example)) throw new Error("缺少配置文件，且找不到 config.example.json: " + CONFIG_PATH);
    fs.copyFileSync(example, CONFIG_PATH);
    console.log("[配置] 首次运行：已从 config.example.json 生成 config.json");
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

const ROLE_IDS = ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5", "claude-fable-5"];

function loadPresets() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "presets.json"), "utf8")); } catch { return {}; }
}

function describeProviders(available) {
  if (!available || !available.length) return;
  console.log("[配置] 可选 provider（凭据不显示）：");
  for (const p of available) {
    console.log("         - " + p.name + (p.isCurrent ? "（current）" : "") + "  " + (p.baseUrl || "(无端点)"));
  }
}

/// 把 custom（可带 preset）展开成网关上游配置。
function expandCustom(custom) {
  const c = custom || {};
  let type = c.type || "";
  let baseUrl = c.baseUrl || "";
  let label = "自定义端点";
  if (c.preset) {
    const presets = loadPresets();
    const preset = presets[c.preset];
    if (!preset) {
      const names = Object.keys(presets).filter(function (k) { return k.indexOf("_") !== 0; });
      throw new Error("未知 preset: " + c.preset + "；可用: " + names.join(", "));
    }
    type = type || preset.type;
    baseUrl = baseUrl || preset.baseUrl;
    label = preset.label;
  }
  if (!baseUrl) throw new Error("custom.baseUrl 为空：请填 baseUrl，或用 custom.preset 选一个内置厂商");
  if (!c.apiKey) throw new Error("custom.apiKey 为空：请填入该厂商的 API Key");
  let models = Array.isArray(c.models) && c.models.length ? c.models : null;
  if (!models) {
    if (!c.model) {
      throw new Error("custom.model 为空：请填上游真实模型名（四档共用），或用 custom.models 逐档指定");
    }
    models = ROLE_IDS.map(function (id) {
      return { id: id, displayName: c.model, upstream: c.model, supports1m: false };
    });
  }
  return {
    upstream: { type: type || "anthropic", baseUrl: baseUrl, apiKey: c.apiKey, bearerToken: c.apiKey, rewriteModel: false, passthroughModels: false, models: models },
    label: label + "（" + baseUrl + "）",
  };
}

function resolveUpstream(config) {
  const mode = config.source || "ccswitch";
  if (mode === "ccswitch") {
    const cs = config.ccswitch || {};
    const app = cs.app || "claude-desktop";
    const transport = cs.transport || "direct";

    if (transport === "proxy") {
      const profile = readGatewayProfile();
      if (profile) {
        console.log("[配置] 走 cc-switch 网关: " + profile.baseUrl);
        return {
          gatewayUpstream: { type: "anthropic", baseUrl: profile.baseUrl, bearerToken: profile.token, rewriteModel: false, passthroughModels: true, models: profile.models },
          virtualToken: profile.token,
          label: "cc-switch 网关",
        };
      }
      console.log("[配置] 未找到 cc-switch 网关 profile，退回 direct 解析");
    }

    const resolved = resolveProvider(app, cs.provider || "first", cs.db);
    if (resolved.ok) {
      const provider = resolved.provider;
      if (!provider.baseUrl || !provider.hasToken) {
        console.log("[配置] provider「" + provider.name + "」缺少端点或凭据，无法 direct；改用 custom");
        describeProviders(resolved.available);
      } else {
        const upstream = providerToUpstream(provider);
        console.log("[配置] 复用 cc-switch provider: " + provider.name + (provider.isCurrent ? "（current）" : "") + "  " + provider.baseUrl + "（" + upstream.type + "，模型映射 " + upstream.models.length + " 档）");
        return { gatewayUpstream: upstream, virtualToken: undefined, label: "cc-switch/" + provider.name };
      }
    } else {
      const reason = resolved.reason || "unknown";
      if (String(reason).indexOf("db-missing") === 0) console.log("[配置] 未发现 cc-switch，改用 custom");
      else console.log("[配置] provider 解析失败（" + reason + "）");
      describeProviders(resolved.available);
    }
  }

  const expanded = expandCustom(config.custom);
  console.log("[配置] 使用自定义端点: " + expanded.label);
  return { gatewayUpstream: expanded.upstream, virtualToken: undefined, label: expanded.label };
}

function gatewayAlive(host, port) {
  return new Promise(function (resolve) {
    import("node:net").then(function (net) {
      const socket = net.connect({ host: host, port: port }, function () { socket.destroy(); resolve(true); });
      socket.on("error", function () { resolve(false); });
      setTimeout(function () { socket.destroy(); resolve(false); }, 1000);
    });
  });
}

async function main() {
  const config = loadConfig();
  const host = (config.gateway && config.gateway.host) || "127.0.0.1";
  const port = (config.gateway && config.gateway.port) || 18992;
  const dataDir = (config.science && config.science.dataDir) || path.join(os.homedir(), ".claude-science");
  const exe = (config.science && config.science.exePath) || defaultExe();

  const upstream = resolveUpstream(config);

  // 1) 本地网关：为 Science 提供 /api/oauth/profile 等虚拟应答，并把 /v1/messages 转给上游。
  if (await gatewayAlive(host, port)) {
    console.log("[网关] 已在运行: http://" + host + ":" + port);
  } else {
    const runtimeConfig = path.join(ROOT, "runtime-config.json");
    fs.writeFileSync(runtimeConfig, JSON.stringify({ gateway: { host: host, port: port }, account: config.account || { name: "admin" }, upstream: upstream.gatewayUpstream }, null, 2));
    const child = spawn(process.execPath, [path.join(ROOT, "lib", "gateway.mjs"), runtimeConfig], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    child.unref();
    fs.writeFileSync(PID_FILE, String(child.pid));
    console.log("[网关] 已启动 pid=" + child.pid + " http://" + host + ":" + port);
    await new Promise(function (r) { setTimeout(r, 1500); });
  }

  // 2) 虚拟登录：写进 Science 的 data-dir，复用其已有 encryption.key。
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const accountName = (config.account && config.account.name) || "admin";
  // 虚拟身份必须跨重启稳定，否则 org 目录会变、会话历史与技能目录都会断。
  const identityFile = path.join(ROOT, "identity.json");
  let identity = {};
  try { identity = JSON.parse(fs.readFileSync(identityFile, "utf8")); } catch { identity = {}; }
  const login = writeVirtualLogin(dataDir, {
    accessToken: upstream.virtualToken,
    email: accountName,
    accountUuid: identity.accountUuid,
    orgUuid: identity.orgUuid,
  });
  fs.writeFileSync(identityFile, JSON.stringify({ accountUuid: login.account_uuid, orgUuid: login.org_uuid }, null, 2));
  let orgUuid = login.org_uuid;
  console.log("[登录] 已写入虚拟登录 account=" + login.account_uuid + " org=" + login.org_uuid);

  // 3) 放行 Anthropic 等域名，让 update 与账户相关请求不被网络策略挡住。
  const domains = (config.network && config.network.allowedDomains) || DEFAULT_ALLOWED_DOMAINS;
  const applied = allowDomains(dataDir, domains);
  if (applied) {
    console.log("[网络] 已放行域名 " + applied.total + " 条" + (applied.added.length ? "（新增 " + applied.added.join(", ") + "）" : "（无新增）"));
  } else {
    console.log("[网络] 未找到 active-org.json，跳过域名放行");
  }

  // 3.5) 定向 MITM：只为 claude.ai 等白名单主机的账号接口提供仿真应答。
  const em = config.accountEmulation || {};
  let proxyEnv = {};
  if (em.enabled) {
    const mitmPort = em.port || 18993;
    if (await gatewayAlive(host, mitmPort)) {
      console.log("[MITM] 已在运行: 127.0.0.1:" + mitmPort);
    } else {
      const mitmConfig = path.join(ROOT, "runtime-mitm.json");
      fs.writeFileSync(mitmConfig, JSON.stringify({
        accountEmulation: Object.assign({}, em, {
          port: mitmPort,
          orgUuid: orgUuid,
          accountUuid: login.account_uuid,
          skillsDir: path.join(dataDir, "orgs", orgUuid, "skills"),
          emulateSkillRegistry: em.emulateSkillRegistry !== false,
        }),
      }, null, 2));
      const child = spawn(process.execPath, [path.join(ROOT, "lib", "mitm-main.mjs"), mitmConfig], {
        detached: true, stdio: "ignore", windowsHide: true,
      });
      child.unref();
      fs.writeFileSync(MITM_PID_FILE, String(child.pid));
      console.log("[MITM] 已启动 pid=" + child.pid + " 127.0.0.1:" + mitmPort);
      await new Promise(function (r) { setTimeout(r, 1200); });
      if (!(await gatewayAlive(host, mitmPort))) {
        throw new Error("MITM 未能在 127.0.0.1:" + mitmPort + " 监听；拒绝启动 app（否则会打断全部出网）");
      }
    }
    proxyEnv = {
      HTTPS_PROXY: "http://127.0.0.1:" + mitmPort,
      HTTP_PROXY: "http://127.0.0.1:" + mitmPort,
      NO_PROXY: "127.0.0.1,localhost,::1",
      NODE_EXTRA_CA_CERTS: path.join(ROOT, "certs", "ca.pem"),
    };
    console.log("[MITM] 白名单: " + (em.interceptHosts || []).join(", "));
  }

  // 4) 带 base URL 启动桌面 app（必须走进程环境变量，Science 不读 config.toml）。
  const baseUrl = "http://" + host + ":" + port;
  const app = spawn(exe, [], {
    detached: true, stdio: "ignore", windowsHide: false,
    cwd: path.dirname(exe),
    env: Object.assign({}, process.env, { ANTHROPIC_BASE_URL: baseUrl }, proxyEnv),
  });
  app.unref();
  console.log("[启动] Claude Science pid=" + app.pid + " ANTHROPIC_BASE_URL=" + baseUrl);
  console.log("[完成] 上游=" + upstream.label + " 现在可以正常使用 Claude Science。");
}

function defaultExe() {
  const base = process.env.LOCALAPPDATA || "";
  return path.join(base, "Programs", "ClaudeScience", "claude-science.exe");
}

main().catch(function (error) {
  console.error("[失败] " + error.message);
  process.exit(1);
});
