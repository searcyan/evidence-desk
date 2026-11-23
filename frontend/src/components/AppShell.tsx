/** 应用外框：左侧导航（窄屏折叠为顶栏抽屉）、最近运行、语言与主题切换、后端连接状态 */
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import clsx from 'clsx';
import { FlaskConical, History, Menu as MenuIcon, Monitor, Moon, PenLine, Server, Sun, X } from 'lucide-react';
import { useConfig, useHealth, useRuns } from '../api/hooks.ts';
import { useI18n } from '../i18n/index.tsx';
import { useTheme, type ThemePref } from '../lib/theme.tsx';
import { isTerminal } from '../lib/fold.ts';
import { Segmented } from './ui.tsx';

function Brand() {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2.5 px-2">
      <svg viewBox="0 0 32 32" className="size-8 shrink-0" aria-hidden>
        <rect width="32" height="32" rx="8" fill="var(--accent)" />
        <path d="M9 10h14M9 16h10M9 22h6" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
        <circle cx="22.5" cy="21.5" r="3.2" fill="#9ec5f4" />
      </svg>
      <div className="min-w-0 leading-tight">
        <div className="font-semibold tracking-tight">{t('app.name')}</div>
        <div className="truncate text-xs text-ink-3">{t('app.tagline')}</div>
      </div>
    </div>
  );
}

function NavItem({ to, icon, label, end }: { to: string; icon: React.ReactNode; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        clsx(
          'flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium transition-colors',
          isActive ? 'bg-surface text-ink shadow-card' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
        )
      }
    >
      {icon}
      {label}
    </NavLink>
  );
}

function RecentRuns() {
  const { t } = useI18n();
  const runs = useRuns();
  const items = runs.data?.items.slice(0, 6) ?? [];
  if (!items.length) return null;
  return (
    <div className="mt-6">
      <div className="mb-1.5 px-2.5 text-[11px] font-semibold tracking-wider text-ink-3 uppercase">{t('nav.recent')}</div>
      <div className="flex flex-col">
        {items.map((r) => (
          <NavLink
            key={r.id}
            to={`/runs/${r.id}`}
            className={({ isActive }) => clsx('flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors', isActive ? 'bg-surface text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}
          >
            <span
              className={clsx('size-1.5 shrink-0 rounded-full', !isTerminal(r.status) && 'animate-pulse-dot')}
              style={{
                background:
                  r.status === 'completed' ? 'var(--good)' : r.status === 'failed' ? 'var(--critical)' : r.status === 'partial' ? 'var(--serious)' : r.status === 'awaiting_clarification' ? 'var(--warn)' : !isTerminal(r.status) ? 'var(--accent)' : 'var(--ink-3)',
              }}
            />
            <span className="truncate">{r.title}</span>
          </NavLink>
        ))}
      </div>
    </div>
  );
}

function BackendStatus() {
  const { t } = useI18n();
  const config = useConfig();
  const health = useHealth();
  const down = health.isError || config.isError;
  if (down)
    return (
      <div className="rounded-lg border border-critical/30 bg-critical-soft px-2.5 py-2 text-xs text-critical-text">
        <div className="font-semibold">{t('common.backendDown')}</div>
        <div className="mt-0.5 opacity-90">{t('common.backendDownHint')}</div>
      </div>
    );
  if (config.data?.mode === 'mock')
    return (
      <div className="rounded-lg border border-warn/40 bg-warn-soft px-2.5 py-2 text-xs text-warn-text" title={t('common.mockHint')}>
        <div className="font-semibold">{t('common.mockBadge')}</div>
        <div className="mt-0.5 opacity-90">{t('common.mockHint')}</div>
      </div>
    );
  return null;
}

function Preferences() {
  const { t, lang, setLang } = useI18n();
  const { pref, setPref } = useTheme();
  return (
    <div className="flex items-center justify-between gap-2 px-1">
      <Segmented size="sm" value={lang} onChange={setLang} options={[{ value: 'en', label: 'EN' }, { value: 'zh', label: '中文' }]} />
      <Segmented<ThemePref>
        size="sm"
        value={pref}
        onChange={setPref}
        options={[
          { value: 'light', label: <Sun className="size-3.5" />, title: t('theme.light') },
          { value: 'system', label: <Monitor className="size-3.5" />, title: t('theme.system') },
          { value: 'dark', label: <Moon className="size-3.5" />, title: t('theme.dark') },
        ]}
      />
    </div>
  );
}

function SidebarContent() {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col gap-1 p-3">
      <div className="py-2">
        <Brand />
      </div>
      <nav className="mt-3 flex flex-col gap-0.5">
        <NavItem to="/" end icon={<PenLine className="size-4" />} label={t('nav.new')} />
        <NavItem to="/runs" icon={<History className="size-4" />} label={t('nav.runs')} />
        <NavItem to="/experiments" icon={<FlaskConical className="size-4" />} label={t('nav.experiments')} />
        <NavItem to="/system" icon={<Server className="size-4" />} label={t('nav.system')} />
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <RecentRuns />
      </div>
      <div className="flex flex-col gap-3 pt-3">
        <BackendStatus />
        <Preferences />
      </div>
    </div>
  );
}

export function AppShell() {
  const [drawer, setDrawer] = useState(false);
  const loc = useLocation();
  const { t } = useI18n();
  useEffect(() => setDrawer(false), [loc.pathname]);

  return (
    <div className="flex h-full">
      <aside className="hidden w-[248px] shrink-0 border-r border-line bg-bg lg:block">
        <SidebarContent />
      </aside>
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 w-[272px] border-r border-line bg-bg shadow-pop">
            <button className="absolute top-4 right-3 p-1 text-ink-2" onClick={() => setDrawer(false)} aria-label={t('common.close')}>
              <X className="size-5" />
            </button>
            <SidebarContent />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b border-line bg-bg px-4 lg:hidden">
          <button onClick={() => setDrawer(true)} className="p-1 text-ink-2" aria-label="Menu">
            <MenuIcon className="size-5" />
          </button>
          <Brand />
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto" id="main-scroll">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
