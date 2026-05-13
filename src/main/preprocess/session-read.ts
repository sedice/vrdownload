import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { sessionMainHtmlName } from "./fs-utils.js";

export async function readTitleFromSessionMainHtml(
  treeRoot: string,
  startUrl: string,
): Promise<string> {
  const mainName = sessionMainHtmlName(startUrl);
  const mainPath = join(treeRoot, mainName);
  if (!existsSync(mainPath)) return "";
  const html = await readFile(mainPath, "utf8");
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return (m?.[1] ?? "").trim().replace(/\s+/g, " ");
}

function escapeHtmlTextContent(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const RE_TITLE_BLOCK = /<title[^>]*>[\s\S]*?<\/title>/i;

/**
 * 将会话根目录下主入口 HTML（与 sessionMainHtmlName 一致）的 title 标签更新为给定文案。
 */
export async function writeTitleToSessionMainHtml(
  treeRoot: string,
  startUrl: string,
  title: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const mainName = sessionMainHtmlName(startUrl);
  const mainPath = join(treeRoot, mainName);
  if (!existsSync(mainPath)) {
    return { ok: false, reason: `未找到主页面文件 ${mainName}` };
  }
  let html = await readFile(mainPath, "utf8");
  const inner = escapeHtmlTextContent(title);
  const replacement = `<title>${inner}</title>`;
  if (html.match(RE_TITLE_BLOCK)) {
    html = html.replace(RE_TITLE_BLOCK, replacement);
  } else if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (open) => `${open}${replacement}`);
  } else {
    return { ok: false, reason: "页面中无 <title> 且无 <head>，无法写入标题" };
  }
  await writeFile(mainPath, html, "utf8");
  return { ok: true };
}
