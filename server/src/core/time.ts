/**
 * Utilitarios de tempo. Todo o nucleo trabalha com ISO-8601 e um `Clock`
 * injetavel, para que os testes e os cenarios de demonstracao controlem o relogio.
 */

export interface Clock {
  now(): Date;
  nowIso(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
};

export class FakeClock implements Clock {
  private current: Date;
  constructor(start: Date | string) {
    this.current = typeof start === 'string' ? new Date(start) : start;
  }
  now(): Date {
    return new Date(this.current);
  }
  nowIso(): string {
    return this.current.toISOString();
  }
  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }
  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
  set(date: Date | string): void {
    this.current = typeof date === 'string' ? new Date(date) : date;
  }
}

export function minutesBetween(a: string | Date, b: string | Date): number {
  const ta = typeof a === 'string' ? Date.parse(a) : a.getTime();
  const tb = typeof b === 'string' ? Date.parse(b) : b.getTime();
  return (tb - ta) / 60_000;
}

export function secondsBetween(a: string | Date, b: string | Date): number {
  return minutesBetween(a, b) * 60;
}

export function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

/** Partes de data/hora de um instante em um fuso IANA. */
export function zonedParts(
  iso: string,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const date = new Date(iso);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekdayMap: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
    minute: Number(parts.minute),
    weekday: weekdayMap[parts.weekday ?? 'Mon'] ?? 1,
  };
}

/** Chave do dia operacional (YYYY-MM-DD) no fuso informado. */
export function tradingDayKey(iso: string, timeZone: string): string {
  const p = zonedParts(iso, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function minutesOfDay(iso: string, timeZone: string): number {
  const p = zonedParts(iso, timeZone);
  return p.hour * 60 + p.minute;
}

export function parseHhMm(value: string): number {
  const [h = '0', m = '0'] = value.split(':');
  return Number(h) * 60 + Number(m);
}

export function formatIsoInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(iso));
}
