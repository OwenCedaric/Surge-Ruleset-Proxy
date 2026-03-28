addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  // 1. 拦截非 GET 请求
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const url = new URL(request.url)

  // 2. 边缘防御：丢弃所有查询参数，彻底阻断利用参数造成的 CDN 缓存击穿攻击
  const targetPath = url.pathname

  // 3. 上游节点阵列 (按优先级排序)
  const UPSTREAMS = [
    'https://ruleset.skk.moe',
    'https://ruleset-mirror.skk.moe'
    // 可以在此处继续追加更多镜像节点
  ]

  // 4. Header 清洗：统一 User-Agent 并仅放行必要 Header
  const headers = new Headers()
  headers.set('User-Agent', 'Cloudflare-Worker/1.0')
  for (const key of ['Accept', 'Range', 'If-None-Match', 'If-Modified-Since']) {
    const val = request.headers.get(key)
    if (val) headers.set(key, val)
  }

  // 5. 串行兜底逻辑
  let finalResponse = null;

  for (const upstream of UPSTREAMS) {
    const targetUrl = new URL(targetPath, upstream)
    
    try {
      const res = await fetch(targetUrl, {
        method: 'GET',
        headers,
        redirect: 'follow'
      })

      // 遇到 5xx 错误视为节点服务端异常，继续尝试下一个节点
      if (res.status >= 500) {
        continue
      }

      // 获取到有效响应 (2xx, 3xx, 4xx) 时，中断循环
      finalResponse = res
      break
      
    } catch (err) {
      // 捕获 Fetch 级别的网络错误 (如 DNS 解析失败、连接超时拒绝等)，继续尝试下一个
      continue
    }
  }

  // 如果遍历完所有节点依然没有获取到有效响应
  if (!finalResponse) {
    return new Response('All upstreams failed', { status: 502 })
  }

  const res = finalResponse

  try {
    // 6. 首页注入代理说明
    if (res.ok && (url.pathname === '/' || url.pathname === '/index.html')) {
      const contentType = res.headers.get('content-type') || ''
      if (contentType.includes('text/html')) {
        let html = await res.text()
        
        html = html.replace(
          'AGPL-3.0</a>', 
          'AGPL-3.0</a> | Proxied by fleet.ceda.is'
        )

        const newHeaders = new Headers(res.headers)
        newHeaders.delete('content-length') // 修改了内容，必须删除原有的长度 Header
        
        return new Response(html, {
          status: res.status,
          statusText: res.statusText,
          headers: newHeaders
        })
      }
    }

    return res
  } catch (err) {
    // 处理文本解析或注入时可能发生的异常
    return new Response('Error processing upstream response', { status: 500 })
  }
}
