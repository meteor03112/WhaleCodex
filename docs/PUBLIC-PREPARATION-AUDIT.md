# 1.2.0 公开源码准备记录

准备日期：2026-11-14。目标仓库：https://github.com/meteor03112/WhaleCodex 。本记录不表示已经上传或创建发布。

## 复制范围

从授权的原项目应用目录按白名单复制：独立可读 JavaScript 模块、HTML、模板、必要 vendor 浏览器资源；main、renderer、asr-models、license 使用对应可读源版本重命名。未复制旧混淆文件、隐藏开发草稿、原 node_modules、用户设置/会话/聊天/日志/密钥、引擎、whisper 或签名/打包目录。主代码通过 app/main.js 启动。

项目所有者明确要求保留原鲸鱼娘图标、头像及连接器品牌资源；此前临时替代图标已撤销。图像许可独立于 Apache-2.0 代码许可，不声称这些图像为本次原创。没有使用用户截图。主题只保留适配代码、来源和上游许可；视频、预览与上游样式归档不分发。主题默认不加载，默认构建排除其整个目录。

## 许可来源

主代码 LICENSE 为已安装 node-gyp 所带 Python packaging 的标准 Apache License 2.0 文本；未复制其软件代码。保留 NOTICE，主代码与第三方许可分别说明。

- marked、highlight.js、DOMPurify：从本机已安装对应版本包复制许可。
- opencc-js MIT：https://raw.githubusercontent.com/nk2028/opencc-js/master/LICENSE
- OpenCC 字典 Apache-2.0：https://raw.githubusercontent.com/BYVoid/OpenCC/master/LICENSE （本地标准 Apache2 文本保留于 vendor/licenses）。
- whale-fantasy：保留原 ATTRIBUTION 与 upstream/LICENSE，CC BY-NC-SA 4.0。该例外不属于 Apache2 主代码许可，默认禁用。

## 扫描方法与处理

`scripts/scan-public.py` 扫描文字源码与配置中的常见私钥头、常见令牌模式、硬编码凭据赋值和开发机路径；输出仅文件、行和类别，不打印匹配值。扫描覆盖应用、文档和脚本，排除 node_modules、构建产物、外部运行时及 .git。通用 Windows系统路径属于可移植回退，不是开发机用户路径。

准备中发现并清理的路径类别（以下行号为初次检查时，后续可能移动）：

| 文件 | 原行 | 类别 / 处理 |
| --- | --- | --- |
| app/main.js | 1202 | 开发机用户目录，删除 Node 候选 |
| app/desktop-bridge.js | 51 | 固定开发盘符，改为环境变量或 resources 候选 |
| app/renderer.js | 1597 / 3411 / 3636 / 3675 | 固定默认工作目录，改为空值使用现有目录选择流程 |
| app/index.html | 1369 | 示例盘符，改为文件夹选择提示 |
| app/subagent-orchestrator.js | 108 | 注释中的示例盘符，删除 |

未发现符合当前扫描规则的真实私钥或疑似硬编码服务密钥；未因疑似secret额外删去业务模块。模型清单验签与旧授权验签公钥保留，它们不含私钥。模式扫描不能证明不存在所有类型的秘密，提交前仍应审查新增文件。

## 构建与验证范围

已运行 `node scripts/check.cjs`：31 个 JavaScript 文件通过语法检查。入口 package.json main=app/main.js，版本1.2.0，许可Apache-2.0。配置中没有固定开发盘符；外部引擎不在仓库内也可生成应用壳。`WHALE_EXTERNAL_RESOURCES` 只显式复制 engine 与 whisper，发布输出和本机 Electron 路径允许由环境变量提供。

完整安装器与真实运行时组合由发布负责人另行构建/验收。本记录不宣称 Windows/Linux/macOS 全部通过，不处理签名，也不触及原项目或签名/打包目录。缺少平台引擎时 Agent 不可用，缺少 whisper/模型时语音不可用。D1默认off待验收，F1目标应用拖入待验收，macOS实机待验收。
