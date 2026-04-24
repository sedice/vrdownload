import './style.css'

declare global {
  interface Window {
    appApi: import('../preload/index.js').AppApi
  }
}

const $ = (id: string) => document.getElementById(id) as HTMLElement

const logEl = $('log') as HTMLPreElement
const urlInput = $('url') as HTMLInputElement
const outDirInput = $('outDir') as HTMLInputElement
const pickBtn = $('pick') as HTMLButtonElement
const startBtn = $('start') as HTMLButtonElement
const stopBtn = $('stop') as HTMLButtonElement
const preprocessBtn = $('preprocess') as HTMLButtonElement

function appendLog(line: string): void {
  const t = new Date()
  const ts = t.toTimeString().split(' ')[0] ?? ''
  logEl.textContent += `[${ts}] ${line}\n`
  logEl.scrollTop = logEl.scrollHeight
}

window.appApi.onLog(appendLog)

pickBtn.addEventListener('click', async () => {
  const p = await window.appApi.selectOutputDir()
  if (p) {
    outDirInput.value = p
    appendLog(`已选择目录: ${p}`)
  }
})

startBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim()
  const outDir = outDirInput.value.trim()
  if (!outDir) {
    appendLog('请先选择输出目录。')
    return
  }
  if (!url) {
    appendLog('请填写 URL。')
    return
  }
  startBtn.disabled = true
  try {
    const r = await window.appApi.startCapture(url, outDir)
    if (!r.ok) {
      appendLog(`启动失败: ${r.error}`)
    } else {
      appendLog('已启动。')
    }
  } finally {
    startBtn.disabled = false
  }
})

stopBtn.addEventListener('click', async () => {
  await window.appApi.stopCapture()
})

preprocessBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim()
  const outDir = outDirInput.value.trim()
  if (!outDir) {
    appendLog('请先选择保存目录。')
    return
  }
  if (!url) {
    appendLog('请填写 URL（需与采集时一致，用于定位会话子目录）。')
    return
  }
  preprocessBtn.disabled = true
  try {
    const r = await window.appApi.runPreprocess(url, outDir)
    if (!r.ok) {
      appendLog(`预处理失败: ${r.error}`)
    }
  } finally {
    preprocessBtn.disabled = false
  }
})
