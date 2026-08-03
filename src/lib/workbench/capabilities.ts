/**
 * 工作台能力注册表 —— composer 的欢迎建议 chip 与 `/` 命令的单一真源。
 *
 * 设计约定（对齐业界主流 Agent 产品）：
 * - `@` = 引用/上下文（主体、参考图…），在 thread.tsx 的 mention adapter 里。
 * - `/` = 功能/命令，取本表中 `slash: true` 的能力。
 * - 欢迎页 chip 取本表全部分组。
 *
 * 动作语义（run 的分发见 CapabilityActions.tsx）：
 * - fill：把提示词写进输入框，由用户自己发送（对齐「填入不发送」约定）。
 * - image-picker / matting-picker / import-picker：拉起文件选择器。
 * - video-dialog：打开视频链接输入卡。
 * - image2-mode：切到生图模式。
 */
export type CapabilityAction =
  | "fill"
  | "image-picker"
  | "video-dialog"
  | "matting-picker"
  | "import-picker"
  | "video-picker"
  | "image2-mode"
  | "video-generation-mode"
  | "product-pipeline";

export type CapabilityOption = {
  id: string;
  label: string;
  prompt: string;
  /** 默认 "fill"。 */
  action?: CapabilityAction;
  /** 供 `/` 命令使用的图标键；仅 slash 能力需要。 */
  iconKey?: string;
  /** `/` 命令项的副标题（一句话说明）；仅 slash 能力需要。 */
  hint?: string;
  /** 是否作为 `/` 命令暴露（真能力入口）。 */
  slash?: boolean;
  /**
   * 留口子、还没上线的能力：chip 灰显不可点，也不会进 `/` 命令面板
   * （`/` 里出现就意味着能执行，别把做不了的活派给模型）。
   */
  disabled?: boolean;
  /** 灰显 chip 尾部的徽标文案，如「即将上线」。 */
  badge?: string;
};

export type CapabilityGroup = {
  id: string;
  label: string;
  /** 供欢迎页分组 chip 使用的图标键。 */
  iconKey: string;
  options: CapabilityOption[];
};

export const CAPABILITY_GROUPS: CapabilityGroup[] = [
  {
    id: "mono",
    label: "创作工具",
    iconKey: "sparkles",
    options: [
      {
        id: "product-pipeline",
        label: "商品套图",
        prompt: "",
        action: "product-pipeline",
        iconKey: "image",
        hint: "选择商品文件夹，一键生成帽子白底主图与详情套图",
        slash: true,
      },
      {
        id: "reverse-image",
        label: "反推图片",
        prompt: "反推这张图片，生成可复用的 AI 生图提示词。",
        action: "image-picker",
        iconKey: "image",
        hint: "选一张图，反推可复用的生图提示词",
        slash: true,
      },
      {
        id: "generate-image",
        label: "生成图片",
        prompt:
          "生成一张电商产品主图：白色陶瓷马克杯，干净白底，柔和自然光，45 度俯拍，高清商业摄影，1:1。",
        action: "image2-mode",
        iconKey: "sparkles",
        hint: "进入生图模式，按模板出图",
        slash: true,
      },
      {
        id: "analyze-video",
        label: "分析视频",
        prompt: "我想分析一段视频，请提示我粘贴公开视频链接。",
        action: "video-dialog",
        iconKey: "video",
        hint: "粘贴链接或上传，分析视频内容",
        slash: true,
      },
      {
        id: "matting",
        label: "抠像换背景",
        prompt: "把这张图片做主体抠像，输出透明背景。",
        action: "matting-picker",
        iconKey: "scissors",
        hint: "选一张图，抠出主体换背景",
        slash: true,
      },
    ],
  },
  {
    id: "video-toolbox",
    label: "视频工具箱",
    iconKey: "film",
    options: [
      {
        id: "generate-video",
        label: "生成视频",
        prompt: "",
        action: "video-generation-mode",
        iconKey: "film",
        hint: "创建文生或图生视频，规格以当前 provider 能力为准",
        slash: true,
      },
      {
        id: "video-erase",
        label: "智能擦除",
        prompt: "擦掉这个视频里的字幕。",
        action: "video-picker",
        iconKey: "eraser",
        hint: "选视频，框选区域擦掉字幕/水印",
        slash: true,
      },
      {
        id: "video-enhance",
        label: "修复增强",
        prompt: "把这个视频做修复增强，放大 4 倍。",
        action: "video-picker",
        iconKey: "wand",
        hint: "选视频，超分放大 + 去噪",
        slash: true,
      },
      {
        id: "video-matting",
        label: "抠像换背景",
        prompt: "把这个视频里的人物抠出来，换成白色背景。",
        action: "video-picker",
        iconKey: "scissors",
        hint: "选视频，抠出人物换纯色背景",
        slash: true,
      },
      // 以下是路线图上留口子的能力：可见传达进度，不可点避免派出做不了的活。
      // 上线时把 disabled/badge 去掉、补上 action 与 slash 即可。
      {
        id: "video-translate-dub",
        label: "翻译配音",
        prompt: "",
        disabled: true,
        badge: "即将上线",
      },
      {
        id: "video-lip-sync",
        label: "口型同步",
        prompt: "",
        disabled: true,
        badge: "即将上线",
      },
      {
        id: "video-motion-transfer",
        label: "动作迁移",
        prompt: "",
        disabled: true,
        badge: "即将上线",
      },
    ],
  },
  {
    id: "ecommerce",
    label: "电商数据",
    iconKey: "chart",
    options: [
      {
        id: "rank-events",
        label: "看榜单异动",
        prompt:
          "查询最新一轮抖音罗盘短视频榜的异动事件（新进榜和排名急升），帮我解读哪些商品值得关注，按优先级给出理由。",
        iconKey: "activity",
        hint: "查最新榜单的新进榜与急升",
        slash: true,
      },
      {
        id: "rank-trend",
        label: "查商品排名轨迹",
        prompt:
          "我想查一个商品在抖音罗盘短视频榜的排名轨迹，请先问我商品 ID 或先列出最近的异动商品让我选。",
        iconKey: "trending-up",
        hint: "查单个商品的排名走势",
        slash: true,
      },
      {
        id: "collector-search",
        label: "检索采集内容",
        prompt:
          "列出已导入的抓取批次，然后帮我检索分析其中的内容：总结标题风格、互动数据分布，找出表现最好的几条。",
        iconKey: "search",
        hint: "检索分析已导入的抓取批次",
        slash: true,
      },
      {
        id: "collector-import",
        label: "导入采集结果",
        prompt: "导入抓取结果文件。",
        action: "import-picker",
        iconKey: "upload",
        hint: "上传 XLSX/CSV 抓取结果",
        slash: true,
      },
    ],
  },
  {
    id: "agent",
    label: "Agent 能力",
    iconKey: "bot",
    options: [
      {
        id: "agent-tools",
        label: "你能调用哪些工具？",
        prompt: "介绍一下你当前可以调用的工具和能力，各举一个使用场景",
      },
      {
        id: "agent-memory",
        label: "测试跨轮记忆",
        prompt:
          "记住：我的品牌主色是黛蓝色（#2E4057）。之后设计类的建议都要基于它。",
      },
      {
        id: "agent-multistep",
        label: "多步拆解任务",
        prompt:
          "我要为一款新咖啡豆做一页宣传落地页，请先列出执行步骤，再逐步产出每一步的内容",
      },
    ],
  },
  {
    id: "writing",
    label: "创作",
    iconKey: "pencil-line",
    options: [
      {
        id: "write-launch",
        label: "产品发布文案",
        prompt: "为一个 AI 创作工作台的新版本写一段 200 字以内的发布文案，克制、专业",
      },
      {
        id: "write-xhs",
        label: "小红书图文脚本",
        prompt: "帮我写一篇介绍手冲咖啡入门的小红书图文脚本，包含每张配图的画面描述",
      },
      {
        id: "write-storyboard",
        label: "视频分镜脚本",
        prompt: "为 30 秒的产品宣传短视频写分镜脚本，产品是一款便携榨汁杯",
      },
    ],
  },
  {
    id: "analysis",
    label: "分析",
    iconKey: "chart",
    options: [
      {
        id: "analyze-compare",
        label: "对比两种方案",
        prompt: "用表格对比服务端持有 API key 按次计费与用户自带 key 两种商业模式的优劣",
      },
      {
        id: "analyze-competitor",
        label: "拆解竞品卖点",
        prompt: "假设竞品是一个浏览器里的 AI 修图插件，帮我拆解它可能的核心卖点和差异化机会",
      },
    ],
  },
  {
    id: "brainstorm",
    label: "头脑风暴",
    iconKey: "lightbulb",
    options: [
      {
        id: "brainstorm-features",
        label: "插件新功能点子",
        prompt: "为一个面向创作者的 Chrome 侧边栏 AI 插件头脑风暴 5 个新功能，按实现难度排序",
      },
      {
        id: "brainstorm-ops",
        label: "激活码运营玩法",
        prompt: "围绕图像/视频生成配额激活码，头脑风暴几种拉新和复购的运营玩法",
      },
    ],
  },
];

/**
 * `/` 命令入口：本表中标记 slash 且已上线的真能力
 * （反推/生成/分析视频/抠像/擦除/增强/榜单/轨迹/检索/导入）。
 */
export const SLASH_CAPABILITIES: CapabilityOption[] = CAPABILITY_GROUPS.flatMap(
  (group) => group.options.filter((option) => option.slash && !option.disabled),
);
