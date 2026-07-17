# Mineradio 汽水音乐跨电脑部署方案

## 1. 目标

让 Windows 10/11 x64 用户安装 Mineradio 后，不依赖本机官方汽水音乐客户端的安装路径、版本或被修改过的 `app.asar`，即可完成：

- 扫码登录自己的汽水音乐账号。
- 同步歌单、喜欢列表与搜索结果。
- 播放歌曲、加载歌词。
- 切换 `standard`、`exhigh`、`lossless`、`hires`、`jymaster` 五档音质。

## 2. 当前问题

当前播放链路通过扫描本机官方汽水音乐客户端启动 bridge。它要求目标 `resources/app.asar` 已包含 `MINERADIO_SODA_BRIDGE_PORT` 标记。

因此另一台电脑会在以下任一情况失败：

- 未安装官方汽水音乐客户端。
- 官方客户端安装在未扫描的自定义路径。
- 官方客户端版本不同。
- 官方客户端的 `app.asar` 没有预先注入 bridge。

二维码登录可能成功，但播放、歌词和音质切换会因 bridge 不存在而失败。

## 3. 推荐架构

将 bridge 随 Mineradio 自身发布，不修改、启动或依赖用户的官方汽水音乐客户端。

```text
Mineradio Electron 主进程
  |- 扫码登录与会话管理
  |- 启动独立 soda bridge
  |- 本地 API server
  `- 前端播放器

soda bridge
  |- GET  /health
  |- POST /player
  `- POST /lyric
```

bridge 仅监听 `127.0.0.1`，使用每次启动生成的随机 token 鉴权，并使用 Mineradio 自己的用户目录保存运行状态。

## 4. 目录结构

建议新增如下文件：

```text
resources/app/
  desktop/
    soda-bridge.js
    soda-bridge-protocol.js
    soda-bridge-adapters/
      v352.js
  build/
    soda-bridge-manifest.json
```

运行时状态目录：

```text
%APPDATA%/Mineradio/
  soda-runtime/
    bridge/
    profile/
    ttnet/
```

不要把账号 Cookie、二维码、播放 URL 或 bridge token 写入安装目录或日志。

## 5. Bridge 启动协议

主进程使用 Electron 自身作为 Node 运行时启动 bridge，不要求用户另装 Node.js：

```js
const { fork } = require('child_process');
const crypto = require('crypto');
const path = require('path');

async function startBundledSodaBridge() {
  const token = crypto.randomBytes(32).toString('hex');
  const bridgeFile = path.join(__dirname, 'desktop', 'soda-bridge.js');
  const stateDir = path.join(app.getPath('userData'), 'soda-runtime', 'bridge');

  const child = fork(bridgeFile, [], {
    execPath: process.execPath,
    silent: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      MINERADIO_SODA_BRIDGE_PORT: '0',
      MINERADIO_SODA_BRIDGE_TOKEN: token,
      MINERADIO_SODA_STATE_DIR: stateDir,
    },
  });

  return waitBridgeReady(child, token);
}
```

bridge 成功监听后必须通过 stdout 输出单行 JSON：

```json
{"type":"ready","port":43127,"version":"1.0.0"}
```

主进程保存该端口和 token 到内存。端口使用 `0` 由系统分配，不能继续固定使用 `17891`，避免其他软件或旧实例占用端口。

## 6. HTTP 接口约定

所有 bridge 请求都必须包含：

```text
x-mineradio-soda-bridge: <random-token>
```

### GET /health

```json
{"ok":true,"ready":true,"version":"1.0.0"}
```

### POST /player

请求：

```json
{"id":"track-id","vid":"video-id","quality":"hires","cookie":"session-cookie"}
```

成功响应：

```json
{
  "ok": true,
  "url": "signed-audio-url",
  "level": "hires",
  "sourceQuality": "hi_res",
  "br": 322008,
  "expire_at": 0
}
```

失败时返回机器可读错误码，例如：

```json
{"ok":false,"error":"SODA_LOGIN_REQUIRED"}
```

### POST /lyric

```json
{"id":"track-id","cookie":"session-cookie"}
```

## 7. 音质约定

bridge 必须返回服务端实际解析出的质量和码率，不能只回显用户选择。

| 请求档位 | 实际质量标识 |
| --- | --- |
| `standard` | `medium` |
| `exhigh` | `higher` |
| `lossless` | `highest` |
| `hires` | `hi_res` |
| `jymaster` | `spatial` |

如果歌曲不支持请求档位，bridge 仍应返回可用的较低档，并由前端显示“已自动降级”。

## 8. server.js 改造

移除以下旧依赖：

- `findSodaBridgeExecutable()`。
- `sodaArchiveContainsBridge()`。
- `SODA_MUSIC_HOME` 扫描逻辑。
- 对 `SodaMusic.exe` 的 `spawn()`。

保留现有 `sodaBridgeRequest()`、`sodaNativePlayerRequest()` 和 `sodaNativeLyricRequest()` 的调用形式，但将端口改为 bridge 就绪握手返回的动态端口。

建议维护如下运行状态：

```js
const sodaBridgeRuntime = {
  child: null,
  port: 0,
  token: '',
  ready: null,
  lastFailure: null,
};
```

启动失败后返回明确错误，例如 `SODA_BRIDGE_BOOT_FAILED`，不要伪装成“无播放地址”。

## 9. 打包配置

在 Electron Builder 配置中将 bridge 包含为资源，并保证运行时可读取：

```json
{
  "build": {
    "extraResources": [
      {
        "from": "desktop/soda-bridge",
        "to": "soda-bridge"
      }
    ],
    "asarUnpack": [
      "desktop/soda-bridge/**"
    ]
  }
}
```

发布前生成 `soda-bridge-manifest.json`，记录 bridge 版本、文件长度与 SHA-256。启动前校验完整性，校验失败则重新从自身安装包资源恢复。

## 10. 首次运行流程

1. Mineradio 创建 `%APPDATA%/Mineradio/soda-runtime`。
2. 启动自身携带的 bridge，等待 `/health` 成功。
3. 用户打开汽水音乐扫码界面并完成确认。
4. 主进程验证会话，再允许播放入口显示可用状态。
5. 播放时将会话和请求档位传给 bridge。
6. 前端使用响应中的实际 `level` 和 `br` 更新音质标签。

整个流程不扫描 `D:`、`Program Files`、注册表或用户的官方汽水音乐目录。

## 11. 迁移步骤

1. 固化当前可用 bridge 的 `/player`、`/lyric` 请求与响应协议。
2. 将其实现迁入 `soda-bridge.js`，不再注入官方 `app.asar`。
3. 修改 `server.js` 使用动态端口和独立 bridge 进程。
4. 修改前端：仅在 bridge `ready` 且账号已登录时开放播放和音质菜单。
5. 打出新的 Windows 安装包。
6. 在干净虚拟机测试后再发布。

## 12. 验收清单

必须在未安装官方汽水音乐客户端的干净 Windows 10/11 x64 虚拟机完成：

- 安装 Mineradio 后首次启动成功。
- 没有管理员权限时 bridge 可启动。
- 完成扫码后客户端在 10 秒内显示登录成功。
- 歌单、喜欢列表、搜索结果可用。
- 五档音质均可请求，界面显示 bridge 返回的实际档位与码率。
- 音频代理返回有效 `206` Range 响应和正确的媒体类型。
- 歌词正常显示，无乱码。
- 端口被占用时仍可通过动态端口启动。
- 退出、重开、覆盖升级后会话与 bridge 状态正常。
- 电脑未安装官方汽水音乐客户端时不弹出或启动任何官方客户端。

## 13. 不推荐的方案

不要通过安装器自动修改用户官方汽水音乐的 `app.asar`。这种方式仍会被客户端自动更新、安装目录变化和版本差异破坏，无法保证其他电脑稳定使用。
