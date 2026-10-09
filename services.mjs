// services.mjs — 桥的 harness 服务层装载（真兼容路线）
// 结论（2026-10-09 实测）：DeepSeek harness 的服务层实现**全量在 npm**（0.2.0-rc.2，
// 被 latest 标签藏住了）。桥不再用 stub，直接挂真服务——插件的 inject 面越宽，
// 激活率越高。装载顺序按依赖关系排列；失败的服务单独记录、不拖垮桥。
//
// 唯二例外（npm 无 0.2.0-rc.2 实现，走兼容 stub）：
// - webServer：收集型——插件只往里注册 HTTP 路由，桥收下但不监听（无 Web UI 消费方）。
// - attachments：数据型——按红线不能假实现，这里做**本地目录真存储**
//   （saveImage 写盘 / readImage 读盘，语义正确；存储位置与 DSH 会话不同）。
import { Service } from "@deepseek-ai/cordis";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import AgentDefaultModel from "@deepseek-ai/dsh-agent-default-model";
import { SkillRegistry } from "@deepseek-ai/dsh-skill";
import { FileSystem } from "@deepseek-ai/dsh-fs";
import { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";

const err = (...a) => console.error("[bridge:services]", ...a);

// ---------- 兼容 stub（收窄到最小面） ----------

/** 收集型：吃下路由注册，不监听。防重复注册炸（同进程再次 apply 场景）。 */
class WebServerStub extends Service {
  static routes = [];
  constructor(ctx, config) {
    super(ctx, "webServer");
    this.host = "127.0.0.1";
    this.port = 0;
    this.register = (route) => {
      WebServerStub.routes.push(route);
      // cordis effect 语义：apply 回调的返回值会被当 disposer 收集，
      // 必须返回 function（对齐原生 webServer.register 行为）
      return () => {
        const i = WebServerStub.routes.indexOf(route);
        if (i >= 0) WebServerStub.routes.splice(i, 1);
      };
    };
    // dsh-meme 的面板/路由线索工具；桥无 Web 面，恒返回空
    this.tapIndex = async () => null;
  }
}

/** 数据型：本地目录真存储。saveImage 写盘、readImage 读盘，base64 进出。 */
class AttachmentsLocal extends Service {
  constructor(ctx, config) {
    super(ctx, "attachments");
    this.dir = join(process.cwd(), "agent-data", "attachments");
    mkdirSync(this.dir, { recursive: true });
    this._n = 0;
  }
  async saveImage({ data, mediaType, name }) {
    const ext = mediaType === "image/png" ? "png" : mediaType === "image/gif" ? "gif" : mediaType === "image/webp" ? "webp" : "jpg";
    const file = `att-${Date.now()}-${this._n++}.${ext}`;
    writeFileSync(join(this.dir, file), Buffer.from(data));
    const ref = { mediaType, name: name ?? file, file, storedPath: join(this.dir, file) };
    return ref;
  }
  async readImage(ref) {
    if (ref?.storedPath) return { data: new Uint8Array(readFileSync(ref.storedPath)), ref };
    if (ref?.file) return { data: new Uint8Array(readFileSync(join(this.dir, ref.file))), ref };
    throw new Error(`attachments: cannot resolve image ref ${JSON.stringify(ref)}`);
  }
}

/**
 * 依序挂载服务。单个服务失败只记录并继续——cordis 对 inject 了缺失服务的插件
 * 会保持静默不激活（预期语义），桥不因为一个服务起不来而整体宕机。
 * @returns {Promise<string[]>} 成功激活的服务名列表
 */
export async function installServices(ctx) {
  const steps = [
    ["systemPrompt", SystemPrompt, undefined],
    ["llm", LlmRuntime, undefined],
    ["sessions", SessionStore, undefined],
    ["sessionProjections", SessionProjectionRegistry, undefined],
    ["agents", AgentRegistry, undefined],
    // 桥场景没有真实模型后端；dsh-meme 等插件只读 currentSelection，给确定性占位值
    ["agentDefaultModel", AgentDefaultModel, { provider: "bridge", model: "bridge-default" }],
    ["skills", SkillRegistry, undefined],
    ["fs", FileSystem, undefined],
    ["subprocess", SubprocessRuntime, undefined],
    ["webServer", WebServerStub, undefined],
    ["attachments", AttachmentsLocal, undefined],
    ["tools", ToolRuntime, undefined],
  ];
  const ok = [];
  for (const [service, C, config] of steps) {
    try {
      await ctx.plugin(C, config);
      ok.push(service);
    } catch (e) {
      err(`service "${service}" FAILED: ${String(e?.message ?? e).split("\n")[0].slice(0, 140)}`);
    }
  }
  err(`services active: ${ok.join(", ")}`);
  return ok;
}
