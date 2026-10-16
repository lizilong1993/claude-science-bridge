<p align="center"><img src="assets/banner.png" alt="Claude Science Bridge" width="100%" /></p>

<h1 align="center">Claude Science Bridge</h1>

<p align="center"><strong>让 Claude Science 连接你自己的模型</strong><br />
在 Windows 上把 Claude Science 桌面版接到你自己的模型 API —— 无需构建。</p>

<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

<p align="center">
  <a href="https://github.com/lizilong1993/claude-science-bridge/releases/latest"><img src="https://img.shields.io/github/v/release/lizilong1993/claude-science-bridge?label=Release" alt="Release" /></a>
  <img src="https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D6" alt="Windows 10/11" />
  <img src="https://img.shields.io/badge/Runtime-Node.js-339933" alt="Node.js" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue" alt="MIT" /></a>
</p>

## 这是什么

Claude Science Bridge 把 **Windows 上的 Claude Science 桌面版**接到**你自己**的模型 API。

它会启动一个本地网关、为 Science 写入一份虚拟登录档案，并用指向该网关的 `ANTHROPIC_BASE_URL` 启动应用；
同时仿真少量账号接口，让界面不再坚持要求 Claude 账号。**不会修改你的 Claude Science 安装。**

| | |
| --- | --- |
| **接入自选模型** | 把 Science 的模型角色映射到 DeepSeek、Kimi、GLM、Qwen、SiliconFlow、OpenRouter，或任意 Anthropic / OpenAI 兼容端点。 |
| **复用 cc-switch**（推荐） | 直接选用你在 cc-switch 里已配好的 provider —— 按名字选，或默认取 Claude Desktop 列表第一项。 |
| **也可以不用 cc-switch** | 用内置预设或自定义 `baseUrl` 直接配置端点。 |
| **无需构建** | 纯 Node.js 脚本，**零 npm 依赖**，不需要 Rust / VS / Tauri 工具链。 |

> 独立的社区工具。不包含 Claude Science、API Key、订阅或模型额度，与 Anthropic 无官方关联。

## 怎么用

### 依赖

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10/11 x64，**不需要管理员权限** |
| Node.js | **≥ 22.5**（用到内置 `node:sqlite`；实测 **24.18**） |
| OpenSSL | 账号仿真需要，**Git for Windows 自带** |
| Claude Science | Windows 桌面版（实测 **0.1.63**） |
| cc-switch | 可选，仅方式 A 需要 |

从 [Releases](https://github.com/lizilong1993/claude-science-bridge/releases/latest) 下载 ZIP，解压到任意目录，例如 `D:\claude-science-bridge`。

### 方式 A —— 复用 cc-switch（推荐）

1. 在 cc-switch 里配好一个 **Claude Desktop** provider：端点、API Key、模型映射。
2. 在解压目录运行 **`列provider.cmd`**，查看可选的 provider、第一项以及模型映射。
3. 双击 **`安装.cmd`** —— **只跑这一次**。它会把开始菜单里「Claude Science」快捷方式指向本桥接
   （原快捷方式已备份，`卸载.cmd` 可还原）。
4. 之后**直接从开始菜单启动 Claude Science 即可**，桥接会自动起来。
5. 在 Science 里选一个模型，发一条消息。

默认使用 Claude Desktop 列表里的**第一项**。想指定别的，编辑 `config.json`：

```json
{
  "source": "ccswitch",
  "ccswitch": { "app": "claude-desktop", "provider": "OpenDesign", "transport": "direct" }
}
```

- `provider`：`first`（默认）· `current` · provider **名字** · provider **id**。
- `transport`：`direct`（默认，直接从 cc-switch 数据库读端点与凭据，**cc-switch 不需要常驻**）；
  `proxy`（走 cc-switch 网关，需要它常驻）。

### 方式 B —— 不用 cc-switch

```json
{
  "source": "custom",
  "custom": { "preset": "deepseek", "type": "anthropic", "apiKey": "你的KEY", "model": "deepseek-chat" }
}
```

内置预设：`deepseek`、`kimi`、`kimi-global`、`glm`、`glm-intl`、`qwen`、`siliconflow`、`openrouter`、`doubao`、`ppio`、`mimo`、`longcat`、`groq`、`mistral`。
其它厂商直接填 `custom.baseUrl` 与 `custom.type`（`anthropic` 或 `openai`）。
想给不同角色映射不同模型，把 `custom.model` 换成 `custom.models`，写法见 `config.example.json`。

### 停止与还原

| 操作 | 方式 |
| --- | --- |
| 停止桥接 | `停止.cmd`（同时停掉网关、本地代理与 Science） |
| 还原开始菜单快捷方式 | `卸载.cmd` |
| 手工启动（排错用） | `启动.cmd` |
| 回到真实 Claude 账号 | 先停止桥接，删除 `%USERPROFILE%\.claude-science` 下的 `.oauth-tokens/` 与 `active-org.json`，再正常启动 Science |

### config.json 速查

| 字段 | 含义 |
| --- | --- |
| `source` | `ccswitch` 或 `custom` |
| `ccswitch.provider` | `first` \| `current` \| 名字 \| id |
| `ccswitch.transport` | `direct`（推荐）或 `proxy` |
| `account.name` | Science 里显示的虚拟账户名（默认 `admin`） |
| `custom.preset` / `baseUrl` / `type` / `apiKey` | 自定义上游端点 |
| `custom.model` / `models` | 四档角色共用一个模型，或逐档映射 |
| `gateway.port` / `accountEmulation.*` | 本地端口，通常不用改 |
| `science.exePath` / `dataDir` | 留空即用默认安装路径与 `%USERPROFILE%\.claude-science` |

带注释的完整默认值见 [`config.example.json`](config.example.json)。

### 说明与限制

- 未仿真的账号级接口会快速失败，应用日志可能出现 `claudeAiFetch: 401`；
  这**不影响**对话、MCP 连接器与本地 skills。
- Directory connectors（Anthropic 托管的目录）显示为空 —— 这是虚拟账号的真实状态；
  **Featured** 里那批内置连接器可以正常使用。
- 实测基于 Claude Science **0.1.63**，客户端升级后这些接口可能变化。
- `config.json` 里可能有你的 API Key，默认已被 `.gitignore` 忽略，请勿提交。

## 致谢与声明

- **[cc-switch](https://github.com/farion1231/cc-switch)**（farion1231）—— 本桥接复用其本地数据库里的
  provider 定义（端点、凭据、角色到模型的映射），内置预设也取自其公开的 Claude Desktop 预设目录。感谢。
- **[CSSwitch](https://github.com/SuperJJ007/CSSwitch)**（SuperJJ007）—— 本项目采用的虚拟登录方案
（向 Science 数据目录写入 `v2` 加密令牌与 `active-org.json`，再把 `ANTHROPIC_BASE_URL` 指向本地网关）
沿用了 CSSwitch 在 macOS 上率先实现并验证的设计。也感谢其贡献者与围绕 Claude Science 的社区工作。
- Claude、Claude Science 及各模型厂商名称归各自权利人所有。本项目与 Anthropic、cc-switch、CSSwitch 均无隶属关系。

## 许可证

[MIT](LICENSE)
