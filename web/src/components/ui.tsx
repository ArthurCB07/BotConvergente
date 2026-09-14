import type { ReactNode } from 'react';
import { MARKET_LABEL, type MarketId } from '../api.ts';

export const SIDE_LABEL: Record<string, string> = { BUY: 'Compra', SELL: 'Venda' };
export const MODE_LABEL: Record<string, string> = {
  OBSERVE: 'Observacao',
  SEMI_AUTO: 'Semiautomatico',
  AUTO: 'Autonomo',
};

export function money(value: number | null | undefined, currency = 'USD'): string {
  if (value == null || Number.isNaN(value)) return '—';
  return `${currency} ${value.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function signed(value: number | null | undefined, currency = 'USD'): string {
  if (value == null) return '—';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${money(value, currency)}`;
}

export function pct(value: number | null | undefined, digits = 1): string {
  if (value == null || Number.isNaN(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('pt-BR', { hour12: false });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { hour12: false });
}

export function relative(iso: string | null | undefined, now: string): string {
  if (!iso) return '—';
  const seconds = (Date.parse(now) - Date.parse(iso)) / 1000;
  if (seconds < 0) return 'em instantes';
  if (seconds < 60) return `ha ${Math.round(seconds)} s`;
  if (seconds < 3600) return `ha ${Math.round(seconds / 60)} min`;
  return `ha ${Math.round(seconds / 3600)} h`;
}

export function countdown(validUntil: string, now: string): string {
  const seconds = (Date.parse(validUntil) - Date.parse(now)) / 1000;
  if (seconds <= 0) return 'expirada';
  if (seconds < 60) return `${Math.round(seconds)} s restantes`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s restantes`;
}

type Tone = 'ok' | 'block' | 'watch' | 'risk' | 'neutral' | 'long' | 'short';

/** Etiqueta de mercado, com a cor de identidade daquele mercado. */
export function MarketChip({ marketId }: { marketId: MarketId }) {
  return (
    <span className="market-chip" data-market={marketId}>
      {MARKET_LABEL[marketId]}
    </span>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Card({
  title,
  aside,
  children,
  tight,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  tight?: boolean;
}) {
  return (
    <section className="card">
      {title != null && (
        <header className="card-head">
          <h2>{title}</h2>
          {aside}
        </header>
      )}
      <div className={tight ? 'card-body tight' : 'card-body'}>{children}</div>
    </section>
  );
}

export function Checks({ items }: { items: Array<{ code: string; label: string; passed: boolean; detail: string }> }) {
  if (items.length === 0) return <p className="dim small">Nenhum criterio avaliado.</p>;
  return (
    <ul className="checks">
      {items.map((item) => (
        <li key={item.code} className={`check ${item.passed ? 'check-pass' : 'check-fail'}`}>
          <span className="check-mark" aria-hidden="true">
            {item.passed ? '✓' : '✕'}
          </span>
          <span>
            <span className="check-label">{item.label}</span>
            <br />
            <span className="check-detail small">{item.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Meter({ value, max, tone }: { value: number; max: number; tone: string }) {
  const ratio = max === 0 ? 0 : Math.min(1, Math.abs(value) / Math.abs(max));
  return (
    <div className="meter" role="img" aria-label={`${Math.round(ratio * 100)}% do limite`}>
      <span style={{ width: `${ratio * 100}%`, background: tone }} />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
