import { getInstrument } from './instruments.ts';
import { stableHash, id } from './ids.ts';
import { minutesBetween } from './time.ts';
import type {
  MarketId,
  ParserKind,
  ProductType,
  RawMessage,
  Side,
  Signal,
  SignalIssue,
  Source,
  Venue,
  EntryType,
} from './types.ts';
import { MARKET_LABEL, PRODUCT_LABEL } from './types.ts';

/**
 * Camada de ingestao: mensagem bruta -> sinal normalizado -> validacao determinista.
 *
 * Regra estrutural: qualquer interpretacao probabilistica (parser de texto livre ou
 * modelo de linguagem) produz apenas um RASCUNHO. O rascunho passa por
 * `validateSignal`, que e deterministico, antes de chegar ao motor de convergencia.
 * Sinal marcado como AMBIGUOUS nunca vota e nunca gera operacao automatica.
 *
 * Roteamento de mercado: o mercado do sinal vem do instrumento, nunca do palpite
 * de quem enviou. Se o mercado resultante nao estiver no cadastro da fonte, o sinal
 * e marcado MARKET_MISMATCH: fica registrado e visivel, porem fora da convergencia
 * dos dois mercados.
 */

/** Confianca minima do interpretador para o sinal ser considerado nao ambiguo. */
export const MIN_PARSER_CONFIDENCE = 0.75;

export type IngestAction = 'NEW' | 'EDIT' | 'CANCEL';

export interface SignalInput {
  sourceId: string;
  raw: RawMessage;
  parsedBy: ParserKind;
  parserConfidence?: number | null;
  action?: IngestAction;

  /** Mercado declarado pela origem. Conferido contra o instrumento. */
  marketId?: MarketId | null;
  symbol?: string | null;
  venue?: Venue | null;
  productType?: ProductType | null;
  broker?: string | null;
  side?: Side | null;
  emittedAt?: string | null;
  entryAt?: string | null;
  timezone?: string;
  timeframeMinutes?: number | null;
  horizonMinutes?: number | null;
  validUntil?: string | null;
  entryType?: EntryType;
  entryPrice?: number | null;
  entryMin?: number | null;
  entryMax?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
}

export interface IngestContext {
  nowIso: string;
  source: Source;
  /** Sinais ja conhecidos desta fonte, do mais recente para o mais antigo. */
  existing: Signal[];
  defaultTimezone: string;
  /**
   * Preco de referencia vigente do instrumento, quando houver fonte externa. Usado
   * apenas na checagem de plausibilidade: sem ele, vale o preco do catalogo, que e
   * um valor inicial arbitrario e envelhece.
   */
  referencePriceOf?: (symbol: string) => number | null;
}

export type IngestOutcome =
  | { kind: 'ACCEPTED'; signal: Signal; supersededId: string | null }
  | { kind: 'DUPLICATE'; signal: Signal; duplicateOfId: string }
  | { kind: 'CANCELLATION'; cancelledId: string; note: string }
  | { kind: 'REJECTED'; signal: Signal; reason: string };

// ---------------------------------------------------------------------------
// Parser de texto livre (deterministico, sem modelo de linguagem)
// ---------------------------------------------------------------------------

const BUY_WORDS = ['compra', 'comprar', 'buy', 'long', 'alta', 'call'];
const SELL_WORDS = ['venda', 'vender', 'sell', 'short', 'baixa', 'put'];

export interface ParsedDraft {
  symbol: string | null;
  marketId: MarketId | null;
  side: Side | null;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  timeframeMinutes: number | null;
  confidence: number;
  notes: string[];
}

/**
 * Extrai campos de uma mensagem em texto livre. Devolve confianca baixa quando o
 * texto e contraditorio ou incompleto. O resultado ainda passa por validacao.
 */
export function parseFreeText(text: string): ParsedDraft {
  const lower = text.toLowerCase();
  const notes: string[] = [];

  const hasBuy = BUY_WORDS.some((w) => lower.includes(w));
  const hasSell = SELL_WORDS.some((w) => lower.includes(w));
  let side: Side | null = null;
  if (hasBuy && !hasSell) side = 'BUY';
  else if (hasSell && !hasBuy) side = 'SELL';
  else if (hasBuy && hasSell) notes.push('Mensagem contem termos de compra e de venda.');
  else notes.push('Nenhuma direcao reconhecida na mensagem.');

  /*
   * So aceita como instrumento aquilo que existe no catalogo. Sem esta checagem,
   * uma palavra de seis letras como "COMPRA" seria lida como par de moedas.
   */
  const candidates =
    text.toUpperCase().match(/\b[A-Z]{3,12}(?:-OTC|-PERP)?\b|\b[A-Z]{3,5}\/[A-Z]{3,5}\b/g) ?? [];
  let symbol: string | null = null;
  let marketId: MarketId | null = null;
  for (const candidate of candidates) {
    const normalized = candidate.replace('/', '');
    const instrument = getInstrument(normalized);
    if (instrument) {
      symbol = instrument.symbol;
      marketId = instrument.marketId;
      break;
    }
  }
  if (!symbol) notes.push('Nenhum instrumento reconhecido na mensagem.');

  const num = (re: RegExp): number | null => {
    const m = lower.match(re);
    if (!m?.[1]) return null;
    const v = Number(m[1].replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(v) ? v : null;
  };

  const numPlain = (re: RegExp): number | null => {
    const m = lower.match(re);
    if (!m?.[1]) return null;
    const v = Number(m[1].replace(',', '.'));
    return Number.isFinite(v) ? v : null;
  };

  const entryPrice = numPlain(/(?:entrada|entry|@|preco)\s*:?\s*([0-9]+(?:[.,][0-9]+)?)/);
  const stopLoss = numPlain(/(?:sl|stop|stop loss)\s*:?\s*([0-9]+(?:[.,][0-9]+)?)/);
  const takeProfit = numPlain(/(?:tp|alvo|take profit)\s*:?\s*([0-9]+(?:[.,][0-9]+)?)/);
  void num;

  const tfMatch = lower.match(/\b(m|h)\s?(\d{1,3})\b/);
  let timeframeMinutes: number | null = null;
  if (tfMatch?.[1] && tfMatch?.[2]) {
    timeframeMinutes = tfMatch[1] === 'h' ? Number(tfMatch[2]) * 60 : Number(tfMatch[2]);
  }

  let confidence = 1;
  if (!side) confidence -= 0.5;
  if (!symbol) confidence -= 0.4;
  if (hasBuy && hasSell) confidence -= 0.3;
  if (entryPrice === null) confidence -= 0.1;
  confidence = Math.max(0, Math.round(confidence * 100) / 100);

  return {
    symbol,
    marketId,
    side,
    entryPrice,
    stopLoss,
    takeProfit,
    timeframeMinutes,
    confidence,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Normalizacao + validacao
// ---------------------------------------------------------------------------

function contentFingerprint(input: SignalInput): string {
  return stableHash(
    [
      input.sourceId,
      input.symbol ?? '',
      input.side ?? '',
      input.entryPrice ?? '',
      input.stopLoss ?? '',
      input.takeProfit ?? '',
      input.raw.text.trim().toLowerCase(),
    ].join('|'),
  );
}

function normalize(input: SignalInput, ctx: IngestContext): Signal {
  const symbol = (input.symbol ?? '').toUpperCase() || '';
  const instrument = getInstrument(symbol);
  return {
    id: id('sig'),
    sourceId: ctx.source.id,
    independenceGroupId: ctx.source.independenceGroupId,
    raw: input.raw,
    parsedBy: input.parsedBy,
    parserConfidence: input.parserConfidence ?? null,

    // O mercado vem do instrumento. O campo declarado serve apenas para conferencia.
    marketId: instrument?.marketId ?? input.marketId ?? 'FOREX',
    productType: instrument?.productType ?? input.productType ?? 'FX_SPOT',
    symbol,
    venue: input.venue ?? instrument?.venue ?? 'REGULAR',
    quoteCurrency: instrument?.quote ?? 'USD',
    broker: input.broker ?? null,

    side: input.side ?? null,
    emittedAt: input.emittedAt ?? null,
    receivedAt: ctx.nowIso,
    entryAt: input.entryAt ?? null,
    timezone: input.timezone ?? ctx.defaultTimezone,

    timeframeMinutes: input.timeframeMinutes ?? null,
    horizonMinutes: input.horizonMinutes ?? input.timeframeMinutes ?? null,
    validUntil: input.validUntil ?? null,

    entryType: input.entryType ?? (input.entryPrice == null ? 'MARKET' : 'LIMIT'),
    entryPrice: input.entryPrice ?? null,
    entryMin: input.entryMin ?? null,
    entryMax: input.entryMax ?? null,
    stopLoss: input.stopLoss ?? null,
    takeProfit: input.takeProfit ?? null,

    status: 'VALID',
    issues: [],
    version: 1,
    supersedesSignalId: null,
    supersededBySignalId: null,
  };
}

/**
 * Validacao determinista. Nao depende de modelo, de aleatoriedade nem de
 * configuracao do usuario: as mesmas entradas produzem sempre o mesmo resultado.
 */
export function validateSignal(
  signal: Signal,
  nowIso: string,
  source?: Pick<Source, 'markets' | 'name'>,
  declaredMarketId?: MarketId | null,
  liveReferencePrice?: number | null,
): Signal {
  const issues: SignalIssue[] = [];
  let status: Signal['status'] = 'VALID';

  const instrument = getInstrument(signal.symbol);

  if (!signal.symbol) {
    issues.push({ code: 'SEM_INSTRUMENTO', message: 'Instrumento nao identificado.', severity: 'BLOCK' });
    status = 'INCOMPLETE';
  } else if (!instrument) {
    issues.push({
      code: 'INSTRUMENTO_NAO_SUPORTADO',
      message: `Instrumento ${signal.symbol} fora do catalogo dos mercados suportados (Forex e Cripto).`,
      severity: 'BLOCK',
    });
    status = 'REJECTED';
  } else if (instrument.venue !== signal.venue) {
    issues.push({
      code: 'AMBIENTE_INCONSISTENTE',
      message: `Ambiente informado (${signal.venue}) diverge do cadastro do instrumento (${instrument.venue}).`,
      severity: 'BLOCK',
    });
    status = 'REJECTED';
  }

  // --- Roteamento de mercado ------------------------------------------------
  if (instrument) {
    if (declaredMarketId && declaredMarketId !== instrument.marketId) {
      issues.push({
        code: 'MERCADO_DECLARADO_DIVERGE',
        message: `Mensagem declarou ${MARKET_LABEL[declaredMarketId]}, porem ${instrument.symbol} pertence a ${MARKET_LABEL[instrument.marketId]}. Vale o instrumento.`,
        severity: 'WARN',
      });
    }
    if (source && !source.markets.includes(instrument.marketId)) {
      const cadastro =
        source.markets.length === 0
          ? 'nenhum mercado classificado'
          : source.markets.map((m) => MARKET_LABEL[m]).join(' e ');
      issues.push({
        code: 'MERCADO_NAO_CADASTRADO',
        message: `A fonte esta cadastrada para ${cadastro} e este sinal e de ${MARKET_LABEL[instrument.marketId]} (${PRODUCT_LABEL[instrument.productType]}). O sinal fica registrado, porem fora da convergencia.`,
        severity: 'BLOCK',
      });
      status = 'MARKET_MISMATCH';
    }
  }

  if (!signal.side) {
    issues.push({ code: 'SEM_DIRECAO', message: 'Direcao da operacao nao identificada.', severity: 'BLOCK' });
    if (status === 'VALID') status = 'AMBIGUOUS';
  }

  if (
    signal.parsedBy === 'AI_ASSISTED' &&
    (signal.parserConfidence ?? 0) < MIN_PARSER_CONFIDENCE
  ) {
    issues.push({
      code: 'INTERPRETACAO_INCERTA',
      message: `Confianca do interpretador ${(signal.parserConfidence ?? 0).toFixed(2)} abaixo do minimo ${MIN_PARSER_CONFIDENCE}. Sinal nao vota e nao gera operacao automatica.`,
      severity: 'BLOCK',
    });
    if (status === 'VALID') status = 'AMBIGUOUS';
  }

  if (instrument && signal.entryPrice != null) {
    // Preco de referencia externo vence o valor inicial do catalogo, quando existe.
    const reference =
      liveReferencePrice != null && liveReferencePrice > 0
        ? liveReferencePrice
        : instrument.referencePrice;
    const origem = liveReferencePrice != null && liveReferencePrice > 0 ? 'referencia externa' : 'catalogo';
    const drift = Math.abs(signal.entryPrice - reference) / reference;
    if (drift > 0.2) {
      issues.push({
        code: 'PRECO_IMPLAUSIVEL',
        message: `Preco de entrada ${signal.entryPrice} distante mais de 20% da referencia (${reference}, ${origem}).`,
        severity: 'BLOCK',
      });
      status = 'REJECTED';
    }
  }

  if (signal.side && signal.entryPrice != null) {
    if (signal.stopLoss != null) {
      const wrongSide =
        signal.side === 'BUY' ? signal.stopLoss >= signal.entryPrice : signal.stopLoss <= signal.entryPrice;
      if (wrongSide) {
        issues.push({
          code: 'STOP_INVERTIDO',
          message: 'Stop loss esta do lado errado do preco de entrada para a direcao informada.',
          severity: 'BLOCK',
        });
        if (status === 'VALID') status = 'AMBIGUOUS';
      }
    }
    if (signal.takeProfit != null) {
      const wrongSide =
        signal.side === 'BUY'
          ? signal.takeProfit <= signal.entryPrice
          : signal.takeProfit >= signal.entryPrice;
      if (wrongSide) {
        issues.push({
          code: 'ALVO_INVERTIDO',
          message: 'Take profit esta do lado errado do preco de entrada para a direcao informada.',
          severity: 'BLOCK',
        });
        if (status === 'VALID') status = 'AMBIGUOUS';
      }
    }
  }

  if (signal.entryPrice == null && signal.entryType === 'LIMIT') {
    issues.push({
      code: 'ENTRADA_INCOMPLETA',
      message: 'Entrada limitada sem preco informado.',
      severity: 'BLOCK',
    });
    if (status === 'VALID') status = 'INCOMPLETE';
  }

  if (signal.emittedAt && minutesBetween(nowIso, signal.emittedAt) > 1) {
    issues.push({
      code: 'EMISSAO_NO_FUTURO',
      message: 'Horario de emissao no futuro em relacao ao recebimento.',
      severity: 'WARN',
    });
  }

  if (signal.emittedAt) {
    const lagMin = minutesBetween(signal.emittedAt, signal.receivedAt);
    if (lagMin > 5) {
      issues.push({
        code: 'SINAL_ATRASADO',
        message: `Mensagem recebida ${lagMin.toFixed(1)} min apos a emissao.`,
        severity: 'WARN',
      });
    }
  }

  if (signal.validUntil && Date.parse(signal.validUntil) <= Date.parse(nowIso)) {
    issues.push({
      code: 'SINAL_EXPIRADO',
      message: 'Validade do sinal ja passou no momento do recebimento.',
      severity: 'BLOCK',
    });
    status = 'EXPIRED';
  }

  if (!signal.timeframeMinutes) {
    issues.push({
      code: 'SEM_TIMEFRAME',
      message: 'Timeframe ausente. A comparacao por horizonte sera pulada para este sinal.',
      severity: 'INFO',
    });
  }

  return { ...signal, status, issues };
}

// ---------------------------------------------------------------------------
// Duplicatas, edicoes e cancelamentos
// ---------------------------------------------------------------------------

/** Janela usada para considerar duas mensagens iguais como repeticao. */
export const DUPLICATE_WINDOW_MINUTES = 30;

export function ingest(input: SignalInput, ctx: IngestContext): IngestOutcome {
  const action = input.action ?? 'NEW';
  const externalId = input.raw.externalMessageId;

  // Cancelamento explicito de uma mensagem anterior.
  if (action === 'CANCEL') {
    const target = ctx.existing.find(
      (s) =>
        s.raw.externalMessageId != null &&
        s.raw.externalMessageId === externalId &&
        s.status !== 'CANCELLED',
    );
    if (!target) {
      return {
        kind: 'REJECTED',
        signal: validateSignal(
          normalize(input, ctx),
          ctx.nowIso,
          ctx.source,
          input.marketId ?? null,
          ctx.referencePriceOf?.(input.symbol ?? '') ?? null,
        ),
        reason: `Cancelamento sem sinal correspondente (mensagem ${externalId ?? 'sem id'}).`,
      };
    }
    return {
      kind: 'CANCELLATION',
      cancelledId: target.id,
      note: `Fonte cancelou a mensagem ${externalId}. O voto sai do agrupamento.`,
    };
  }

  const draft = normalize(input, ctx);

  // Edicao: mesma mensagem de origem, conteudo diferente -> nova versao.
  if (externalId) {
    const prior = ctx.existing.find(
      (s) => s.raw.externalMessageId === externalId && s.supersededBySignalId === null,
    );
    if (prior) {
      const same = contentFingerprint(input) === contentFingerprint(toInput(prior));
      if (same) {
        return { kind: 'DUPLICATE', signal: prior, duplicateOfId: prior.id };
      }
      const edited = validateSignal(
        { ...draft, version: prior.version + 1, supersedesSignalId: prior.id },
        ctx.nowIso,
        ctx.source,
        input.marketId ?? null,
        ctx.referencePriceOf?.(input.symbol ?? '') ?? null,
      );
      return { kind: 'ACCEPTED', signal: edited, supersededId: prior.id };
    }
  }

  /*
   * Duplicata por conteudo: usada apenas quando a origem NAO fornece identificador
   * de mensagem. Se a fonte deu ids distintos, sao mensagens distintas — o colapso
   * para um voto unico por fonte ja e feito no motor de convergencia.
   */
  if (!externalId) {
    const fp = contentFingerprint(input);
    const dup = ctx.existing.find(
      (s) =>
        s.raw.externalMessageId == null &&
        contentFingerprint(toInput(s)) === fp &&
        minutesBetween(s.receivedAt, ctx.nowIso) <= DUPLICATE_WINDOW_MINUTES,
    );
    if (dup) {
      return { kind: 'DUPLICATE', signal: dup, duplicateOfId: dup.id };
    }
  }

  const validated = validateSignal(
    draft,
    ctx.nowIso,
    ctx.source,
    input.marketId ?? null,
    ctx.referencePriceOf?.(input.symbol ?? '') ?? null,
  );
  if (validated.status === 'REJECTED') {
    return {
      kind: 'REJECTED',
      signal: validated,
      reason: validated.issues.find((i) => i.severity === 'BLOCK')?.message ?? 'Sinal recusado.',
    };
  }
  return { kind: 'ACCEPTED', signal: validated, supersededId: null };
}

function toInput(signal: Signal): SignalInput {
  return {
    sourceId: signal.sourceId,
    raw: signal.raw,
    parsedBy: signal.parsedBy,
    symbol: signal.symbol,
    side: signal.side,
    entryPrice: signal.entryPrice,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
  };
}

/** Reavalia expiracao de um sinal ja armazenado. */
export function refreshSignalStatus(
  signal: Signal,
  nowIso: string,
  maxAgeMinutes: number,
): Signal {
  if (
    signal.status === 'CANCELLED' ||
    signal.status === 'SUPERSEDED' ||
    signal.status === 'REJECTED' ||
    signal.status === 'MARKET_MISMATCH'
  ) {
    return signal;
  }
  const ageMin = minutesBetween(signal.receivedAt, nowIso);
  const ownExpiry = signal.validUntil ? Date.parse(signal.validUntil) <= Date.parse(nowIso) : false;
  if (ownExpiry || ageMin > maxAgeMinutes) {
    if (signal.status === 'EXPIRED') return signal;
    return {
      ...signal,
      status: 'EXPIRED',
      issues: [
        ...signal.issues,
        {
          code: 'EXPIRADO',
          message: ownExpiry
            ? 'Validade declarada pelo sinal foi atingida.'
            : `Sinal passou da idade maxima configurada (${maxAgeMinutes} min).`,
          severity: 'BLOCK',
        },
      ],
    };
  }
  return signal;
}
