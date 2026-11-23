/** 事件阶段标签（后端为 snake_case 英文）的显示名；未收录的标签把下划线换成空格原样显示 */
import type { Lang } from '../api/types.ts';

const ZH: Record<string, string> = {
  announced: '宣布',
  agreement_signed: '签署协议',
  regulatory_review: '监管审查',
  approved: '获批',
  closed: '完成交割',
  filed: '起诉',
  hearing: '庭审',
  ruling: '裁决',
  appeal: '上诉',
  proposed: '提出',
  enacted: '颁布',
  implemented: '实施',
  onset: '发生',
  response: '应对',
  recovery: '恢复',
  campaign: '竞选',
  voting: '投票',
  results: '结果公布',
  certification: '结果认证',
  released: '发布',
  escalation: '升级',
  negotiation: '谈判',
  resolution: '解决',
  reviewed: '审查中',
  accepted: '获得公认',
  submitted: '提交',
  published: '发表',
  completed: '完成',
  rejected: '被否决',
  blocked: '被阻止',
};

export function stageLabel(stage: string, lang: Lang): string {
  if (lang === 'zh' && ZH[stage]) return ZH[stage];
  const text = stage.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
