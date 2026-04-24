/**
 * 判断是否保存为「静态类」资源（方案 1 与回退拉取共用）
 */
export function isStaticLikeMime(mime: string | undefined, url: string): boolean {
  if (!mime) {
    return looksLikeStaticByUrl(url)
  }
  const m = mime.split(';')[0]!.trim().toLowerCase()
  if (m === 'text/html' || m === 'text/css' || m === 'application/xhtml+xml') return true
  if (m === 'text/javascript' || m === 'application/javascript' || m === 'application/x-javascript')
    return true
  if (m.startsWith('image/')) return true
  if (m.startsWith('font/') || m === 'application/font-woff' || m === 'application/vnd.ms-fontobject')
    return true
  if (m.startsWith('audio/') || m.startsWith('video/') || m === 'application/octet-stream')
    return true
  if (m === 'text/plain' && looksLikeStaticByUrl(url)) return true
  return false
}

const API_PATH_HINT = /\/(api|graphql|v\d+)(\/|$)/i

/**
 * 常见接口响应类型（与 CDP 的 XHR / Fetch 配合使用；无 MIME 时可用 URL 粗判）
 */
export function isApiLikeMime(mime: string | undefined, url: string): boolean {
  if (!mime) {
    try {
      if (API_PATH_HINT.test(new URL(url).pathname)) return true
    } catch {
      /* ignore */
    }
    return false
  }
  const m = mime.split(';')[0]!.trim().toLowerCase()
  if (m === 'application/json' || m === 'text/json' || m === 'application/x-ndjson') return true
  if (m.endsWith('+json') && m.startsWith('application/')) return true
  if (m === 'text/xml' || m === 'application/xml') return true
  if (m === 'application/x-www-form-urlencoded') return true
  if (m === 'text/plain') {
    try {
      if (API_PATH_HINT.test(new URL(url).pathname)) return true
    } catch {
      /* ignore */
    }
  }
  return false
}

const STATIC_EXT = /\.(css|js|mjs|cjs|jsx|ts|tsx|html|htm|json|map|ico|png|jpe?g|gif|webp|svg|avif|bmp|woff2?|ttf|otf|eot|mp3|mp4|webm|ogg|wav|glb|wasm)$/i

function looksLikeStaticByUrl(url: string): boolean {
  try {
    const p = new URL(url).pathname
    if (STATIC_EXT.test(p)) return true
  } catch {
    return false
  }
  return false
}

export function isSkippableUrl(url: string): boolean {
  if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('file:')) return true
  if (url.startsWith('ws:') || url.startsWith('wss:')) return true
  if (url.includes('favicon') && url.endsWith('.ico')) {
    // 保留 favicon
    return false
  }
  return false
}
