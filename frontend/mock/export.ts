/** Markdown 导出（mock 实现，格式与 api-contract.md §4 一致，后端可参考） */
import type { ReportParagraph, RunDetail } from '../src/api/types.ts';

export function exportMarkdown(d: RunDetail): string {
  const r = d.report;
  const zh = d.request.report_language === 'zh';
  const T = (en: string, z: string) => (zh ? z : en);
  if (!r) return `# ${d.title}\n\n${T('No report yet.', '暂无报告。')}\n`;

  // 按首次引用顺序给证据编号
  const order: string[] = [];
  const num = (id: string) => {
    let i = order.indexOf(id);
    if (i === -1) {
      order.push(id);
      i = order.length - 1;
    }
    return i + 1;
  };
  const para = (p: ReportParagraph) =>
    p.sentences.map((s) => s.text + s.evidence_ids.map((e) => `[${num(e)}]`).join('')).join(' ');

  const lines: string[] = [];
  lines.push(`# ${r.title}`, '');
  lines.push(`> ${T('Cutoff', '截止时间')}: ${d.request.cutoff} · ${T('Mode', '模式')}: ${d.request.temporal_mode}${r.is_partial ? ` · **${T('Partial report', '部分报告')}**` : ''}`, '');
  lines.push(`## ${T('Answer', '答案')}`, '', para(r.answer), '');
  for (const s of r.sections) {
    lines.push(`## ${s.title}`, '');
    for (const p of s.paragraphs) lines.push(para(p), '');
  }
  if (d.timeline.length) {
    lines.push(`## ${T('Timeline', '时间线')}`, '', `| ${T('Date', '日期')} | ${T('Event', '事件')} | ${T('Status', '状态')} |`, '|---|---|---|');
    for (const t of d.timeline) lines.push(`| ${t.date.precision === 'month' ? t.date.start.slice(0, 7) : t.date.start} | ${t.title} — ${t.summary} | ${t.verdict} |`);
    lines.push('');
  }
  if (r.open_questions.length) {
    lines.push(`## ${T('Open questions', '未解决问题')}`, '', ...r.open_questions.map((q) => `- ${q}`), '');
  }
  lines.push(`${T('Stop reason', '停止原因')}: \`${r.stop_reason ?? d.stop_reason ?? 'n/a'}\``, '');
  lines.push(`## ${T('Sources', '参考来源')}`, '');
  order.forEach((evIdv, i) => {
    const ev = d.evidence.find((e) => e.id === evIdv);
    const doc = ev && d.documents.find((x) => x.id === ev.document_id);
    if (!doc) return;
    lines.push(`${i + 1}. [${doc.title}](${doc.url}) — ${doc.publisher ?? doc.domain}, ${doc.published_at?.slice(0, 10) ?? 'n.d.'}${doc.is_original ? ` (${T('original source', '原始来源')})` : ''}`);
  });
  return lines.join('\n') + '\n';
}
