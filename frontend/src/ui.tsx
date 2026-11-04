import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ApiError } from './api';
import { cn } from './utils';

export type Tone = 'brand' | 'blue' | 'green' | 'amber' | 'red' | 'gray';

export function Badge({ tone = 'gray', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cn('badge', `badge-${tone}`)}>{children}</span>;
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {subtitle && <p className="page-sub">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  padded = true,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={cn('card', className)}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {subtitle && <p className="card-sub">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'card-body' : ''}>{children}</div>
    </section>
  );
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
}) {
  return (
    <button
      className={cn('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', className)}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  required,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('field', className)}>
      <span className="field-label">
        {label}
        {required && <em className="req">*</em>}
      </span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('input', props.className)} {...props} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn('input select', props.className)} {...props} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn('input textarea', props.className)} {...props} />;
}

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className={cn('modal', wide && 'modal-wide')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-mark">◇</div>
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Spinner({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="spinner">
      <span className="spinner-dot" />
      {label}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
  onClick,
  title,
  spark,
  sparkLabels,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  onClick?: () => void;
  title?: string;
  spark?: number[];
  sparkLabels?: string[];
}) {
  const sparkMax = Math.max(1, ...(spark ?? []));
  return (
    <div
      className={cn('stat', tone && `stat-${tone}`)}
      onClick={onClick}
      title={title}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      style={onClick ? { cursor: 'pointer' } : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      {hint && <span className="stat-hint">{hint}</span>}
      {spark && spark.length > 1 ? (
        <span
          aria-hidden="true"
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 1,
            height: 18,
            marginTop: 4,
            color: 'currentColor',
          }}
        >
          {spark.map((item, index) => (
            <span
              key={index}
              title={
                sparkLabels?.[index]
                  ? `${sparkLabels[index]}：${item}`
                  : undefined
              }
              style={{
                flex: 1,
                minWidth: 2,
                height: `${Math.max(
                  8,
                  Math.round((item / sparkMax) * 100),
                )}%`,
                background: 'currentColor',
                opacity: item > 0 ? 0.35 : 0.12,
                borderRadius: 1,
              }}
            />
          ))}
        </span>
      ) : null}
    </div>
  );
}

export function Progress({ value, max = 100 }: { value: number; max?: number }) {
  const pct = Math.max(0, Math.min(100, Math.round((value / max) * 100)));
  return (
    <div className="progress" title={`${value}/${max}`}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Tabs({
  items,
  active,
  onChange,
  onPrefetch,
}: {
  items: Array<{ key: string; label: string; count?: number }>;
  active: string;
  onChange: (key: string) => void;
  onPrefetch?: (key: string) => void;
}) {
  return (
    <nav className="tabs">
      {items.map((it) => (
        <button
          key={it.key}
          className={cn('tab', active === it.key && 'tab-active')}
          onClick={() => onChange(it.key)}
          onMouseEnter={() => onPrefetch?.(it.key)}
          onFocus={() => onPrefetch?.(it.key)}
        >
          {it.label}
          {it.count !== undefined && <span className="tab-count">{it.count}</span>}
        </button>
      ))}
    </nav>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const e = error instanceof ApiError ? error : null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="error-box">
      <div>
        <strong>请求失败</strong>
        <p>{message}</p>
        {e?.issues?.length ? (
          <ul>
            {e.issues.map((i) => (
              <li key={i.path}>
                {i.path}：{i.message}
              </li>
            ))}
          </ul>
        ) : null}
        {e?.details?.requestId ? (
          <p className="muted small mono">请求 ID：{e.details.requestId}</p>
        ) : null}
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  );
}

export function Notice({ tone = 'blue', children }: { tone?: Tone; children: ReactNode }) {
  return <div className={cn('notice', `notice-${tone}`)}>{children}</div>;
}
