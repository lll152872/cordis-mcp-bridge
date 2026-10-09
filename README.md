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

## 状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | cordis 冒烟：官方服务链（systemPrompt→tools）挂载、工具注册/调用/schema 校验 | ✅ `npm run smoke` 5 PASS |
| 2 | MCP 出口：stdio JSON-RPC（initialize / tools/list / tools/call / ping），手写零 SDK | ✅ `npm run selftest` 5 PASS |
| 3 | 接真实第三方插件（Perfect-Web-Clone / dsh-meme 等） | ⬜ |
| 4 | 插件清单外置（`bridge.yml`） | ⬜ |

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
