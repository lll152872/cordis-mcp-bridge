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

// 1) initialize
const init = await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "bridge-selftest", version: "0.0.0" },
});
if (init?.serverInfo?.name !== "cordis-mcp-bridge") fail(`initialize: ${JSON.stringify(init)}`);
console.log("PASS 1: initialize ->", init.serverInfo.name, init.serverInfo.version, "proto", init.protocolVersion);

child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

// 2) tools/list
const list = await request("tools/list", {});
const names = list.tools.map((t) => t.name);
if (!names.includes("bridge_echo")) fail(`tools/list missing bridge_echo: ${names}`);
const echoSpec = list.tools.find((t) => t.name === "bridge_echo");
if (echoSpec.inputSchema?.type !== "object" || !echoSpec.inputSchema.required?.includes("text"))
  fail(`inputSchema not standard JSON Schema: ${JSON.stringify(echoSpec.inputSchema)}`);
console.log("PASS 2: tools/list ->", names.join(", "), "| inputSchema OK");

// 3) tools/call
const call = await request("tools/call", { name: "bridge_echo", arguments: { text: "hello mcp" } });
if (call.isError) fail(`tools/call isError: ${JSON.stringify(call)}`);
if (!call.content?.[0]?.text?.includes("hello mcp")) fail(`unexpected content: ${JSON.stringify(call)}`);
if (call.structuredContent?.echoed !== "hello mcp") fail(`unexpected structuredContent: ${JSON.stringify(call)}`);
console.log("PASS 3: tools/call ->", call.content[0].text, "| structured:", JSON.stringify(call.structuredContent));

// 4) 未知工具 → isError 而非崩溃
const bad = await request("tools/call", { name: "no_such_tool", arguments: {} });
if (!bad.isError) fail("unknown tool did not return isError");
console.log("PASS 4: unknown tool -> isError:", bad.content[0].text);

// 5) 服务端崩不了主循环：再来一次正常调用
const again = await request("tools/call", { name: "bridge_echo", arguments: { text: "still alive" } });
if (again.isError) fail("bridge loop broken after error path");
console.log("PASS 5: loop alive ->", again.content[0].text);

child.stdin.end();
await new Promise((r) => child.on("exit", r));
console.log("\nSELFTEST OK");
