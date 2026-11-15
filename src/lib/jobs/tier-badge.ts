/**
 * 看板/列表的「投递定位」徽标（通用分类 + 用户策略）
 */

import { TIER_LABEL, categoryTier, type CampaignTier } from '../jobs/category.ts';

const TIER_STYLE: Record<CampaignTier, string> = {
  primary: 'badge ok',
  secondary: 'badge',
  casual: 'badge muted',
};

export function tierBadgeClass(category: string | null | undefined): string {
  return TIER_STYLE[categoryTier(category)];
}

export function tierBadgeText(category: string | null | undefined): string {
  return TIER_LABEL[categoryTier(category)];
}
