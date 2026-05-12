import type {
  IPreprocessStrategy,
  PreprocessContext,
  ProcessedSessionData,
} from "./types.js";
import { readTitleFromSessionMainHtml } from "./session-read.js";
import { sessionMainHtmlName } from "./fs-utils.js";

async function runGenericTransforms(_ctx: PreprocessContext): Promise<void> {
  // 其他平台在此扩展：改镜像、入口页等；默认无站点专属步骤。
}

async function collectGenericSessionData(
  ctx: PreprocessContext,
): Promise<ProcessedSessionData> {
  const title = await readTitleFromSessionMainHtml(ctx.treeRoot, ctx.startUrl);
  if (!title) {
    ctx.log(
      `[预处理] 主 HTML 未找到有效 <title>: ${sessionMainHtmlName(ctx.startUrl)}`,
    );
  }
  return {
    title,
    thumbJpgList: [],
    cover: null,
    tags: [],
  };
}

export const genericStrategy: IPreprocessStrategy = {
  platformId: "generic",
  runPlatformTransforms: runGenericTransforms,
  collectSessionData: collectGenericSessionData,
};
