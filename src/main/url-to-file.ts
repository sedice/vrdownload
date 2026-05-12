import { createHash } from 'node:crypto'
import { extname, posix } from 'node:path'
import { isStaticLikeMime } from './static-mime.js'

const WIN_BAD = new Set(['<', '>', ':', '"', '|', '?', '*', '\0'])
const MAX_SEGMENT = 120

/** 建 E 全景起始页：仅此类 URL 启用 /view/… 会话名与缩略图等专用提取逻辑。 */
const VR_JUSTEASY_ORIGIN = 'https://vr.justeasy.cn'

export function isVrJusteasyStartUrl(href: string): boolean {
  try {
    const u = new URL(href)
    return u.origin === VR_JUSTEASY_ORIGIN
  } catch {
    return false
  }
}

const VR_3D66_ORIGIN = 'https://vr.3d66.com'
/** 溜溜全景 index_detail 详情页，如 /vr/index_detail_3663810.asp */
const VR_3D66_DETAIL_ASP_RE = /^\/vr\/index_detail_\d+\.asp$/i

export function isVr3d66DetailAspStartUrl(href: string): boolean {
  try {
    const u = new URL(href)
    if (u.origin !== VR_3D66_ORIGIN) return false
    return VR_3D66_DETAIL_ASP_RE.test(u.pathname)
  } catch {
    return false
  }
}

/**
 * 将 URL 映射为输出子路径：hostname + pathname。
 * **忽略 query（及 hash）**，仅按 `origin + pathname` 落盘；同一路径不同 query 写入同一相对路径（后者覆盖）。
 * 仍冲突时（极少见）加 `_2`、`_3`… 递增后缀。
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

  const pathHref =
    u.protocol === 'http:' || u.protocol === 'https:'
      ? `${u.origin}${u.pathname || '/'}`
      : href
  const up = new URL(pathHref)

  const host = sanitizeSegment(up.hostname || 'host', true)
  let pathname = up.pathname || '/'
  if (pathname === '/' || pathname === '') {
    pathname = indexNameFromMime(mime, pathHref)
  } else {
    const parts = pathname.split('/').filter(Boolean).map((p) => sanitizeSegment(p, false))
    pathname = parts.length ? parts.join('/') : indexNameFromMime(mime, pathHref)
  }

  let rel = posix.join(host, pathname.replaceAll('\\', '/'))

  if (seenPaths.has(rel)) {
    const ext = extname(rel) || guessExt(mime, pathHref)
    const base = ext ? rel.slice(0, -ext.length) : rel
    let n = 2
    let candidate = `${base}_${n}${ext || ''}`
    while (seenPaths.has(candidate)) {
      n += 1
      candidate = `${base}_${n}${ext || ''}`
    }
    rel = candidate
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
 * 从采集起始页 URL 得到会话子目录名。
 * - **仅**当起始 URL 为 `https://vr.justeasy.cn` 同源时：按建 E 规则，优先取 `/view/` 后一段，并做 `compactSessionSlug`。
 * - 其他站点：仅取路径最后一段（不解析 `view` 段），使用通用 slug，便于后续按站点扩展规则。
 */
export function sessionFolderFromStartUrl(href: string): string {
  if (isVrJusteasyStartUrl(href)) {
    return sessionFolderFromVrJusteasyStartUrl(href)
  }
  return sessionFolderFromGenericStartUrl(href)
}

function sessionFolderFromVrJusteasyStartUrl(href: string): string {
  let u: URL
  try {
    u = new URL(href)
  } catch {
    return `session_${hash6(href)}`
  }
  const parts = pathnamePartsDecoded(u.pathname)

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
  if (!folder || folder === "_") return `session_${hash6(href)}`
  return compactSessionSlug(folder)
}

function sessionFolderFromGenericStartUrl(href: string): string {
  let u: URL
  try {
    u = new URL(href)
  } catch {
    return `session_${hash6(href)}`
  }
  const parts = pathnamePartsDecoded(u.pathname)
  const segment =
    parts.length > 0 ? parts[parts.length - 1]!.replace(/\.html?$/i, '') : undefined

  if (!segment || segment === '.' || segment === '..') {
    const host = sanitizeSegment(u.hostname || 'site', true)
    return `session_${host}_${hash6(u.pathname + u.search || href)}`
  }

  const folder = sanitizeSegment(segment, false)
  if (!folder || folder === "_") {
    return `session_${hash6(href)}`
  }
  return genericSessionSlug(folder)
}

function pathnamePartsDecoded(pathname: string): string[] {
  return pathname
    .split('/')
    .map((p) => {
      try {
        return decodeURIComponent(p)
      } catch {
        return p
      }
    })
    .filter(Boolean)
}

function compactSessionSlug(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/\.html?$/i, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!cleaned) return `session-${hash6(raw).slice(0, 6)}`;

  // 常见丑名称：超长随机串 + 时间戳（如 abcdefgh1234-1722820018）
  const uglyTs = cleaned.match(/^([a-z0-9]{10,})-(\d{9,})$/);
  if (uglyTs) {
    const prefix = uglyTs[1].slice(0, 6);
    const suffix = hash6(cleaned).slice(0, 4);
    return `pano-${prefix}-${suffix}`;
  }

  if (cleaned.length <= 24) {
    return cleaned;
  }

  // 其他过长场景：保留头部可读片段 + 哈希，兼顾短与稳定。
  return `${cleaned.slice(0, 18)}-${hash6(cleaned).slice(0, 6)}`;
}

/** 非建 E 站点：可读 slug + 长度上限，不做 pano-/时间戳等建 E 专用压缩。 */
function genericSessionSlug(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/\.html?$/i, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  if (!cleaned) return `session-${hash6(raw).slice(0, 6)}`
  if (cleaned.length <= 48) return cleaned
  return `${cleaned.slice(0, 40)}-${hash6(cleaned).slice(0, 6)}`
}
