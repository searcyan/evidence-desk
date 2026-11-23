/** 基础 UI 组件：按钮、卡片、标签页、开关、弹出层、对话框等（无第三方组件库） */
import {
  cloneElement,
  forwardRef,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { Loader2, X } from 'lucide-react';

// ───────── 按钮 ─────────

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type BtnSize = 'sm' | 'md' | 'lg';

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: BtnSize; loading?: boolean; icon?: ReactNode }
>(function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors select-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' && 'h-7 px-2.5 text-xs',
        size === 'md' && 'h-9 px-3.5 text-sm',
        size === 'lg' && 'h-11 px-5 text-[15px]',
        variant === 'primary' && 'bg-accent text-accent-ink hover:bg-accent-hover',
        variant === 'secondary' && 'border border-line-strong bg-surface text-ink hover:bg-surface-2',
        variant === 'ghost' && 'text-ink-2 hover:bg-surface-2 hover:text-ink',
        variant === 'danger' && 'border border-line-strong bg-surface text-critical-text hover:bg-critical-soft',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={clsx('inline-flex size-8 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

// ───────── 布局 ─────────

export function Card({ className, children, padded = true }: { className?: string; children: ReactNode; padded?: boolean }) {
  return <div className={clsx('rounded-xl border border-line bg-surface shadow-card', padded && 'p-5', className)}>{children}</div>;
}

export function SectionTitle({ children, right, className }: { children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={clsx('mb-3 flex items-center justify-between gap-3', className)}>
      <h3 className="text-[13px] font-semibold tracking-wide text-ink-2 uppercase">{children}</h3>
      {right}
    </div>
  );
}

export function PageHeader({ title, subtitle, right }: { title: ReactNode; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-ink-2">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

export function EmptyState({ icon, title, hint, action }: { icon?: ReactNode; title: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      {icon && <div className="mb-1 text-ink-3">{icon}</div>}
      <div className="font-medium text-ink-2">{title}</div>
      {hint && <div className="max-w-md text-sm text-ink-3">{hint}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-5 animate-spin text-ink-3', className)} />;
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-ink-3">
      <Spinner /> {label}
    </div>
  );
}

// ───────── 小标签 ─────────

export function Badge({ tone = 'neutral', className, children, title }: { tone?: 'neutral' | 'accent' | 'good' | 'warn' | 'serious' | 'critical' | 'outline'; className?: string; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex h-[22px] items-center gap-1 rounded-md px-1.5 text-xs font-medium whitespace-nowrap',
        tone === 'neutral' && 'bg-neutral-soft text-ink-2',
        tone === 'accent' && 'bg-accent-soft text-accent-text',
        tone === 'good' && 'bg-good-soft text-good-text',
        tone === 'warn' && 'bg-warn-soft text-warn-text',
        tone === 'serious' && 'bg-serious-soft text-serious-text',
        tone === 'critical' && 'bg-critical-soft text-critical-text',
        tone === 'outline' && 'border border-line-strong text-ink-2',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <code className="rounded bg-surface-3 px-1 py-px font-mono text-[12px] text-ink-2">{children}</code>;
}

// ───────── 表单 ─────────

export function Field({ label, hint, children, htmlFor, right }: { label: ReactNode; hint?: ReactNode; children: ReactNode; htmlFor?: string; right?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink">
          {label}
        </label>
        {right}
      </div>
      {children}
      {hint && <div className="text-xs text-ink-3">{hint}</div>}
    </div>
  );
}

const inputCls =
  'w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-3 transition-colors hover:border-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60';

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, ...rest }, ref) {
  return <input ref={ref} className={clsx(inputCls, 'h-9', className)} {...rest} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={clsx(inputCls, 'py-2.5 leading-relaxed', className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={clsx(inputCls, 'h-9 cursor-pointer pr-8', className)} {...rest}>
      {children}
    </select>
  );
}

export function Switch({ checked, onChange, label, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; id?: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={clsx('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line-strong')}
    >
      <span className={clsx('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  );
}

export function Segmented<T extends string>({ value, onChange, options, size = 'md', className }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; title?: string }[]; size?: 'sm' | 'md'; className?: string }) {
  return (
    <div role="radiogroup" className={clsx('inline-flex rounded-lg bg-surface-3 p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={clsx(
            'rounded-md font-medium whitespace-nowrap transition-colors',
            size === 'sm' ? 'h-6 px-2 text-xs' : 'h-8 px-3 text-[13px]',
            value === o.value ? 'bg-surface text-ink shadow-sm' : 'text-ink-2 hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ───────── 标签页 ─────────

export function Tabs<T extends string>({ value, onChange, tabs, className }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; count?: number | null; dot?: boolean }[]; className?: string }) {
  return (
    <div role="tablist" className={clsx('flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]', className)}>
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={clsx(
            '-mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors',
            value === t.value ? 'border-accent text-ink' : 'border-transparent text-ink-2 hover:text-ink',
          )}
        >
          {t.label}
          {t.count != null && <span className="tnum rounded-full bg-surface-3 px-1.5 text-[11px] text-ink-2">{t.count}</span>}
          {t.dot && <span className="size-1.5 rounded-full bg-accent animate-pulse-dot" />}
        </button>
      ))}
    </div>
  );
}

// ───────── 进度条 ─────────

export function Meter({ value, max, label, display, warnAt = 0.75, dangerAt = 0.92, mark, markTitle }: { value: number; max: number | null; label: ReactNode; display: ReactNode; warnAt?: number; dangerAt?: number; mark?: number; markTitle?: string }) {
  const ratio = max ? Math.min(1, value / max) : 0;
  const tone = ratio >= dangerAt ? 'var(--critical)' : ratio >= warnAt ? 'var(--warn)' : 'var(--accent)';
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="text-ink-2">{label}</span>
        <span className="tnum text-ink">{display}</span>
      </div>
      <div className="relative">
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-3" role="meter" aria-valuenow={value} aria-valuemax={max ?? undefined}>
          <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${ratio * 100}%`, background: tone }} />
        </div>
        {/* 标线：例如研究阶段可用额度的上限 */}
        {mark != null && max != null && <span className="absolute -top-[3px] h-3 w-[2px] -translate-x-1/2 rounded-full bg-ink-2" style={{ left: `${mark * 100}%` }} title={markTitle} />}
      </div>
    </div>
  );
}

// ───────── 弹出层 ─────────

/**
 * 悬停/点击弹出层：悬停显示，点击固定；渲染到 body，自动上下翻转。
 */
export function Popover({ trigger, children, width = 360, openOnHover = true }: { trigger: ReactElement<Record<string, unknown>>; children: ReactNode; width?: number; openOnHover?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; above: boolean } | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const pop = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  const place = useCallback(() => {
    const el = anchor.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const h = pop.current?.offsetHeight ?? 200;
    const above = r.bottom + h + 12 > window.innerHeight && r.top > h + 12;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - width / 2), window.innerWidth - width - 8);
    setPos({ top: above ? r.top - h - 8 : r.bottom + 8, left, above });
  }, [width]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => place();
    const onDown = (e: MouseEvent) => {
      if (pop.current?.contains(e.target as Node) || anchor.current?.contains(e.target as Node)) return;
      setOpen(false);
      setPinned(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setPinned(false);
      }
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, place]);

  const enter = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (openOnHover) setOpen(true);
  };
  const leave = () => {
    if (pinned) return;
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };

  if (!isValidElement(trigger)) return null;
  const t = cloneElement(trigger, {
    ref: (el: HTMLElement | null) => {
      anchor.current = el;
    },
    onMouseEnter: enter,
    onMouseLeave: leave,
    onFocus: enter,
    onBlur: leave,
    onClick: (e: MouseEvent) => {
      e.stopPropagation?.();
      // 点击切换"固定"状态：固定后鼠标移开也不关闭
      if (pinned) {
        setPinned(false);
        setOpen(false);
      } else {
        setPinned(true);
        setOpen(true);
      }
    },
    'aria-describedby': open ? id : undefined,
    'aria-expanded': open,
  });

  return (
    <>
      {t}
      {open &&
        createPortal(
          <div
            ref={pop}
            id={id}
            role="dialog"
            onMouseEnter={enter}
            onMouseLeave={leave}
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width }}
            className="animate-slide-in fixed z-50 rounded-xl border border-line bg-surface p-3.5 text-sm shadow-pop"
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

// ───────── 下拉菜单 ─────────

export function Menu({ trigger, items, align = 'right' }: { trigger: (p: { onClick: () => void; 'aria-expanded': boolean }) => ReactNode; items: { label: ReactNode; icon?: ReactNode; onSelect: () => void; danger?: boolean; href?: string }[]; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open })}
      {open && (
        <div role="menu" className={clsx('animate-slide-in absolute z-40 mt-1 min-w-[200px] rounded-xl border border-line bg-surface p-1 shadow-pop', align === 'right' ? 'right-0' : 'left-0')}>
          {items.map((it, i) => {
            const cls = clsx('flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2', it.danger ? 'text-critical-text' : 'text-ink');
            return it.href ? (
              <a key={i} role="menuitem" href={it.href} className={cls} onClick={() => setOpen(false)}>
                {it.icon}
                {it.label}
              </a>
            ) : (
              <button
                key={i}
                role="menuitem"
                className={cls}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
              >
                {it.icon}
                {it.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ───────── 对话框 ─────────

export function Dialog({ open, onClose, title, subtitle, children, footer, width = 520, dismissable = true }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; width?: number; dismissable?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, textarea, button, [tabindex]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose, dismissable]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={dismissable ? onClose : undefined} />
      <div ref={ref} role="dialog" aria-modal="true" className="animate-slide-in relative max-h-[90vh] w-full overflow-auto rounded-2xl border border-line bg-surface shadow-pop" style={{ maxWidth: width }}>
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            {subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}
          </div>
          {dismissable && (
            <IconButton label="Close" onClick={onClose} className="-mr-2">
              <X className="size-4" />
            </IconButton>
          )}
        </div>
        <div className="px-6 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-6 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** 右侧抽屉：用于查看某一部分的细节，不打断主界面 */
export function Drawer({ open, onClose, title, subtitle, children, width = 560 }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/25" onClick={onClose} />
      <aside role="dialog" aria-modal="true" className="animate-drawer-in absolute inset-y-0 right-0 flex w-full flex-col border-l border-line bg-surface shadow-pop" style={{ maxWidth: width }}>
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{title}</h2>
            {subtitle && <div className="mt-0.5 text-sm text-ink-2">{subtitle}</div>}
          </div>
          <IconButton label="Close" onClick={onClose} className="-mr-2">
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, body, confirmLabel, cancelLabel, danger, loading }: { open: boolean; onClose: () => void; onConfirm: () => void; title: ReactNode; body?: ReactNode; confirmLabel: string; cancelLabel: string; danger?: boolean; loading?: boolean }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width={440}
      footer={
        <>
          <Button onClick={onClose}>{cancelLabel}</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body && <p className="text-ink-2">{body}</p>}
    </Dialog>
  );
}
