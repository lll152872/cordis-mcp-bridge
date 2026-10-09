// smoke.mjs — 阶段1验证：cordis 生命周期 + 官方服务链（systemPrompt→tools）在本机 node22 跑通
// 通过标准：服务解析成功、假工具注册成功、真实调用返回结果、schema 校验拒绝坏参数
import { Context } from "@deepseek-ai/cordis";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime, defineTool } from "@deepseek-ai/dsh-tools";

const ctx = new Context();

// 服务链：systemPrompt（无依赖，自洽）→ tools（inject systemPrompt）
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime);

const echo = defineTool({
  name: "bridge_echo",
  description: "smoke: 回显输入文本",
  parameters: {
    text: { type: "string", required: true, description: "要回显的文本" },
  },
  async execute(args) {
    return { echoed: args.text, at: "bridge-smoke" };
  },
  output: {
    schema: {
      type: "object",
      properties: {
        echoed: { type: "string" },
        at: { type: "string" },
      },
      additionalProperties: false,
    },
    render(args, value) {
      return `echoed: ${value.echoed}`;
    },
  },
});

ctx.tools.register(echo);

// 1) 工具已注册、可查
const got = ctx.tools.get("bridge_echo");
if (!got) throw new Error("FAIL: bridge_echo 未注册");
console.log("PASS 1: register + get OK");

// 2) 真实调用（绕过调度器的最小路径：definition.execute）
const result = await got.execute({ text: "hello from orbcat" }, null);
console.log("PASS 2: execute OK ->", JSON.stringify(result));

// 3) 渲染（MCP tools/call 的 content 由 render 产出）
console.log("PASS 3: render OK ->", String(got.output.render({}, result)));

// 4) defineTool 的参数已是标准 JSON Schema（MCP inputSchema 可直接用）
console.log("PASS 4: parameters(JSON Schema) ->", JSON.stringify(got.parameters));

// 5) 坏参数应被 schema 校验拦截
let rejected = false;
try {
  await got.execute({ text: 42 }, null);
} catch (e) {
  rejected = true;
  console.log("PASS 5: schema 校验拒绝坏参数 ->", e.name);
}
if (!rejected) throw new Error("FAIL: 坏参数未被拦截");

console.log("\nSMOKE OK — cordis + dsh 服务链在 node", process.version, "可用");
