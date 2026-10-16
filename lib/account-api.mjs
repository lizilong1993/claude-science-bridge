//! claude.ai 账号接口仿真（供定向 MITM 使用）。
//! 只实现已知会用到的端点；其余一律返回 null，交由 MITM 转发真实上游，绝不伪造。

/// bootstrap 的 SSE 契约（从 Science 二进制提取）：
///   空行分块；`event: server_base` + `data: {...}` 逐条追加连接器；`event: completed` 结束。
/// 解析逻辑：if (m === "completed") return "completed"; if (m !== "server_base" || !h) return;
/// 虚拟账号没有任何目录连接器，因此只发 completed —— daemon 得到 ok:true 且不会与内嵌目录重复。
import fs from "node:fs";
import path from "node:path";

const BOOTSTRAP_SSE = "event: completed\ndata: {}\n\n";

/// 技能注册表路径（daemon 只在拿不到时才会回落到内嵌目录）。
const SKILLS_LIST_RE = /^\/api\/oauth\/organizations\/[^/]+\/skills\/list-skills$/;

function json(status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  return { status: status, headers: { "content-type": "application/json" }, body: payload };
}

function account(uuid, name) {
  return { uuid: uuid, email: name, display_name: name };
}

/// 从本地技能目录生成注册表响应。
/// daemon 的校验极简：{skills:[{name:string 非空}]}；多给的字段会被忽略。
function localSkills(skillsDir) {
  if (!skillsDir) return [];
  let entries = [];
  try { entries = fs.readdirSync(skillsDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    if (!id) continue;
    let displayName = id;
    let description = "";
    let category = "";
    try {
      const md = fs.readFileSync(path.join(skillsDir, id, "SKILL.md"), "utf8").slice(0, 4000);
      const dn = md.match(/^\s*display-name:\s*(.+)$/m);
      if (dn) displayName = dn[1].trim();
      const cat = md.match(/^category:\s*(.+)$/m);
      if (cat) category = cat[1].trim();
      const desc = md.match(/^description:\s*>?\s*(.+)$/m);
      if (desc) description = desc[1].trim();
    } catch { /* 没有 SKILL.md 就用目录名 */ }
    out.push({ name: id, display_name: displayName, description: description, category: category });
  }
  return out;
}

export function createAccountApi(options) {
  const name = options.accountName || "admin";
  const org = options.orgUuid || "";
  const accountUuid = options.accountUuid || "";
  const skillsDir = options.skillsDir || "";
  const emulateSkills = options.emulateSkillRegistry !== false;

  return function handle(req) {
    const path = req.path.split("?")[0];
    const method = req.method.toUpperCase();

    if (path === "/api/oauth/profile") {
      return json(200, {
        account: account(accountUuid, name),
        organization: {
          uuid: org,
          name: "Local Virtual Org",
          organization_type: "claude_max",
          billing_type: "none",
        },
        applications: [],
        enabled_plugins: [],
      });
    }

    if (path === "/api/oauth/account") {
      return json(200, Object.assign(account(accountUuid, name), { memberships: [] }));
    }

    if (path === "/api/oauth/usage") {
      return json(200, {
        five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: 0, resets_at: null },
        seven_day_opus: null,
        extra_usage: { is_enabled: false, monthly_limit: null, used_credits: 0 },
      });
    }

    if (path === "/api/usage/velocity") {
      return json(200, { windows: [], computed_at: new Date().toISOString() });
    }

    if (path === "/api/auth/organizations") {
      return json(200, {
        organizations: org ? [{ uuid: org, name: "Local Virtual Org", organization_type: "claude_max" }] : [],
      });
    }

    // 技能注册表：用本地技能目录应答。daemon 只校验 name 非空，
    // 因此这能把界面上因远程注册表不可达而缺失的本地技能补回来。
    if (SKILLS_LIST_RE.test(path)) {
      if (!emulateSkills) return null;
      return json(200, { skills: localSkills(skillsDir) });
    }

    // 目录连接器列表：ok:true 即会让横幅消失。
    if (/^\/api\/oauth\/organizations\/[^/]+\/mcp\/v2\/bootstrap$/.test(path)) {
      return {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: Buffer.from(BOOTSTRAP_SSE),
      };
    }

    if (/^\/api\/oauth\/organizations\/[^/]+\/mcp\/remote_servers$/.test(path)) {
      return json(200, { servers: [] });
    }

    // 偏好类：给空对象即可，未列出的路径继续透传。
    if (path.startsWith("/api/preferences/") || path === "/api/preferences") {
      if (method === "GET") return json(200, {});
    }

    return null;
  };
}
