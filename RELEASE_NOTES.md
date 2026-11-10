# WhaleCodex 1.1.0 发布说明

发布日期：2026-11-10 ｜ 发布密钥指纹：`6F84E4E00F86FD100CA94FEDF63AE65454CC2288`

## 1.1.0 主要变更（免费版）

- **移除授权锁**：不再需要授权码、不再有激活页，下载安装后直接进主界面，全部功能可用（模型 API 需自备密钥）。
- **不再比对 Windows 发布证书指纹**：公开分发场景下，用户自行编译或由发布者签名的包都能正常启动；asar 内嵌完整性校验仍然生效。
- 连接器面板：同一连接器的开关操作串行化（连点不再抖动）、授权等待支持取消、卡住的授权进程 150 秒自动回收、「检测状态」真实探测端点。
- 设置新增「语音与机器人」：填入自建的 GPT-SoVITS / AstrBot 地址即可检测连通并一键打开，客户端不内置这两套运行时。
- 语音转写支持视频文件（mp4 / mov / webm 等），转写文本不再有占位提示残留。
- **模型目录精简**：内置模型目录只保留实测可用的 7 个高质量模型（Nemotron-3-Ultra-550B / 3.5-Lightning / 3.5-Bolt / 3-Nano-Omni / 3.5-Super-VL / Poolside-Laguna-XS / Step-5-Preview），移除了排队拥塞或账号不可用的 DeepSeek-V4.1-Flash / MiniMax-M3.1-Flash / GLM-5.3-Flash，避免误选「未开通」模型。
- **DSH 风格 API 提供商预设模板**：设置里的「API 提供商」改为预设模板卡片列表，内置「NVIDIA NIM」卡片（绿点 + 已登录状态 + 编辑/删除）；点「＋ 添加 API 提供商」即可保存一份独立的自定义模板（名称 / 接口地址 / 密钥 / 协议 / 模型目录分别保存，密钥加密落盘），可自由增删切换。

## 本次包含的安装包

| 适用系统 | 安装包 | 说明 |
|----------|--------|------|
| Windows 10 / 11（x64） | `WhaleCodex-Setup-1.1.0.exe` | NSIS 安装版 |
| Windows 10 / 11（x64） | `WhaleCodex-Portable-1.1.0.exe` | 免安装便携版 |
| Linux（x64 通用） | `WhaleCodex-1.1.0-x64.zip` | 免安装便携包 |

## 主要特性

- 本地优先的 Electron 桌面客户端，会话 / 记忆库 / 设置全部落在用户数据目录。
- 多模型、多提供商配置，内置模型目录与故障转移链（首字节看门狗超时后自动降级）。
- 上游错误分类（429 / 410 / 404 / 401 / 5xx）与模型实况探测。
- 记忆库、会话管理、本地工具调用与 Agent 工作目录白名单。
- Windows / Linux 均内置本地语音识别引擎（whisper.cpp）；语音模型改为**唯一的高精度 `large-v3-turbo q8_0` 按需下载**（首次使用需在设置里主动下载，约 834 MiB），不再随包附带量化小模型。音频始终在本机识别，不上传。

## 许可状态

**1.1.0 起免费使用，无需任何授权码或激活。** 本仓库仅提供编译后的二进制安装包，不提供源代码；完整条款与随包分发的第三方开源组件许可证全文见仓库 [`LICENSE`](../../blob/main/LICENSE)。

## 安全与完整性

- 三个安装包**全部**配有 GPG 分离签名（`.asc`），统一使用同一把发布密钥。
- Windows 两个 `.exe` 内嵌 Authenticode 代码签名（CN=WhaleCodex，自签）。
- 1.1.0 未提供 `.deb`（需 Linux 环境用 fpm 打包），Linux 用户请用 zip 便携包。
- 运行时默认不落盘用户会话内容；语音转写、模型回复、工具调用日志仅在 `WHALE_DEBUG=1` 时记录。
- 无遥测、无隐藏外联；网络请求仅限用户配置的模型 API 端点、本地回环，以及用户主动下载语音模型时访问官方发布域名。
- 完整性：asar 内嵌校验始终生效；1.1.0 免费版不再硬编码比对发布证书指纹（`9D0758A2A7FAABE8E83E3773A4FB8C4274B790AA` 仅 1.0.0 适用）。
- **本次安全加固（全平台）**：
  - 本地 HTTP 接口新增每进程随机令牌 + `Host` / `Origin` / `Sec-Fetch-Site` 白名单，阻断任意网页或本机其它进程越权调用 `/api/*`（读取会话、改设置、启动 Agent）。
  - 渲染进程启用 sandbox / contextIsolation / webSecurity，禁用 Node 集成、webview、新窗口与外域导航；全站 CSP + `Referrer-Policy: no-referrer`。
  - API Key 与提供商密钥改用系统密钥环（DPAPI / libsecret）加密落盘，兼容旧明文配置。
  - Electron fuses：禁用 `ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS`、`--inspect`，强制只从 `app.asar` 加载，启用 asar 完整性校验与 Cookie 加密。
  - 修正 `require('./license')` 在 Windows 大小写不敏感文件系统下误命中 `LICENSE` 纯文本文件的加载缺陷。
  - 新增 `SHA256SUMS.txt.asc`，校验和清单本身也受 GPG 签名保护。
  - 修正本地服务静态资源白名单漏掉 `/renderer.js` 导致前端脚本 404 的回归。
- **语音与 Linux 平台（本轮）**：
  - 移除内置的 small/base 量化模型（安装包明显瘦身）；模型文件名改由签名清单决定，换档位无需重发客户端。
  - 模型清单使用与分发 GPG 密钥分离的专用 Ed25519 密钥离线签名；服务器只放公开文件，被攻破也无法伪造清单。
  - Linux 包内置 `whisper-server`（静态链接 ggml，glibc ≥ 2.34，deb 声明 `libgomp1` 等依赖）；`resources/whisper/THIRD-PARTY-NOTICES.txt` 记录上游来源与 sha256；主 LICENSE 补入 whisper.cpp / ggml 的 MIT 全文。
  - 新增可选的 `-ac` 编码器上下文限制以缩短语音响应等待，默认约 15 秒，可切「完整 30 秒」避免长句截断。

## 校验方式

见仓库 [README](../../blob/main/README.md) 的「核验下载完整性」章节，或直接下载本 Release 的 `SHA256SUMS.txt` 与 `whalecodex_pubkey.asc`。
