import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { existsSync } from "node:fs";
import { replaceInFile } from "replace-in-file";
import type { LogFn } from "../cdp-capture.js";
import { collectFilesUnder } from "./fs-utils.js";

const BACK_HOME_MARKER = "data-download-vr-back-home";
const BACK_HOME_STYLE = `
  a.__download_vr_back_home {
    position: fixed;
    top: 12px;
    left: 12px;
    z-index: 2147483647;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border-radius: 999px;
    background: rgba(15, 23, 42, 0.72);
    color: #ffffff !important;
    text-decoration: none !important;
    font: 600 13px/1 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }
  a.__download_vr_back_home:hover {
    background: rgba(15, 23, 42, 0.86);
  }
  a.__download_vr_back_home:active {
    transform: scale(0.98);
  }
`;

async function injectBackHomeIntoOneHtml(htmlPath: string): Promise<boolean> {
  if (!existsSync(htmlPath)) return false;
  let html = await readFile(htmlPath, "utf8");
  if (html.includes(BACK_HOME_MARKER)) return false;

  const styleTag = `<style ${BACK_HOME_MARKER}>${BACK_HOME_STYLE}</style>`;
  const headCloseRe = /<\/head>/i;
  if (headCloseRe.test(html)) {
    html = html.replace(headCloseRe, (close) => `${styleTag}${close}`);
  } else {
    html = `${styleTag}\n${html}`;
  }

  const btn = `<a ${BACK_HOME_MARKER} class="__download_vr_back_home" href="/" title="返回首页">返回首页</a>`;
  const bodyOpenRe = /<body(\s[^>]*)?>/i;
  if (bodyOpenRe.test(html)) {
    html = html.replace(bodyOpenRe, (open) => `${open}${btn}`);
  } else {
    html = `${btn}\n${html}`;
  }

  await writeFile(htmlPath, html, "utf8");
  return true;
}

export async function injectBackHomeIntoHtmlInTree(
  treeRoot: string,
  log: LogFn,
): Promise<number> {
  const files: Array<{ abs: string; rel: string }> = [];
  await collectFilesUnder(treeRoot, treeRoot, files);
  const htmlFiles = files
    .map((f) => f.abs)
    .filter(
      (p) =>
        p.toLowerCase().endsWith(".html") || p.toLowerCase().endsWith(".htm"),
    );

  let touched = 0;
  for (const p of htmlFiles) {
    try {
      if (await injectBackHomeIntoOneHtml(p)) touched++;
    } catch {
      // ignore single file
    }
  }
  log(`[预处理] 已为页面注入返回首页按钮，共 ${touched} 个 HTML 文件`);
  return touched;
}

const MP3_REF_RE =
  /(?:https?:\/\/|\/\/|\.{0,2}\/|[a-z0-9_])[^\s"'<>\\]*?\.mp3(?:\?[^"'\s<>\\]*)?/gi;

function sanitizeAssetRef(ref: string): string {
  return ref.split("#")[0]!.split("?")[0]!;
}

function toLocalAssetPath(
  treeRoot: string,
  htmlPath: string,
  ref: string,
): string | null {
  const cleanRef = sanitizeAssetRef(ref.trim());
  if (!cleanRef || cleanRef === "/default.mp3") return null;

  let candidate: string;
  if (cleanRef.startsWith("http://") || cleanRef.startsWith("https://")) {
    let u: URL;
    try {
      u = new URL(cleanRef);
    } catch {
      return null;
    }
    candidate = join(treeRoot, u.hostname, ...u.pathname.split("/").filter(Boolean));
  } else if (cleanRef.startsWith("//")) {
    const noProto = cleanRef.slice(2);
    const slash = noProto.indexOf("/");
    const host = slash >= 0 ? noProto.slice(0, slash) : noProto;
    const p = slash >= 0 ? noProto.slice(slash) : "/";
    candidate = join(treeRoot, host, ...p.split("/").filter(Boolean));
  } else if (cleanRef.startsWith("/")) {
    candidate = join(treeRoot, ...cleanRef.slice(1).split("/").filter(Boolean));
  } else {
    candidate = join(dirname(htmlPath), ...cleanRef.split("/").filter(Boolean));
  }

  const rootAbs = resolve(treeRoot);
  const fileAbs = resolve(candidate);
  if (
    fileAbs !== rootAbs &&
    !fileAbs.startsWith(`${rootAbs}\\`) &&
    !fileAbs.startsWith(`${rootAbs}/`)
  ) {
    return null;
  }
  return fileAbs;
}

async function replaceMissingMp3InOneHtml(
  htmlPath: string,
  treeRoot: string,
): Promise<{ changed: boolean; replaced: number }> {
  let html = await readFile(htmlPath, "utf8");
  const matches = Array.from(html.matchAll(MP3_REF_RE));
  if (matches.length === 0) return { changed: false, replaced: 0 };

  let replaced = 0;
  let offset = 0;
  for (const m of matches) {
    const raw = m[0];
    const idx = m.index ?? -1;
    if (idx < 0) continue;
    const localPath = toLocalAssetPath(treeRoot, htmlPath, raw);
    if (!localPath) continue;
    if (!existsSync(localPath)) {
      const start = idx + offset;
      const end = start + raw.length;
      html = `${html.slice(0, start)}/default.mp3${html.slice(end)}`;
      offset += "/default.mp3".length - raw.length;
      replaced++;
    }
  }
  if (replaced > 0) {
    await writeFile(htmlPath, html, "utf8");
    return { changed: true, replaced };
  }
  return { changed: false, replaced: 0 };
}

export async function replaceMissingMp3RefsInHtmlInTree(
  treeRoot: string,
  log: LogFn,
): Promise<number> {
  const files: Array<{ abs: string; rel: string }> = [];
  await collectFilesUnder(treeRoot, treeRoot, files);
  const htmlFiles = files
    .map((f) => f.abs)
    .filter(
      (p) =>
        p.toLowerCase().endsWith(".html") || p.toLowerCase().endsWith(".htm"),
    );

  let touched = 0;
  let replaced = 0;
  for (const p of htmlFiles) {
    try {
      const res = await replaceMissingMp3InOneHtml(p, treeRoot);
      if (res.changed) touched++;
      replaced += res.replaced;
    } catch {
      // ignore single file
    }
  }
  log(`[预处理] 已替换缺失 MP3 引用 ${replaced} 处，涉及 ${touched} 个 HTML 文件`);
  return replaced;
}

/**
 * 会话镜像根下全树：将字面量 `https://` 替换为 `./`（离线相对引用），与建 E 策略内镜像改写一致。
 * 在平台专属步骤之前执行，作为预处理第一步。
 */
export async function rewriteHttpsToDotSlashInTree(
  treeRoot: string,
  log: LogFn,
): Promise<number> {
  const filesGlob = join(treeRoot, "**", "*");
  const results = await replaceInFile({
    files: filesGlob,
    allowEmptyPaths: true,
    glob: { dot: true, windowsPathsNoEscape: true },
    from: /https:\/\//g,
    to: "./",
  });
  const touched = results.filter((r) => r.hasChanged).length;
  log(`[预处理] 第一步：全树 https:// → ./ ，共 ${touched} 个文件`);
  return touched;
}
