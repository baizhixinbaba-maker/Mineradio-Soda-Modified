# Mineradio Project

这是 Mineradio 汽水音乐功能的正式项目目录。当前项目基线为 `1.1.7`。

## 项目目录

```text
Mineradio-Project/
├─ src/                    可维护源码和运行资源
│  ├─ desktop/             Electron 主进程、preload、bridge 部署器
│  ├─ public/              Mineradio 前端页面、汽水登录页面和静态资源
│  ├─ build/soda-bridge/   受支持汽水客户端的 bridge payload 和 manifest
│  ├─ server.js            本地 API 和播放/歌词/歌单服务
│  ├─ dj-analyzer.js       音频分析辅助模块
│  └─ package.json         Mineradio 应用依赖和版本信息
├─ vendor/                 bridge native 依赖和独立供应物
├─ tools/                  诊断、验证和发布辅助脚本
├─ docs/                   项目交接、部署方案和技术说明
├─ artifacts/              发布包和匿名测试证据
│  ├─ releases/             不可变发行包
│  └─ evidence/             已脱敏的诊断摘要
└─ README.md               项目入口文档
```

## 当前版本和发布包

- 应用版本：`1.1.7`
- 发布包：`artifacts/releases/Mineradio-v1.1.7.zip`
- SHA-256：`5459EFD4D371EF1389505C0768F97CCA02AF4ECBD1D2314E1349670E8D256F48`
- 当前支持的汽水客户端 profile：
  - `soda-shell-3.5.1-bridge-1`
  - `soda-package-3.5.2-bridge-1`

当前目标电脑仍需要安装匹配 profile 的官方汽水音乐客户端。项目尚未证明能够兼容所有历史版本，也尚未证明在所有干净虚拟机上完成扫码闭环。

## 开发入口

源码入口是：

```text
C:\Users\Administrator\Documents\Codex\2026-07-15\wo\Mineradio-Project\src
```

`D:\Mineradio` 是已安装/已构建的运行目录，不是本项目的源码根目录。修改应在 `src` 中进行，验证通过后再生成新的 staging 目录和发行包。不要直接在 `D:\Mineradio\resources\app` 上叠加修改。

## 诊断

在问题电脑上关闭 Mineradio 后执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\Collect-Mineradio-Diagnostics.ps1
```

诊断输出必须在交接前确认不包含账号数据、Cookie 值、二维码 token、bridge token 或真实播放地址。

## 相关文档

- `docs/Mineradio-Project-Handoff-2026-07-17.md`：完整交接文档、失败时间线、风险和验收矩阵。
- `docs/Mineradio-Soda-Bridge-Deployment-Plan.md`：bridge 部署方案和长期独立化方向。
- `artifacts/evidence/evidence-index.md`：匿名测试证据索引。

## 版本管理建议

本目录应作为 Git 仓库根目录。每次改动前先建立可回滚提交；发行包从干净 checkout 构建，不要覆盖旧版本目录。

