import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { type WebContents } from 'electron'
import { isApiLikeMime, isSkippableUrl, isStaticLikeMime } from './static-mime.js'
import { urlToRelativePath } from './url-to-file.js'

type Dbg = WebContents['debugger']

type Pending = {
  url: string
  mime: string
  staticCandidate: boolean
  resourceType?: string
}

export type LogFn = (line: string) => void

function isApiResourceType(rt: string | undefined): boolean {
  return rt === 'XHR' || rt === 'Fetch'
}

/**
 * 使用 CDP Network 获取与页面一致的响应体，并写入 outRoot。
 */
export async function attachCdpAndSave(
  webContents: WebContents,
  outRoot: string,
  log: LogFn
): Promise<() => Promise<void>> {
  const dbg: Dbg = webContents.debugger
  if (dbg.isAttached()) {
    await dbg.detach()
  }
  // 不指定协议版本，与当前 Chromium 一致；在「尚无文档的 webContents」上 attach 会挂起，请先在主流程里 load about:blank
  try {
    dbg.attach()
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    throw new Error(`CDP attach 失败: ${m}`)
  }
  const pending = new Map<string, Pending>()
  const savedUrl = new Set<string>()
  const seenRel = new Set<string>()

  const onMessage: Parameters<Dbg['on']>[1] = async (_e, method, params) => {
    if (method === 'Network.responseReceived') {
      const p = params as {
        requestId: string
        type?: string
        response: { url: string; mimeType?: string; status: number; fromServiceWorker?: boolean }
      }
      const { requestId, response, type: resourceType } = p
      const url = response?.url
      if (!url || response.status >= 400) return
      if (isSkippableUrl(url)) return

      const mime = response.mimeType || ''
      const rt = resourceType
      const isDoc = mime.includes('text/html') || rt === 'Document'
      const staticRt = ['Stylesheet', 'Script', 'Image', 'Font', 'Media'].some((x) => x === rt)
      const want =
        isDoc ||
        isStaticLikeMime(mime, url) ||
        staticRt ||
        isApiResourceType(rt) ||
        isApiLikeMime(mime, url)
      if (!want) return

      pending.set(requestId, {
        url,
        mime,
        staticCandidate: true,
        resourceType: rt
      })
    }

    if (method === 'Network.loadingFinished') {
      const p = params as { requestId: string; encodedDataLength: number }
      const { requestId } = p
      const meta = pending.get(requestId)
      pending.delete(requestId)
      if (!meta?.staticCandidate) return
      if (savedUrl.has(meta.url)) return
      const allowHtml = meta.mime.includes('html') || meta.resourceType === 'Document'
      const allowByMime = isStaticLikeMime(meta.mime, meta.url)
      const allowByRt = ['Stylesheet', 'Script', 'Image', 'Font', 'Media'].includes(
        meta.resourceType || ''
      )
      const allowApi = isApiResourceType(meta.resourceType) || isApiLikeMime(meta.mime, meta.url)
      if (!allowHtml && !allowByMime && !allowByRt && !allowApi) return

      const writeOnce = async (raw: Buffer, source: 'CDP' | '回退') => {
        if (savedUrl.has(meta.url)) return
        const rel = urlToRelativePath(meta.url, meta.mime, seenRel)
        const full = join(outRoot, ...rel.split('/').filter(Boolean))
        await mkdir(dirname(full), { recursive: true })
        await writeFile(full, raw)
        savedUrl.add(meta.url)
        log(`[${source}] 已保存 ${rel} (${raw.length} B)`)
      }

      try {
        const body = await dbg.sendCommand('Network.getResponseBody', { requestId })
        const raw =
          (body as { body: string; base64Encoded: boolean }).base64Encoded === true
            ? Buffer.from((body as { body: string }).body, 'base64')
            : Buffer.from((body as { body: string }).body, 'utf8')
        await writeOnce(raw, 'CDP')
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        log(`[CDP] getResponseBody 失败: ${meta.url} — ${errMsg}，尝试回退拉取…`)
        try {
          const buf = await fetchResourceFallback(webContents, meta.url, log)
          if (buf) {
            await writeOnce(buf, '回退')
          }
        } catch (e2) {
          const m = e2 instanceof Error ? e2.message : String(e2)
          log(`[回退] 仍失败: ${meta.url} — ${m}`)
        }
      }
    }
  }

  dbg.on('message', onMessage)
  await dbg.sendCommand('Network.enable')

  return async () => {
    dbg.removeListener('message', onMessage)
    if (dbg.isAttached()) {
      try {
        await dbg.sendCommand('Network.disable')
      } catch {
        // ignore
      }
      try {
        await dbg.detach()
      } catch {
        // ignore
      }
    }
  }
}

/**
 * 使用同一会话的 net.fetch 做二次拉取（Cookie 更一致于捕获窗口）。
 */
async function fetchResourceFallback(
  webContents: WebContents,
  url: string,
  log: LogFn
): Promise<Buffer | null> {
  if (isSkippableUrl(url) || !/^https?:/i.test(url)) return null

  const res = await webContents.session.fetch(url)
  if (!res.ok) {
    log(`[回退] HTTP ${res.status} ${url}`)
    return null
  }
  const ab = await res.arrayBuffer()
  return Buffer.from(ab)
}
