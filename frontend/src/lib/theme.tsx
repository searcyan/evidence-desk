/** 主题：light / dark / system，system 时跟随操作系统并实时响应变化 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';

const Ctx = createContext<{ pref: ThemePref; setPref: (p: ThemePref) => void; resolved: 'light' | 'dark' } | null>(null);

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem('nra.theme');
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* 忽略 */
  }
  return 'system';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const resolved = pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  const value = useMemo(
    () => ({
      pref,
      resolved,
      setPref: (p: ThemePref) => {
        setPrefState(p);
        try {
          if (p === 'system') localStorage.removeItem('nra.theme');
          else localStorage.setItem('nra.theme', p);
        } catch {
          /* 忽略 */
        }
      },
    }),
    [pref, resolved],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme must be used inside ThemeProvider');
  return v;
}
