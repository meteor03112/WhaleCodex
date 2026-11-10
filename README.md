# WhaleCodex（鲸鱼娘 · Codex 桌面客户端）

一个本地优先的 AI 编程助手桌面客户端，基于 Electron，支持多模型 / 多提供商配置、故障转移与实况探测，内置记忆库、会话管理与本地工具调用。

> 当前版本：**1.1.0**（免费版：**无需授权码、无需激活，下载即用**）
>
> 所有安装包均由同一把 WhaleCodex 发布密钥 GPG 签名，可自行核验。

本版内置**精简模型目录**（仅保留实测可用的 7 个高质量模型）与 **DSH 风格的「API 提供商」预设模板**（内置 NVIDIA NIM 卡片，可自由新增 / 编辑 / 删除自定义模板，密钥加密落盘）。

## 下载

请前往本仓库的 **[Releases 页面](../../releases/latest)** 下载。安装包体积较大（276–430 MB），未放入 Git 仓库，全部以 Release 附件形式提供。

| # | 文件 | 适用系统版本 | 形态 | 内置签名 |
|---|------|--------------|------|----------|
| 1 | `WhaleCodex-Setup-1.1.0.exe` | **Windows 10 / 11（x64）** | NSIS 安装版，安装到 Program Files，可自定义目录 | Authenticode（CN=WhaleCodex） |
| 2 | `WhaleCodex-Portable-1.1.0.exe` | **Windows 10 / 11（x64）** | 便携版，免安装，双击即用，适合 U 盘 / 无管理员权限 | Authenticode（CN=WhaleCodex） |
| 3 | `WhaleCodex-1.1.0-x64.zip` | **Linux（x64，任意发行版）** | 免安装便携包，解压后 `chmod +x whalecodex && ./whalecodex` | 无内嵌机制，配同名 `.asc` |

每个安装包都有**同名的 `.asc` 分离签名**；另有 `whalecodex_pubkey.asc`（发布公钥）、`SHA256SUMS.txt`（全部文件 SHA-256）及其签名 `SHA256SUMS.txt.asc`（防止清单本身被替换）。

## 安装

**Windows**：双击 `WhaleCodex-Setup-1.1.0.exe` 按向导安装，或直接运行便携版。
自签名证书会被 SmartScreen / 系统提示"发布者不受信任"（`UnknownError`），属预期现象；签名本身真实有效，客户端启动自检已兼容自签证书，不影响使用。

**Linux（x64，通用）**：
```bash
unzip WhaleCodex-1.1.0-x64.zip -d WhaleCodex
cd WhaleCodex
chmod +x whalecodex

# Electron 的内核沙箱需要 root 属主的 setuid 助手（只做这一步需要 sudo）
sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox

./whalecodex
```

> 不想给 sudo 也可以直接 `./whalecodex --no-sandbox` 启动——功能完全一致，只是放弃 Chromium 的多进程沙箱隔离。

> **语音输入（两个平台都支持）**：语音引擎随安装包内置，但**模型不随包分发**。首次使用请在「设置 → 语音输入」点击「刷新模型清单」后下载（约 834 MiB，支持断点续传）。Linux zip 便携版需自行安装 `libgomp1`，并要求 glibc ≥ 2.34（Ubuntu 22.04+ / Debian 12+）。
>
> **Linux .deb 暂未提供 1.1.0**：deb 需要在 Linux 环境用 fpm 打包，本次只在 Windows 上产出了 zip。用 `.deb` 的用户可先用 zip，或等后续补包。

## 核验下载完整性

```bash
# 1) 导入发布公钥（只需一次）
gpg --import whalecodex_pubkey.asc

# 2) 逐个校验 GPG 分离签名
gpg --verify WhaleCodex-Setup-1.1.0.exe.asc      WhaleCodex-Setup-1.1.0.exe
gpg --verify WhaleCodex-Portable-1.1.0.exe.asc   WhaleCodex-Portable-1.1.0.exe
gpg --verify WhaleCodex-1.1.0-x64.zip.asc        WhaleCodex-1.1.0-x64.zip

# 3) 先验证校验和清单本身的签名，再校验文件
gpg --verify SHA256SUMS.txt.asc                SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt
```

发布密钥指纹：`6F84E4E00F86FD100CA94FEDF63AE65454CC2288`

> **关于签名与安装**：`.asc` 是旁路边文件，不是安装 / 运行的必要条件——没有它，三个包照样能正常安装使用；它只用于下载后自行核验来源与完整性。"把签名内置进被签名的文件本身"在技术上不可行（写回会改变文件字节使签名失效）。真正内置的是 Windows exe 的 Authenticode 签名。

## 隐私与数据

- 客户端**本地优先**：会话、记忆库、设置均存储在用户数据目录，运行时默认不写用户会话内容到磁盘。
- 语音转写、模型回复、工具调用等调试日志默认关闭，仅在显式设置 `WHALE_DEBUG=1` 时记录。
- **无遥测、无隐藏外联、无全网监听**：网络请求仅限用户自行配置的模型 API 端点、本地回环地址，以及**用户主动点击「刷新模型清单 / 下载」时**访问官方发布域名获取语音模型。清单经 Ed25519 离线签名校验、模型按 SHA-256 复验；音频始终在 `127.0.0.1` 本地识别，不上传。
- 分发包内不含任何私钥、口令、License 主授权码或开发机绝对路径。
- 设置文件中的 API Key / 提供商密钥经系统密钥环加密后落盘，不再以明文保存。
- 如需排查问题并临时开启调试日志，请注意日志会包含会话内容，排查完请及时删除并关闭该开关。

## 运行时安全加固（1.1.0 安全版）

- **本地 API 令牌**：每次启动生成 256 位随机令牌，只存在于本进程内存；由本地服务注入页面，所有 `/api/*` 请求必须携带 `X-Whale-Token`。任意网页、DNS rebinding 或本机其它进程不再能直接调用本地接口读取聊天记录、修改设置或启动 Agent。
- **来源白名单**：本地服务校验 `Host` 必须为回环地址，并校验 `Origin` / `Sec-Fetch-Site`；伪造 Host 与跨站请求一律返回 403。
- **渲染进程隔离**：启用 sandbox / contextIsolation / webSecurity，禁用 Node 集成、webview、新窗口与外域导航；页面强制 CSP（脚本 nonce、`object-src 'none'`、`frame-ancestors 'none'`）与 `Referrer-Policy: no-referrer`。
- **二进制加固**：Electron fuses 关闭 `ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS`、`--inspect`，强制只从 `app.asar` 加载，并启用 asar 完整性校验与 Cookie 加密。
- **完整性校验**：asar 内嵌完整性校验始终生效；1.1.0 免费版不再比对 Windows 发布证书指纹（公开分发时用户可自行编译/签名，强制指纹只会挡住正常用户）。
- **清单可验证**：`SHA256SUMS.txt.asc` 让完整性清单本身也受 GPG 保护。
- **单一高精度语音模型按需下载**：安装包内不再附带量化小模型；唯一模型 `large-v3-turbo q8_0` 由用户主动下载，清单 Ed25519 验签 + SHA-256 复验 + HTTPS 域名白名单 + 断点续传。默认启用 `-ac 768` 编码器上下文限制以缩短等待，可在设置里关闭。

> 说明：开启 `runAsNode=false` 后，环境变量 `ELECTRON_RUN_AS_NODE` 不再能使程序退化为纯 Node 进程；若你此前依赖该变量启动，请直接用正常方式启动客户端。自签名 Authenticode 的 `UnknownError` 仍是预期现象，详见上文「安装」。

## 许可证与开源状态

**本软件为专有（闭源）软件，不是开源软件。** 本仓库仅提供编译后的二进制安装包与完整性校验文件，**不提供源代码**；仓库公开可见仅用于方便下载，不构成对源代码、商标或再分发的授权。

完整条款见仓库内 [`LICENSE`](LICENSE)：包含专有授权条款、使用限制与无担保声明，以及随包分发的第三方开源组件（highlight.js、@highlightjs/cdn-assets、DOMPurify、marked、whisper.cpp / ggml）的许可证全文。Electron / Chromium 的许可全文随安装包附带，语音引擎来源说明见包内 `resources/whisper/THIRD-PARTY-NOTICES.txt`。**1.1.0 起为免费版，不含任何授权码或激活校验**；安装后即可使用全部功能（模型 API 需自备密钥）。
