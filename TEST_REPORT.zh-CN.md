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
- 官方 Mihomo v1.19.28 已成功加载脱敏合并后的 Light 与 Full 配置；本机初始化分别约 9 ms 与 7 ms。
- 删除了与 `cn-ip` MRS 重复的 `GEOIP,CN` 规则及依赖 MMDB 的 DNS fallback-filter，避免首次启动因 GeoIP 数据库下载失败而无法加载。
- Bootstrap DNS 使用 IP 形式的 DoH/443；两个端点均完成 TLS 证书验证，避免依赖更容易被受限网络封锁的 DoT/853。

## 性能参数结论

- `url-test` 保持 300 秒间隔、5 秒超时和 lazy，并增加 50 ms tolerance，降低小幅延迟波动导致的频繁切换。
- `tcp-concurrent` 与 `unified-delay` 暂不写入默认覆写。它们必须依据跨平台单变量 A/B 结果决定，避免未经测量的性能变化。

## 尚需跨平台实测

macOS、Windows、Linux 的 TUN、系统 DNS、IPv6、WebRTC、休眠切网、防火墙、真实吞吐与资源占用无法由当前单机静态测试证明。执行 `tests/CROSS_PLATFORM_TESTS.zh-CN.md` 的矩阵后，将平台结果补充到本节；任何平台超过 10% 中位数退化或发生泄漏均不得发布。
