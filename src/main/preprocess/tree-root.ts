import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LogFn } from "../cdp-capture.js";
import { sessionFolderFromStartUrl } from "../url-to-file.js";

function sessionRootCandidates(outDir: string, startUrl: string): string[] {
  const key = sessionFolderFromStartUrl(startUrl);
  const a = join(outDir, key);
  const b = join(outDir, `${key}.html`);
  if (a === b) return [a];
  return [a, b];
}

export function resolveExistingSessionRoot(
  outDir: string,
  startUrl: string,
): string | null {
  for (const p of sessionRootCandidates(outDir, startUrl)) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 预处理实际扫描的根：优先「保存目录/会话名」；若无（旧版扁平落盘到保存根下），则用整个保存目录。
 */
export function resolvePreprocessTreeRoot(
  outDir: string,
  startUrl: string,
  log: LogFn,
): string | null {
  const session = resolveExistingSessionRoot(outDir, startUrl);
  if (session) {
    log(`[预处理] 工作目录: ${session}`);
    return session;
  }
  if (existsSync(outDir)) {
    const key = sessionFolderFromStartUrl(startUrl);
    log(
      `[预处理] 未找到子文件夹「${key}」，按扁平目录在整个保存目录下处理: ${outDir}`,
    );
    return outDir;
  }
  return null;
}
