import {
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { existsSync } from "node:fs";
import { replaceInFile } from "replace-in-file";
import type { LogFn } from "./cdp-capture.js";
import { sessionFolderFromStartUrl } from "./url-to-file.js";

const NEST_VIEW = join("vr.justeasy.cn", "view");

/** 仅处理该镜像前缀下的 static chunks（磁盘 + 文本）。 */
const RES1_VR_NEXT_STATIC_CHUNKS_APP =
  "res1.justeasy.cn/vr_justeasy/_next/static/chunks/app";

const RES1_POLYFILL_MARKER = "var FROM='https://res1'";

const GLOBAL_STYLE = `
[class^="AuthorInfo"],
[class^="WaterInfo"],
[class^="Basic_rightBottom"] {
  display: none !important;
}
`;

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
      if (typeof input==='string')return _fetch.call(this,mapRes1Url(input),init);
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
function resolvePreprocessTreeRoot(
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

/** 与采集时一致的会话主 HTML 文件名（根目录目标）。 */
function sessionMainHtmlName(startUrl: string): string {
  const key = sessionFolderFromStartUrl(startUrl);
  return key.toLowerCase().endsWith(".html") ? key : `${key}.html`;
}

function sourceMainHtmlNameCandidates(startUrl: string, destMainName: string): string[] {
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
    const picked = viewIdx >= 0 && parts[viewIdx + 1]
      ? parts[viewIdx + 1]!
      : parts[parts.length - 1];
    if (picked) {
      const withExt = picked.toLowerCase().endsWith(".html")
        || picked.toLowerCase().endsWith(".htm")
        ? picked
        : `${picked}.html`;
      names.add(withExt);
    }
  } catch {
    // ignore URL parse error
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

async function collectFilesUnder(
  base: string,
  dir: string,
  out: Array<{ abs: string; rel: string }>,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isFile()) {
      out.push({ abs, rel: relative(base, abs) });
    } else if (e.isDirectory()) {
      await collectFilesUnder(base, abs, out);
    }
  }
}

async function pruneEmptyDirsUnder(root: string, dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    await pruneEmptyDirsUnder(root, join(dir, e.name));
  }
  if (dir === root) return;
  const left = await readdir(dir);
  if (left.length === 0) {
    await rmdir(dir);
  }
}

/**
 * 将 res1…/ _next/static/chunks/app 下子目录中的 .js 移到该 app 根。
 */
async function flattenOneRes1NextChunksApp(
  appDir: string,
  log: LogFn,
): Promise<number> {
  const files: Array<{ abs: string; rel: string }> = [];
  await collectFilesUnder(appDir, appDir, files);
  let moved = 0;
  files.sort((a, b) => {
    const da = a.rel.split(/[/\\]/).filter(Boolean).length;
    const db = b.rel.split(/[/\\]/).filter(Boolean).length;
    return db - da;
  });
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

/**
 * 仅匹配 app 下仍有多级路径：至少一段「子路径/」再跟 xx.js（扁平的 app/xx.js 不匹配）。
 * 中间与文件名禁止含 "，避免跨过属性结束符和下一个 script；.js 后须紧跟合法结束符，防止吞到后面 /chunks/2eb0….js。
 */
const RE_RELATIVE_STATIC_CHUNKS_APP_JS =
  /static\/chunks\/app\/((?:[^/"]+\/)+)([^/"]+\.js)(?=["'\\\s>),;\]]|$)/g;

/**
 * 整树文本：https→./；仅将 static/chunks/app/子路径/xx.js 收成 static/chunks/app/xx.js。
 */
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

/**
 * 在会话主 HTML 的 <head> 开头注入 res1 URL polyfill（须最先执行）。
 */
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
  const wrapped = `<script>\n${RES1_POLYFILL_BODY}\n</script><style>${GLOBAL_STYLE}</style>`;
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
  if (fileAbs !== rootAbs && !fileAbs.startsWith(`${rootAbs}\\`) && !fileAbs.startsWith(`${rootAbs}/`)) {
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
 * 从会话主 HTML 提取 <title> 并写入会话根目录 setting.json。
 */
export async function writeMainHtmlTitleToSettingJson(
  treeRoot: string,
  startUrl: string,
  log: LogFn,
): Promise<void> {
  const mainName = sessionMainHtmlName(startUrl);
  const mainPath = join(treeRoot, mainName);
  if (!existsSync(mainPath)) {
    log(`[预处理] 未找到主 HTML，跳过写入 setting.json: ${mainPath}`);
    return;
  }
  const html = await readFile(mainPath, "utf8");
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (m?.[1] ?? "").trim().replace(/\s+/g, " ");
  if (!title) {
    log(
      `[预处理] 主 HTML 未找到有效 <title>，跳过写入 setting.json: ${mainName}`,
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

function resolveSettingsPath(treeRoot: string): string {
  const settingsPath = join(treeRoot, "settings.json");
  const settingPath = join(treeRoot, "setting.json");
  if (existsSync(settingsPath)) return settingsPath;
  if (existsSync(settingPath)) return settingPath;
  return settingsPath;
}

export function resolveSettingsPathForSession(
  outDir: string,
  startUrl: string,
): string | null {
  const treeRoot = resolveExistingSessionRoot(outDir, startUrl);
  if (!treeRoot) return null;
  return resolveSettingsPath(treeRoot);
}

async function readSettingsObject(
  path: string,
  log: LogFn,
): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    log(`[预处理] settings 文件非法 JSON，将覆盖重建: ${path}`);
  }
  return {};
}

/**
 * 仅提取 vrpic.justeasy.cn/thumb 下的 thumb.jpg 列表并写入 settings。
 */
export async function writeThumbJpgListToSettings(
  treeRoot: string,
  log: LogFn,
): Promise<void> {
  const thumbRoot = join(treeRoot, "vrpic.justeasy.cn", "thumb");
  const settingPath = resolveSettingsPath(treeRoot);
  const settingObj = await readSettingsObject(settingPath, log);
  if (!existsSync(thumbRoot)) {
    settingObj.thumbJpgList = [];
    await writeFile(
      settingPath,
      `${JSON.stringify(settingObj, null, 2)}\n`,
      "utf8",
    );
    log(`[预处理] 未找到目录 vrpic.justeasy.cn/thumb，已写入空 thumbJpgList`);
    return;
  }

  const files: Array<{ abs: string; rel: string }> = [];
  await collectFilesUnder(thumbRoot, thumbRoot, files);
  const list = files
    .map(({ rel }) => rel.replaceAll("\\", "/"))
    .filter(
      (rel) =>
        rel.toLowerCase().endsWith("/thumb.jpg") ||
        rel.toLowerCase() === "thumb.jpg",
    )
    .sort()
    .map((rel) => `vrpic.justeasy.cn/thumb/${rel}`);

  settingObj.thumbJpgList = list;
  await writeFile(
    settingPath,
    `${JSON.stringify(settingObj, null, 2)}\n`,
    "utf8",
  );
  log(`[预处理] 已写入 thumbJpgList，共 ${list.length} 个`);
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
  await moveViewHtmlToSessionRoot(treeRoot, startUrl, log);
  await flattenAllRes1NextStaticChunksAppInTree(treeRoot, log);
  await rewriteMirrorTextInTree(treeRoot, log);
  await injectRes1PolyfillIntoMainHtml(treeRoot, startUrl, log);
  await writeMainHtmlTitleToSettingJson(treeRoot, startUrl, log);
  await writeThumbJpgListToSettings(treeRoot, log);
  await injectBackHomeIntoHtmlInTree(treeRoot, log);
  await replaceMissingMp3RefsInHtmlInTree(treeRoot, log);
}
