// dsh-tools-compat.mjs — 面向第三方插件的 dsh-tools 兼容包装
// `export *` 透传真包全部导出；本地 defineTool 与其同名 → 本地优先（ESM 冲突规则）。
// 兼容点：旧式/简化式插件不写 output（如 Perfect-Web-Clone）→ 0.1.x/0.2.x 的
// defineTool 都硬要求 output.render，这里补一个默认：schema 开放对象 + JSON 序列化渲染。
import { defineTool as realDefineTool } from "@deepseek-ai/dsh-tools";

export * from "@deepseek-ai/dsh-tools";

export function defineTool(options) {
  let opts = options;
  if (opts && opts.output === undefined) {
    opts = {
      ...opts,
      output: {
        schema: { type: "object", additionalProperties: true },
        render(args, value) {
          return typeof value === "string" ? value : JSON.stringify(value ?? null);
        },
      },
    };
  }
  return realDefineTool(opts);
}
