import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { existsSync } from "node:fs";
import type { LogFn } from "../cdp-capture.js";
import type { ProcessedSessionData } from "./types.js";
import { resolveExistingSessionRoot } from "./tree-root.js";

export function resolveSettingsPath(treeRoot: string): string {
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

export async function readSettingsObject(
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

function normalizeThumbList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0);
}

function normalizeTagList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const next = typeof raw === "string" ? raw.trim() : "";
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
  }
  return out;
}

/**
 * 将策略产出的统一结构合并写入 settings.json（保留已有 tags 等，除非策略显式覆盖）。
 */
export async function persistProcessedSessionData(
  treeRoot: string,
  data: ProcessedSessionData,
  log: LogFn,
): Promise<void> {
  const settingPath = resolveSettingsPath(treeRoot);
  const obj = await readSettingsObject(settingPath, log);

  const prevTags = normalizeTagList(obj["tags"]);
  const thumbs = data.thumbJpgList;

  if (data.title.trim()) {
    obj.title = data.title.trim();
  }
  obj.thumbJpgList = thumbs;

  if (data.tags.length > 0) {
    obj.tags = data.tags;
  } else if (prevTags.length > 0) {
    obj.tags = prevTags;
  }

  let cover: string | null =
    typeof obj.cover === "string" && obj.cover.trim().length > 0
      ? obj.cover.trim()
      : null;

  if (data.cover && thumbs.includes(data.cover)) {
    cover = data.cover;
  } else if (cover && !thumbs.includes(cover)) {
    cover = thumbs[0] ?? null;
  } else if (!cover && thumbs.length > 0) {
    cover = thumbs[0]!;
  }

  if (cover) obj.cover = cover;
  else if ("cover" in obj) obj.cover = null;

  await writeFile(
    settingPath,
    `${JSON.stringify(obj, null, 2)}\n`,
    "utf8",
  );
  log(
    `[预处理] 已写入 ${relative(treeRoot, settingPath).replaceAll("\\", "/")}（title / thumbJpgList / cover）`,
  );
}
