// bridge.mjs — cordis → MCP 桥接器
// 把 cordis/dsh 插件生态桥接成标准 MCP server（stdio, newline-delimited JSON-RPC）。
// 任何会说 MCP 的客户端（orbcat / Claude Code / …）加一条 stdio 配置即可使用。
//
// 铁律：
//   1. stdout 只准走 JSON-RPC —— 一切日志/报错走 stderr，一个裸 console.log 就会打崩帧。
//   2. 工具异常必须转成 isError 响应，绝不炸主循环。
//   3. 工具清单在启动时装载完成；改插件清单 → 重启生效（不做热更新）。
//   4. stdin EOF（客户端退出）→ 主动退出，不留孤儿进程。

import { createInterface } from "node:readline";
import process from "node:process";
import { Context } from "@deepseek-ai/cordis";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime, defineTool } from "@deepseek-ai/dsh-tools";

const VERSION = "0.1.0";
const err = (...a) => console.error("[bridge]", ...a);

// ---------- cordis 服务链 ----------
const ctx = new Context();
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime);

// ---------- 内置演示工具（阶段1冒烟的同一形状；阶段3起由插件清单提供真工具） ----------
const echo = defineTool({
  name: "bridge_echo",
  description: "演示工具：原样回显 text 参数。验证桥接管线是否存活。",
  parameters: {
    text: { type: "string", required: true, description: "要回显的文本" },
  },
  async execute(args) {
    return { echoed: args.text, at: "cordis-mcp-bridge" };
  },
  output: {
    schema: {
      type: "object",
      properties: { echoed: { type: "string" }, at: { type: "string" } },
      additionalProperties: false,
    },
    render(args, value) {
      return `echoed: ${value.echoed}`;
    },
  },
});
ctx.tools.register(echo);

// ---------- 工具清单（全局层视图） ----------
function listTools() {
  const view = ctx.tools.view(undefined);
  const names = [...view.restrictableNames].sort();
  return names.map((name) => {
    const t = ctx.tools.get(name, undefined);
    // defineTool 已把 parameters 编译成标准 JSON Schema（含顶层 required 数组）
    return { name, description: t.description ?? "", inputSchema: t.parameters };
  });
}

const execStub = () => ({ signal: new AbortController().signal });

// ---------- MCP 方法实现 ----------
const methods = {
  initialize(params) {
    // 回显客户端协议版本：客户端断言我们支持它说的版本
    return {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "cordis-mcp-bridge", version: VERSION },
    };
  },
  "tools/list"() {
    return { tools: listTools() };
  },
  async "tools/call"(params) {
    const { name, args } = { name: params?.name, args: params?.arguments ?? {} };
    const tool = ctx.tools.get(name, undefined);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      const value = await tool.execute(args, execStub());
      const rendered = tool.output.render(args, value);
      return {
        content: [{ type: "text", text: String(rendered) }],
        structuredContent: value,
      };
    } catch (e) {
      err(`tool ${name} failed:`, e?.stack ?? e);
      return {
        content: [{ type: "text", text: `tool ${name} failed: ${e?.message ?? e}` }],
        isError: true,
      };
    }
  },
  ping() {
    return {};
  },
};

// ---------- JSON-RPC 主循环 ----------
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    err("non-JSON line ignored");
    return;
  }
  const { id, method, params } = msg;
  if (method === undefined) return; // 对服务器的响应：忽略
  if (method.startsWith("notifications/")) {
    if (method === "notifications/initialized") err("client initialized");
    return; // 通知无需响应
  }
  const handler = methods[method];
  if (!handler) {
    if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
    return;
  }
  Promise.resolve()
    .then(() => handler(params))
    .then(
      (result) => id !== undefined && reply(id, result),
      (e) => {
        err(`handler ${method} threw:`, e?.stack ?? e);
        if (id !== undefined) replyError(id, -32603, `Internal error: ${e?.message ?? e}`);
      },
    );
});
rl.on("close", () => {
  err("stdin closed, exiting");
  process.exit(0);
});

err(`cordis-mcp-bridge v${VERSION} ready (tools: ${listTools().map((t) => t.name).join(", ")})`);
