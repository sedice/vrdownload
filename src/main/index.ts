import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import { attachCdpAndSave } from './cdp-capture.js'
import { runPreprocess } from './preprocess.js'
import { sessionFolderFromStartUrl } from './url-to-file.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const isDev = !app.isPackaged

function resolvePreloadPath(): string {
  const base = join(__dirname, '../preload')
  // 优先 CJS 的 index.js；勿优先 index.mjs（旧构建残留会导致 preload 以非 module 方式执行 ESM 而失败）
  for (const name of ['index.js', 'index.cjs', 'index.mjs']) {
    const p = join(base, name)
    if (existsSync(p)) return p
  }
  return join(base, 'index.js')
}

let controlWindow: BrowserWindow | null = null
let captureWindow: BrowserWindow | null = null
let detachCdp: (() => Promise<void>) | null = null

function createControlWindow(): void {
  controlWindow = new BrowserWindow({
    width: 720,
    height: 640,
    webPreferences: {
      preload: resolvePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  const devUrl = process.env['ELECTRON_RENDERER_URL'] || process.env['VITE_DEV_SERVER_URL']
  if (isDev && devUrl) {
    void controlWindow.loadURL(devUrl)
  } else {
    void controlWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  controlWindow.on('closed', () => {
    controlWindow = null
  })
}

function sendLog(line: string): void {
  controlWindow?.webContents.send('capture:log', line)
}

app.whenReady().then(() => {
  createControlWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createControlWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

async function closeCaptureAndDetach(): Promise<void> {
  if (detachCdp) {
    try {
      await detachCdp()
    } catch {
      // ignore
    }
    detachCdp = null
  }
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.close()
  }
  captureWindow = null
}

ipcMain.handle('dialog:selectOutput', async () => {
  const parent = controlWindow ?? undefined
  const r = await dialog.showOpenDialog(parent, {
    title: '选择保存目录',
    properties: ['openDirectory', 'createDirectory']
  })
  if (r.canceled || r.filePaths.length === 0) return null
  return r.filePaths[0]!
})

ipcMain.handle('capture:stop', async () => {
  await closeCaptureAndDetach()
  sendLog('已停止采集。')
  return { ok: true as const }
})

ipcMain.handle('capture:start', async (_e, args: { url: string; outDir: string }) => {
  const { url, outDir } = args
  if (!url?.trim() || !outDir?.trim()) {
    return { ok: false as const, error: '请填写 URL 并选择输出目录' }
  }
  let target: URL
  try {
    target = new URL(url.trim())
  } catch {
    return { ok: false as const, error: 'URL 不合法' }
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { ok: false as const, error: '仅支持 http(s) 协议' }
  }

  await closeCaptureAndDetach()

  const sessionName = sessionFolderFromStartUrl(target.href)
  const sessionDir = join(outDir, sessionName)

  if (existsSync(sessionDir)) {
    sendLog(`正在清空本次保存目录（开始采集前）: ${sessionDir}`)
    try {
      await rm(sessionDir, { recursive: true, force: true })
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      return { ok: false as const, error: `无法清空目录: ${m}` }
    }
  }

  try {
    await mkdir(sessionDir, { recursive: true })
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    return { ok: false as const, error: `无法创建/访问目录: ${m}` }
  }

  sendLog(`本次保存子目录: ${sessionName}（完整路径: ${sessionDir}）`)
  sendLog('正在准备采集窗口…')

  captureWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const wc: WebContents = captureWindow.webContents
  const log = (line: string) => {
    sendLog(line)
  }

  // 新窗口在尚未加载过文档时调用 debugger.attach 可能永远不返回；先 about:blank 再 CDP
  try {
    await wc.loadURL('about:blank')
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    sendLog(`about:blank 失败: ${m}`)
    captureWindow.close()
    captureWindow = null
    return { ok: false as const, error: m }
  }

  sendLog('正在附加 CDP…')
  try {
    detachCdp = await attachCdpAndSave(wc, sessionDir, log)
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    sendLog(`CDP 附加失败: ${m}`)
    captureWindow.close()
    captureWindow = null
    return { ok: false as const, error: m }
  }

  let targetLoadStarted = false
  wc.on('did-fail-load', (_ev, code, desc, _u, isMainFrame) => {
    if (isMainFrame && targetLoadStarted) {
      sendLog(`主框架加载错误 ${code}: ${desc || ''}`.trim())
    }
  })
  wc.on('did-finish-load', () => {
    if (targetLoadStarted) {
      sendLog('主文档加载完成（子资源可能仍在进行）。可关闭目标窗口或点「停止 / 结束 CDP」结束。')
    }
  })

  captureWindow.on('closed', async () => {
    if (detachCdp) {
      try {
        await detachCdp()
      } catch {
        // ignore
      }
      detachCdp = null
    }
    captureWindow = null
  })

  sendLog(`开始加载: ${target.href}`)
  targetLoadStarted = true
  try {
    await captureWindow.loadURL(target.href)
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    sendLog(`loadURL: ${m}`)
    await closeCaptureAndDetach()
    return { ok: false as const, error: m }
  }

  return { ok: true as const }
})

ipcMain.handle('preprocess:run', async (_e, args: { url: string; outDir: string }) => {
  const { url, outDir } = args
  if (!url?.trim() || !outDir?.trim()) {
    return { ok: false as const, error: '请填写 URL 并选择保存目录' }
  }
  let target: URL
  try {
    target = new URL(url.trim())
  } catch {
    return { ok: false as const, error: 'URL 不合法' }
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { ok: false as const, error: '仅支持 http(s) 协议' }
  }

  sendLog('—— 预处理开始 ——')
  try {
    await runPreprocess(outDir.trim(), target.href, sendLog)
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    sendLog(`[预处理] 失败: ${m}`)
    return { ok: false as const, error: m }
  }
  sendLog('—— 预处理结束 ——')
  return { ok: true as const }
})
