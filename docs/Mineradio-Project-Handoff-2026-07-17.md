# Mineradio 汽水音乐功能项目交接文档

> 文档日期：2026-07-17  
> 当前版本：Mineradio `1.1.7`  
> 项目目录：`D:\Mineradio`  
> 交接目的：让后续维护者能够复现当前实现、判断问题边界、收集有效证据，并避免重复引入二维码登录回归。

## 1. 项目目标与支持边界

### 1.1 产品目标

Mineradio 的汽水音乐入口需要在 Mineradio 内完成以下流程：

1. 调起隐藏的汽水音乐登录页。
2. 显示二维码，用户使用手机扫码确认。
3. 将登录会话交给 Mineradio 的独立 session。
4. 同步汽水音乐歌单和“我喜欢的音乐”。
5. 搜索汽水音乐歌曲。
6. 获取可播放地址、歌词，并支持音质切换。

### 1.2 当前明确边界

- 目标电脑必须已经安装官方汽水音乐客户端。
- 当前不是所有历史版本通用，只允许 manifest 中 SHA-256 精确匹配的兼容 profile。
- 当前验证的 profile 为：
  - `soda-shell-3.5.1-bridge-1`
  - `soda-package-3.5.2-bridge-1`
- 3.5.2 的实际目录是：壳程序位于 `3.5.1/SodaMusic.exe`，业务包位于 `Packages/3.5.2/app.asar`。
- 不能对外宣称“任何电脑都已验证成功”。当前已有本机端到端证据，但尚未取得干净虚拟机或第三方电脑完成扫码闭环的证据。
- 当前官方客户端仍会被 Mineradio 以隐藏 profile 启动；“不让用户看到官方窗口”不等于“完全不启动官方客户端”。

原始部署方案曾设想把 bridge 完全随 Mineradio 发布、摆脱官方客户端安装路径。该方向仍属于长期重构方案，不是当前 `1.1.7` 的实现。

## 2. 当前目录和关键产物

### 2.1 核心源码

| 文件 | 责任 |
| --- | --- |
| `D:\Mineradio\resources\app\desktop\main.js` | Electron 主进程、隐藏二维码窗口、独立 session、Cookie 捕获、二维码 IPC 和状态诊断 |
| `D:\Mineradio\resources\app\server.js` | 本地 HTTP API、歌单、喜欢、搜索、播放地址、歌词和音质接口；负责 bridge 启动协调 |
| `D:\Mineradio\resources\app\desktop\soda-bridge-deployment.js` | 官方客户端发现、哈希校验、备份、stage、原子替换、恢复和回滚 |
| `D:\Mineradio\resources\app\desktop\preload.js` | 向前端暴露二维码创建和登录状态 IPC |
| `D:\Mineradio\resources\app\build\soda-bridge\manifest.json` | 受支持的 shell、业务包和 native 文件兼容清单 |
| `D:\Mineradio\resources\app\package.json` | Mineradio 版本和发布元数据，当前为 `1.1.7` |

### 2.2 关键函数

- `desktop/main.js:483`：`prepareBundledSodaBridge`
- `desktop/main.js:1349`：`configureSodaQrRequestHeaders`
- `desktop/main.js:1504`：`createSodaMusicQr`
- `desktop/main.js:1706`：`getSodaMusicQrLoginStatus`
- `desktop/soda-bridge-deployment.js:501`：`prepareSodaBridgeDeployment`
- `server.js:2926`：`ensureSodaBridge`
- `server.js:3055`：`loadSodaPlaylists`
- `server.js:3124`：`loadSodaPlaylistTracks`
- `server.js:3221`：`handleSodaSongUrl`

### 2.3 发布产物

- 发布包：`C:\Users\Administrator\Documents\Codex\2026-07-15\wo\outputs\Mineradio-v1.1.7-soda-login-e2e-fix-Windows-x64.zip`
- SHA-256：`5459EFD4D371EF1389505C0768F97CCA02AF4ECBD1D2314E1349670E8D256F48`
- 当前曾上传的 GoFile 地址：`https://gofile.io/d/kU9MFl`

发布包下载后必须重新计算 SHA-256，并在解压后的目录中再次检查版本和关键文件，不能只相信上传文件名。

## 3. 当前架构

```text
Mineradio Electron 主进程
  ├─ 隐藏二维码 BrowserWindow
  ├─ 独立 session partition
  ├─ Cookie 捕获和匿名状态诊断
  ├─ 本地 server.js API
  └─ 启动/健康检查官方汽水 bridge

官方汽水客户端（匹配 profile 时临时部署 bridge）
  ├─ 官方登录 SDK 和二维码接口
  ├─ native runtime
  ├─ 音频签名与 CENC MP4 解密
  └─ bridge-only 隐藏进程

前端
  ├─ 汽水二维码登录入口
  ├─ 歌单和喜欢列表
  ├─ 搜索
  ├─ 播放和进度条
  ├─ 歌词
  └─ 音质选择
```

当前 bridge 使用本机回环地址和运行时 token。token 只应保存在内存或运行时目录中，不能写入交接文档、发布包或普通日志。

登录页目前存在多套观测和兜底机制：页面 XHR/fetch monkey patch、压缩 JS 字符串替换、Electron `webRequest.filterResponseData`、canvas 像素提取以及 SDK 全局变量暴露。它们互相耦合，是近期二维码回归的主要结构性原因。

## 4. 版本时间线、失败原因和修复思路

| 版本 | 修改目标 | 结果和经验 |
| --- | --- | --- |
| `1.1.2` | 初次加入汽水二维码和入口 | 有发布包但缺少完整匿名诊断，不能作为跨电脑基线。 |
| `1.1.3` | 增加官方客户端 bridge 自动部署 | 主要按 3.5.1 shell 处理，实际使用 3.5.2 package 的电脑可能注入错误位置。旧诊断中二维码请求和轮询存在，但页面没有正确解析状态。 |
| `1.1.4` | 增加 3.5.2 package 布局和隐藏窗口处理 | 本机能看到 `new` 状态，但只证明请求启动，不等于二维码渲染和真实扫码成功；虚拟机仍失败。 |
| `1.1.5` | 修复 JSON 响应读取，增加 network response、token、canvas 兜底 | 本机禁用 GPU 时有过 network-response 兜底证据，但其他环境仍出现响应字段为空、token 未捕获；“一定是 GPU 问题”没有被虚拟机证据证实。 |
| `1.1.6` | 直接暴露 SDK `getQrcode()` 和轮询结果 | 产生确定性回归：把压缩代码中的 `const` 声明链插入分号，导致后续轮询表达式不再执行。本机也出现二维码后不轮询、扫码无反应。 |
| `1.1.7` | 用赋值表达式暴露返回值，保持原声明链 | 改为 `c=window.__mineradioSodaQrResponse=await getQrcode(...)`，不破坏原语法链。本机恢复 `new -> scanned`，轮询 POST 200，真实扫码端到端验证通过。 |

### 4.1 `1.1.6` 回归的根因

原压缩代码属于类似以下结构：

```js
const a=...,c=await getQrcode(...),f=new URL(...);
```

错误替换后变成：

```js
const a=...,c=await getQrcode(...);window.__qr=c,f=new URL(...);
```

`f` 不再处于合法的 `const` 声明链中，导致 module 脚本在该位置中断。表面上可能仍能看到二维码请求，实际上轮询和登录完成逻辑没有启动。

### 4.2 这次修复得到的硬性经验

- 不要对 minified bundle 做未经语法断言的字符串插入。
- 接口 HTTP 200、页面显示二维码、手机确认成功、Cookie 到达、业务接口验证成功，是五个不同阶段。
- 任何一个阶段都不能单独当作“登录成功”。
- 修复后必须真实扫码，不能只等待二维码过期。

## 5. 主要困难、根因和解决思路

### 5.1 二维码长时间加载或空白

**现象**

- 页面一直显示“正在生成二维码”。
- 二维码区域空白。
- 手机端偶尔显示扫描成功，但 Mineradio 没有反应。

**可能根因**

- SDK 返回的是 data URL、token 或二维码索引地址中的一种，不能假定只有一个字段。
- 使用 Axios `responseType=json` 时读取 `responseText` 会抛异常。
- `filterResponseData` 拿到压缩响应，直接 `JSON.parse` 可能失败。
- canvas 绘制依赖 compositor；本机 `--disable-gpu` 测试不代表干净虚拟机。
- 外部 `sdk-glue.js`、代理、证书、固定 User-Agent 或网络策略影响页面初始化。
- 运行时压缩 JS 替换破坏了原始声明链。

**处理思路**

当前 `1.1.7` 保留原始 SDK 表达式，只通过赋值表达式把返回值暴露给主进程，同时保留 network response 和 canvas 兜底。后续应停止继续叠加兜底，改为单一登录控制器和明确状态机。

### 5.2 手机确认成功但客户端不登录

手机端成功只说明服务端认可了扫码。PC 端还必须：

1. 收到状态轮询响应。
2. 收到会话 Cookie。
3. 将 Cookie 写入独立 session partition。
4. 通过用户信息或歌单接口验证会话。
5. 再通知前端登录完成。

正确的完成条件必须是“必要 Cookie 存在且真实业务接口成功”，不能只检查二维码状态是 `scanned` 或手机提示成功。

### 5.3 官方客户端路径和版本差异

官方客户端可能安装在自定义路径，且存在壳版本和业务包版本不一致的情况。部署器需要综合：

- `SODA_MUSIC_HOME` 环境变量。
- 常见安装目录。
- 卸载注册表。
- `3.5.1/SodaMusic.exe` 壳和 `Packages/3.5.2/app.asar` 业务包。

发现后先读取并校验 manifest 的 SHA-256，再执行备份、stage、原子替换和启动健康检查。任何哈希不匹配都应返回明确的“不支持版本”，不能继续覆盖用户文件。

### 5.4 bridge 依赖 native runtime

只复制 `app.asar` 不足以保证播放。3.5.1 链路还依赖 `bdms.node`、`bdticket.node`、`device.node`、`ttnet.node` 等 native 文件；运行时文件被锁定时必须先退出官方客户端。独立 native probe 曾出现 Cronet `-300`，说明脱离官方启动上下文运行 bridge 仍有初始化难点。

### 5.5 播放无声、进度条不动和部分歌曲无地址

播放链路不是“拿到 URL 就结束”：

- 某些歌曲缺少 `vid`、受版权限制或没有目标音质资源。
- 音频可能是 CENC 加密 MP4，需要官方 native runtime 解密。
- 播放代理必须正确处理 `Range` 和 `206 Partial Content`。
- `Content-Type` 必须是 `audio/mp4` 或实际媒体类型。
- 前端进度条必须绑定可读媒体时长和 `timeupdate`。

已验证的关键证据包括：音频代理返回 `206 audio/mp4`，Range 请求可取得前 4096 字节；本机五档音质均返回可播放地址。

### 5.6 歌词乱码

歌词接口返回的数据可能是字符串、对象或嵌套字段。处理时要统一 UTF-8 解码、字段归一化和换行格式，避免把二进制响应或错误编码直接渲染到页面。

### 5.7 定位和天气不准确

天气定位链路采用以下优先级：

1. Browser geolocation。
2. Windows Runtime geolocation。
3. 逆地理编码，提取省/市。
4. IP 定位兜底。
5. 最后才使用默认城市。

“默认上海”只能作为最终 fallback，不能把上海当成已经定位到的当前位置。需要在界面和诊断中区分定位来源与置信度。

### 5.8 桌面快捷方式

桌面快捷键打不开通常与快捷方式目标、工作目录或安装路径变化有关。应使用 Electron `shell.writeShortcutLink` 创建快捷方式，并在发布包中验证目标路径和启动参数。

## 6. 当前已经掌握的技术能力

- Electron 主进程、preload、IPC、BrowserWindow 生命周期和独立 session partition。
- `app.asar` 解包、压缩 JavaScript 分析、source map 和运行时注入定位。
- 官方汽水 shell/package 双层目录和自定义安装路径发现。
- Windows 卸载注册表读取、SHA-256 白名单、备份、stage、原子替换、回滚。
- `webRequest`、Cookie 捕获、二维码 GET/POST 请求和状态轮询分析。
- 官方 native runtime、Cronet、ttnet 和 device 依赖排查。
- CENC MP4 解密、Range 代理、媒体类型和播放进度处理。
- 歌单、喜欢、搜索、歌词和音质数据归一化。
- 发布 ZIP 完整性校验和敏感信息审计。
- 使用匿名诊断文件区分请求失败、渲染失败、扫码失败和业务验证失败。

## 7. 当前已完成的真实验证

使用 `1.1.7` 在本机、从发布目录启动并加上 `--disable-gpu --disable-software-rasterizer` 后，完成了真实手机扫码：

- 二维码生成成功。
- 状态由 `new` 进入 `scanned`。
- 登录轮询为 POST，HTTP 200。
- `checkQrconnect.count=3`。
- 取得会话 Cookie，且无 Cookie 写入错误。
- 歌单数量：2。
- “我喜欢的音乐”：269 首。
- 喜欢状态查询返回 `true`。
- `standard`：68199 bps。
- `hires`：322008 bps。
- `jymaster`：324231 bps。
- 三档测试均得到可播放地址。
- 已验证音频代理 `206 audio/mp4` 和 Range 4096 字节。
- 歌词接口存在有效歌词。

这些证据证明本机链路已经恢复，不证明所有电脑都能成功。

## 8. 当前未解决风险

优先级 P0：

- 尚未取得真实干净虚拟机或第三方电脑的 `1.1.7` 端到端扫码证据。
- 虚拟机“二维码生成失败”的精确根因仍需该虚拟机的匿名诊断文件、console、证书和网络记录。
- 当前登录链路有多套互相竞争的拦截和兜底机制，后续改动容易再次回归。

优先级 P1：

- `filterResponseData` 对压缩响应的解析不稳定。
- 外部登录资源在代理、证书异常或受限网络下未充分验证。
- 压缩 JS 固定字符串替换依赖官方资源结构，官方更新后可能静默失效。
- bridge 固定使用 `127.0.0.1:17891`，存在端口占用和旧进程残留风险。
- 仅支持精确哈希，官方自动更新后必须新增 profile。
- 可变输出目录和缺少 Git/CI 使回滚、审计和发布复现困难。

## 9. 后续重构建议

### P0：重写单一登录控制器

建立 `SodaLoginController`，只保留一条数据通道，状态明确为：

```text
page_loading
qr_requesting
qr_ready
scanned
session_received
session_verified
failed
```

只有 `session_verified` 才通知前端“登录成功”。删除或逐步替换 `server.js` 对 minified JS 的字符串替换链，以及页面多套 XHR/fetch monkey patch。

### P1：拆分 bridge 管理器

建立独立 `SodaBridgeManager`，职责仅包括 `discover`、`deploy`、`start`、`health`、`stop`。使用系统动态端口和随机握手 token；compatibility profile 同时记录 shell、package 和 native 文件哈希。

### P1：建立可复现发布流程

- 将源码纳入 Git。
- 每次从干净 source tree 生成新的 staging 目录。
- 自动生成版本、文件 SHA-256、兼容 profile 和匿名验收结果。
- ZIP 解压后再次校验关键文件和敏感信息黑名单。
- 禁止复制旧版本 checkpoint，避免把旧版本号和旧测试结果带入新包。

### P2：独立 bridge

长期可以继续原始部署方案中的独立 bridge，但必须先解决 Cronet `-300`、native device 初始化和资源绑定问题。在当前“目标电脑必须安装官方客户端”的约束下，不应把它作为本次交付前置条件。

## 10. 发布前验收矩阵

至少覆盖以下组合：

- Windows 10、Windows 11 干净虚拟机。
- 普通用户权限，无历史 `%APPDATA%\Mineradio`。
- 默认安装路径和包含中文的自定义路径。
- 3.5.1 shell 与 3.5.2 package 两种布局。
- 官方客户端运行中、完全退出、更新后。
- 正常 GPU、禁用 GPU、远程桌面环境。
- 系统代理、无代理、证书异常。
- 端口占用、旧 bridge 进程残留。

每台测试机必须真实扫码并记录：

1. 二维码请求 HTTP 状态。
2. 页面二维码图像来源和尺寸。
3. 轮询次数及 HTTP 方法。
4. 手机确认后的状态变化。
5. 会话是否写入独立 partition。
6. 用户接口验证结果。
7. 歌单、喜欢、搜索、歌词。
8. 五档音质的实际质量标识和码率。
9. 音频 `206`、媒体类型、声音和进度条。
10. 退出重开后的会话恢复和登出后的 Cookie 清理。

## 11. 诊断和交接操作

在问题电脑上关闭 Mineradio 后运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\Collect-Mineradio-Diagnostics.ps1
```

脚本输出匿名诊断 JSON，包含版本、文件哈希、进程、监听端口、网络连通性和二维码状态；脚本设计为排除 Cookie、账号数据和 bridge token。交接时应同时提供：

- 诊断 JSON。
- Mineradio 启动时间和操作步骤。
- 是否能看到二维码。
- 手机是否提示确认成功。
- 官方客户端版本和安装路径类型。
- 是否处于虚拟机、远程桌面、代理或禁用 GPU 环境。

建议证据文件：

- `work\qr-fallback-test\soda-qr-diagnostics.json`
- `work\qr-response-test\soda-qr-diagnostics.json`
- `work\sdk-expose-test\soda-qr-diagnostics.json`
- `work\qr-poll-regression-test\soda-qr-diagnostics.json`
- `work\release-v117-test\soda-qr-diagnostics.json`
- `work\soda-signed-player-probe-result.json`
- `outputs` 下 `1.1.3` 至 `1.1.7` 的不可变 ZIP

## 12. 交接结论

当前 `1.1.7` 已经解决了本机二维码轮询回归，并完成了本机真实扫码、歌单、喜欢、播放地址、歌词和音质验证。当前最重要的未完成事项不是继续增加二维码兜底，而是获取干净虚拟机/第三方电脑的匿名失败证据，并按状态机逐阶段定位。

后续维护必须遵守三条原则：

1. 先保留可回滚的发布基线，再修改登录链路。
2. 任何“扫码成功”结论都必须包含 Cookie 和业务接口验证。
3. 官方客户端版本、目录布局和 native 依赖必须通过哈希清单明确判断，不能用模糊的“看起来兼容”。

