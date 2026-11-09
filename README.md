# WhaleCodex（鲸鱼娘 · Codex 桌面客户端）

一个本地优先的 AI 编程助手桌面客户端，基于 Electron，支持多模型 / 多提供商配置、故障转移与实况探测，内置记忆库、会话管理与本地工具调用。

> 当前版本：**1.0.0** ｜ 所有安装包均由同一把 WhaleCodex 发布密钥 GPG 签名，可自行核验。

## 下载

请前往本仓库的 **[Releases 页面](../../releases/latest)** 下载。安装包体积较大（276–430 MB），未放入 Git 仓库，全部以 Release 附件形式提供。

| # | 文件 | 适用系统版本 | 形态 | 内置签名 |
|---|------|--------------|------|----------|
| 1 | `WhaleCodex-Setup-1.0.0.exe` | **Windows 10 / 11（x64）** | NSIS 安装版，安装到 Program Files，可自定义目录 | Authenticode（CN=WhaleCodex） |
| 2 | `WhaleCodex-Portable-1.0.0.exe` | **Windows 10 / 11（x64）** | 便携版，免安装，双击即用，适合 U 盘 / 无管理员权限 | Authenticode（CN=WhaleCodex） |
| 3 | `whalecodex_1.0.0_amd64.deb` | **Debian / Ubuntu 等（amd64 / x64）** | dpkg 安装包，装到 `/opt/whalecodex`，自动建 `/usr/bin/whalecodex` 软链与桌面项 | 内嵌 GPG 签名 `_gpgorigin` |
| 4 | `WhaleCodex-1.0.0-x64.zip` | **Linux（x64，任意发行版）** | 免安装便携包，解压后 `chmod +x whalecodex && ./whalecodex` | 无内嵌机制，配同名 `.asc` |

每个安装包都有**同名的 `.asc` 分离签名**；另有 `whalecodex_pubkey.asc`（发布公钥）、`SHA256SUMS.txt`（全部文件 SHA-256）及其签名 `SHA256SUMS.txt.asc`（防止清单本身被替换）。

## 安装

**Windows**：双击 `WhaleCodex-Setup-1.0.0.exe` 按向导安装，或直接运行便携版。
自签名证书会被 SmartScreen / 系统提示"发布者不受信任"（`UnknownError`），属预期现象；签名本身真实有效，客户端启动自检已兼容自签证书，不影响使用。

**Debian / Ubuntu**：
```bash
sudo dpkg -i whalecodex_1.0.0_amd64.deb
whalecodex
```

**其他 Linux 发行版**：
```bash
unzip WhaleCodex-1.0.0-x64.zip -d WhaleCodex
cd WhaleCodex
chmod +x whalecodex chrome-sandbox
./whalecodex
```

> Linux 版本不含语音输入（whisper）引擎，启动时会自动降级为"无语音引擎"，不影响主程序功能。

## 核验下载完整性

```bash
# 1) 导入发布公钥（只需一次）
gpg --import whalecodex_pubkey.asc

# 2) 逐个校验 GPG 分离签名
gpg --verify WhaleCodex-Setup-1.0.0.exe.asc      WhaleCodex-Setup-1.0.0.exe
gpg --verify WhaleCodex-Portable-1.0.0.exe.asc   WhaleCodex-Portable-1.0.0.exe
gpg --verify whalecodex_1.0.0_amd64.deb.asc      whalecodex_1.0.0_amd64.deb
gpg --verify WhaleCodex-1.0.0-x64.zip.asc        WhaleCodex-1.0.0-x64.zip

# 3) 先验证校验和清单本身的签名，再校验文件
gpg --verify SHA256SUMS.txt.asc                SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt
```

发布密钥指纹：`6F84E4E00F86FD100CA94FEDF63AE65454CC2288`

`.deb` 另可校验内嵌签名（需 `ar`）：
```bash
ar p whalecodex_1.0.0_amd64.deb _gpgorigin | gunzip | gpg --verify
```

> **关于签名与安装**：`.asc` 是旁路边文件，不是安装 / 运行的必要条件——没有它，四个包照样能正常安装使用；它只用于下载后自行核验来源与完整性。"把签名内置进被签名的文件本身"在技术上不可行（写回会改变文件字节使签名失效）。真正内置的是 Windows exe 的 Authenticode 与 `.deb` 的 `_gpgorigin`。

## 隐私与数据

- 客户端**本地优先**：会话、记忆库、设置均存储在用户数据目录，运行时默认不写用户会话内容到磁盘。
- 语音转写、模型回复、工具调用等调试日志默认关闭，仅在显式设置 `WHALE_DEBUG=1` 时记录。
- **无遥测、无隐藏外联、无全网监听**：网络请求仅限用户自行配置的模型 API 端点与本地回环地址。
- 分发包内不含任何私钥、口令、License 主授权码或开发机绝对路径。
- 设置文件中的 API Key / 提供商密钥经系统密钥环加密后落盘，不再以明文保存。
- 如需排查问题并临时开启调试日志，请注意日志会包含会话内容，排查完请及时删除并关闭该开关。

## 运行时安全加固（1.0.0 安全版）

- **本地 API 令牌**：每次启动生成 256 位随机令牌，只存在于本进程内存；由本地服务注入页面，所有 `/api/*` 请求必须携带 `X-Whale-Token`。任意网页、DNS rebinding 或本机其它进程不再能直接调用本地接口读取聊天记录、修改设置或启动 Agent。
- **来源白名单**：本地服务校验 `Host` 必须为回环地址，并校验 `Origin` / `Sec-Fetch-Site`；伪造 Host 与跨站请求一律返回 403。
- **渲染进程隔离**：启用 sandbox / contextIsolation / webSecurity，禁用 Node 集成、webview、新窗口与外域导航；页面强制 CSP（脚本 nonce、`object-src 'none'`、`frame-ancestors 'none'`）与 `Referrer-Policy: no-referrer`。
- **二进制加固**：Electron fuses 关闭 `ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS`、`--inspect`，强制只从 `app.asar` 加载，并启用 asar 完整性校验与 Cookie 加密。
- **启动门禁**：Windows 端比对发布证书指纹 `9D0758A2A7FAABE8E83E3773A4FB8C4274B790AA`，不再只凭签发者名称判断，可拦截被篡改或伪造签名的主程序。
- **清单可验证**：`SHA256SUMS.txt.asc` 让完整性清单本身也受 GPG 保护。

> 说明：开启 `runAsNode=false` 后，环境变量 `ELECTRON_RUN_AS_NODE` 不再能使程序退化为纯 Node 进程；若你此前依赖该变量启动，请直接用正常方式启动客户端。自签名 Authenticode 的 `UnknownError` 仍是预期现象，详见上文「安装」。

## 许可证与开源状态

**本软件为专有（闭源）软件，不是开源软件。** 本仓库仅提供编译后的二进制安装包与完整性校验文件，**不提供源代码**；仓库公开可见仅用于方便下载，不构成对源代码、商标或再分发的授权。

完整条款见仓库内 [`LICENSE`](LICENSE)：包含专有授权条款、使用限制与无担保声明，以及随包分发的第三方开源组件（highlight.js、@highlightjs/cdn-assets、DOMPurify、marked）的许可证全文。Electron / Chromium 的许可全文随安装包附带。软件内的授权 / 激活机制另行适用。
