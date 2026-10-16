# claude-science-bridge

在 Windows 上把 **Claude Science 桌面版**接到你自己的模型 API（DeepSeek / Kimi / GLM / Qwen / SiliconFlow / OpenRouter …），
无需 Claude 账号、无需改动 Science 本体、**无需任何构建步骤**。

已实测环境：Windows 11 x64 + Claude Science **0.1.63** + Node.js **24.18**。

---

## 一、这是什么 / 不是什么

**是**：一个本地桥接工具。它做四件事：

1. 在 Science 的数据目录里写入一套**虚拟登录**（复用其 `encryption.key`，令牌格式与 Science 的 `v2` 契约逐字节一致）；
2. 起一个本地**网关**（默认 `127.0.0.1:18992`），提供 Anthropic 兼容的 `/v1/messages`、`/v1/models`（含能力字段）与 `/api/oauth/profile` 等应答，把推理转发给你的上游；
3. 起一个**定向 MITM**（默认 `127.0.0.1:18993`），只为 `claude.ai` 等白名单主机的账号接口提供仿真应答，让界面不再报「会话过期」；
4. 带 `ANTHROPIC_BASE_URL` 启动 `claude-science.exe`。

**不是**：不分发 Claude Science 本体；不含任何 API Key；不绕过任何付费；不改动 Science 二进制（其 Anthropic 代码签名保持完好）。

---

## 二、依赖清单（逐项）

### 运行环境
| 项 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | Windows 10/11 x64 | 脚本用 `cmd` + `node`，不需要管理员权限 |
| Node.js | **≥ 22.5**（实测 24.18） | 需要内置 `node:sqlite` 来读 cc-switch 的库；低于该版本会退化为只能用 `custom` 模式 |

### 外部工具
| 项 | 是否必需 | 用途 |
| --- | --- | --- |
| **OpenSSL** | 必需（仅账号仿真用） | 生成本地 CA 与叶子证书。**Git for Windows 自带**，脚本会自动在 PATH 与常见安装位置里找 |
| Clash 等本地代理 | 可选 | 仅 MITM 的**透传上游**会用到（默认 `http://127.0.0.1:7897`）；不用代理可把 `accountEmulation.upstreamProxy` 置空 |

### 第三方依赖
| 项 | 情况 |
| --- | --- |
| npm 包 | **零**。只用 Node 内置模块：`http` `net` `tls` `crypto` `child_process` `fs` `path` `sqlite` |
| 构建工具 | **不需要**。没有 Rust / VS / Tauri，不需要编译 |

### 可选组件
| 项 | 用途 |
| --- | --- |
| **cc-switch** | 复用你已配好的 Claude Desktop / Claude Code provider（含 baseUrl、凭据、角色模型映射）。不装也能用，见下面「路径 B」 |
| **Claude Science Windows 版** | 被桥接的对象（实测 0.1.63） |

---

## 三、安装与使用

### 0. 准备
1. 安装 Node.js ≥ 22.5（`node -v` 能输出版本即可）。
2. 安装 Git for Windows（提供 OpenSSL），安装时勾选默认组件即可。
3. 安装 Claude Science Windows 版（正常装好、**不需要登录**）。
4. 把本 release 的 zip 解压到任意目录，例如 `D:\claude-science-bridge`。

### 路径 A：已经装了 cc-switch（推荐）

1. 在 cc-switch 里配好一个 **Claude Desktop** provider（例如 DeepSeek），并把 Key 填好。
2. 双击 **`列provider.cmd`**，它会列出可选的 provider（含 `current` 标记、baseUrl、模型映射，凭据不显示）。
3. 编辑 `config.json`：
   ```json
   {
     "source": "ccswitch",
     "ccswitch": {
       "app": "claude-desktop",
       "provider": "current",
       "transport": "direct"
     }
     ...
   }
   ```
   - `provider`：填 `current`（用 cc-switch 当前选中的那家），或填 `列provider.cmd` 里显示的**名字或 id**（例如 `OpenDesign`）来指定别的；
   - `transport`：
     - `direct`（**推荐**）：直接读 cc-switch 库里的 baseUrl 与凭据，**cc-switch 可以不开**；
     - `proxy`：走 cc-switch 的本地网关（需要 cc-switch 常驻运行）。
4. 双击 **`启动.cmd`**。看到 `[完成] 上游=cc-switch/DeepSeek …` 即可。
5. Science 窗口会自动打开；顶部模型选择器里选一个模型就能用。

### 路径 B：没有 cc-switch

用内置预设，只需三行配置：

```json
{
  "source": "custom",
  "custom": {
    "preset": "deepseek",
    "apiKey": "sk-你的key",
    "model": "deepseek-chat"
  }
}
```

- `preset` 可选值见 `列provider.cmd` 末尾的列表（deepseek / kimi / glm / qwen / siliconflow / openrouter / doubao / ppio / mimo / longcat / groq / mistral …），baseUrl 取自 cc-switch 的官方预设目录；
- `model` 填上游**真实模型名**，四档角色会共用它；
- 需要逐档映射时，把 `custom.model` 换成 `custom.models`：
  ```json
  "models": [
    { "id": "claude-opus-5",   "displayName": "deepseek-reasoner", "upstream": "deepseek-reasoner" },
    { "id": "claude-sonnet-5", "displayName": "deepseek-chat",     "upstream": "deepseek-chat" }
  ]
  ```

### 停止与恢复

- **`停止.cmd`**：停止网关、MITM 与 Science。
- **恢复真实登录**：删除 Science 数据目录下的 `.oauth-tokens/`、`active-org.json` 以及 `orgs/` 下由本工具创建的目录即可。
- **彻底停用账号仿真**：把 `config.json` 里 `accountEmulation.enabled` 改成 `false`，启动器就不再注入代理与 CA。

---

## 四、config.json 全字段

| 字段 | 说明 |
| --- | --- |
| `source` | `ccswitch`（优先用 cc-switch）或 `custom`（用自己的端点）。解析失败会自动退回 `custom` |
| `ccswitch.app` | `claude-desktop`（自带角色模型映射）或 `claude` |
| `ccswitch.provider` | `current` \| provider 的名字 \| provider 的 id |
| `ccswitch.transport` | `direct`（不依赖 cc-switch 常驻）\| `proxy`（走 cc-switch 网关） |
| `ccswitch.db` | 留空则用 `~/.cc-switch/cc-switch.db` |
| `account.name` | 虚拟账户名，同时用作 profile 的 `email` 与 `display_name`（默认 `admin`） |
| `gateway` | 本地网关的 host/port |
| `accountEmulation.enabled` | 是否启用定向 MITM 账号仿真 |
| `accountEmulation.port` | MITM 监听端口 |
| `accountEmulation.upstreamProxy` | MITM 透传时用的上游代理（默认 Clash `http://127.0.0.1:7897`），置空则直连 |
| `accountEmulation.unmatchedAccountPathStatus` | 白名单主机上未实现路径的返回码，默认 `404`（让 Science 走它自己的降级分支） |
| `accountEmulation.interceptHosts` | 需要 TLS 终止的主机白名单 |
| `science.dataDir` | 留空则用真实数据目录 `~/.claude-science` |
| `network.allowedDomains` | 并入 Science 的 `userAllowedDomains`，放行 update 与账户相关域名 |
| `custom.preset` \| `apiKey` \| `model` \| `models` | 见「路径 B」 |

---

## 五、工作原理（简）

```
Claude Science (app + daemon)
  ├─ ANTHROPIC_BASE_URL ─► 本地网关 127.0.0.1:18992
  │                           ├─ /v1/models   给出角色模型 + 能力字段（Science 只登记带能力字段的模型）
  │                           ├─ /v1/messages 按角色映射重写模型名，转发给上游（Anthropic 或 OpenAI 兼容）
  │                           └─ /api/oauth/profile 等虚拟应答
  └─ HTTPS_PROXY ────────► 定向 MITM 127.0.0.1:18993
                              ├─ claude.ai 等白名单 → TLS 终止 → 账号接口仿真
                              └─ 其余一切 → 盲隧道透传（看不到内容）
```

几个关键点（都是实测结论）：

- **必须用启动器**：Science 只在**进程环境变量**里读 `ANTHROPIC_BASE_URL`；`<安装目录>\.env`、`<data-dir>\env`、`config.toml` **都无效**。
- **`auth_dir` 跟随用户主目录**，不是 `--data-dir`；本工具直接写真实数据目录，因此不需要改 `USERPROFILE`（改了会破坏 winsbx 沙箱）。
- **模型能力字段**：Science 只登记带 `max_tokens` / `max_input_tokens` / `capabilities.effort.supported` 之一的模型，全缺时模型选择器会是空的。
- **CA 注入**：二进制支持 `NODE_EXTRA_CA_CERTS` 与 `HTTPS_PROXY`，因此可以只对 Science 进程做定向拦截。

---

## 六、已知限制

- **账号级接口**：`list-skills` / `list-plugins` / `account/settings` / `client_data` / telemetry 未仿真，按 404 快速失败。日志里仍可能出现 `claudeAiFetch: 401 … treating as logged-out`，**不影响对话、MCP 连接器与本地 skills**。
- **Directory connectors**（Anthropic 托管的远程 MCP 目录）显示为空——这是虚拟账号的真实状态；界面里 **Featured** 那批（本地 bundled + Anthropic 托管的 `hcls.mcp.claude.com`）**实测 24/24 全部可连**。
- **`update`**：CLI 的 `claude-science update --check` 正常；应用内自动更新按上游策略处理。
- 虚拟账号没有真实配额，用量面板显示为 0。

---

## 七、安全边界

- MITM **只作用于启动器拉起的 Claude Science 进程**：`HTTPS_PROXY` 与 `NODE_EXTRA_CA_CERTS` 都只注入给它。
- 本地 CA 私钥只落在工具目录 `certs/`，**不写入 Windows 信任库**，**不修改 hosts**。
- 只终止白名单主机的 TLS；其余流量是盲隧道，工具看不到内容。
- 不修改 Science 可执行文件，Anthropic 的 Authenticode 签名保持完好。
- `停止.cmd` 后立即失效；`accountEmulation.enabled=false` 可一键退回直连。
- 工具**不读取、不回显**任何 API Key；`列provider.cmd` 只显示 baseUrl 与是否具备凭据。

---

## 八、故障排查

| 现象 | 处理 |
| --- | --- |
| `找不到 openssl` | 安装 Git for Windows，或把 openssl 加入 PATH |
| `MITM 未能在 127.0.0.1:18993 监听` | 端口被占用；改 `accountEmulation.port`，并确认没有残留进程（先跑一次 `停止.cmd`） |
| 模型选择器是空的 | 上游返回的模型缺少能力字段；用 `ccswitch` 模式（网关自动补齐），或检查 `custom.models` |
| 界面仍提示会话过期 | 确认 `accountEmulation.enabled=true`，并查看 `mitm.log` 是否出现 `emulated GET claude.ai /api/oauth/profile -> 200` |
| 对话报 400/404 | 上游模型名不对：确认 `custom.model` 或 cc-switch provider 的模型映射是真实存在的模型名 |
| 想回到原生登录 | 跑 `停止.cmd`，删除 `.oauth-tokens/`、`active-org.json`，然后正常启动 Science |
| 想对比是否由本工具引起 | 把 `config.json` 的 `accountEmulation.enabled` 改成 `false` 再启动 |

---

## 九、日志与产物

| 文件 | 内容 |
| --- | --- |
| `gateway.log` | 网关收到的请求与上游响应码 |
| `mitm.log` | 哪些主机被拦截、哪些路径被仿真 / 快速失败 |
| `gateway.pid` / `mitm.pid` | 由 `停止.cmd` 回收 |
| `identity.json` | 虚拟身份（account/org），**不要删**，删了会导致会话历史与技能目录重置 |
| `certs/` | 本地 CA 与叶子证书（含私钥，注意保密） |
