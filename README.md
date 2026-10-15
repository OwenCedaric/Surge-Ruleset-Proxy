# Surge Ruleset Proxy

这是一个运行在 Cloudflare Workers 上的反代服务，用于代理 [SukkaW/Surge](https://github.com/SukkaW/Surge/) 项目的规则集。

## 核心功能

* 串行兜底切换：内置上游镜像节点数组。按优先级严格顺序请求上游节点，仅当当前节点抛出网络异常或返回 5xx 服务端错误时，才会自动切换至下一个备用节点，保障规则更新的连通率并减少对上游的并发压力。
* 内部连接动态重写：针对模块（如 `.sgmodule`）以及规则集中引用的上游内部连接（如 `https://ruleset.skk.moe/Mock/...`、`RULE-SET:https://ruleset.skk.moe/...` 等），自动基于当前访问节点动态替换为反代节点 URL，确保 Surge 重定向与规则更新完全经由反代服务，避免回源绕过。
* 无侵入来源声明：在透传规则集的同时，针对首页响应进行轻量级文本替换，在保留原作者 AGPL 声明的基础上追加当前反代节点的来源信息。

## 部署指引

1. 确保本地环境已安装 Node.js，并全局安装 Cloudflare Wrangler CLI (执行 npm install -g wrangler)。
2. 登录 Cloudflare 账号 (执行 wrangler login)。
3. 根据实际情况修改配置：
   - `src/index.js` 中的 `UPSTREAMS`: 填入你要顺序代理的各个上游节点 URL。
   - `wrangler.toml` 中的 `pattern`: 填入你自己的反代节点域名（Worker 会自动基于请求来源动态重写内部连接与首页声明）。
4. 部署至边缘节点 (执行 wrangler deploy)。
