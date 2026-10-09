# cordis-mcp-bridge

**把 cordis/dsh 插件生态桥接成标准 MCP server。** 任何 MCP 客户端（orbcat / Claude Code / Cherry Studio / …）加一条 stdio 配置，就能用上 dsh 插件的工具——不需要装 dsh，不需要改客户端代码。

```
┌─ 任意 MCP 客户端 ─────────┐
│  mcp__bridge__<toolName>  │
└────────────┬──────────────┘
             │ JSON-RPC over stdio（标准 MCP，零客户端改动）
┌────────────▼──────────────┐
│ bridge.mjs（独立 Node 进程）│
│  ├─ MCP server: tools/list + tools/call │
│  ├─ cordis Context + 官方服务链           │
│  │   (dsh-system-prompt → dsh-tools)     │
│  └─ 插件装载（plugins 清单）               │
└────────────┬──────────────┘
             │
     cordis / dsh 插件生态（defineTool + ctx.tools.register）
```

## 与 orbcat 的关系

**[orbcat](https://github.com/lll152872/orbcat)** 是一个 Windows 桌面悬浮 AI agent（Tauri + Rust，源码构建），本仓库是它的配套子项目，但**不依赖 orbcat 源码、不与它同仓**：

- **动机**：orbcat 内置了 MCP 客户端（stdio），但没有 dsh/cordis 运行时。要给它扩展工具能力，与其在 Rust 里重写每个插件，不如把整个 dsh 插件生态一次性桥接成标准 MCP server——orbcat 加一条 stdio 配置就全量接入（见下方「客户端接入」的 orbcat 配置示例）。
- **协议即边界**：桥是独立 Node 进程，两边只通过标准 MCP（JSON-RPC over stdio）通信。orbcat 怎么改、桥怎么升级，互不牵连；任何其他 MCP 客户端（Claude Code / Cherry Studio / …）用同一座桥。
- **诞生地**：本仓库在 orbcat 的开发工作区内孵化（`D:/workplace/悬浮小agent/cordis-mcp-bridge`），设计讨论与生态勘察由 orbcat 的 agent 迭代完成，记录在 [`docs/PLAN.md`](docs/PLAN.md)。

一句话：**orbcat 是第一个用户，不是唯一用户；桥只认 MCP 协议，不认宿主。**

## 状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | cordis 冒烟：官方服务链（systemPrompt→tools）挂载、工具注册/调用/schema 校验 | ✅ `npm run smoke` 5 PASS |
| 2 | MCP 出口：stdio JSON-RPC（initialize / tools/list / tools/call / ping），手写零 SDK | ✅ `npm run selftest` 8 PASS |
| 3 | 接真实第三方插件 | ✅ **3 插件 18 工具**：Perfect-Web-Clone 7 + lsp-actions 8 + dsh-expression(dsh-meme) 2 |
| 3.5 | **真兼容服务层**：harness 服务 npm 实现整链挂载（12 服务，10 真 2 stub） | ✅ `services.mjs` |
| 4 | 插件清单外置（`bridge.yml`） | ⬜ |

**关键结论（2026-10-09 实测）**：DeepSeek harness 的**服务层实现全量在 npm**（`dsh-fs`/`dsh-llm`/`dsh-agent`/`dsh-session`/`dsh-skill`/`dsh-subprocess`/`dsh-session-projection`/`dsh-agent-default-model`…，0.2.0-rc.2 全有，被 latest 标签藏住了）。桥直接挂真服务，服务面从 2 → 12，带服务依赖的插件（lsp-actions 的 fs/subprocess、dsh-meme 的 webServer/agentDefaultModel/attachments）全部激活。仅 `dsh-bash-env`/`attachments`/`web-server` 无 rc.2，走兼容 stub（webServer=收集型、attachments=本地目录真存储）。

**生态兼容垫片**（`compat/`）：第三方插件面向的 dsh-tools API 与 0.2.x 有断层（如 `defineTool` 无 `output` 字段），桥用 Node 官方 `module.register()` ESM hook 拦截**插件模块图**里的 dsh-tools import 做包装——服务链本体零改动。**兼容垫片是桥的核心职责。**

设计讨论与生态勘察全记录见 [`docs/PLAN.md`](docs/PLAN.md)。

## 快速开始

```bash
npm install        # 全部依赖 pin 精确版本（@deepseek-ai/dsh-*@0.2.0-rc.2），可复现
npm run smoke      # 阶段1：cordis 服务链冒烟
npm run selftest   # 阶段2：起 bridge 进程，用内置 MCP client 走完整协议流程
```

## 客户端接入

通用（任何 MCP 客户端）：`command: node`，`args: [<本仓库>/bridge.mjs]`。

```jsonc
// Claude Code / 通用 .mcp.json 风格
{ "mcpServers": { "cordis-bridge": { "command": "node", "args": ["/path/to/cordis-mcp-bridge/bridge.mjs"] } } }

// orbcat（设置 › MCP 加一条）
{ "transport": "stdio", "command": "node", "args": ["/path/to/cordis-mcp-bridge/bridge.mjs"], "label": "dsh插件桥" }
```

工具会以 `mcp__<serverId>__<toolName>` 出现在客户端工具列表里。

## 工程铁律

1. **stdout 只走 JSON-RPC**——日志全走 stderr，一个裸 `console.log` 就打崩帧。
2. 工具异常转 MCP `isError` 响应，主循环不炸。
3. 工具清单启动时装载完成，改清单 → 重启生效（不做热更新）。
4. stdin EOF → 主动退出，不留孤儿进程。
5. 版本锚定 `0.2.0-rc.2`（与 dsh 桌面端应用内一致）；升级 = 改 package.json 重测。

## License

本仓库 MIT。依赖的 `@deepseek-ai/*` 包各自携带其许可（MIT / BSD-3-Clause），随 npm 分发，本仓库不再分发其代码。
