/** 轻量 i18n：中英双语，界面语言保存在 localStorage，与报告语言相互独立 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { en, type MessageKey } from './en.ts';
import { zh } from './zh.ts';
import type { Lang } from '../api/types.ts';

const DICTS: Record<Lang, Record<MessageKey, string>> = { en, zh };

export type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

interface I18nValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: TFn;
}

const Ctx = createContext<I18nValue | null>(null);

function initialLang(): Lang {
  try {
    const v = localStorage.getItem('nra.lang');
    if (v === 'en' || v === 'zh') return v;
  } catch {
    /* 存储不可用时使用浏览器语言 */
  }
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en';
    try {
      localStorage.setItem('nra.lang', l);
    } catch {
      /* 忽略 */
    }
  }, []);
  const t = useCallback<TFn>(
    (key, vars) => {
      let s = DICTS[lang][key] ?? en[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
      return s;
    },
    [lang],
  );
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n must be used inside I18nProvider');
  return v;
}

export type { MessageKey };
