import { readdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { existsSync } from "node:fs";
import type { LogFn } from "../cdp-capture.js";
import { urlToRelativePath } from "../url-to-file.js";
import type {
  IPreprocessStrategy,
  PreprocessContext,
  ProcessedSessionData,
} from "./types.js";
import { collectFilesUnder, sessionMainHtmlName } from "./fs-utils.js";
import { readTitleFromSessionMainHtml } from "./session-read.js";
import { injectMirrorHideChromeStyleIntoHead } from "./chrome-hide-style.js";

function expectedAspAbsPath(treeRoot: string, startUrl: string): string {
  const rel = urlToRelativePath(startUrl, "text/html", new Set());
  return join(treeRoot, ...rel.split("/").filter(Boolean));
}

async function findIndexDetailAspUnder(treeRoot: string): Promise<string | null> {
  const files: Array<{ abs: string; rel: string }> = [];
  await collectFilesUnder(treeRoot, treeRoot, files);
  const re = /^index_detail_\d+\.asp$/i;
  const hits = files
    .filter((f) => re.test(basename(f.abs)))
    .map((f) => f.abs);
  hits.sort((a, b) => a.length - b.length);
  return hits[0] ?? null;
}

async function rewriteXmlDotSlashForTourFiles(
  xmlAbsPaths: string[],
  log: LogFn,
): Promise<number> {
  let n = 0;
  // for (const p of xmlAbsPaths) {
  //   if (!existsSync(p)) continue;
  //   if (!p.toLowerCase().endsWith(".xml")) continue;
  //   let text = await readFile(p, "utf8");
  //   if (!text.includes("./")) continue;
  //   const next = text.replaceAll("./", "/");
  //   await writeFile(p, next, "utf8");
  //   n++;
  //   log(`[预处理][3d66] 已改写 XML 内 ./ → / : ${basename(p)}`);
  // }
  return n;
}

/** 将旧预处理落在 vr/ 下的 tour xml 迁到会话根（与主 HTML 同级） */
async function moveLegacyVrFolderXmlToSessionRoot(
  treeRoot: string,
  xmlTargets: string[],
  log: LogFn,
): Promise<void> {
  const legacyVr = join(treeRoot, "vr");
  if (!existsSync(legacyVr)) return;
  const ent = await readdir(legacyVr, { withFileTypes: true });
  for (const e of ent) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".xml")) continue;
    const from = join(legacyVr, e.name);
    const to = join(treeRoot, e.name);
    if (from === to) continue;
    if (existsSync(to)) {
      await unlink(to);
    }
    await rename(from, to);
    xmlTargets.push(to);
    log(`[预处理][3d66] 已从 vr/ 迁入会话根: ${e.name}`);
  }
  try {
    const left = await readdir(legacyVr);
    if (left.length === 0) {
      await rmdir(legacyVr);
      log("[预处理][3d66] 已删除空目录 vr/");
    }
  } catch {
    // ignore
  }
}

async function stripDocumentDomain3d66FromStaticIndexJs(
  treeRoot: string,
  log: LogFn,
): Promise<void> {
  const p = join(treeRoot, "static.3d66.com", "index.js");
  if (!existsSync(p)) {
    log("[预处理][3d66] 未找到 static.3d66.com/index.js，跳过移除 document.domain");
    return;
  }
  let t = await readFile(p, "utf8");
  const before = t;
  t = t.replace(/document\.domain\s*=\s*["']3d66\.com["']\s*;?/g, "");
  t = t.replace(/^\s*\/\/\s*$/gm, "");
  if (t !== before) {
    await writeFile(p, t, "utf8");
    log("[预处理][3d66] 已从 static.3d66.com/index.js 移除 document.domain = \"3d66.com\"");
  }
}

const RE_STATIC_3D66_COMBO_HREF =
  /href=(['"])((?:\.\/|https:\/\/)static\.3d66\.com\/\?\?[^'"]*)\1/g;
const RE_STATIC_3D66_COMBO_SCRIPT_SRC =
  /src=(['"])((?:\.\/|https:\/\/)static\.3d66\.com\/\?\?[^'"]*)\1/g;

async function rewriteStatic3d66ComboInMainHtml(
  mainHtmlPath: string,
  log: LogFn,
): Promise<void> {
  if (!existsSync(mainHtmlPath)) return;
  let html = await readFile(mainHtmlPath, "utf8");
  const before = html;
  html = html.replace(RE_STATIC_3D66_COMBO_HREF, "href=$1./static.3d66.com/index.css$1");
  html = html.replace(
    RE_STATIC_3D66_COMBO_SCRIPT_SRC,
    "src=$1./static.3d66.com/index.js$1",
  );
  html = html.replaceAll('"/vr/work_index_tour_"', '"./work_index_tour_"');
  html = html.replaceAll('"/vr/index_tour_"', '"./index_tour_"');
  html = html.replaceAll('"./vr/work_index_tour_"', '"./work_index_tour_"');
  html = html.replaceAll('"./vr/index_tour_"', '"./index_tour_"');
  if (html !== before) {
    await writeFile(mainHtmlPath, html, "utf8");
    log(
      "[预处理][3d66] 已替换 static.3d66.com/?? 合并请求：link→./static.3d66.com/index.css，script→./static.3d66.com/index.js",
    );
  }
}

async function runVr3d66DetailTransforms(ctx: PreprocessContext): Promise<void> {
  const { treeRoot, startUrl, log } = ctx;
  await stripDocumentDomain3d66FromStaticIndexJs(treeRoot, log);

  const destMain = sessionMainHtmlName(startUrl);
  const destAbs = join(treeRoot, destMain);

  let aspAbs = expectedAspAbsPath(treeRoot, startUrl);
  if (!existsSync(aspAbs)) {
    const found = await findIndexDetailAspUnder(treeRoot);
    if (found) {
      log(`[预处理][3d66] 按 URL 未命中文件，改用扫描: ${relative(treeRoot, found).replaceAll("\\", "/")}`);
      aspAbs = found;
    }
  }

  if (!existsSync(aspAbs)) {
    log("[预处理][3d66] 未找到 index_detail_*.asp，跳过站点步骤");
    return;
  }

  const aspDir = dirname(aspAbs);
  const aspDirRel = relative(treeRoot, aspDir).replaceAll("\\", "/");
  const xmlAbsList: string[] = [];
  const allowXmlFromDir =
    aspDirRel === "vr.3d66.com" || aspDirRel.startsWith("vr.3d66.com/");
  if (allowXmlFromDir && existsSync(aspDir)) {
    const dirEnt = await readdir(aspDir, { withFileTypes: true });
    for (const e of dirEnt) {
      if (!e.isFile()) continue;
      if (!e.name.toLowerCase().endsWith(".xml")) continue;
      const abs = join(aspDir, e.name);
      if (abs !== aspAbs) xmlAbsList.push(abs);
    }
  } else if (!allowXmlFromDir) {
    log(
      `[预处理][3d66] asp 所在目录非 vr.3d66.com 镜像路径（${aspDirRel}），跳过同目录 XML 归集`,
    );
  }

  // 1. 入口 asp → 会话根目录 / {会话文件夹名}.html
  if (aspAbs !== destAbs) {
    if (existsSync(destAbs)) {
      await unlink(destAbs);
    }
    await rename(aspAbs, destAbs);
    log(
      `[预处理][3d66] 入口页已移至根目录: ${relative(treeRoot, aspAbs).replaceAll("\\", "/")} → ${destMain}`,
    );
  } else {
    log(`[预处理][3d66] 入口页已在目标位置: ${destMain}`);
  }

  // 2. 同目录 XML → 会话根目录（与主 HTML 同级，便于 ./index_tour_*.xml）
  const xmlTargets: string[] = [];
  for (const xml of xmlAbsList) {
    const name = basename(xml);
    const target = join(treeRoot, name);
    if (xml === target) {
      xmlTargets.push(target);
      continue;
    }
    if (existsSync(target)) {
      await unlink(target);
    }
    await rename(xml, target);
    xmlTargets.push(target);
    log(
      `[预处理][3d66] XML 已移至会话根: ${relative(treeRoot, xml).replaceAll("\\", "/")} → ${name}`,
    );
  }

  await moveLegacyVrFolderXmlToSessionRoot(treeRoot, xmlTargets, log);

  // 3. 会话根下 tour XML 内 ./ → /
  await rewriteXmlDotSlashForTourFiles([...new Set(xmlTargets)], log);

  // 4. 主 HTML：combo ?? 外链 → 单 css / 单 js（正则匹配任意后缀）
  await rewriteStatic3d66ComboInMainHtml(destAbs, log);

  // 5. 与建 E 一致：注入隐藏作者/水印等 UI 的内联样式
  await injectMirrorHideChromeStyleIntoHead(destAbs, log, "[预处理][3d66]");
}

async function collectVr3d66ThumbRelPaths(treeRoot: string): Promise<string[]> {
  const thumbRoot = join(treeRoot, "vrimg.3d66.com", "vr", "thumb");
  if (!existsSync(thumbRoot)) return [];
  const files: Array<{ abs: string; rel: string }> = [];
  await collectFilesUnder(thumbRoot, thumbRoot, files);
  const list = files
    .map(({ rel }) => rel.replaceAll("\\", "/"))
    .filter((rel) => {
      const lower = rel.toLowerCase();
      return lower.endsWith("/thumb.jpg") || lower === "thumb.jpg";
    })
    .sort()
    .map((rel) => `vrimg.3d66.com/vr/thumb/${rel}`);
  return list;
}

async function collectVr3d66DetailSessionData(
  ctx: PreprocessContext,
): Promise<ProcessedSessionData> {
  const title = await readTitleFromSessionMainHtml(ctx.treeRoot, ctx.startUrl);
  if (!title) {
    ctx.log(
      `[预处理][3d66] 主 HTML 未找到有效 <title>: ${sessionMainHtmlName(ctx.startUrl)}`,
    );
  }
  const thumbJpgList = await collectVr3d66ThumbRelPaths(ctx.treeRoot);
  if (thumbJpgList.length > 0) {
    ctx.log(`[预处理][3d66] 已发现封面缩略图 thumb.jpg 共 ${thumbJpgList.length} 个`);
  } else {
    ctx.log(
      "[预处理][3d66] 未在 vrimg.3d66.com/vr/thumb 下找到 thumb.jpg（可先完成采集）",
    );
  }
  const cover = thumbJpgList[0] ?? null;
  return {
    title,
    thumbJpgList,
    cover,
    tags: [],
  };
}

export const vr3d66DetailStrategy: IPreprocessStrategy = {
  platformId: "vr-3d66-detail-asp",
  runPlatformTransforms: runVr3d66DetailTransforms,
  collectSessionData: collectVr3d66DetailSessionData,
};
