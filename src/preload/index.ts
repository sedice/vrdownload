import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

type StartResult = { ok: true } | { ok: false; error: string }
type SettingsEditorData = {
  title: string
  selectedCover: string | null
  thumbs: Array<{ path: string; fileUrl: string }>
}
type GetSettingsResult = { ok: true; data: SettingsEditorData } | { ok: false; error: string }

const api = {
  selectOutputDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectOutput'),
  getPrefs: (): Promise<{ lastOutDir: string }> => ipcRenderer.invoke('prefs:get'),
  startCapture: (url: string, outDir: string): Promise<StartResult> =>
    ipcRenderer.invoke('capture:start', { url, outDir }),
  runPreprocess: (url: string, outDir: string): Promise<StartResult> =>
    ipcRenderer.invoke('preprocess:run', { url, outDir }),
  getSettings: (url: string, outDir: string): Promise<GetSettingsResult> =>
    ipcRenderer.invoke('settings:get', { url, outDir }),
  saveSettings: (
    url: string,
    outDir: string,
    title: string,
    selectedCover: string | null
  ): Promise<StartResult> => ipcRenderer.invoke('settings:save', { url, outDir, title, selectedCover }),
  stopCapture: (): Promise<{ ok: true }> => ipcRenderer.invoke('capture:stop'),
  onLog: (cb: (line: string) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, line: string) => {
      cb(line)
    }
    ipcRenderer.on('capture:log', handler)
    return () => {
      ipcRenderer.removeListener('capture:log', handler)
    }
  }
} as const

contextBridge.exposeInMainWorld('appApi', api)

export type AppApi = typeof api
