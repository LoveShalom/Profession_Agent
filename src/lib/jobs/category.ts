/**
 * 岗位分类（通用完整）+ 投递定位（主投 / 副投 / 碰运气）
 *
 * 为什么分两层：
 *   · **分类**回答"这是什么岗位"（通用：医学影像 / CV / AI 应用 / 后端 / 数据…）；
 *   · **定位**回答"对我的求职策略重要吗"（用户当前：主投医学影像算法，副投 CV 与 AI 应用，其余碰运气）。
 *   拆开后分类可以保持通用完整，而策略（主投/副投/碰运气）可随时调整。
 *
 * 派生规则：标题×3 + 技能×2 + 原文×1 权重；纯 ASCII 关键词按词边界匹配（CT 不会命中 react），
 * 中文关键词按子串（已移除"脑"这类单字，避免命中"电脑"）。没命中任何分类 → 其他（不猜）。
 */

export type CampaignTier = 'primary' | 'secondary' | 'casual';

export interface JobCategory {
  code: string;
  label: string;
  /** 投递定位：主投 / 副投 / 碰运气 */
  tier: CampaignTier;
  keywords: readonly string[];
}

export const TIER_LABEL: Record<CampaignTier, string> = {
  primary: '主投',
  secondary: '副投',
  casual: '碰运气',
};

/** 推荐分类（顺序即优先级；同分时排前面的赢）——覆盖各技术大类，保持通用 */
export const JOB_CATEGORIES: readonly JobCategory[] = [
  {
    code: 'algo-medical-imaging',
    label: '医学影像算法',
    tier: 'primary',
    keywords: ['医学影像', '医学图像', '影像', '核磁', 'MRI', 'CT', 'fMRI', 'DTI', 'DWI', 'NODDI', '脑影像', '脑区', '脑部', '放射', '病灶', '卒中', '医学图像分割'],
  },
  {
    code: 'ai-app',
    label: 'AI 应用（RAG/Agent/多模态）',
    tier: 'secondary',
    keywords: ['RAG', 'Agent', '智能体', '多模态', '知识库', 'function calling', 'MCP', '提示词', 'prompt', 'AI 应用', '大模型应用', 'LLM 应用'],
  },
  {
    code: 'algo-cv',
    label: 'CV 算法',
    tier: 'secondary',
    keywords: ['计算机视觉', 'CV', '目标检测', '图像分割', '视觉', 'SAM', 'YOLO', 'BEV', '3D 检测', '点云', '视频理解', '图像识别'],
  },
  {
    code: 'algo-llm',
    label: '大模型算法',
    tier: 'casual',
    keywords: ['大模型', 'LLM', '预训练', '微调', '对齐', '强化学习', 'Transformer', '分布式训练', '推理优化'],
  },
  {
    code: 'algo-nlp',
    label: 'NLP 算法',
    tier: 'casual',
    keywords: ['自然语言', 'NLP', '文本分类', '信息抽取', '对话系统', '检索', '知识图谱'],
  },
  {
    code: 'algo-recsys',
    label: '推荐/搜索算法',
    tier: 'casual',
    keywords: ['推荐', '搜索', '排序', '召回', '广告', 'CTR'],
  },
  {
    code: 'data',
    label: '数据/数仓',
    tier: 'casual',
    keywords: ['数据仓库', '数仓', 'ETL', '数据分析', 'BI', 'Spark', 'Hive', 'Flink', '数据工程'],
  },
  {
    code: 'backend',
    label: '后端开发',
    tier: 'casual',
    keywords: ['后端', '服务端', 'Java', 'Go', 'Golang', 'Spring', '微服务', 'C++', 'PHP', '.NET'],
  },
  {
    code: 'frontend',
    label: '前端开发',
    tier: 'casual',
    keywords: ['前端', 'React', 'Vue', 'TypeScript', 'Web', '小程序', 'H5', 'Flutter'],
  },
  {
    code: 'embedded',
    label: '嵌入式/硬件',
    tier: 'casual',
    keywords: ['嵌入式', '单片机', 'FreeRTOS', '驱动', 'FPGA', '硬件', '电路', 'Verilog'],
  },
  {
    code: 'test',
    label: '测试/QA',
    tier: 'casual',
    keywords: ['测试开发', '测试工程师', 'QA', '自动化测试', 'Selenium', '性能测试'],
  },
  {
    code: 'ops',
    label: '运维/SRE',
    tier: 'casual',
    keywords: ['运维', 'SRE', 'Kubernetes', 'K8s', 'Docker', 'DevOps', '云原生'],
  },
  {
    code: 'security',
    label: '安全',
    tier: 'casual',
    keywords: ['安全', '渗透', '攻防', '漏洞', '等保', '风控'],
  },
  {
    code: 'product',
    label: '产品/运营',
    tier: 'casual',
    keywords: ['产品经理', '产品设计', '需求分析', 'PRD', '运营'],
  },
  {
    code: 'other',
    label: '其他',
    tier: 'casual',
    keywords: [],
  },
];

export const OTHER_CATEGORY: JobCategory = JOB_CATEGORIES[JOB_CATEGORIES.length - 1]!;

/** 中文标签 → code（台账 CSV 里存中文标签，读回时反查） */
const LABEL_TO_CODE = new Map(JOB_CATEGORIES.map((category) => [category.label, category.code]));

const CATEGORY_BY_CODE = new Map(JOB_CATEGORIES.map((category) => [category.code, category]));

export interface CategoryMatch {
  code: string;
  label: string;
  tier: CampaignTier;
  /** 命中依据（UI 展示"为什么是这个分类"） */
  reason: string;
  score: number;
}

const TITLE_WEIGHT = 3;
const SKILL_WEIGHT = 2;
const TEXT_WEIGHT = 1;

/**
 * 关键词命中（大小写不敏感）：
 *   · 纯 ASCII（CT / CV / LLM / RAG…）按"词边界"匹配，避免 `CT` 命中 `react`；
 *   · 中文用子串匹配（词表已去掉单字）。
 */
function keywordHit(haystack: string, keyword: string): boolean {
  const key = keyword.toLowerCase();
  const isAscii = /^[a-z0-9+#.\s-]+$/.test(key);
  if (!isAscii) return haystack.includes(key);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
}

export function deriveJobCategory(input: {
  title?: string | null;
  skills?: readonly string[] | null;
  rawText?: string | null;
}): CategoryMatch {
  const title = (input.title ?? '').toLowerCase();
  const skills = (input.skills ?? []).join(' ').toLowerCase();
  const text = (input.rawText ?? '').toLowerCase();

  let best: CategoryMatch = { ...OTHER_CATEGORY, reason: '未命中关键词', score: 0 };
  for (const category of JOB_CATEGORIES) {
    let score = 0;
    const hits: string[] = [];
    for (const keyword of category.keywords) {
      let hit = false;
      if (keywordHit(title, keyword)) {
        score += TITLE_WEIGHT;
        hit = true;
      }
      if (keywordHit(skills, keyword)) {
        score += SKILL_WEIGHT;
        hit = true;
      }
      if (keywordHit(text, keyword)) {
        score += TEXT_WEIGHT;
        hit = true;
      }
      if (hit) hits.push(keyword);
    }
    if (score > best.score) {
      best = { code: category.code, label: category.label, tier: category.tier, reason: `命中：${hits.slice(0, 3).join('、')}`, score };
    }
  }
  return best;
}

/** 分类 code → 中文标签；未知 code 原样返回（支持用户自定义） */
export function categoryLabel(code: string | null | undefined): string {
  if (!code) return '未分类';
  return CATEGORY_BY_CODE.get(code)?.label ?? code;
}

/**
 * 有效定位 = 手动覆盖 ?? 分类派生。
 * 覆盖值存在三个合法枚举之外时视为"未覆盖"（数据脏了也不至于崩）。
 */
export function effectiveTier(
  category: string | null | undefined,
  campaignTier?: string | null,
): { tier: CampaignTier; label: string; overridden: boolean } {
  const override = campaignTier === 'primary' || campaignTier === 'secondary' || campaignTier === 'casual' ? campaignTier : null;
  if (override) return { tier: override, label: TIER_LABEL[override], overridden: true };
  const derived = categoryTier(category);
  return { tier: derived, label: TIER_LABEL[derived], overridden: false };
}

/** 台账「投递定位」单元格 → 覆盖值：空 = 跟随分类（null）；也接受英文 code */
export function parseTierCell(cell: string): CampaignTier | null {
  const value = cell.trim();
  if (value.length === 0) return null;
  if (value === 'primary' || value === '主投') return 'primary';
  if (value === 'secondary' || value === '副投') return 'secondary';
  if (value === 'casual' || value === '碰运气') return 'casual';
  return null;
}

/** 分类 code → 投递定位；未知/自定义分类一律"碰运气"（不冒充主投） */
export function categoryTier(code: string | null | undefined): CampaignTier {
  if (!code) return 'casual';
  return CATEGORY_BY_CODE.get(code)?.tier ?? 'casual';
}

export function tierLabel(code: string | null | undefined): string {
  return TIER_LABEL[categoryTier(code)];
}

/**
 * 台账单元格 → code：接受中文标签、code、或自定义字符串。
 * 空字符串返回 null（表示"未分类"）。
 */
export function categoryCodeFromCell(cell: string): string | null {
  const value = cell.trim();
  if (value.length === 0) return null;
  const byLabel = LABEL_TO_CODE.get(value);
  if (byLabel) return byLabel;
  if (CATEGORY_BY_CODE.has(value)) return value;
  return value; // 自定义分类：原样当 code，UI 会原样显示
}
