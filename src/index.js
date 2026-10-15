/**
 * Surge Ruleset Proxy
 * 运行在 Cloudflare Workers 上的规则集与模块反向代理服务
 * 
 * 核心功能：
 * 1. 串行上游兜底（Sequential Fallback）：按优先级顺序请求上游镜像节点，遇到异常自动切换
 * 2. 内部链接动态重写（Domain Rewriting）：动态识别并重写 .sgmodule 及配置中的内部上游链接至当前反代域名
 * 3. 首页版权与来源声明注入（Source Statement）：保持 AGPL 协议并在首页追加反代来源
 * 4. 边缘缓存优化：严格过滤参数抵御 CDN 穿透，保留原生 ETag 与缓存头
 */

// 1. 默认上游节点阵列 (按优先级排序)
const DEFAULT_UPSTREAMS = [
  'https://ruleset.skk.moe',
  'https://ruleset-mirror.skk.moe'
]

// 2. 允许透传给上游的客户端请求头白名单
const ALLOWED_REQUEST_HEADERS = [
  'Accept',
  'Range',
  'If-None-Match',
  'If-Modified-Since'
]

// 3. 支持内容重写的文本/配置文件扩展名
const REWRITABLE_EXTENSIONS = [
  '.sgmodule',
  '.conf',
  '.list',
  '.txt',
  '.json',
  '.js',
  '.yaml',
  '.yml',
  '.html',
  '.md'
]

export default {
  /**
   * Cloudflare Worker 主请求入口
   * @param {Request} request 
   * @param {Object} env 
   * @param {Object} ctx 
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    // 仅允许 GET 与 HEAD 请求
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    const url = new URL(request.url)

    // 若配置了静态资源绑定 (ASSETS)，优先尝试匹配本地静态文件 (public/ 目录)
    if (env?.ASSETS) {
      try {
        const assetResponse = await env.ASSETS.fetch(request)
        if (assetResponse.status !== 404) {
          return assetResponse
        }
      } catch (_) {
        // 本地静态资源未命中或出错，继续回源
      }
    }

    // 边缘防御：仅提取纯路径，丢弃所有查询参数，彻底阻断利用参数造成的 CDN 缓存穿透攻击
    const targetPath = normalizePath(url.pathname)

    // 请求头清洗：统一 User-Agent 并仅保留缓存协商等必要头部
    const upstreamHeaders = cleanHeaders(request.headers)

    // 获取上游节点列表 (支持环境变量覆写)
    const upstreams = env?.UPSTREAMS 
      ? env.UPSTREAMS.split(',').map(s => s.trim()) 
      : DEFAULT_UPSTREAMS

    // 串行兜底请求上游
    const upstreamResponse = await fetchUpstreamWithFallback(targetPath, upstreamHeaders, upstreams)

    if (!upstreamResponse) {
      return new Response('All upstreams failed', { status: 502 })
    }

    // 对于 HEAD 请求、304 Not Modified 或错误状态码，无需文本重写，直接透传
    if (request.method === 'HEAD' || upstreamResponse.status !== 200) {
      return upstreamResponse
    }

    // 执行文本重写（域名替换与首页声明）
    try {
      return await handleAndRewriteResponse(request, url, targetPath, upstreamResponse, upstreams)
    } catch (err) {
      return new Response('Error processing upstream response', { status: 500 })
    }
  }
}

/**
 * 规范化路径，防范异常前缀
 * @param {string} pathname 
 * @returns {string}
 */
function normalizePath(pathname) {
  let cleaned = pathname.replace(/^\/https?:\/?/i, '/')
  cleaned = cleaned.replace(/^\/(ruleset(-mirror)?\.skk\.moe)/i, '')
  return cleaned.startsWith('/') ? cleaned : `/${cleaned}`
}

/**
 * 请求头清洗与标准化
 * @param {Headers} originalHeaders 
 * @returns {Headers}
 */
function cleanHeaders(originalHeaders) {
  const headers = new Headers()
  headers.set('User-Agent', 'Cloudflare-Worker/1.0')
  for (const key of ALLOWED_REQUEST_HEADERS) {
    const val = originalHeaders.get(key)
    if (val) headers.set(key, val)
  }
  return headers
}

/**
 * 串行上游兜底拉取逻辑
 * @param {string} path 
 * @param {Headers} headers 
 * @param {string[]} upstreams 
 * @returns {Promise<Response|null>}
 */
async function fetchUpstreamWithFallback(path, headers, upstreams) {
  for (const upstream of upstreams) {
    try {
      const targetUrl = new URL(path, upstream)
      const res = await fetch(targetUrl, {
        method: 'GET',
        headers,
        redirect: 'follow'
      })

      // 遇到 5xx 服务端错误继续尝试下一节点
      if (res.status >= 500) {
        continue
      }

      return res
    } catch (err) {
      // 捕获网络异常（DNS 解析失败、连接超时等），继续尝试下一节点
      continue
    }
  }

  return null
}

/**
 * 判断响应是否为需要进行链接重写的文本或配置文件
 * @param {Response} response 
 * @param {string} path 
 * @returns {boolean}
 */
function isRewritableText(response, path) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase()

  if (
    contentType.includes('text/') ||
    contentType.includes('application/javascript') ||
    contentType.includes('application/x-javascript') ||
    contentType.includes('application/json') ||
    contentType.includes('application/yaml') ||
    contentType.includes('application/x-yaml')
  ) {
    return true
  }

  const lowerPath = path.toLowerCase()
  return REWRITABLE_EXTENSIONS.some(ext => lowerPath.endsWith(ext)) || path === '/' || path === '/index.html'
}

/**
 * 读取文本并对其中的上游域名与内部连接进行动态替换
 * @param {Request} request 
 * @param {URL} url 
 * @param {string} targetPath 
 * @param {Response} upstreamResponse 
 * @param {string[]} upstreams 
 * @returns {Promise<Response>}
 */
async function handleAndRewriteResponse(request, url, targetPath, upstreamResponse, upstreams) {
  // 图片、音视频等二进制文件直接透传
  if (!isRewritableText(upstreamResponse, targetPath)) {
    return upstreamResponse
  }

  let text = await upstreamResponse.text()

  // 1. 获取当前反代节点的 Origin（动态适配反代域名与 HTTPS 协议）
  const clientProto = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '')
  const currentOrigin = `${clientProto}://${url.host}`

  // 2. 提取所有上游节点的主机名，生成精确替换正则
  const upstreamHosts = [...new Set(upstreams.map(u => {
    try { return new URL(u).hostname } catch { return null }
  }).filter(Boolean))]

  if (upstreamHosts.length > 0) {
    const escapedHosts = upstreamHosts.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    const upstreamRegex = new RegExp(`(?:https?:)?\\/\\/(?:${escapedHosts})`, 'g')
    text = text.replace(upstreamRegex, currentOrigin)
  }

  // 3. 首页版权及来源声明轻量注入
  const isHomepage = targetPath === '/' || targetPath === '/index.html'
  if (isHomepage) {
    text = text.replace(
      'AGPL-3.0</a>', 
      `AGPL-3.0</a> | Proxied by ${url.host}`
    )
  }

  // 4. 重建响应头（移除已失效的长度与编码 Header，保留 ETag 与缓存头）
  const newHeaders = new Headers(upstreamResponse.headers)
  newHeaders.delete('content-length')
  newHeaders.delete('content-encoding')

  return new Response(text, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: newHeaders
  })
}
