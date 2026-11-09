# WhaleCodex 1.0.0 发布说明

发布日期：2026-11-09 ｜ 发布密钥指纹：`6F84E4E00F86FD100CA94FEDF63AE65454CC2288`

## 本次包含的安装包

| 适用系统 | 安装包 | 说明 |
|----------|--------|------|
| Windows 10 / 11（x64） | `WhaleCodex-Setup-1.0.0.exe` | NSIS 安装版 |
| Windows 10 / 11（x64） | `WhaleCodex-Portable-1.0.0.exe` | 免安装便携版 |
| Debian / Ubuntu（amd64） | `whalecodex_1.0.0_amd64.deb` | dpkg 安装包 |
| Linux（x64 通用） | `WhaleCodex-1.0.0-x64.zip` | 免安装便携包 |

## 主要特性

- 本地优先的 Electron 桌面客户端，会话 / 记忆库 / 设置全部落在用户数据目录。
- 多模型、多提供商配置，内置模型目录与故障转移链（首字节看门狗超时后自动降级）。
- 上游错误分类（429 / 410 / 404 / 401 / 5xx）与模型实况探测。
- 记忆库、会话管理、本地工具调用与 Agent 工作目录白名单。
- Windows 端支持语音输入（whisper）；Linux 端自动降级为无语音引擎，不影响主程序。

## 许可状态

**专有（闭源）软件，不是开源软件。** 本仓库仅提供编译后的二进制安装包，不提供源代码；完整授权条款与随包分发的第三方开源组件许可证全文见仓库 [`LICENSE`](../../blob/main/LICENSE)。

## 安全与完整性

- 四个安装包**全部**配有 GPG 分离签名（`.asc`），统一使用同一把发布密钥。
- Windows 两个 `.exe` 内嵌 Authenticode 代码签名（CN=WhaleCodex，自签）。
- `.deb` 内嵌 `_gpgorigin` GPG 签名（dpkg-sig 约定）。
- 运行时默认不落盘用户会话内容；语音转写、模型回复、工具调用日志仅在 `WHALE_DEBUG=1` 时记录。
- 无遥测、无隐藏外联；网络请求仅限用户配置的模型 API 端点与本地回环地址。
- 加固：Windows 启动完整性门禁原先只校验证书签发者名称（可被同名自签证书伪造），现改为**硬编码比对发布证书指纹** `9D0758A2A7FAABE8E83E3773A4FB8C4274B790AA`；同时兼容自签证书的 `UnknownError` 状态，避免误判退出。

## 校验方式

见仓库 [README](../../blob/main/README.md) 的「核验下载完整性」章节，或直接下载本 Release 的 `SHA256SUMS.txt` 与 `whalecodex_pubkey.asc`。
