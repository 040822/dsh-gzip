# dsh-gzip

[![npm](https://img.shields.io/npm/v/dsh-gzip.svg)](https://www.npmjs.com/package/dsh-gzip)
[![license](https://img.shields.io/npm/l/dsh-gzip.svg)](LICENSE)

DeepSeek Harness 的 `/api` 响应 gzip 压缩插件：解决远程 / 低带宽访问时「历史加载失败：The user aborted a request.（internal）」的问题。

## 起因

dsh Web GUI 加载会话历史时，一页历史会把最近 50 条消息涉及的**全部原始事件**下发（含全部流式 chunk），响应体积可达 **4–13.4MB**，且服务端**不做任何压缩**；而浏览器侧的 RPC 请求有 **30 秒硬超时**。对于带宽较低或链路不佳的访问（easytier / ZeroTier / Tailscale 等异地组网、移动网络、上行受限的家宽），传输超过 30 秒就会被浏览器中止，界面显示「历史加载失败」。

实测数据（本项目开发环境的真实会话）：

| 会话 | 原始响应 | gzip 后 | 压缩率 |
|---|---|---|---|
| 大型历史会话 | 13.4MB | 1.16MB | 91.4% |

gzip 之后，同样 ~3Mbps 的链路上，单页历史从 ~36 秒降到 ~3 秒，远低于 30 秒超时。

## 安装

**前置要求**：已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh` 命令可用）；Node.js `^22.19` 或 `>=24`。

插件已发布到 npm，一条命令装好：

```sh
dsh plugin --profile web add dsh-gzip
```

> **重启生效**：安装完成后，重启正在运行的 DeepSeek Harness Web 服务并刷新页面。

### 其他安装方式

- **指定版本**：`dsh plugin --profile web add dsh-gzip@<version>`
- **还没装 DSH**：`npx -p @deepseek-ai/dsh dsh plugin --profile web add dsh-gzip`
- **从 GitHub 安装**：`dsh plugin --profile web add github:040822/dsh-gzip`（仓库：[github.com/040822/dsh-gzip](https://github.com/040822/dsh-gzip)）
- **从源码 / 符号链接安装**（不经过 npm，开发或内网部署用）：把插件目录链接到 profile 的插件解析目录，并在 profile patch 中注册：

```sh
ln -sfn /path/to/dsh-gzip ~/.dsh/profiles/node_modules/dsh-gzip
```

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: dsh-gzip
      name: dsh-gzip
```

## 验证

装好并重启后，用一条 curl 确认响应带上了 `content-encoding: gzip`：

```sh
curl -s -D - -o /dev/null -X POST http://127.0.0.1:3080/api/session.list \
  -H "Content-Type: application/json" -H "Accept-Encoding: gzip" \
  -d '{"type":"client-request","rpcId":"test","method":"session.list","payload":{}}' \
  | grep -i content-encoding
# 应看到: content-encoding: gzip
```

浏览器端：DevTools → Network → 任意 `session.*` 请求的 Response Headers 应带 `content-encoding: gzip`；打开大型历史会话的加载时间应显著下降。

## 工作原理

- dsh 的 `/api` 路由由 `dsh-client-connection` **独占注册**（重复注册会抛错），`bridge()` 函数也未导出——插件没有"正门"可走，因此采用：monkey-patch `webServer.register`，在 `/api` 前缀路由注册的瞬间把 handler 替换为"按请求包装 `res`"的版本（实例级遮蔽 `writeHead` / `write` / `end`，不动原型，作用域仅 `/api`）。
- 压缩条件：请求 `Accept-Encoding` 含 gzip，且响应为可压缩类型（`application/json`、`*+json`、非 `text/event-stream` 的 `text/*`），且响应未自带 `content-encoding`。
- 豁免：SSE 事件流（`text/event-stream`）、zip 导出、未协商压缩的请求、已编码响应——全部原样透传。
- 时序无关：不依赖插件加载顺序；上游如何修改 `bridge()` 都不影响本插件（挂钩的是公开服务 API 与 node:http 稳定接口）。

## 兼容性与定位

- 在 `@deepseek-ai/dsh` **0.1.0-rc.6** 上验证通过（含端到端测试：13.8MB 响应压缩为 1.19MB，JSON 完整；无 `Accept-Encoding` 时行为不变；WS 下行流与错误路径不受影响）。
- **定位是过渡方案**：根治在上游——历史响应瘦身（流式 chunk 事件不必全量下发）、官方启用压缩、超时策略按响应规模调整（见 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)）。上游合并后本插件自然退居"旧版本兼容"角色；即使失效也是安全降级（不压缩、不报错），不会破坏功能。

## 开发

本插件由 **DeepSeek V4 Flash + DeepSeek Harness vibe coding** 完成：在 dsh GUI 会话中完成问题诊断（含实测数据与完整证据链）、方案设计、实现与端到端验证。全部代码就是一个 `index.js`，欢迎阅读、修改与提 PR。

## License

MIT
