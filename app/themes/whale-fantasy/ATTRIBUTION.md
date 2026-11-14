# 主题来源、许可与适配说明 · whale-fantasy

## 主题

- 名称：鲸鱼娘 · 未至之境（Whale Girl · The Unreached）
- 版本：1.0.0
- 作者：**stushansusu**
- 来源仓库：`zhu1090093659/dsh-web`
- 固定提交：`971cc3e1f6f5b52bbcd86802a9be0e0c50fc32f1`
- 原始路径：`market/dist/assets/skins/whale-fantasy`
- 来源 URL：https://github.com/zhu1090093659/dsh-web/tree/971cc3e1f6f5b52bbcd86802a9be0e0c50fc32f1/market/dist/assets/skins/whale-fantasy

## 许可

**Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International（CC BY-NC-SA 4.0）**

许可全文见 `upstream/LICENSE`，或 https://creativecommons.org/licenses/by-nc-sa/4.0/

该许可同时覆盖皮肤样式与背景视频。使用范围：

- 允许：署名前提下自用、非商业分享、改编并以相同许可共享。
- 要求：保留作者署名、许可标识、来源与改动说明；改编部分同样以 CC BY-NC-SA 4.0 发布。
- 限制：不得用于商业用途。若后续收费、广告、商业捆绑或推广，需另行核对许可或向作者取得授权。
- 本文件不构成法律意见。

## 原样归档（未修改）

以下文件按上游原样保留于 `upstream/`，仅供追溯，**不作为运行样式加载**：

| 文件 | 字节 | SHA-256 |
|---|---:|---|
| `upstream/skin.json` | 2489 | `5F8E70A151C9015E3D64E2B51D6A658B5B4DDF7BA3A63F058C77AF200E168173` |
| `upstream/skin.css` | 12205 | `EA02FD6E0236A0006504D0B3C08BFE6168A23D1D1BC8E245E7F5FAA576A2CF68` |
| `upstream/patches.css` | 76644 | `A297F26502AECE76D13AF9637676D2D8F7BECAA795979B2ADAF0EC55AAE5862F` |
| `upstream/README.zh.md` | 5912 | `0DC1A70042A703922C168861169D61B97C691CE00D919942F60BC392EA2C67AD` |
| `upstream/LICENSE` | 20849 | `1349A4B6148492B44F629E64EED676612E234FE9A839E4F3B277C1482C8849F1` |
| `upstream/preview/dark.jpg` | 172483 | `2252D5398E7BE62A28B5E14B3DBDB42727F0F8AA58613FF8E6B69DBE10CBEF7A` |
| `assets/whale-fantasy-loop.mp4` | 6630589 | `DB8A022AC3BF877EFB764CA4962E79C9B32CC07FA4BE2CBC8AC98D4DF0310E4D` |

背景视频为作者提供的完整循环版本（1664×856、24fps、611 帧、约 25.46 秒），已由作者裁去源片上下各 46px 黑边并烘焙尾头交叉淡入。WhaleCodex **保留原分发文件**，未裁剪、未重编码、未缩短、未二次加淡入。

归档不含 manifest 引用的 light 预览，因此本目录不是完整可安装的市场包。

## 适配改动（WhaleCodex 侧）

`whale-native.css` 与 `whale-background.js` 是为 WhaleCodex 原生界面重写的适配层，**不是上游文件副本**：

1. **选择器重新映射**：上游面向 DSH 的 `[data-slot]` / `[data-dsh-surface]` / `[data-dsh-part]` 钩子，改为 WhaleCodex 的真实类名与 ID（`.sidebar`、`.topbar`、`.composer`、`.sb-item-row`、`.set-page .sect` 等）。不向页面堆伪造宿主属性。
2. **背景合成**：上游用 `ff-lift` 关键帧把 z-index −2 的背景层抬到 1（针对原宿主合成顺序的修正）。WhaleCodex 背景层**从正层级 1 起步**，`.app` 为 2，因此不复制负层级与 700ms 延迟跳变。
3. **布局来源不同**：宏观空间参数（侧栏 264/240、顶栏 56、阅读列 848/1008、输入列同轴）取自 WorkBuddy 的静态资料与本方案设计适配值；皮肤只负责材质、颜色、字体角色、边线与微观圆角。二者不互相覆盖。
4. **品牌与版本**：不移植上游「把品牌替换为皮肤名、把版本收为 0」的规则，保留 WhaleCodex 身份与真实版本。
5. **客户端独有控件**：推理强度滑块（262px 卡片 / 22 颗粒子 / Ultra 皮肤）为本客户端独有交互，上游无同款组件；仅映射配色与边线，不改几何、粒子与定位数学。
6. **代码高亮**：上游未为本客户端的 highlight.js 语法类提供一对一映射。`whale-native.css` 按皮肤语言逐类建立暗色配色，属适配项，不称上游原版。
7. **系统标题栏**：原生窗口边框不在 Web 皮肤可控范围，保留窗口机制，不为截图效果改为无边框窗口。
8. **未引入**：DSH 插件宿主、主题市场、桌宠 / 挂件、欢迎页、启动动画、账户或积分系统。

## 适配差异清单（与上游不完全一致，逐项说明原因）

| 项 | 上游值 | 本适配值 | 原因 |
|---|---|---|---|
| 代码块 / 表格底色 | `#05070d9e` | `#05070dc7` | 实测明亮视频帧下 0.62 叠加后底色被抬到 RGB≈100，代码 token 与表头对比不足；提高不透明度仍保留画面透出 |
| 用户内气泡底色 | 外壳 token（`bg-layer-2` = `#1428478f`） | `#142847d9` | 上游 bubble 吃的是面板色而非外层 row 的淡蓝；只给淡蓝（0x8f）在明亮视频帧上会整块消失，实测叠加后与背景几乎同亮度。提高到 0xd9 让气泡成立；外层 message-row 仍是 `#3a7bff1a` + 2px 青线，两层不混为一层 |
| 推理块 / 工具行底色 | 无上游对应 | `#0a1020a6` / `#0a10208c` | 同属「内容面」可读性调整，语言与设置卡一致 |
| 提供商卡 | 无上游对应 | 整行铺满 | 文档要求「复杂提供商整行」；留在右列会把名称挤成省略号 |
| 设置外壳圆角 | 无上游同类外壳实测 | 24px | 沿用 WorkBuddy 模态规格，列为本方案适配值 |
| 阅读列与输入列宽度 | 无上游对应 | 848 / 1008 | 来自 WorkBuddy 静态资料，属主动统一到本客户端 |
| 语法高亮 | 无上游映射 | 逐类自建 | 上游未为本客户端 highlight.js 类提供一对一映射 |
| 系统标题栏 | — | 保留原生窗口边框 | 不在 Web 皮肤可控范围，不为截图效果改无边框窗口 |
| Ultra / 能量粒子 | 无上游同款 | 保留客户端原行为 | 客户端独有交互，只换配色不改几何与定位数学 |
| 滚动条 | `body * { scrollbar-color: #39ffd14d transparent }`（未指定宽度） | 同一青色 `#39ffd14d`（hover `#39ffd1a6`），用 `::-webkit-scrollbar` 实现，宽 10px + 2px 内缩 + 6px 圆角 | 实测 Electron 45 下标准 `scrollbar-color` 会接管滚动容器并忽略伪元素，宽度回落到平台默认 **15px**（客户端基线 10px）。按「保留合理几何」改用伪元素，颜色对齐、宽度不变；两套规则不并存，避免互相覆盖 |

背景视频在上述任何一项调整中均**未改动**：文件哈希保持 `DB8A022AC3BF877EFB764CA4962E79C9B32CC07FA4BE2CBC8AC98D4DF0310E4D`，未裁剪、未重编码、未加速、未替换。

## 已知的可访问性冲突

原皮肤以「文字自带单向柔光」承担正文对比度（`0 0 10px #05070deb, 0 0 24px #05070d9e`）。背景视频包含高亮帧，正文压在其最亮处时对比度会低于 WCAG AA。本适配**沿用上游做法**，未额外增加全屏重遮罩；结构化内容（代码 / 表格 / 推理块）通过加深局部底色缓解。系统开启「减少动态效果」时背景自动暂停，可在设置 → 自检与诊断 → 主题来源与许可中手动暂停或恢复。

## 免责

保留作者原有说明及许可中的免责声明。本适配不暗示作者为 WhaleCodex 客户端提供背书。

WhaleCodex 其他独立代码与第三方组件按各自许可处理；本目录下的皮肤改编部分依 CC BY-NC-SA 4.0 分享。
