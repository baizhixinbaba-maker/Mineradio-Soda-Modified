# 匿名测试证据索引

这里仅保存不含 Cookie 值、账号标识、二维码 token、bridge token 或真实播放地址的测试摘要。原始浏览器 profile、Cache、Network 日志和运行时目录不应进入项目仓库。

| 文件 | 用途 |
| --- | --- |
| `qr-fallback-soda-qr-diagnostics.json` | 二维码 fallback 链路测试摘要 |
| `qr-response-soda-qr-diagnostics.json` | 网络响应读取和响应兜底测试摘要 |
| `sdk-expose-soda-qr-diagnostics.json` | SDK 返回值暴露测试摘要，记录过 `1.1.6` 回归 |
| `qr-poll-regression-soda-qr-diagnostics.json` | `1.1.7` 修复后的轮询诊断摘要 |
| `release-v117-soda-qr-diagnostics.json` | 从 `1.1.7` 发布目录启动的诊断摘要 |
| `soda-signed-player-probe-result.json` | native 播放探针结果摘要 |

注意：这些文件的字段只用于判断阶段和错误，不应据此推断“所有电脑都可用”。跨电脑验收仍需在干净 Windows 虚拟机上真实扫码，并重新生成脱敏诊断。

