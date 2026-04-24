import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
  type WebContents,
} from "electron";
import { attachCdpAndSave } from "./cdp-capture.js";
import {
  resolveExistingSessionRoot,
  resolveSettingsPathForSession,
  runPreprocess,
} from "./preprocess.js";
import { sessionFolderFromStartUrl } from "./url-to-file.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isDev = !app.isPackaged;

function resolvePreloadPath(): string {
  const base = join(__dirname, "../preload");
  // 优先 CJS 的 index.js；勿优先 index.mjs（旧构建残留会导致 preload 以非 module 方式执行 ESM 而失败）
  for (const name of ["index.js", "index.cjs", "index.mjs"]) {
    const p = join(base, name);
    if (existsSync(p)) return p;
  }
  return join(base, "index.js");
}

let controlWindow: BrowserWindow | null = null;
let captureWindow: BrowserWindow | null = null;
let detachCdp: (() => Promise<void>) | null = null;
const prefPath = join(app.getPath("userData"), "prefs.json");

type AppPrefs = {
  lastOutDir?: string;
};

async function readPrefs(): Promise<AppPrefs> {
  try {
    const raw = await readFile(prefPath, "utf8");
    const parsed = JSON.parse(raw) as AppPrefs;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

async function writePrefs(nextPrefs: AppPrefs): Promise<void> {
  await writeFile(prefPath, JSON.stringify(nextPrefs, null, 2), "utf8");
}

function createControlWindow(): void {
  controlWindow = new BrowserWindow({
    width: 700,
    height: 800,
    webPreferences: {
      preload: resolvePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const devUrl =
    process.env["ELECTRON_RENDERER_URL"] || process.env["VITE_DEV_SERVER_URL"];
  if (isDev && devUrl) {
    void controlWindow.loadURL(devUrl);
  } else {
    void controlWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
  controlWindow.on("closed", () => {
    controlWindow = null;
  });
}

function sendLog(line: string): void {
  controlWindow?.webContents.send("capture:log", line);
}

type SettingsEditorData = {
  title: string;
  selectedCover: string | null;
  thumbs: Array<{ path: string; fileUrl: string }>;
};

function normalizeThumbList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0);
}

async function readThumbAsDataUrl(absPath: string): Promise<string | null> {
  try {
    const raw = await readFile(absPath);
    return `data:image/jpeg;base64,${raw.toString("base64")}`;
  } catch {
    return null;
  }
}

app.whenReady().then(() => {
  createControlWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createControlWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

async function closeCaptureAndDetach(): Promise<void> {
  if (detachCdp) {
    try {
      await detachCdp();
    } catch {
      // ignore
    }
    detachCdp = null;
  }
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.close();
  }
  captureWindow = null;
}

ipcMain.handle("dialog:selectOutput", async () => {
  const options: OpenDialogOptions = {
    title: "选择保存目录",
    properties: ["openDirectory", "createDirectory"],
  };
  const r = controlWindow
    ? await dialog.showOpenDialog(controlWindow, options)
    : await dialog.showOpenDialog(options);
  if (r.canceled || r.filePaths.length === 0) return null;
  const selected = r.filePaths[0]!;
  const prefs = await readPrefs();
  await writePrefs({ ...prefs, lastOutDir: selected });
  return selected;
});

ipcMain.handle("prefs:get", async () => {
  const prefs = await readPrefs();
  return {
    lastOutDir: typeof prefs.lastOutDir === "string" ? prefs.lastOutDir : "",
  };
});

ipcMain.handle("capture:stop", async () => {
  await closeCaptureAndDetach();
  sendLog("已停止采集。");
  return { ok: true as const };
});

ipcMain.handle(
  "capture:start",
  async (_e, args: { url: string; outDir: string }) => {
    const { url, outDir } = args;
    if (!url?.trim() || !outDir?.trim()) {
      return { ok: false as const, error: "请填写 URL 并选择输出目录" };
    }
    let target: URL;
    try {
      target = new URL(url.trim());
    } catch {
      return { ok: false as const, error: "URL 不合法" };
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return { ok: false as const, error: "仅支持 http(s) 协议" };
    }

    await closeCaptureAndDetach();

    const sessionName = sessionFolderFromStartUrl(target.href);
    const sessionDir = join(outDir, sessionName);

    if (existsSync(sessionDir)) {
      sendLog(`正在清空本次保存目录（开始采集前）: ${sessionDir}`);
      try {
        await rm(sessionDir, { recursive: true, force: true });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        return { ok: false as const, error: `无法清空目录: ${m}` };
      }
    }

    try {
      await mkdir(sessionDir, { recursive: true });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: `无法创建/访问目录: ${m}` };
    }

    sendLog(`本次保存子目录: ${sessionName}（完整路径: ${sessionDir}）`);
    sendLog("正在准备采集窗口…");

    captureWindow = new BrowserWindow({
      width: 1024,
      height: 768,
      show: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const wc: WebContents = captureWindow.webContents;
    const log = (line: string) => {
      sendLog(line);
    };

    // 新窗口在尚未加载过文档时调用 debugger.attach 可能永远不返回；先 about:blank 再 CDP
    try {
      await wc.loadURL("about:blank");
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      sendLog(`about:blank 失败: ${m}`);
      captureWindow.close();
      captureWindow = null;
      return { ok: false as const, error: m };
    }

    sendLog("正在附加 CDP…");
    try {
      detachCdp = await attachCdpAndSave(wc, sessionDir, log);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      sendLog(`CDP 附加失败: ${m}`);
      captureWindow.close();
      captureWindow = null;
      return { ok: false as const, error: m };
    }

    let targetLoadStarted = false;
    wc.on("did-fail-load", (_ev, code, desc, _u, isMainFrame) => {
      if (isMainFrame && targetLoadStarted) {
        sendLog(`主框架加载错误 ${code}: ${desc || ""}`.trim());
      }
    });
    wc.on("did-finish-load", () => {
      if (targetLoadStarted) {
        sendLog(
          "主文档加载完成（子资源可能仍在进行）。可关闭目标窗口或点「停止 / 结束 CDP」结束。",
        );
      }
    });

    captureWindow.on("closed", async () => {
      if (detachCdp) {
        try {
          await detachCdp();
        } catch {
          // ignore
        }
        detachCdp = null;
      }
      captureWindow = null;
    });

    sendLog(`开始加载: ${target.href}`);
    targetLoadStarted = true;
    try {
      await captureWindow.loadURL(target.href);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      sendLog(`loadURL: ${m}`);
      await closeCaptureAndDetach();
      return { ok: false as const, error: m };
    }

    return { ok: true as const };
  },
);

ipcMain.handle(
  "preprocess:run",
  async (_e, args: { url: string; outDir: string }) => {
    const { url, outDir } = args;
    if (!url?.trim() || !outDir?.trim()) {
      return { ok: false as const, error: "请填写 URL 并选择保存目录" };
    }
    let target: URL;
    try {
      target = new URL(url.trim());
    } catch {
      return { ok: false as const, error: "URL 不合法" };
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return { ok: false as const, error: "仅支持 http(s) 协议" };
    }

    sendLog("—— 预处理开始 ——");
    try {
      await runPreprocess(outDir.trim(), target.href, sendLog);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      sendLog(`[预处理] 失败: ${m}`);
      return { ok: false as const, error: m };
    }
    sendLog("—— 预处理结束 ——");
    return { ok: true as const };
  },
);

ipcMain.handle(
  "settings:get",
  async (_e, args: { url: string; outDir: string }) => {
    const { url, outDir } = args;
    if (!url?.trim() || !outDir?.trim()) {
      return { ok: false as const, error: "请填写 URL 并选择保存目录" };
    }
    let target: URL;
    try {
      target = new URL(url.trim());
    } catch {
      return { ok: false as const, error: "URL 不合法" };
    }
    const out = outDir.trim();
    const settingsPath = resolveSettingsPathForSession(out, target.href);
    const sessionRoot = resolveExistingSessionRoot(out, target.href);
    if (!settingsPath) {
      return { ok: false as const, error: "未找到对应会话目录，请先完成采集和预处理" };
    }
    if (!sessionRoot) {
      return { ok: false as const, error: "未找到对应会话目录，请先完成采集和预处理" };
    }
    try {
      const raw = existsSync(settingsPath) ? await readFile(settingsPath, "utf8") : "{}";
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false as const, error: "settings 内容格式无效（应为 JSON 对象）" };
      }
      const obj = parsed as Record<string, unknown>;
      const title = typeof obj.title === "string" ? obj.title : "";
      const thumbs = normalizeThumbList(obj.thumbJpgList);
      const coverValue = typeof obj.cover === "string" ? obj.cover.trim() : "";
      const selectedCover = thumbs.includes(coverValue) ? coverValue : (thumbs[0] ?? null);
      const thumbItems = await Promise.all(
        thumbs.map(async (p) => {
          const absPath = join(sessionRoot, ...p.split("/"));
          const dataUrl = await readThumbAsDataUrl(absPath);
          return {
            path: p,
            fileUrl: dataUrl ?? "",
          };
        }),
      );
      const data: SettingsEditorData = {
        title,
        selectedCover,
        thumbs: thumbItems,
      };
      return { ok: true as const, data };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: `读取 settings 失败: ${m}` };
    }
  },
);

ipcMain.handle(
  "settings:save",
  async (_e, args: { url: string; outDir: string; title: string; selectedCover: string | null }) => {
    const { url, outDir, title, selectedCover } = args;
    if (!url?.trim() || !outDir?.trim()) {
      return { ok: false as const, error: "请填写 URL 并选择保存目录" };
    }
    let target: URL;
    try {
      target = new URL(url.trim());
    } catch {
      return { ok: false as const, error: "URL 不合法" };
    }
    const settingsPath = resolveSettingsPathForSession(outDir.trim(), target.href);
    if (!settingsPath) {
      return { ok: false as const, error: "未找到对应会话目录，请先完成采集和预处理" };
    }
    try {
      const raw = existsSync(settingsPath) ? await readFile(settingsPath, "utf8") : "{}";
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false as const, error: "settings 内容格式无效（应为 JSON 对象）" };
      }
      const obj = parsed as Record<string, unknown>;
      const thumbList = normalizeThumbList(obj.thumbJpgList);
      const nextCover =
        typeof selectedCover === "string" && selectedCover.trim().length > 0
          ? selectedCover.trim()
          : null;
      if (nextCover && thumbList.includes(nextCover)) {
        obj.thumbJpgList = [nextCover, ...thumbList.filter((p) => p !== nextCover)];
        obj.cover = nextCover;
      } else if (thumbList.length > 0) {
        obj.cover = thumbList[0];
      } else {
        obj.cover = null;
      }
      obj.title = title.trim();
      await writeFile(settingsPath, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
      return { ok: true as const };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: `保存 settings 失败: ${m}` };
    }
  },
);
