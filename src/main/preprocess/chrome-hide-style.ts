import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { LogFn } from "../cdp-capture.js";

/** 与主 HTML 内 style 节点对应，避免重复注入 */
export const MIRROR_HIDE_CHROME_MARKER = "data-download-vr-mirror-hide-chrome";

/** 离线镜像中隐藏作者/水印/右下等 UI（建 E、3d66 等共用） */
export const MIRROR_HIDE_CHROME_STYLE = `
[class^="AuthorInfo"],
[class^="WaterInfo"],
[class^="Basic_rightBottom"] {
  display: none !important;
}

.right-bottom.clearfix {
  display: none !important;
}

.js-vr-name,
.icon-view-count,
.js-user-name {
  display: none !important;
}
`;

/**
 * 在主 HTML 的 `<head>` 开头注入隐藏用内联样式（无则插入；已有 marker 则跳过）。
 */
export async function injectMirrorHideChromeStyleIntoHead(
  mainHtmlPath: string,
  log: LogFn,
  logPrefix = "[预处理]",
): Promise<void> {
  if (!existsSync(mainHtmlPath)) {
    log(`${logPrefix} 未找到主 HTML，跳过镜像隐藏样式: ${mainHtmlPath}`);
    return;
  }
  let html = await readFile(mainHtmlPath, "utf8");
  if (html.includes(MIRROR_HIDE_CHROME_MARKER)) {
    log(`${logPrefix} 主 HTML 已含镜像隐藏样式，跳过`);
    return;
  }
  const tag = `<style ${MIRROR_HIDE_CHROME_MARKER}>${MIRROR_HIDE_CHROME_STYLE}</style>`;
  const headRe = /<head(\s[^>]*)?>/i;
  if (headRe.test(html)) {
    html = html.replace(headRe, (open) => `${open}${tag}`);
  } else {
    log(`${logPrefix} 未找到 <head>，镜像隐藏样式置于文档最前`);
    html = tag + html;
  }
  await writeFile(mainHtmlPath, html, "utf8");
  log(`${logPrefix} 已注入镜像隐藏样式（<head>）`);
}
