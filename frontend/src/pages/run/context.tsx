/** 运行详情页共享上下文：实体索引、引用编号、跨标签页联动（聚焦某个声明/文档） */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Claim, Evidence, RunDetail, RunEvent, SourceDocument } from '../../api/types.ts';

export type RunTab = 'report' | 'timeline' | 'claims' | 'sources' | 'process';
export type Focus = { kind: 'claim' | 'document' | 'evidence' | 'gap'; id: string } | null;

interface RunCtx {
  run: RunDetail;
  events: RunEvent[];
  evidence: (id: string) => Evidence | undefined;
  doc: (id: string) => SourceDocument | undefined;
  claim: (id: string) => Claim | undefined;
  docOfEvidence: (evId: string) => SourceDocument | undefined;
  /** 证据 id → 报告中的引用编号（按首次出现顺序） */
  citeNum: Map<string, number>;
  evidenceByDoc: Map<string, Evidence[]>;
  claimsByEvidence: Map<string, Claim[]>;
  focus: Focus;
  goto: (tab: RunTab, focus?: Focus) => void;
}

const Ctx = createContext<RunCtx | null>(null);

export function RunProvider({ run, events, focus, goto, children }: { run: RunDetail; events: RunEvent[]; focus: Focus; goto: RunCtx['goto']; children: ReactNode }) {
  const value = useMemo<RunCtx>(() => {
    const evMap = new Map(run.evidence.map((e) => [e.id, e]));
    const docMap = new Map(run.documents.map((d) => [d.id, d]));
    const claimMap = new Map(run.claims.map((c) => [c.id, c]));
    const citeNum = new Map<string, number>();
    if (run.report) {
      const paras = [run.report.answer, ...run.report.sections.flatMap((s) => s.paragraphs)];
      for (const p of paras) for (const s of p.sentences) for (const e of s.evidence_ids) if (!citeNum.has(e)) citeNum.set(e, citeNum.size + 1);
    }
    const evidenceByDoc = new Map<string, Evidence[]>();
    for (const e of run.evidence) evidenceByDoc.set(e.document_id, [...(evidenceByDoc.get(e.document_id) ?? []), e]);
    const claimsByEvidence = new Map<string, Claim[]>();
    for (const c of run.claims) for (const l of c.links) claimsByEvidence.set(l.evidence_id, [...(claimsByEvidence.get(l.evidence_id) ?? []), c]);
    return {
      run,
      events,
      evidence: (id) => evMap.get(id),
      doc: (id) => docMap.get(id),
      claim: (id) => claimMap.get(id),
      docOfEvidence: (id) => {
        const e = evMap.get(id);
        return e ? docMap.get(e.document_id) : undefined;
      },
      citeNum,
      evidenceByDoc,
      claimsByEvidence,
      focus,
      goto,
    };
  }, [run, events, focus, goto]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRun() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useRun must be used inside RunProvider');
  return v;
}
