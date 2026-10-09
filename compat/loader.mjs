// loader.mjs — 桥的生态兼容垫片（resolve hook）
// 现实：第三方 dsh 插件面向的 dsh-tools API 各不相同（defineTool 在 0.1.x/0.2.x 间
// 断过，如 Perfect-Web-Clone 的 defineTool 无 output 字段，rc.2 直接 throw）。
// 桥的职责 = 把这些差异 normalize 掉：只拦截「插件模块图」里的 @deepseek-ai/dsh-tools，
// 重定向到 compat 包一层；桥自己与服务链的 import 不受影响。
//
// 注册：bridge.mjs 顶部 register("./compat/loader.mjs", import.meta.url)

const PLUGIN_MARK = "/plugins/";

/** 这条 parentURL 是否属于第三方插件模块图（本地 plugins/ 目录或 npm 安装的插件包） */
function isPluginModule(parentURL) {
  const url = decodeURIComponent(parentURL ?? "");
  if (url.includes(PLUGIN_MARK)) return true;
  // npm 安装的插件（如 dsh-meme、dsh-lsp-actions）在 node_modules 顶层；
  // 服务链自身的 import 都在 node_modules/@deepseek-ai/ 下，不拦。
  if (url.includes("/node_modules/") && !url.includes("/node_modules/@deepseek-ai/")) return true;
  return false;
}

export async function resolve(specifier, context, next) {
  if (specifier === "@deepseek-ai/dsh-tools" && isPluginModule(context.parentURL)) {
    return {
      url: new URL("./dsh-tools-compat.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
