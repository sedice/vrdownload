import {
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { existsSync } from "node:fs";
import { replaceInFile } from "replace-in-file";
import { isVrJusteasyStartUrl } from "../url-to-file.js";
import type { LogFn } from "../cdp-capture.js";
import type { IPreprocessStrategy, PreprocessContext, ProcessedSessionData } from "./types.js";
import { collectFilesUnder, pruneEmptyDirsUnder, sessionMainHtmlName } from "./fs-utils.js";
import { readTitleFromSessionMainHtml } from "./session-read.js";
import { readSettingsObject, resolveSettingsPath } from "./settings-io.js";
import {
  MIRROR_HIDE_CHROME_MARKER,
  MIRROR_HIDE_CHROME_STYLE,
} from "./chrome-hide-style.js";

const NEST_VIEW = join("vr.justeasy.cn", "view");

/** 仅处理该镜像前缀下的 static chunks（磁盘 + 文本）。 */
const RES1_VR_NEXT_STATIC_CHUNKS_APP =
  "res1.justeasy.cn/vr_justeasy/_next/static/chunks/app";

const RES1_POLYFILL_MARKER = "var FROM='https://res1'";

/** 须置于 <head> 最前，在其余 script 之前执行。 */
const RES1_POLYFILL_BODY = `(function(){
  var FROM='https://res1';
  var TO='./res1';
  function mapRes1Url(s){
    if (typeof s!=='string'||s.length<FROM.length)return s;
    return s.indexOf(FROM)===0?TO+s.slice(FROM.length):s;
  }
  if (typeof fetch!=='undefined'){
    var _fetch=fetch;
    window.fetch=function(input,init){
      if (typeof input==='string')return _fetch.call(this,mapRes1Url(input));
      if (input instanceof Request){
        var u=mapRes1Url(input.url);
        if (u!==input.url)input=new Request(u,input);
      }
      return _fetch.call(this,input,init);
    };
  }
  var _open=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(){
    var a=[].slice.call(arguments);
    if (a[1]!=null)a[1]=mapRes1Url(String(a[1]));
    return _open.apply(this,a);
  };
  var _set=Element.prototype.setAttribute;
  Element.prototype.setAttribute=function(name,value){
    if (value!=null&&(name==='src'||name==='href'||name==='xlink:href'))
      value=mapRes1Url(String(value));
    return _set.call(this,name,value);
  };
})();`;

function sourceMainHtmlNameCandidates(
  startUrl: string,
  destMainName: string,
): string[] {
  const names = new Set<string>([destMainName]);
  try {
    const u = new URL(startUrl);
    const parts = u.pathname
      .split("/")
      .map((p) => {
        try {
          return decodeURIComponent(p);
        } catch {
          return p;
        }
      })
      .filter(Boolean);
    const viewIdx = parts.findIndex((p) => p.toLowerCase() === "view");
    const picked =
      viewIdx >= 0 && parts[viewIdx + 1]
        ? parts[viewIdx + 1]!
        : parts[parts.length - 1];
    if (picked) {
      const withExt =
        picked.toLowerCase().endsWith(".html") ||
        picked.toLowerCase().endsWith(".htm")
          ? picked
          : `${picked}.html`;
      names.add(withExt);
    }
  } catch {
    // ignore
  }
  return Array.from(names);
}

/**
 * 将 vr.justeasy.cn/view 下与会话同名的 html 移到会话目录根。
 */
export async function moveViewHtmlToSessionRoot(
  sessionRoot: string,
  startUrl: string,
  log: LogFn,
): Promise<void> {
  if (!isVrJusteasyStartUrl(startUrl)) {
    log(`[预处理] 非 https://vr.justeasy.cn 起始页，跳过 view 目录 HTML 移动`);
    return;
  }
  const destMainName = sessionMainHtmlName(startUrl);
  const viewDir = join(sessionRoot, NEST_VIEW);
  let src: string | null = null;
  for (const name of sourceMainHtmlNameCandidates(startUrl, destMainName)) {
    const p = join(viewDir, name);
    if (existsSync(p)) {
      src = p;
      break;
    }
  }
  if (!src && existsSync(viewDir)) {
    try {
      const entries = await readdir(viewDir, { withFileTypes: true });
      const htmlCandidates = entries
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .filter((name) => {
          const lower = name.toLowerCase();
          return lower.endsWith(".html") || lower.endsWith(".htm");
        });
      if (htmlCandidates.length === 1) {
        src = join(viewDir, htmlCandidates[0]!);
      }
    } catch {
      // ignore
    }
  }
  if (!src) {
    log(`[预处理] 未找到需移动的页面: ${viewDir}/*.html（跳过移动）`);
    return;
  }
  const dest = join(sessionRoot, destMainName);
  if (src === dest) {
    log(`[预处理] 页面已在根目录: ${destMainName}`);
    return;
  }
  if (existsSync(dest)) {
    await unlink(dest);
  }
  await rename(src, dest);
  log(
    `[预处理] 已移动: ${relative(sessionRoot, src).replaceAll("\\", "/")} → ${destMainName}`,
  );
}

function isRes1VrNextStaticChunksAppDir(relFromRoot: string): boolean {
  const r = relFromRoot.replaceAll("\\", "/");
  return (
    r === RES1_VR_NEXT_STATIC_CHUNKS_APP ||
    r.endsWith(`/${RES1_VR_NEXT_STATIC_CHUNKS_APP}`)
  );
}

async function findRes1NextStaticChunksAppDirs(
  current: string,
  treeRoot: string,
  found: Set<string>,
): Promise<void> {
  try {
    const entries = await readdir(current, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = join(current, e.name);
      const rel = relative(treeRoot, p);
      if (isRes1VrNextStaticChunksAppDir(rel)) {
        found.add(p);
      }
      await findRes1NextStaticChunksAppDirs(p, treeRoot, found);
    }
  } catch {
    /* ignore */
  }
}

async function flattenOneRes1NextChunksApp(
  appDir: string,
  log: LogFn,
): Promise<number> {
  const files: Array<{ abs: string; rel: string }> = [];
  await collectFilesUnder(appDir, appDir, files);
  files.sort((a, b) => {
    const da = a.rel.split(/[/\\]/).filter(Boolean).length;
    const db = b.rel.split(/[/\\]/).filter(Boolean).length;
    return db - da;
  });
  let moved = 0;
  for (const { abs, rel } of files) {
    const relPosix = rel.replaceAll("\\", "/");
    if (!relPosix.includes("/")) continue;
    const name = relPosix.slice(relPosix.lastIndexOf("/") + 1);
    if (!name || !name.endsWith(".js")) continue;
    const dest = join(appDir, name);
    if (abs === dest) continue;
    if (existsSync(dest)) {
      log(
        `[预处理] ${RES1_VR_NEXT_STATIC_CHUNKS_APP} 跳过（根下已有同名 .js）: ${name} ← ${relPosix}`,
      );
      continue;
    }
    await rename(abs, dest);
    moved++;
  }
  await pruneEmptyDirsUnder(appDir, appDir);
  if (moved > 0) {
    log(
      `[预处理] ${RES1_VR_NEXT_STATIC_CHUNKS_APP} 已上移 ${moved} 个 .js → ${appDir}`,
    );
  }
  return moved;
}

async function flattenAllRes1NextStaticChunksAppInTree(
  root: string,
  log: LogFn,
): Promise<void> {
  const found = new Set<string>();
  await findRes1NextStaticChunksAppDirs(root, root, found);
  for (const appDir of found) {
    await flattenOneRes1NextChunksApp(appDir, log);
  }
}

const RE_RELATIVE_STATIC_CHUNKS_APP_JS =
  /static\/chunks\/app\/((?:[^/"]+\/)+)([^/"]+\.js)(?=["'\\\s>),;\]]|$)/g;

export async function rewriteMirrorTextInTree(
  root: string,
  log: LogFn,
): Promise<number> {
  const filesGlob = join(root, "**", "*");
  const results = await replaceInFile({
    files: filesGlob,
    allowEmptyPaths: true,
    glob: { dot: true, windowsPathsNoEscape: true },
    from: [RE_RELATIVE_STATIC_CHUNKS_APP_JS, /https:\/\//g],
    to: ["static/chunks/app/$2", "./"],
  });
  const touched = results.filter((r) => r.hasChanged).length;
  log(
    `[预处理] 文本（https→./、static/chunks/app 子目录 js 扁平）共 ${touched} 个文件`,
  );
  return touched;
}

export async function injectRes1PolyfillIntoMainHtml(
  treeRoot: string,
  startUrl: string,
  log: LogFn,
): Promise<void> {
  const mainName = sessionMainHtmlName(startUrl);
  const mainPath = join(treeRoot, mainName);
  if (!existsSync(mainPath)) {
    log(`[预处理] 未找到主 HTML，跳过 polyfill: ${mainPath}`);
    return;
  }
  let html = await readFile(mainPath, "utf8");
  if (html.includes(RES1_POLYFILL_MARKER)) {
    log(`[预处理] 主 HTML 已含 res1 polyfill，跳过: ${mainName}`);
    return;
  }
  const wrapped = `<script>\n${RES1_POLYFILL_BODY}\n</script><style ${MIRROR_HIDE_CHROME_MARKER}>${MIRROR_HIDE_CHROME_STYLE}</style>`;
  const headRe = /<head(\s[^>]*)?>/i;
  if (headRe.test(html)) {
    html = html.replace(headRe, (open) => `${open}${wrapped}`);
  } else {
    log(`[预处理] 未找到 <head>，polyfill 置于文档最前: ${mainName}`);
    html = wrapped + html;
  }
  await writeFile(mainPath, html, "utf8");
  log(`[预处理] 已在 <head> 最前注入 res1 URL polyfill: ${mainName}`);
}

async function collectJusteasyThumbRelPaths(treeRoot: string): Promise<string[]> {
  const thumbRoot = join(treeRoot, "vrpic.justeasy.cn", "thumb");
  if (!existsSync(thumbRoot)) return [];
  const files: Array<{ abs: string; rel: string }> = [];
  await collectFilesUnder(thumbRoot, thumbRoot, files);
  return files
    .map(({ rel }) => rel.replaceAll("\\", "/"))
    .filter(
      (rel) =>
        rel.toLowerCase().endsWith("/thumb.jpg") ||
        rel.toLowerCase() === "thumb.jpg",
    )
    .sort()
    .map((rel) => `vrpic.justeasy.cn/thumb/${rel}`);
}

export async function writeThumbJpgListToSettings(
  treeRoot: string,
  log: LogFn,
): Promise<void> {
  const list = await collectJusteasyThumbRelPaths(treeRoot);
  const settingPath = resolveSettingsPath(treeRoot);
  const settingObj = await readSettingsObject(settingPath, log);
  if (!existsSync(join(treeRoot, "vrpic.justeasy.cn", "thumb"))) {
    settingObj.thumbJpgList = [];
    await writeFile(
      settingPath,
      `${JSON.stringify(settingObj, null, 2)}\n`,
      "utf8",
    );
    log(`[预处理] 未找到目录 vrpic.justeasy.cn/thumb，已写入空 thumbJpgList`);
    return;
  }
  settingObj.thumbJpgList = list;
  await writeFile(
    settingPath,
    `${JSON.stringify(settingObj, null, 2)}\n`,
    "utf8",
  );
  log(`[预处理] 已写入 thumbJpgList，共 ${list.length} 个`);
}

export async function writeMainHtmlTitleToSettingJson(
  treeRoot: string,
  startUrl: string,
  log: LogFn,
): Promise<void> {
  const title = await readTitleFromSessionMainHtml(treeRoot, startUrl);
  if (!title) {
    log(
      `[预处理] 主 HTML 未找到有效 <title>，跳过写入 setting.json: ${sessionMainHtmlName(startUrl)}`,
    );
    return;
  }
  const settingPath = resolveSettingsPath(treeRoot);
  const settingObj = await readSettingsObject(settingPath, log);
  settingObj.title = title;
  await writeFile(
    settingPath,
    `${JSON.stringify(settingObj, null, 2)}\n`,
    "utf8",
  );
  log(
    `[预处理] 已写入 ${relative(treeRoot, settingPath).replaceAll("\\", "/")} 标题: ${title}`,
  );
}

async function runVrJusteasyTransforms(ctx: PreprocessContext): Promise<void> {
  const { treeRoot, startUrl, log } = ctx;
  await moveViewHtmlToSessionRoot(treeRoot, startUrl, log);
  await flattenAllRes1NextStaticChunksAppInTree(treeRoot, log);
  await rewriteMirrorTextInTree(treeRoot, log);
  await injectRes1PolyfillIntoMainHtml(treeRoot, startUrl, log);
}

async function collectVrJusteasySessionData(
  ctx: PreprocessContext,
): Promise<ProcessedSessionData> {
  const { treeRoot, startUrl, log } = ctx;
  const title = await readTitleFromSessionMainHtml(treeRoot, startUrl);
  if (!title) {
    log(
      `[预处理] 主 HTML 未找到有效 <title>（仍将写入缩略图列表）: ${sessionMainHtmlName(startUrl)}`,
    );
  }
  const thumbJpgList = await collectJusteasyThumbRelPaths(treeRoot);
  const cover = thumbJpgList[0] ?? null;
  return { title, thumbJpgList, cover, tags: [] };
}

export const vrJusteasyStrategy: IPreprocessStrategy = {
  platformId: "vr-justeasy",
  runPlatformTransforms: runVrJusteasyTransforms,
  collectSessionData: collectVrJusteasySessionData,
};
