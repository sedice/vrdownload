import { readFile } from "node:fs/promises";
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
