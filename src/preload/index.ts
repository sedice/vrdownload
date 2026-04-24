import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

type StartResult = { ok: true } | { ok: false; error: string }

const api = {
  selectOutputDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectOutput'),
  startCapture: (url: string, outDir: string): Promise<StartResult> =>
    ipcRenderer.invoke('capture:start', { url, outDir }),
  runPreprocess: (url: string, outDir: string): Promise<StartResult> =>
    ipcRenderer.invoke('preprocess:run', { url, outDir }),
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
