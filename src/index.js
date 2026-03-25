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

  const controllers = UPSTREAMS.map(() => new AbortController())

  // 5. 级联竞速逻辑
  const executeRace = () => new Promise((resolve, reject) => {
    let failedCount = 0
    let nextIndex = 0
    let isResolved = false

    const tryNext = () => {
      if (isResolved || nextIndex >= UPSTREAMS.length) return
      
      const currentIndex = nextIndex++
        const targetUrl = new URL(targetPath, UPSTREAMS[currentIndex])
      let timer

      fetch(targetUrl, {
        method: 'GET',
        headers,
        redirect: 'follow',
        signal: controllers[currentIndex].signal
      }).then(res => {
        if (isResolved) return
        if (res.status >= 500) throw new Error('5xx')

        isResolved = true
        clearTimeout(timer)
        resolve({ winnerIndex: currentIndex, res })
      }).catch(() => {
        if (isResolved) return
        clearTimeout(timer)
        failedCount++
        
        if (failedCount === UPSTREAMS.length) {
          reject(new Error('All upstreams failed'))
        } else {
          tryNext()
        }
      })

      // 800ms 慢节点容忍期，超时自动拉起下一个节点
      timer = setTimeout(() => {
        if (!isResolved) tryNext()
      }, 800)
    }

    tryNext()
  })

  try {
    const { winnerIndex, res } = await executeRace()

    // 释放未胜出节点的连接
    controllers.forEach((ctrl, i) => {
      if (i !== winnerIndex) ctrl.abort()
    })

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
        newHeaders.delete('content-length')
        
        return new Response(html, {
          status: res.status,
          statusText: res.statusText,
          headers: newHeaders
        })
      }
    }

    return res
  } catch (err) {
    return new Response('All upstreams failed', { status: 502 })
  }
}
