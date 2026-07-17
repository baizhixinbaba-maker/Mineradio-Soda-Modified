# 项目结构和目录职责

## 正式项目根目录

```text
C:\Users\Administrator\Documents\Codex\2026-07-15\wo\Mineradio-Project
```

后续代码修改、文档维护和 Git 操作都应在这个目录进行。

## 目录对照

| 当前路径 | 类型 | 后续用途 |
| --- | --- | --- |
| `Mineradio-Project\src` | 源码基线 | 只在这里修改源码和资源 |
| `Mineradio-Project\src\desktop` | Electron 运行层 | 主进程、preload、bridge 部署器 |
| `Mineradio-Project\src\public` | 前端资源 | Mineradio 页面、登录页、歌词和静态资源 |
| `Mineradio-Project\src\build\soda-bridge` | 兼容 payload | 汽水客户端 bridge manifest 和 native 文件 |
| `Mineradio-Project\vendor` | 第三方/原生依赖 | 记录 bridge native 依赖，不放账号运行时数据 |
| `Mineradio-Project\tools` | 工具 | 诊断和验收脚本 |
| `Mineradio-Project\docs` | 文档 | 交接、部署方案、发布规则 |
| `Mineradio-Project\artifacts\releases` | 发布物 | 不可变 ZIP 和 SHA-256 |
| `Mineradio-Project\artifacts\evidence` | 证据索引 | 仅保存脱敏的人工整理结论 |
| `D:\Mineradio` | 已安装程序 | 只用于运行和验收，不作为源码编辑目录 |
| `wo\outputs` | 历史发布输出 | 临时历史归档，不能作为当前源码 |
| `wo\work` | 调试工作区 | 原始测试、浏览器 profile 和实验文件，不能直接发布 |

## 当前迁移完成情况

- 已复制 `desktop`、`public`、`server.js`、`dj-analyzer.js`、`package.json`。
- 已复制 bridge manifest、`3.5.1`/`3.5.2` payload 和 native 文件。
- 已复制交接文档、部署方案、诊断脚本和 `1.1.7` 发布包。
- 已初始化 `Mineradio-Project\.git`。
- 未复制 `node_modules`、`.soda-runtime`、`.soda-cookie`、浏览器 profile、Cache、Network 日志和原始登录数据。

## 不能混用的两个目录

`D:\Mineradio\resources\app` 是已安装程序当前正在使用的资源目录。直接修改这里会造成：

- 修改无法追踪。
- 下次重新安装或解压会覆盖修改。
- 发布包和源码产生偏差。
- 运行时 Cookie、bridge token 和缓存可能被误带入发布物。

正确流程是：

```text
修改 Mineradio-Project\src
  -> 在独立 staging 目录构建
  -> 启动 staging 版本验收
  -> 计算 ZIP SHA-256
  -> 将新 ZIP 放入 artifacts\releases
  -> 再复制/安装到 D:\Mineradio 做最终运行验证
```

## Git 初始状态

项目已经初始化 Git，但还没有创建首个提交。首个提交前应先检查：

```powershell
Set-Location 'C:\Users\Administrator\Documents\Codex\2026-07-15\wo\Mineradio-Project'
git status --short
git add README.md .gitignore docs src tools vendor
git status --short
```

发布 ZIP 和 native 二进制是否纳入 Git，需要根据仓库大小和发布策略决定；至少应保留 manifest、哈希和下载地址，避免无法重建。

