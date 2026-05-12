import { join } from "node:path";
import type { LogFn } from "../cdp-capture.js";
import {
  isVr3d66DetailAspStartUrl,
  isVrJusteasyStartUrl,
  sessionFolderFromStartUrl,
} from "../url-to-file.js";
import type { IPreprocessStrategy } from "./types.js";
import {
  injectBackHomeIntoHtmlInTree,
  replaceMissingMp3RefsInHtmlInTree,
  rewriteHttpsToDotSlashInTree,
} from "./post-common.js";
import { persistProcessedSessionData } from "./settings-io.js";
import { resolvePreprocessTreeRoot } from "./tree-root.js";
import { genericStrategy } from "./generic-strategy.js";
import { vr3d66DetailStrategy } from "./vr-3d66-detail-strategy.js";
import { vrJusteasyStrategy } from "./vr-justeasy-strategy.js";

export function resolvePreprocessStrategy(startUrl: string): IPreprocessStrategy {
  if (isVrJusteasyStartUrl(startUrl)) {
    return vrJusteasyStrategy;
  }
  if (isVr3d66DetailAspStartUrl(startUrl)) {
    return vr3d66DetailStrategy;
  }
  return genericStrategy;
}

export async function runPreprocess(
  outDir: string,
  startUrl: string,
  log: LogFn,
): Promise<void> {
  const trimmed = outDir.trim();
  const treeRoot = resolvePreprocessTreeRoot(trimmed, startUrl, log);
  if (!treeRoot) {
    const key = sessionFolderFromStartUrl(startUrl);
    log(
      `[预处理] 保存目录不存在或无效（已尝试会话路径: ${join(trimmed, key)} 等）。`,
    );
    return;
  }

  const strategy = resolvePreprocessStrategy(startUrl);
  log(`[预处理] 使用平台策略: ${strategy.platformId}`);

  await rewriteHttpsToDotSlashInTree(treeRoot, log);
  await strategy.runPlatformTransforms({ treeRoot, startUrl, log });
  await injectBackHomeIntoHtmlInTree(treeRoot, log);
  await replaceMissingMp3RefsInHtmlInTree(treeRoot, log);

  const data = await strategy.collectSessionData({ treeRoot, startUrl, log });
  await persistProcessedSessionData(treeRoot, data, log);
}
