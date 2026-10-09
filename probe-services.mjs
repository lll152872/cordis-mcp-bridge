// probe-services.mjs — 真兼容路线探测：harness 服务层的 npm 实现能否在桥的 Context 里激活
// 方法：逐包 import，把所有 class 导出尝试 ctx.plugin()，然后检查 ctx.<服务名> 是否出现。
// 预期结论分三档：✅激活 / ⛔报错(config校验、缺依赖) / ⏳依赖等待(cordis 静默挂起)
import { Context } from "@deepseek-ai/cordis";

const PACKAGES = [
  "dsh-llm",
  "dsh-session",
  "dsh-agent",
  "dsh-agent-default-model",
  "dsh-skill",
  "dsh-fs",
  "dsh-fs-local",
  "dsh-subprocess",
];

const ctx = new Context();

for (const pkg of PACKAGES) {
  let mod;
  try {
    mod = await import(`@deepseek-ai/${pkg}`);
  } catch (e) {
    console.log(`⛔ ${pkg}: import 失败 — ${e.message.split("\n")[0]}`);
    continue;
  }
  const classes = Object.entries(mod).filter(
    ([, v]) => typeof v === "function" && String(v).startsWith("class "),
  );
  if (classes.length === 0) console.log(`?  ${pkg}: 无 class 导出 (${Object.keys(mod).slice(0, 6).join(",")}…)`);
  for (const [name, C] of classes) {
    try {
      await ctx.plugin(C, name);
      console.log(`✅ ${pkg}.${name} 挂载成功`);
    } catch (e) {
      console.log(`⛔ ${pkg}.${name}: ${String(e?.message ?? e).split("\n")[0].slice(0, 140)}`);
    }
  }
}

// cordis fiber 调度：让等待依赖的服务有机会就绪
for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));

console.log("\n--- 服务激活检查 ---");
const WANT = [
  "systemPrompt", "tools", "llm", "session", "agent", "agentDefaultModel",
  "skills", "fs", "subprocess",
];
for (const s of WANT) {
  console.log(`ctx.${s} = ${ctx[s] ? "✅ " + ctx[s].constructor.name : "— 未激活"}`);
}
