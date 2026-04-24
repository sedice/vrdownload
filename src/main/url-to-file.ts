import { createHash } from 'node:crypto'
import { extname, posix } from 'node:path'
import { isStaticLikeMime } from './static-mime.js'

const WIN_BAD = new Set(['<', '>', ':', '"', '|', '?', '*', '\0'])
const MAX_SEGMENT = 120

/**
 * 将 URL 映射为输出子路径：hostname + pathname。
 * 带 query 且路径末段无扩展名时视为动态请求：只保留 pathname，不拼短哈希、不按 MIME 加后缀；同路径多次请求也不再加 _ 哈希（后者覆盖前者）。
 * 其它情况：query 会参与生成 `_`+哈希+推断后缀；仍冲突时再加全 URL 短哈希。
 */
export function urlToRelativePath(
  href: string,
  mime: string | undefined,
  seenPaths: Set<string>
): string {
  let u: URL
  try {
    u = new URL(href)
  } catch {
    return `unknown/${hash6(href)}.bin`
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:') {
    return `inline/${hash6(href)}.bin`
  }

  const host = sanitizeSegment(u.hostname || 'host', true)
  let pathname = u.pathname || '/'
  if (pathname === '/' || pathname === '') {
    pathname = indexNameFromMime(mime, href)
  } else {
    const parts = pathname.split('/').filter(Boolean).map((p) => sanitizeSegment(p, false))
    pathname = parts.length ? parts.join('/') : indexNameFromMime(mime, href)
  }
  /** 动态请求：/api/foo?a=1、/Pano/Preview/ctdata?... 等，pathname 最后一段无 .ext */
  const isQueryBareNoExt = Boolean(u.search) && !extname(pathname)

  if (u.search && (pathname.includes('index') || !extname(pathname)) && !isQueryBareNoExt) {
    const q = `_${hash6(u.search)}`
    const ext = extname(pathname)
    const base = ext ? pathname.slice(0, -ext.length) : pathname
    pathname = `${base}${q}${ext || guessExt(mime, href)}`
  }

  let rel = posix.join(host, pathname.replaceAll('\\', '/'))

  if (seenPaths.has(rel) && !isQueryBareNoExt) {
    const ext = extname(rel) || guessExt(mime, href)
    const base = ext ? rel.slice(0, -ext.length) : rel
    rel = `${base}_${hash6(href)}${ext || ''}`
  }
  seenPaths.add(rel)
  return rel
}

function indexNameFromMime(mime: string | undefined, href: string): string {
  if (mime?.includes('html')) return 'index.html'
  if (isStaticLikeMime(mime, href)) {
    if (mime?.includes('css')) return 'index.css'
    if (mime?.includes('javascript') || href.endsWith('.js')) return 'index.js'
  }
  return `index${guessExt(mime, href)}`
}

function guessExt(mime: string | undefined, href: string): string {
  if (!mime) {
    const e = extname(new URL(href, 'https://x/').pathname)
    return e || '.bin'
  }
  const m = mime.split(';')[0]!.trim().toLowerCase()
  const map: Record<string, string> = {
    'text/html': '.html',
    'text/css': '.css',
    'text/javascript': '.js',
    'application/javascript': '.js',
    'application/x-javascript': '.js',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'font/woff2': '.woff2',
    'font/woff': '.woff',
    'font/ttf': '.ttf',
    'application/json': '.json'
  }
  for (const [k, v] of Object.entries(map)) {
    if (m === k) return v
  }
  if (m.startsWith('image/')) return '.img'
  return '.bin'
}

function hash6(s: string): string {
  return createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 8)
}

function sanitizeSegment(s: string, isHost: boolean): string {
  let out = ''
  for (const ch of s) {
    if (WIN_BAD.has(ch) || ch === '/' || ch === '\\') {
      out += '_'
    } else {
      out += ch
    }
  }
  if (!isHost) {
    if (out.length > MAX_SEGMENT) {
      out = out.slice(0, MAX_SEGMENT) + '_' + hash6(s)
    }
  }
  const trimmed = out.replace(/^\.+/, '_').trim()
  return trimmed || '_'
}

/**
 * 从采集起始页 URL 得到会话子目录名（如 /view/917a57b609r08g62-1757600959 → 917a57b609r08g62-1757600959）。
 * 优先取路径中 `view` 后一段；否则取末段（去掉 .html）；无法解析时用短哈希。
 */
export function sessionFolderFromStartUrl(href: string): string {
  let u: URL
  try {
    u = new URL(href)
  } catch {
    return `session_${hash6(href)}`
  }
  const parts = u.pathname
    .split('/')
    .map((p) => {
      try {
        return decodeURIComponent(p)
      } catch {
        return p
      }
    })
    .filter(Boolean)

  let segment: string | undefined
  const viewIdx = parts.findIndex((p) => p.toLowerCase() === 'view')
  if (viewIdx >= 0 && parts[viewIdx + 1]) {
    segment = parts[viewIdx + 1]!.replace(/\.html?$/i, '')
  } else if (parts.length > 0) {
    segment = parts[parts.length - 1]!.replace(/\.html?$/i, '')
  }

  if (!segment || segment === '.' || segment === '..') {
    return `session_${hash6(u.pathname + u.search || href)}`
  }

  const folder = sanitizeSegment(segment, false)
  return folder && folder !== '_' ? folder : `session_${hash6(href)}`
}
