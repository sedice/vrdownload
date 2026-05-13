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
const uploadZipBtn = $<HTMLButtonElement>('uploadZip')
const uploadServerUrlInput = $<HTMLInputElement>('uploadServerUrl')
const clearLogBtn = $<HTMLButtonElement>('clearLog')
const statusEl = getOptional<HTMLSpanElement>('status')
const settingsModalEl = $<HTMLDivElement>('settingsModal')
const settingsTitleInputEl = $<HTMLInputElement>('settingsTitleInput')
const settingsTagInputEl = $<HTMLInputElement>('settingsTagInput')
const settingsAddTagBtn = $<HTMLButtonElement>('settingsAddTag')
const settingsTagListEl = $<HTMLDivElement>('settingsTagList')
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
  tags: string[]
} | null = null
let draggingTagIndex: number | null = null

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
      uploadZipBtn.disabled = !outDirInput.value.trim()
      break
    case 'capturing':
      if (statusEl) statusEl.textContent = '采集中…'
      startBtn.disabled = true
      startBtn.textContent = '采集中…'
      stopBtn.disabled = false
      preprocessBtn.textContent = '预处理'
      preprocessBtn.disabled = true
      uploadZipBtn.disabled = true
      break
    case 'processing':
      if (statusEl) statusEl.textContent = '处理中…'
      startBtn.disabled = true
      stopBtn.disabled = true
      preprocessBtn.disabled = true
      preprocessBtn.textContent = '处理中…'
      uploadZipBtn.disabled = true
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

function normalizeTag(value: string): string {
  return value.trim()
}

function renderTagList(tags: string[]): void {
  settingsTagListEl.innerHTML = ''
  if (tags.length === 0) {
    settingsTagListEl.innerHTML = '<span class="tag-empty">暂无标签</span>'
    return
  }
  tags.forEach((tag, idx) => {
    const chip = document.createElement('span')
    chip.className = 'tag-chip'
    chip.draggable = true
    chip.dataset.tagIndex = String(idx)
    chip.innerHTML = `<span>${tag.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</span><button type="button" data-tag-remove="${idx}" aria-label="删除标签">×</button>`
    settingsTagListEl.appendChild(chip)
  })
}

function openSettingsModal(
  data: {
    title: string
    selectedCover: string | null
    thumbs: Array<{ path: string; fileUrl: string }>
    tags: string[]
  },
  ctx: { url: string; outDir: string }
): void {
  settingsEditorContext = {
    ...ctx,
    thumbs: data.thumbs.map((x) => x.path),
    selectedCover: data.selectedCover,
    tags: [...data.tags]
  }
  settingsTitleInputEl.value = data.title
  settingsTagInputEl.value = ''
  renderCoverGrid(data.thumbs, data.selectedCover)
  renderTagList(data.tags)
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
  if (prefs.uploadServerUrl) {
    uploadServerUrlInput.value = prefs.uploadServerUrl
    appendLog(`已恢复上传服务器: ${prefs.uploadServerUrl}`, 'success')
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
      uploadZipBtn.disabled = false
    }
  }
})

uploadServerUrlInput.addEventListener('change', async () => {
  const value = uploadServerUrlInput.value.trim()
  await window.appApi.setUploadServerUrl(value)
  appendLog(`已保存上传服务器地址: ${value || '(空)'}`, 'info')
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

uploadZipBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim()
  const outDir = outDirInput.value.trim()
  const serverUrl = uploadServerUrlInput.value.trim()
  if (!outDir) {
    appendLog('请先选择保存目录。', 'warn')
    return
  }
  if (!url) {
    appendLog('请填写 URL（需与采集时一致，用于定位会话子目录）。', 'warn')
    return
  }
  if (!serverUrl) {
    appendLog('请填写上传服务器地址。', 'warn')
    return
  }
  setState('processing')
  try {
    const r = await window.appApi.uploadProcessedZip(url, outDir, serverUrl)
    if (!r.ok) {
      appendLog(`上传失败: ${r.error}`, 'error')
      return
    }
    appendLog('打包并上传成功。', 'success')
  } catch (err) {
    appendLog(`上传异常: ${String(err)}`, 'error')
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

settingsAddTagBtn.addEventListener('click', () => {
  if (!settingsEditorContext) return
  const next = normalizeTag(settingsTagInputEl.value)
  if (!next) return
  if (settingsEditorContext.tags.includes(next)) {
    appendLog(`标签已存在: ${next}`, 'warn')
    return
  }
  settingsEditorContext.tags.push(next)
  settingsTagInputEl.value = ''
  renderTagList(settingsEditorContext.tags)
  settingsTagInputEl.focus()
})

settingsTagInputEl.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return
  ev.preventDefault()
  settingsAddTagBtn.click()
})

settingsTagListEl.addEventListener('click', (ev) => {
  const target = ev.target as HTMLElement
  const idxRaw = target.getAttribute('data-tag-remove')
  if (idxRaw == null || !settingsEditorContext) return
  const idx = Number(idxRaw)
  if (!Number.isInteger(idx) || idx < 0 || idx >= settingsEditorContext.tags.length) return
  settingsEditorContext.tags.splice(idx, 1)
  renderTagList(settingsEditorContext.tags)
})

settingsTagListEl.addEventListener('dragstart', (ev) => {
  const target = ev.target as HTMLElement
  const chip = target.closest('.tag-chip') as HTMLElement | null
  if (!chip || !settingsEditorContext) return
  const idx = Number(chip.dataset.tagIndex || '-1')
  if (!Number.isInteger(idx) || idx < 0) return
  draggingTagIndex = idx
  chip.classList.add('dragging')
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move'
    ev.dataTransfer.setData('text/plain', String(idx))
  }
})

settingsTagListEl.addEventListener('dragover', (ev) => {
  if (draggingTagIndex == null) return
  ev.preventDefault()
  const target = ev.target as HTMLElement
  const chip = target.closest('.tag-chip') as HTMLElement | null
  settingsTagListEl.querySelectorAll('.tag-chip').forEach((el) => el.classList.remove('drop-target'))
  if (chip) chip.classList.add('drop-target')
})

settingsTagListEl.addEventListener('dragend', () => {
  draggingTagIndex = null
  settingsTagListEl.querySelectorAll('.tag-chip').forEach((el) => el.classList.remove('dragging', 'drop-target'))
})

settingsTagListEl.addEventListener('drop', (ev) => {
  if (!settingsEditorContext || draggingTagIndex == null) return
  ev.preventDefault()
  const target = ev.target as HTMLElement
  const chip = target.closest('.tag-chip') as HTMLElement | null
  let toIdx = settingsEditorContext.tags.length - 1
  if (chip) {
    const idx = Number(chip.dataset.tagIndex || '-1')
    if (Number.isInteger(idx) && idx >= 0) {
      toIdx = idx
    }
  }
  const fromIdx = draggingTagIndex
  draggingTagIndex = null
  if (fromIdx === toIdx || fromIdx < 0 || fromIdx >= settingsEditorContext.tags.length) {
    renderTagList(settingsEditorContext.tags)
    return
  }
  const moved = settingsEditorContext.tags.splice(fromIdx, 1)[0]
  settingsEditorContext.tags.splice(toIdx, 0, moved)
  renderTagList(settingsEditorContext.tags)
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
      ctx.selectedCover,
      ctx.tags
    )
    if (!r.ok) {
      appendLog(`保存 settings 失败: ${r.error}`, 'error')
      return
    }
    appendLog('settings 与主页面标题已保存。', 'success')
    if (r.warning) {
      appendLog(r.warning, 'warn')
    }
    closeSettingsModal()
  } catch (err) {
    appendLog(`保存 settings 异常: ${String(err)}`, 'error')
  } finally {
    settingsSaveBtn.disabled = false
    settingsSaveBtn.textContent = '保存设置'
  }
})
