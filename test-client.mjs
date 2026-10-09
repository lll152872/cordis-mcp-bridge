// test-client.mjs — bridge.mjs 的 MCP stdio 自测客户端
// 流程：spawn bridge → initialize → notifications/initialized → tools/list → tools/call
// 通过标准：收到 serverInfo、工具清单含 bridge_echo、调用结果 isError=false 且内容正确。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import process from "node:process";

const child = spawn(process.execPath, ["bridge.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
const rl = createInterface({ input: child.stdout, terminal: false });

const pending = new Map();
let nextId = 1;
function request(method, params) {
  const id = nextId++;
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  child.stdin.write(msg + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 10_000);
  });
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  }
});

const fail = (m) => { console.error("FAIL:", m); child.kill(); process.exit(1); };

// 1) initialize —— 含 skills 摘要 instructions（剧本送达通道①）
const init = await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "bridge-selftest", version: "0.0.0" },
});
if (init?.serverInfo?.name !== "cordis-mcp-bridge") fail(`initialize: ${JSON.stringify(init)}`);
if (typeof init.instructions !== "string" || !init.instructions.includes("perfect-web-clone"))
  fail(`instructions missing skill summary: ${JSON.stringify(init.instructions)}`);
console.log("PASS 1: initialize -> serverInfo + instructions（含 skill 摘要）✓");

child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

// 2) tools/list
const list = await request("tools/list", {});
const names = list.tools.map((t) => t.name);
if (!names.includes("bridge_echo")) fail(`tools/list missing bridge_echo: ${names}`);

// 阶段3验收①：第三方插件装载激活 —— pwc_* 全部 7 个工具出现在 MCP 清单里
const pwcTools = names.filter((n) => n.startsWith("pwc_"));
const EXPECTED_PWC = ["pwc_extract", "pwc_plan", "pwc_assemble", "pwc_build", "pwc_fingerprints", "pwc_weight", "pwc_score"];
for (const t of EXPECTED_PWC) {
  if (!pwcTools.includes(t)) fail(`plugin not activated, missing ${t}; got: ${names}`);
}
const pwcSpec = list.tools.find((t) => t.name === "pwc_extract");
if (pwcSpec.inputSchema?.properties?.url?.type !== "string")
  fail(`pwc_extract inputSchema wrong: ${JSON.stringify(pwcSpec.inputSchema)}`);
console.log(`PASS 2: tools/list -> ${names.length} tools (plugin: ${pwcTools.length}/7 pwc_*) | inputSchema OK`);

// 3) tools/call —— 内置工具
const call = await request("tools/call", { name: "bridge_echo", arguments: { text: "hello mcp" } });
if (call.isError) fail(`tools/call isError: ${JSON.stringify(call)}`);
if (!call.content?.[0]?.text?.includes("hello mcp")) fail(`unexpected content: ${JSON.stringify(call)}`);
if (call.structuredContent?.echoed !== "hello mcp") fail(`unexpected structuredContent: ${JSON.stringify(call)}`);
console.log("PASS 3: tools/call ->", call.content[0].text, "| structured:", JSON.stringify(call.structuredContent));

// 3b) 阶段3验收②+③：第三方插件工具真实执行。
//     pwc_fingerprints 对本仓库扫描会命中门禁指纹（exit 1 + ok:false JSON）——
//     桥适配副本已把"exit≠0 但 stdout 为 JSON"转为正常结果，结构化数据必须完整送达。
const pwcCall = await request("tools/call", {
  name: "pwc_fingerprints",
  arguments: { dirpath: "." },
});
if (pwcCall.isError) fail(`pwc_fingerprints unexpected error: ${JSON.stringify(pwcCall.content)}`);
// dsh-tools 语义：返回值 {ok:false} 会被规范成 {ok:false, error:{原始结果}}（失败但带详情）——
// 数据没丢，只是换了位置；两种位置都验收
const sc = pwcCall.structuredContent;
const data = sc?.error ?? sc;
if (!data || typeof data.total !== "number" || !data.by_pattern)
  fail(`gate-failure structured data lost: ${JSON.stringify(sc)}`);
console.log(`PASS 3b: gate-failure data intact -> ok:false, total=${data.total}, patterns=${Object.keys(data.by_pattern).join(",")}`);

// 4) 未知工具 → isError 而非崩溃
const bad = await request("tools/call", { name: "no_such_tool", arguments: {} });
if (!bad.isError) fail("unknown tool did not return isError");
console.log("PASS 4: unknown tool -> isError:", bad.content[0].text);

// 4b) skills 送达通道②③：bridge_skills_read 全文 + prompts 能力
const skillRead = await request("tools/call", {
  name: "bridge_skills_read",
  arguments: { name: "perfect-web-clone" },
});
if (skillRead.isError) fail(`bridge_skills_read isError: ${JSON.stringify(skillRead.content)}`);
if (!skillRead.structuredContent?.content?.includes("pwc") && !skillRead.content?.[0]?.text?.includes("pwc"))
  fail(`skill content missing: ${JSON.stringify(skillRead).slice(0, 200)}`);
console.log(`PASS 4b: skills read -> ${String(skillRead.structuredContent?.content ?? "").length} chars`);
const pl = await request("prompts/list", {});
if (!pl.prompts?.some((p) => p.name === "skill_perfect-web-clone"))
  fail(`prompts/list missing skill prompt: ${JSON.stringify(pl)}`);
const pg = await request("prompts/get", { name: "skill_perfect-web-clone" });
if (!pg.messages?.[0]?.content?.text?.includes("pwc")) fail(`prompts/get broken: ${JSON.stringify(pg).slice(0, 200)}`);
console.log("PASS 4c: prompts capability -> list+get OK");

// 5) 服务端崩不了主循环：再来一次正常调用
const again = await request("tools/call", { name: "bridge_echo", arguments: { text: "still alive" } });
if (again.isError) fail("bridge loop broken after error path");
console.log("PASS 5: loop alive ->", again.content[0].text);

child.stdin.end();
await new Promise((r) => child.on("exit", r));
console.log("\nSELFTEST OK");
