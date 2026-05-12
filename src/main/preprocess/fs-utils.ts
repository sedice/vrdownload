import { readdir, rmdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { sessionFolderFromStartUrl } from "../url-to-file.js";

/** 与采集时一致的会话主 HTML 文件名（根目录目标）。 */
export function sessionMainHtmlName(startUrl: string): string {
  const key = sessionFolderFromStartUrl(startUrl);
  return key.toLowerCase().endsWith(".html") ? key : `${key}.html`;
}

export async function collectFilesUnder(
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

export async function pruneEmptyDirsUnder(root: string, dir: string): Promise<void> {
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
