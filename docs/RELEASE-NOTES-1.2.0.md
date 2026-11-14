# WhaleCodex 1.2.0 · 开源工作台

把模型对话、编程任务和文件产物放在同一个桌面工作台。

本次由旧版二进制发布仓库转为可读源码发布：主代码、文档与原创几何鲸鱼图标采用 **Apache-2.0**。支持多提供商配置、Chat/Responses 协议适配、上下文预算和摘要、运行统计、只读子任务编排、工作台侧聊、文件/下载面板，以及受控回复附件。

## 下载

| 文件 | 用途与验证状态 |
|---|---|
| `WhaleCodex-Setup-1.2.0.exe` | Windows 10/11 x64 安装版；主 EXE、卸载器、安装器均已做 SHA-256 Authenticode 签名与时间戳 |
| `WhaleCodex-Portable-1.2.0.exe` | Windows x64 便携版；内嵌主 EXE 与便携外壳签名 |
| `WhaleCodex-1.2.0-linux-arm64.tar.gz` | Linux ARM64 实验包；Electron/Codex/语音库 43 个 ELF 均核验为 AArch64，换入最新 1.2.0 代码，未执行 ARM64 Linux 实机测试 |

**签名类型要区分：** Windows Authenticode 证书为 WhaleCodex 自签证书，不是受信任 CA 证书，SmartScreen/系统可能提示不受信任。Linux tar 使用 GPG 分离签名；所有三个下载包均提供同名 `.asc`，另提供签名校验和清单。签名证明字节与发布密钥对应，不保证应用没有缺陷。

GPG 发布密钥指纹：`6F84 E4E0 0F86 FD10 0CA9 4FED F63A E654 54CC 2288`。
Windows 签名证书指纹：`9D0758A2A7FAABE8E83E3773A4FB8C4274B790AA`。

```bash
gpg --import whalecodex_pubkey.asc
gpg --fingerprint 6F84E4E00F86FD100CA94FEDF63AE65454CC2288
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt
# 可单独核验：
gpg --verify WhaleCodex-1.2.0-linux-arm64.tar.gz.asc WhaleCodex-1.2.0-linux-arm64.tar.gz
```

## Linux ARM64 安装与限制

解压后进入 `WhaleCodex-1.2.0-linux-arm64`，运行 `./whalecodex`。需要 ARM64 图形桌面及 Electron 系统依赖；语音库使用到 GLIBC_2.34，建议 glibc 2.34+。包内启动说明详列 sandbox 与动态库要求。

启动器默认保留 Chromium sandbox，**不自动运行 sudo 或默认附加 `--no-sandbox`**。目标系统若需要 setuid sandbox，由管理员按发行版规范配置。显式放弃 sandbox 会降低隔离，不作为默认推荐。

这是经静态核验的 ARM64 运行时重组包，不是本机 Linux 原生构建。源材料目录中错误的 x86_64 名称已改为 `aarch64-unknown-linux-musl`；应用按实际 CPU 架构定位引擎。旧包中的 1.1.0 ASAR、headless 脚本和旧启动脚本均未沿用。

## 本轮验证与功能边界

- 公开源码：35 个 JavaScript 语法检查通过；敏感信息与开发机路径扫描 0 命中。
- 真实模块回归：60 tests，59 pass、0 fail、1 skip（Windows 文件 symlink 创建权限不足；junction/父链用例通过）。
- Windows 签名解包版：隔离数据目录、mock 模型服务下 7 项 HTTP/CDP 附件冒烟通过。
- Windows fuse4/fuse5 均开启。`ELECTRON_RUN_AS_NODE=1` 曾导致的启动误判已排除，启动测试只清理目标子进程环境。
- Linux：包成员、软链接、Unix 模式、ASAR 最新源文件和全部 ELF 架构复核通过；没有实机启动/Agent/语音测试。
- F1 附件打开/所在目录和原生拖动启动已在前期 Windows 验证；**目标窗口真正接收文件仍未完成跨窗口人工验收**。
- D1 Windows 语义桌面桥默认关闭、待正式验收；helper 需另行准备并核验版本/哈希。未开放物理鼠标键盘模拟或任意桌面控制。
- macOS、Linux x64 本次不提供二进制，源码含构建入口，不代表平台验收通过。

模型账号/API 密钥需自行配置；Release 包含匹配平台的外部 Codex 与 whisper 运行时，但不含用户设置、聊天记录、API 密钥或模型权重。第三方运行时保留原许可。可选 CC BY-NC-SA 主题独立注明，默认关闭且不打入二进制。

源码：[meteor03112/WhaleCodex](https://github.com/meteor03112/WhaleCodex) · 下载：[Releases](https://github.com/meteor03112/WhaleCodex/releases) · 反馈：[Issues](https://github.com/meteor03112/WhaleCodex/issues)
