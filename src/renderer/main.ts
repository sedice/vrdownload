import './style.css'

declare global {
  interface Window {
    appApi: import('../preload/index.js').AppApi
  }
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing element: #${id}`)
  return el as T
}

const getOptional = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null

// ── DOM refs ──

const logEl = $<HTMLPreElement>('log')
const urlInput = $<HTMLInputElement>('url')
const outDirInput = $<HTMLInputElement>('outDir')
const pickBtn = $<HTMLButtonElement>('pick')
const startBtn = $<HTMLButtonElement>('start')
const stopBtn = $<HTMLButtonElement>('stop')
const preprocessBtn = $<HTMLButtonElement>('preprocess')
const clearLogBtn = $<HTMLButtonElement>('clearLog')
const statusEl = getOptional<HTMLSpanElement>('status')
const settingsModalEl = $<HTMLDivElement>('settingsModal')
const settingsTitleInputEl = $<HTMLInputElement>('settingsTitleInput')
const coverGridEl = $<HTMLDivElement>('coverGrid')
const settingsSaveBtn = $<HTMLButtonElement>('settingsSave')
const settingsCancelBtn = $<HTMLButtonElement>('settingsCancel')

// ── State ──

type AppState = 'idle' | 'capturing' | 'processing'

let state: AppState = 'idle'
let settingsEditorContext: {
  url: string
  outDir: string
  thumbs: string[]
  selectedCover: string | null
} | null = null

function setState(next: AppState): void {
  state = next
  if (statusEl) {
    statusEl.className = `status status-${next}`
  }

  switch (next) {
    case 'idle':
      if (statusEl) statusEl.textContent = '就绪'
      startBtn.disabled = false
      startBtn.textContent = '开始采集'
      stopBtn.disabled = true
      preprocessBtn.textContent = '预处理'
      preprocessBtn.disabled = !outDirInput.value.trim()
      break
    case 'capturing':
      if (statusEl) statusEl.textContent = '采集中…'
      startBtn.disabled = true
      startBtn.textContent = '采集中…'
      stopBtn.disabled = false
      preprocessBtn.textContent = '预处理'
      preprocessBtn.disabled = true
      break
    case 'processing':
      if (statusEl) statusEl.textContent = '处理中…'
      startBtn.disabled = true
      stopBtn.disabled = true
      preprocessBtn.disabled = true
      preprocessBtn.textContent = '处理中…'
      break
  }
}

// ── Logging ──

type LogLevel = 'info' | 'success' | 'warn' | 'error'

function appendLog(line: string, level: LogLevel = 'info'): void {
  const t = new Date()
  const ts = t.toTimeString().split(' ')[0] ?? ''
  const span = `<span class="log-${level}">[${ts}] ${line}</span>`
  logEl.innerHTML += `${span}\n`
  logEl.scrollTop = logEl.scrollHeight
}

function clearLog(): void {
  logEl.innerHTML = ''
}

function renderCoverGrid(thumbs: Array<{ path: string; fileUrl: string }>, selected: string | null): void {
  coverGridEl.innerHTML = ''
  if (thumbs.length === 0) {
    coverGridEl.innerHTML = '<div class="cover-empty-tip">未找到可用缩略图</div>'
    return
  }
  thumbs.forEach((item) => {
    const selectedCls = item.path === selected ? ' is-selected' : ''
    const card = document.createElement('button')
    card.type = 'button'
    card.className = `cover-card${selectedCls}`
    card.dataset.coverPath = item.path
    card.innerHTML = `
      <img src="${item.fileUrl}" alt="封面候选" />
    `
    card.addEventListener('click', () => {
      if (!settingsEditorContext) return
      settingsEditorContext.selectedCover = item.path
      renderCoverGrid(thumbs, item.path)
    })
    coverGridEl.appendChild(card)
  })
}

function openSettingsModal(
  data: {
    title: string
    selectedCover: string | null
    thumbs: Array<{ path: string; fileUrl: string }>
  },
  ctx: { url: string; outDir: string }
): void {
  settingsEditorContext = {
    ...ctx,
    thumbs: data.thumbs.map((x) => x.path),
    selectedCover: data.selectedCover
  }
  settingsTitleInputEl.value = data.title
  renderCoverGrid(data.thumbs, data.selectedCover)
  settingsModalEl.classList.remove('hidden')
  settingsTitleInputEl.focus()
}

function closeSettingsModal(): void {
  settingsModalEl.classList.add('hidden')
  settingsEditorContext = null
}

// ── IPC log relay ──

window.appApi.onLog((line) => {
  // Auto-detect error/warning from log content
  const lower = line.toLowerCase()
  const level: LogLevel =
    lower.includes('失败') || lower.includes('错误') || lower.includes('error') || lower.includes('fail')
      ? 'error'
      : lower.includes('警告') || lower.includes('warn')
        ? 'warn'
        : lower.includes('成功') || lower.includes('完成') || lower.includes('已') || lower.includes('ok')
          ? 'success'
          : 'info'
  appendLog(line, level)
})

// ── Init ──

void (async () => {
  const prefs = await window.appApi.getPrefs()
  if (prefs.lastOutDir) {
    outDirInput.value = prefs.lastOutDir
    appendLog(`已恢复上次目录: ${prefs.lastOutDir}`, 'success')
  }
  setState('idle')
})()

// ── Pick directory ──

pickBtn.addEventListener('click', async () => {
  const p = await window.appApi.selectOutputDir()
  if (p) {
    outDirInput.value = p
    appendLog(`已选择目录: ${p}`, 'success')
    if (state === 'idle') {
      preprocessBtn.disabled = false
    }
  }
})

// ── Start capture ──

startBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim()
  const outDir = outDirInput.value.trim()
  if (!outDir) {
    appendLog('请先选择输出目录。', 'warn')
    return
  }
  if (!url) {
    appendLog('请填写 URL。', 'warn')
    return
  }
  setState('capturing')
  try {
    const r = await window.appApi.startCapture(url, outDir)
    if (!r.ok) {
      appendLog(`启动失败: ${r.error}`, 'error')
      setState('idle')
    } else {
      appendLog('已启动采集，等待资源下载…', 'success')
    }
  } catch (err) {
    appendLog(`启动异常: ${String(err)}`, 'error')
    setState('idle')
  }
})

// ── Stop capture ──

stopBtn.addEventListener('click', async () => {
  await window.appApi.stopCapture()
  setState('idle')
})

// ── Preprocess ──

preprocessBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim()
  const outDir = outDirInput.value.trim()
  if (!outDir) {
    appendLog('请先选择保存目录。', 'warn')
    return
  }
  if (!url) {
    appendLog('请填写 URL（需与采集时一致，用于定位会话子目录）。', 'warn')
    return
  }
  setState('processing')
  try {
    const r = await window.appApi.runPreprocess(url, outDir)
    if (!r.ok) {
      appendLog(`预处理失败: ${r.error}`, 'error')
      return
    }
    const settingsRes = await window.appApi.getSettings(url, outDir)
    if (!settingsRes.ok) {
      appendLog(`读取 settings 失败: ${settingsRes.error}`, 'warn')
      return
    }
    openSettingsModal(settingsRes.data, { url, outDir })
    appendLog('预处理完成，已打开 settings 编辑窗口。', 'success')
  } catch (err) {
    appendLog(`预处理异常: ${String(err)}`, 'error')
  } finally {
    setState('idle')
  }
})

// ── Clear log ──

clearLogBtn.addEventListener('click', () => {
  clearLog()
})

settingsCancelBtn.addEventListener('click', () => {
  closeSettingsModal()
})

settingsModalEl.addEventListener('click', (ev) => {
  const target = ev.target as HTMLElement
  if (target.dataset.closeModal === 'true') {
    closeSettingsModal()
  }
})

settingsSaveBtn.addEventListener('click', async () => {
  const ctx = settingsEditorContext
  if (!ctx) return
  settingsSaveBtn.disabled = true
  settingsSaveBtn.textContent = '保存中…'
  try {
    const r = await window.appApi.saveSettings(
      ctx.url,
      ctx.outDir,
      settingsTitleInputEl.value,
      ctx.selectedCover
    )
    if (!r.ok) {
      appendLog(`保存 settings 失败: ${r.error}`, 'error')
      return
    }
    appendLog('settings 已保存。', 'success')
    closeSettingsModal()
  } catch (err) {
    appendLog(`保存 settings 异常: ${String(err)}`, 'error')
  } finally {
    settingsSaveBtn.disabled = false
    settingsSaveBtn.textContent = '保存设置'
  }
})
