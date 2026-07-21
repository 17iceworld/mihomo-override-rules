# 覆写规则测试报告

## 已自动验证

- Light 与 Full 从模块生成且生成文件无漂移。
- 覆写不定义 `proxies`，不会替换订阅节点。
- 关闭局域网访问；境外 DNS 显式走 `PROXY`，国内/节点 DNS 显式走 `DIRECT`。
- `PROXY` 组不再提供 `DIRECT`，防止手动选择后让标记为 `#PROXY` 的境外 DNS 实际直连。
- DNS bootstrap 使用加密传输，`respect-rules` 开启且 `prefer-h3` 关闭。
- 规则、规则提供者与策略组引用完整，无循环、重复规则和提前 MATCH。
- IP 规则与 IP-CIDR provider 均使用 `no-resolve`。
- 脱敏三节点 VLESS 测试配置可被覆写的 `include-all` 策略组发现，测试过程不改动输入。
- 官方 Mihomo v1.19.28 已成功加载脱敏合并后的 Light 与 Full 配置；本机初始化分别约 9 ms 与 7 ms。最新稳定版 v1.19.29 也已通过完整运行时集成测试。
- 删除了与 `cn-ip` MRS 重复的 `GEOIP,CN` 规则及依赖 MMDB 的 DNS fallback-filter，避免首次启动因 GeoIP 数据库下载失败而无法加载。
- Bootstrap DNS 使用 IP 形式的 DoH/443；两个端点均完成 TLS 证书验证，避免依赖更容易被受限网络封锁的 DoT/853。
- `npm run test:runtime` 已用 Mihomo v1.19.27、v1.19.28、最新稳定版 v1.19.29 和 alpha-3b85577 完成运行时集成验证：通过 `/rules` API 核对规则顺序，并从真实连接日志确认广告、AI、国内三个重叠 provider 按首条规则命中。
- Full 配置中的 30 个远程 MRS 已经由 `gh-proxy.org` 实际下载，并逐个交给 Mihomo 解码；测试同时统计远程 domain provider 的精确重叠项，避免仅验证 HTTP 状态或文件扩展名。
- `tests/cases.yaml` 的 16 个案例会在远程 MRS 解码后按完整规则顺序检查第一命中，避免只确认 provider 存在而产生假通过；Apple CN、游戏平台与中国域名的广泛/专属 provider 顺序均已纳入验证。
- inline `private-ip` 已包含 IPv4 与 IPv6 的本地、链路本地、ULA、文件示例及多播网段，远程 private provider 无缓存时仍保有基础 IPv6 安全路由。
- provider 缓存已完成故障注入：首次在线下载生成缓存后关闭服务器，离线重启仍能加载缓存且记录刷新失败；在全新无缓存目录中下载失败会留下明确日志，受保护请求不会到达 DIRECT 测试目标。
- IPv6-only 域名已映射为 `::1`，请求通过 Mihomo 到达仅监听 IPv6 的目标，服务端确认连接族为 IPv6。
- ChatGPT、Claude、Gemini、Copilot 和 Cursor 已通过 Mihomo 真实连接日志确认命中 `AI`；Google、GitHub、Microsoft 策略组也通过 API 确认默认继承 `AI`，用于保持共享认证流量的出口一致。

## 性能参数结论

- `url-test` 保持 300 秒间隔、5 秒超时和 lazy，并增加 50 ms tolerance，降低小幅延迟波动导致的频繁切换。
- `tcp-concurrent` 与 `unified-delay` 暂不写入默认覆写。它们必须依据跨平台单变量 A/B 结果决定，避免未经测量的性能变化。

## 尚需跨平台实测

macOS 本机的隔离代理、provider 和 IPv6 回环路径已自动验证，但这不等同于公网纯 IPv6、TUN 或其他操作系统。Windows/Linux TUN、运营商公网 IPv6、系统 DNS、WebRTC、休眠切网、防火墙、真实吞吐与资源占用仍需执行 `tests/CROSS_PLATFORM_TESTS.zh-CN.md` 的设备矩阵；任何平台超过 10% 中位数退化或发生泄漏均不得发布。
