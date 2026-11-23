/** 澄清对话框：运行处于 awaiting_clarification 时弹出，可点选候选答案或自由输入 */
import { useState } from 'react';
import clsx from 'clsx';
import type { ClarificationRequest } from '../../api/types.ts';
import { useI18n } from '../../i18n/index.tsx';
import { Button, Dialog, TextInput } from '../../components/ui.tsx';

export function ClarificationDialog({ request, onSubmit, submitting }: { request: ClarificationRequest; onSubmit: (answers: { question_id: string; answer: string }[]) => void; submitting: boolean }) {
  const { t } = useI18n();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(true);
  const complete = request.questions.every((q) => (answers[q.id] ?? '').trim());
  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title={t('clarify.title')}
      subtitle={t('clarify.subtitle')}
      width={560}
      footer={
        <>
          <span className="mr-auto self-center text-xs text-ink-3">{t('clarify.timeout')}</span>
          <Button variant="primary" disabled={!complete} loading={submitting} onClick={() => onSubmit(request.questions.map((q) => ({ question_id: q.id, answer: answers[q.id].trim() })))}>
            {t('clarify.submit')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {request.questions.map((q, i) => (
          <div key={q.id}>
            <div className="mb-2 text-sm font-medium">
              <span className="tnum mr-1.5 text-ink-3">{i + 1}.</span>
              {q.text}
            </div>
            <div className="flex flex-col gap-1.5">
              {q.options.map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => setAnswers({ ...answers, [q.id]: o })}
                  className={clsx('rounded-lg border px-3 py-2 text-left text-sm transition-colors', answers[q.id] === o ? 'border-accent bg-accent-soft text-ink' : 'border-line-strong text-ink-2 hover:bg-surface-2')}
                >
                  {o}
                </button>
              ))}
              <TextInput placeholder={t('clarify.other')} value={q.options.includes(answers[q.id] ?? '') ? '' : (answers[q.id] ?? '')} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
            </div>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
