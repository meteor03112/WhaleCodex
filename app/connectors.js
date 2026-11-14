/*
 * 连接器注册表（鲸鱼娘 · Codex）
 * 同时供 渲染进程（window.WHALE_CONNECTORS）与主进程（require）使用。
 *
 * 每条连接器：
 *   id        唯一标识，也是写入 Codex 引擎 config.toml [mcp_servers.<id>] 的段名
 *   name/cat/desc  显示用
 *   iconUrl   官方品牌图（128px PNG，来自官方站点 / 官方 App Store 图标）
 *   icon      官方图加载失败时的兜底 emoji
 *   auth      'local' | 'token' | 'oauth'
 *   oauthFlow 是否支持客户端「自主发起授权」（借助 codex mcp login：DCR + PKCE + 本地回调）
 *   note      面板里的补充说明（端点现状 / 授权注意事项）
 *   fields    连接表单字段；secret:true 的字段加密落盘
 *   defaultUrl 默认服务地址（可被用户覆盖）
 *   build(cfg, ctx) → { command,args,env } 本地 / { url, bearerEnv? } 令牌 / { url } OAuth
 *
 * 【端点核实 2026-11-10】下列默认地址均经真实请求验证（POST initialize）：
 *   github        api.githubcopilot.com/mcp  → 401 + OAuth 元数据（官方不支持动态注册，用 PAT）
 *   gitlab        gitlab.com/api/v4/mcp      → 401 + OAuth 元数据（支持 DCR，可自主授权）
 *   notion        mcp.notion.com/mcp         → 401 + OAuth 元数据（可自主授权）
 *   tencent-docs  docs.qq.com/openapi/mcp    → 401 + OAuth 元数据（可自主授权）
 *   feishu        mcp.feishu.cn/mcp          → 401 + OAuth 元数据，但 DCR 拒绝 127.0.0.1 回调
 *   企业微信 / 腾讯会议 / 腾讯自选股 / 百度网盘 / 可灵 / Tushare / QQ邮箱 / 通达信：
 *                 实测 404 / 超时 / 连接重置 —— 服务商目前未公开 MCP 端点，
 *                 因此不预设地址，留空由用户填自建网关或私有地址。
 */
(function (root, factory) {
  const list = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = list;
  if (typeof window !== 'undefined') window.WHALE_CONNECTORS = list;
})(this, function () {
  return [
    /* ---------- 开发 ---------- */
    {
      id: 'whaletools', name: '鲸鱼娘工具箱（本地）', cat: '开发',
      iconUrl: 'connector-icons/whaletools.png', icon: '🐳',
      desc: '在本地运行的工具集：读取文件、列出目录、获取当前时间、做算式计算。不联网、无需密钥，开箱即用。',
      auth: 'local', fields: [],
      build: (cfg, ctx) => ({ command: ctx.nodeExe, args: [ctx.serverPath], env: ctx.mcpEnv || {} }),
    },
    {
      id: 'github', name: 'GitHub', cat: '开发',
      iconUrl: 'connector-icons/github.png', icon: '🐙',
      desc: '通过个人访问令牌（PAT）连接 GitHub 官方 MCP（api.githubcopilot.com），管理仓库、Issue、PR。',
      note: '官方端点不支持自动注册 OAuth 客户端，请用 PAT 连接（需 repo / read:org 等权限）。',
      auth: 'token', oauthFlow: false,
      fields: [{ key: 'token', label: 'GitHub PAT', placeholder: 'ghp_xxx', secret: true }],
      defaultUrl: 'https://api.githubcopilot.com/mcp',
      build: () => ({ url: 'https://api.githubcopilot.com/mcp', bearerEnv: 'WHALE_GITHUB_TOKEN' }),
    },
    {
      id: 'gitlab', name: 'GitLab', cat: '开发',
      iconUrl: 'connector-icons/gitlab.png', icon: '🦊',
      desc: '连接 GitLab 官方 MCP（SaaS 或自建实例），支持一键授权（自动注册客户端 + PKCE）。',
      note: '点「授权」会打开浏览器完成 GitLab 登录；自建实例请先填实例地址。',
      auth: 'oauth', oauthFlow: true,
      fields: [{ key: 'url', label: '实例地址（可选）', placeholder: 'https://gitlab.com/api/v4/mcp' }],
      defaultUrl: 'https://gitlab.com/api/v4/mcp',
      build: (cfg) => ({ url: cfg.url || 'https://gitlab.com/api/v4/mcp' }),
    },

    /* ---------- 文档知识 ---------- */
    {
      id: 'notion', name: 'Notion', cat: '文档知识',
      iconUrl: 'connector-icons/notion.png', icon: '📝',
      desc: '连接 Notion 官方 MCP，读写页面与数据库，支持一键授权。',
      note: '点「授权」后在浏览器里选择要授权的工作区即可。',
      auth: 'oauth', oauthFlow: true,
      fields: [],
      defaultUrl: 'https://mcp.notion.com/mcp',
      build: () => ({ url: 'https://mcp.notion.com/mcp' }),
    },
    {
      id: 'tencent-docs', name: '腾讯文档', cat: '文档知识',
      iconUrl: 'connector-icons/tencent-docs.png', icon: '📄',
      desc: '读写腾讯文档（在线表格/文档），支持一键授权（docs:read / write / manage）。',
      note: '点「授权」会跳转腾讯文档授权页，需已登录腾讯文档账号。',
      auth: 'oauth', oauthFlow: true,
      fields: [],
      defaultUrl: 'https://docs.qq.com/openapi/mcp',
      build: () => ({ url: 'https://docs.qq.com/openapi/mcp' }),
    },
    {
      id: 'feishu', name: '飞书', cat: '文档知识',
      iconUrl: 'connector-icons/feishu.png', icon: '🐦',
      desc: '连接飞书官方 MCP（mcp.feishu.cn），文档 / 多维表格等。',
      note: '飞书的动态注册拒绝 127.0.0.1 回调，暂不能一键授权；需在飞书开放平台登记应用后填自建地址。',
      auth: 'oauth', oauthFlow: false,
      fields: [{ key: 'url', label: '服务地址', placeholder: 'https://mcp.feishu.cn/mcp' }],
      defaultUrl: 'https://mcp.feishu.cn/mcp',
      build: (cfg) => ({ url: cfg.url || 'https://mcp.feishu.cn/mcp' }),
    },
    {
      id: 'wecom', name: '企业微信', cat: '文档知识',
      iconUrl: 'connector-icons/wecom.png', icon: '💬',
      desc: '企业微信会话与文档（自建网关 / 私有 MCP）。',
      note: '官方未公开 MCP 端点（mcp.wecom.work 实测不可达），需填自建地址。',
      auth: 'token', oauthFlow: false,
      fields: [
        { key: 'url', label: '服务地址', placeholder: 'https://your-gateway/mcp' },
        { key: 'token', label: '网关令牌', placeholder: '网关提供的 token', secret: true },
      ],
      defaultUrl: '',
      build: (cfg) => ({ url: cfg.url || '', bearerEnv: 'WHALE_WECOM_TOKEN' }),
    },
    {
      id: 'obsidian', name: 'Obsidian 本地库', cat: '文档知识',
      iconUrl: 'connector-icons/obsidian.png', icon: '🪨',
      desc: '连接本地 Obsidian Local REST API 插件（需插件运行并开启 HTTPS/HTTP 端口）。',
      note: '需在本机安装并启用 Local REST API 插件，地址与密钥来自插件设置。',
      auth: 'token', oauthFlow: false,
      fields: [
        { key: 'url', label: '本地地址', placeholder: 'http://127.0.0.1:27124' },
        { key: 'token', label: 'REST API Key', placeholder: '插件设置的密钥', secret: true },
      ],
      defaultUrl: 'http://127.0.0.1:27124',
      build: (cfg) => ({ url: cfg.url || 'http://127.0.0.1:27124', bearerEnv: 'WHALE_OBSIDIAN_TOKEN' }),
    },

    /* ---------- 效率通信 ---------- */
    {
      id: 'qqmail', name: 'QQ 邮箱', cat: '效率通信',
      iconUrl: 'connector-icons/qqmail.png', icon: '✉️',
      desc: '通过 IMAP/MCP 网关读取与发送邮件（自建网关）。',
      note: '腾讯未提供公开 MCP 端点，需填自建 IMAP 网关地址。',
      auth: 'token', oauthFlow: false,
      fields: [
        { key: 'url', label: '网关地址', placeholder: 'https://your-imap-gateway/mcp' },
        { key: 'token', label: '网关令牌', placeholder: '网关提供的 token', secret: true },
      ],
      defaultUrl: '',
      build: (cfg) => ({ url: cfg.url || '', bearerEnv: 'WHALE_QQMAIL_TOKEN' }),
    },
    {
      id: 'tencent-meeting', name: '腾讯会议', cat: '效率通信',
      iconUrl: 'connector-icons/tencent-meeting.png', icon: '🎥',
      desc: '会议录制与纪要（自建网关 / 私有 MCP）。',
      note: '官方未公开 MCP 端点（实测 404），需填自建地址。',
      auth: 'token', oauthFlow: false,
      fields: [
        { key: 'url', label: '服务地址', placeholder: 'https://your-gateway/mcp' },
        { key: 'token', label: '网关令牌', placeholder: '网关提供的 token', secret: true },
      ],
      defaultUrl: '',
      build: (cfg) => ({ url: cfg.url || '', bearerEnv: 'WHALE_MEETING_TOKEN' }),
    },

    /* ---------- 数据金融 ---------- */
    {
      id: 'tushare', name: 'Tushare', cat: '数据金融',
      iconUrl: 'connector-icons/tushare.png', icon: '📈',
      desc: 'A 股数据接口（需自建 MCP 网关，内部调用 Tushare token）。',
      note: 'Tushare 只提供 HTTP API，未提供 MCP 端点，需自建网关包装。',
      auth: 'token', oauthFlow: false,
      fields: [
        { key: 'url', label: '网关地址', placeholder: 'https://your-gateway/mcp' },
        { key: 'token', label: 'Tushare Token', placeholder: '你的 Tushare token', secret: true },
      ],
      defaultUrl: '',
      build: (cfg) => ({ url: cfg.url || '', bearerEnv: 'WHALE_TUSHARE_TOKEN' }),
    },
    {
      id: 'tencent-stock', name: '腾讯自选股', cat: '数据金融',
      iconUrl: 'connector-icons/tencent-stock.png', icon: '📊',
      desc: '行情与自选股（自建网关 / 私有 MCP）。',
      note: '官方未公开 MCP 端点（实测不可达），需填自建地址。',
      auth: 'token', oauthFlow: false,
      fields: [
        { key: 'url', label: '服务地址', placeholder: 'https://your-gateway/mcp' },
        { key: 'token', label: '网关令牌', placeholder: '网关提供的 token', secret: true },
      ],
      defaultUrl: '',
      build: (cfg) => ({ url: cfg.url || '', bearerEnv: 'WHALE_STOCK_TOKEN' }),
    },
    {
      id: 'tdx', name: '通达信', cat: '数据金融',
      iconUrl: 'connector-icons/tdx.png', icon: '💹',
      desc: '通过本地/远程行情网关查询（需网关地址与令牌）。',
      note: '通达信未提供 MCP 端点，需自建行情网关。',
      auth: 'token', oauthFlow: false,
      fields: [
        { key: 'url', label: '网关地址', placeholder: 'http://127.0.0.1:xxxx/mcp' },
        { key: 'token', label: '网关令牌', placeholder: '网关 token', secret: true },
      ],
      defaultUrl: '',
      build: (cfg) => ({ url: cfg.url || '', bearerEnv: 'WHALE_TDX_TOKEN' }),
    },

    /* ---------- 设计媒体 ---------- */
    {
      id: 'kling', name: '可灵 AI', cat: '设计媒体',
      iconUrl: 'connector-icons/kling.png', icon: '🎨',
      desc: '文生视频 / 图（需自建 MCP 网关，内部调用可灵 API）。',
      note: '可灵未公开 MCP 端点（实测 404），需自建网关包装其 API。',
      auth: 'token', oauthFlow: false,
      fields: [
        { key: 'url', label: '网关地址', placeholder: 'https://your-gateway/mcp' },
        { key: 'token', label: 'API Token', placeholder: '可灵 API token', secret: true },
      ],
      defaultUrl: '',
      build: (cfg) => ({ url: cfg.url || '', bearerEnv: 'WHALE_KLING_TOKEN' }),
    },

    /* ---------- 云盘存储 ---------- */
    {
      id: 'baidu-netdisk', name: '百度网盘', cat: '云盘存储',
      iconUrl: 'connector-icons/baidu-netdisk.png', icon: '☁️',
      desc: '网盘文件管理（自建网关 / 私有 MCP）。',
      note: '官方未公开 MCP 端点（实测 404），需填自建地址。',
      auth: 'token', oauthFlow: false,
      fields: [
        { key: 'url', label: '服务地址', placeholder: 'https://your-gateway/mcp' },
        { key: 'token', label: '网关令牌', placeholder: '网关提供的 token', secret: true },
      ],
      defaultUrl: '',
      build: (cfg) => ({ url: cfg.url || '', bearerEnv: 'WHALE_PAN_TOKEN' }),
    },
  ];
});
