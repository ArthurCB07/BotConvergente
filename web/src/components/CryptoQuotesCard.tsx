import { useState } from 'react';
import { api } from '../api.ts';
import { Badge, Card, Empty, clock, relative } from './ui.tsx';

/**
 * Cotacao publica da Binance Spot.
 *
 * Ultimo negocio, melhor compra e melhor venda aparecem em colunas distintas: sao
 * precos diferentes e nao devem ser lidos como o mesmo numero. A moeda de cotacao
 * fica sempre visivel no par (USDT nunca vira USD).
 */

const STATE_TONE: Record<string, 'ok' | 'block' | 'watch' | 'risk' | 'neutral'> = {
  OK: 'ok',
  CARREGANDO: 'watch',
  RECONECTANDO: 'block',
  DESATUALIZADA: 'block',
  INDISPONIVEL: 'risk',
};

const STATE_LABEL: Record<string, string> = {
  OK: 'ao vivo',
  CARREGANDO: 'carregando',
  RECONECTANDO: 'reconectando',
  DESATUALIZADA: 'desatualizada',
  INDISPONIVEL: 'indisponivel',
};

const STREAM_LABEL: Record<string, string> = {
  ABERTO: 'aberto',
  CONECTANDO: 'conectando',
  RECONECTANDO: 'reconectando',
  PARADO: 'parado',
};

/** Casas decimais derivadas do tickSize do proprio par, sem perder precisao. */
function decimalsFromTick(tickSize: number | null): number {
  if (!tickSize || tickSize <= 0) return 2;
  return Math.min(Math.max(0, Math.round(-Math.log10(tickSize))), 8);
}

function fixed(value: number | null, decimals: number): string {
  if (value == null) return '—';
  return value.toLocaleString('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function CryptoQuotesCard({ cryptoQuotes, now }: { cryptoQuotes: any | null; now: string }) {
  const [busy, setBusy] = useState(false);
  const [symbolsInput, setSymbolsInput] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const status = cryptoQuotes?.status;
  const quotes: any[] = cryptoQuotes?.quotes ?? [];
  const state = status?.state ?? 'INDISPONIVEL';

  return (
    <Card
      title="Cotacao de mercado"
      aside={
        <span className="row" style={{ gap: 6 }}>
          <Badge tone={STATE_TONE[state] ?? 'neutral'}>{STATE_LABEL[state] ?? state}</Badge>
          <Badge tone={status?.streamState === 'ABERTO' ? 'ok' : 'block'}>
            stream {STREAM_LABEL[status?.streamState] ?? '—'}
          </Badge>
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.refreshCryptoQuotes();
              } finally {
                setBusy(false);
              }
            }}
          >
            Recarregar
          </button>
        </span>
      }
    >
      <div className="notice small" style={{ marginBottom: 12 }}>
        <strong>{status?.sourceLabel ?? 'Binance · Spot'}.</strong>{' '}
        {status?.disclaimer ??
          'Preco publico do mercado a vista da Binance. Nao ha acesso a conta, saldo ou envio de ordem.'}
      </div>

      {state !== 'OK' && status?.message && (
        <div
          className={state === 'INDISPONIVEL' ? 'notice notice-risk small' : 'notice notice-warn small'}
          style={{ marginBottom: 10 }}
        >
          {status.message}
        </div>
      )}

      {quotes.length === 0 ? (
        <Empty>{status?.message ?? 'Sem cotacao disponivel.'}</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Par</th>
                <th className="num">Ultimo negocio</th>
                <th className="num">Melhor compra</th>
                <th className="num">Melhor venda</th>
                <th className="num">Max 24h</th>
                <th className="num">Min 24h</th>
                <th className="num">24h %</th>
                <th>Horarios</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((q: any) => {
                const d = decimalsFromTick(q.tickSize);
                return (
                  <tr key={q.symbol}>
                    <td>
                      <div className="num">{q.pairLabel}</div>
                      <div className="tiny dim">
                        {q.exchange} · {q.marketType} · {q.symbol}
                      </div>
                    </td>
                    <td className="num">{fixed(q.lastPrice, d)}</td>
                    <td className="num">{fixed(q.bid, d)}</td>
                    <td className="num">{fixed(q.ask, d)}</td>
                    <td className="num">{fixed(q.high24h, d)}</td>
                    <td className="num">{fixed(q.low24h, d)}</td>
                    <td className={`num ${(q.priceChangePercent ?? 0) >= 0 ? 'gain' : 'loss'}`}>
                      {q.priceChangePercent == null ? '—' : `${q.priceChangePercent.toFixed(2)}%`}
                    </td>
                    <td className="tiny">
                      <div>
                        negocio:{' '}
                        {q.lastTradeAt ? (
                          <span className="num">{clock(q.lastTradeAt)}</span>
                        ) : (
                          <span className="dim">nao informado</span>
                        )}
                      </div>
                      <div className="dim">
                        livro: provedor nao envia horario · recebido{' '}
                        {q.bookReceivedAt ? clock(q.bookReceivedAt) : '—'}
                      </div>
                      <div className="dim">24h ate {q.stats24hAt ? clock(q.stats24hAt) : '—'}</div>
                    </td>
                    <td>
                      {q.stale ? (
                        <Badge tone="block">desatualizada</Badge>
                      ) : (
                        <Badge tone="ok">ok</Badge>
                      )}
                      {q.staleReason && <div className="tiny dim">{q.staleReason}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {status && (
        <dl className="param-note small" style={{ marginTop: 12 }}>
          <dt>Fonte</dt>
          <dd>
            {status.sourceLabel} · REST <span className="num">{status.restBase}</span> · stream{' '}
            <span className="num">{status.streamBase}</span>
          </dd>
          <dt>Conexao</dt>
          <dd>
            {status.streamDetail} · {Number(status.messagesReceived ?? 0).toLocaleString('pt-BR')}{' '}
            mensagem(ns) · {status.reconnects} reconexao(oes) · {status.restRequests} consulta(s) REST
          </dd>
          <dt>Recebido</dt>
          <dd>
            ultima mensagem {status.lastMessageAt ? relative(status.lastMessageAt, now) : '—'} ·
            ultimo REST {status.lastRestAt ? relative(status.lastRestAt, now) : '—'}
          </dd>
          {status.incompatibleSymbols?.length > 0 && (
            <>
              <dt>Incompativel</dt>
              <dd>
                {status.incompatibleSymbols.map((i: any) => (
                  <div key={i.symbol}>
                    <span className="num">{i.symbol}</span> — {i.reason}
                  </div>
                ))}
              </dd>
            </>
          )}
        </dl>
      )}

      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <input
          type="text"
          value={symbolsInput}
          placeholder={status?.symbols?.join(', ') ?? 'BTCUSDT, ETHUSDT'}
          onChange={(e) => setSymbolsInput(e.target.value)}
          style={{ maxWidth: 300 }}
        />
        <button
          className="btn btn-sm"
          disabled={busy || !symbolsInput.trim()}
          onClick={async () => {
            setBusy(true);
            setNote(null);
            try {
              const result = (await api.setCryptoSymbols(
                symbolsInput
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              )) as any;
              setNote(result.message);
              if (result.ok) setSymbolsInput('');
            } catch (e) {
              setNote((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Trocar pares
        </button>
        <span className="tiny dim">
          Validado em exchangeInfo antes de aceitar: somente pares a vista com negociacao ativa.
        </span>
      </div>
      {note && (
        <div className="notice small" style={{ marginTop: 8 }}>
          {note}
        </div>
      )}
    </Card>
  );
}
