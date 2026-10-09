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
import { register } from "node:module";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { installServices } from "./services.mjs";

const VERSION = "0.1.0";
const err = (...a) => console.error("[bridge]", ...a);

// 从任何目录被 spawn 都以仓库根为工作目录（插件相对路径、子进程 cwd 才稳定）
process.chdir(dirname(fileURLToPath(import.meta.url)));

// 铁律1的强制执行：插件常用 console.log 打日志，会打崩 MCP stdio 帧 —— 全部重定向 stderr
console.log = (...a) => console.error("[plugin:log]", ...a);
console.info = (...a) => console.error("[plugin:log]", ...a);

// 生态兼容垫片：拦截插件模块图里的 @deepseek-ai/dsh-tools（必须在插件 import 之前注册）
register("./compat/loader.mjs", import.meta.url);

// ---------- cordis 服务链（真兼容：harness 服务层 npm 实现，见 services.mjs） ----------
const ctx = new Context();
await installServices(ctx);

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

// ---------- 第三方插件装载（阶段3） ----------
// 清单条目两种形态："./plugins/…" 本地路径，或 npm 包名（需已安装到本仓库依赖）。
// 插件 = 任意 cordis/dsh 插件模块（name/inject/apply 形态）。
// inject 缺失服务 → cordis 语义静默不激活（预期，不算错）；装载异常 → 记录后继续，不打死桥。
const PLUGINS = [
  { src: "./plugins/Perfect-Web-Clone/plugin/index.js" },
  // 真兼容验证样本：inject ['tools','fs','subprocess'] —— fs/subprocess 为 npm 真服务。
  // 顶层 defaults 全量抄自其 Config schema（dsh loader 会跑 schemastery 填默认，桥手动喂同值）
  {
    src: "dsh-lsp-actions",
    config: {
      servers: {},
      maxDiagnostics: 200,
      maxCompletionItems: 20,
      maxCodeActions: 50,
      maxSymbols: 100,
      maxSignatures: 10,
      maxInlayHints: 200,
      maxResultChars: 16000,
      maxDocumentBytes: 1048576,
      timeoutMs: 60000,
      editor: { enabled: false, requestTimeoutMs: 60000, diagnosticsCacheMaxFiles: 64 },
    },
  },
  // 用户实际使用的表情包插件：inject ['tools','webServer','agentDefaultModel','attachments']
  { src: "dsh-meme" },
];

// 注：cordis 4 的 ctx.effect(fn) 本来就会立即调用 fn 并把返回值当 disposer 收集
// （function→collect / promise→then / generator→迭代 / null→空），与 0.1.x 语义兼容，
// 无需垫片。此前 dsh-meme 的 "Invalid effect" 是 stub 的 register 返回了对象而非 disposer。

for (const { src: rel, config: pluginConfig } of PLUGINS) {
  try {
    const specifier = rel.startsWith("./") ? pathToFileURL(join(process.cwd(), rel)).href : rel;
    const mod = await import(specifier);
    // 对象形态装载（cordis 对函数导出会 new）+ config 缺省 {}（dsh loader 语义）
    await ctx.plugin({
      name: mod.name,
      inject: mod.inject,
      apply: (ctx2, config) => mod.apply(ctx2, config ?? pluginConfig ?? {}),
    });
    const injected = mod.inject ? `[inject: ${mod.inject.join(", ")}]` : "";
    err(`plugin loaded: ${mod.name ?? rel} ${injected}`);
  } catch (e) {
    err(`plugin FAILED to load: ${rel} — ${e?.stack ?? e}`);
  }
}

// ---------- skills 送达（最后一跳） ----------
// 插件经 skills.register() 存进注册表的剧本（如 pwc 的 257 行 harness 剧本），
// 通过 MCP 协议内三条通道送达客户端 agent：
//   ① initialize 的 instructions 字段（摘要 + 指引）
//   ② bridge_skills_read 工具（全文，任何 MCP 客户端可用）
//   ③ prompts 能力（prompts/list + prompts/get，支持它的客户端可枚举）
// 注意：SkillRegistry.snapshot() 是 async 且默认不含 content；全文走 get(name)。
async function runtimeSkills() {
  const snap = await ctx.skills.snapshot();
  return snap.skills ?? [];
}

async function skillsInstructions() {
  const skills = await runtimeSkills();
  if (skills.length === 0) return undefined;
  const lines = skills.map(
    (s) => `- ${s.name}${s.description ? `：${s.description}` : ""}（用 bridge_skills_read 工具读全文）`,
  );
  return [
    "本服务器携带了来自插件的技能说明（skills）。使用插件提供的工具前，先读对应技能全文：",
    ...lines,
  ].join("\n");
}

// 两个内置 skills 工具（走 dsh-tools 正常注册 → 自动进 tools/list，带 MCP 前缀）
ctx.tools.register(
  defineTool({
    name: "bridge_skills_list",
    description: "列出本桥已装载插件的全部技能说明（skill）。调用插件工具前建议先读对应技能。",
    parameters: {},
    async execute() {
      return { skills: runtimeSkills().map(({ name, description, provider }) => ({ name, description, provider })) };
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render(args, value) {
        const list = value.skills.map((s) => `- ${s.name}：${s.description ?? ""}`).join("\n");
        return `skills (${value.skills.length}):\n${list}`;
      },
    },
  }),
);

ctx.tools.register(
  defineTool({
    name: "bridge_skills_read",
    description: "读取某个技能的完整说明全文（markdown）。",
    parameters: {
      name: { type: "string", required: true, description: "技能名（见 bridge_skills_list）" },
    },
    async execute(args) {
      const skill = await ctx.skills.get(args.name);
      if (!skill?.content) return { ok: false, error: `skill not found: ${args.name}` };
      return { ok: true, name: skill.name, content: skill.content };
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render(args, value) {
        if (!value.ok) return `skill not found: ${args.name}`;
        return value.content;
      },
    },
  }),
);

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
  async initialize(params) {
    // 回显客户端协议版本：客户端断言我们支持它说的版本。
    // instructions = skills 剧本摘要（支持它的客户端会拼进系统提示，如 orbcat）
    const result = {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
      serverInfo: { name: "cordis-mcp-bridge", version: VERSION },
    };
    const instructions = await skillsInstructions();
    if (instructions) result.instructions = instructions;
    return result;
  },
  async "tools/list"() {
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
  async "prompts/list"() {
    return {
      prompts: (await runtimeSkills()).map((s) => ({
        name: `skill_${s.name}`,
        description: s.description ?? `Skill: ${s.name}`,
      })),
    };
  },
  async "prompts/get"(params) {
    const wanted = String(params?.name ?? "").replace(/^skill_/, "");
    const skill = await ctx.skills.get(wanted);
    if (!skill?.content) throw new Error(`prompt not found: ${params?.name}`);
    return {
      messages: [
        { role: "user", content: { type: "text", text: skill.content } },
      ],
    };
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
