import { useState } from 'react';
import { api, type MarketId } from '../api.ts';
import { Badge, Card, Empty, clock, dateTime, relative } from './ui.tsx';

/**
 * Cotacoes da secao. Em Forex mostra a cotacao de REFERENCIA externa; em Cripto,
 * enquanto a integracao nao existe, mostra o preco do simulador rotulado como tal.
 *
 * Estados tratados: sem configuracao, carregando, atualizada, mercado fechado,
 * desatualizada e erro. Em falha, a ultima cotacao conhecida continua na tela,
 * marcada como desatualizada — nunca substituida por valor simulado.
 */

const STATE_TONE: Record<string, 'ok' | 'block' | 'watch' | 'risk' | 'neutral'> = {
  OK: 'ok',
  CARREGANDO: 'watch',
  MERCADO_FECHADO: 'neutral',
  DESATUALIZADA: 'block',
  ERRO: 'risk',
  NAO_CONFIGURADA: 'block',
};

const STATE_LABEL: Record<string, string> = {
  OK: 'atualizada',
  CARREGANDO: 'carregando',
  MERCADO_FECHADO: 'mercado fechado',
  DESATUALIZADA: 'desatualizada',
  ERRO: 'erro',
  NAO_CONFIGURADA: 'nao configurada',
};

function num(value: number | null, digits: number): string {
  if (value == null) return '—';
  return value.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function digitsFor(symbol: string): number {
  return symbol.startsWith('USDJPY') ? 3 : 5;
}

export function ReferenceQuotesCard({
  referenceQuotes,
  now,
}: {
  referenceQuotes: any | null;
  now: string;
}) {
  const [busy, setBusy] = useState(false);
  const status = referenceQuotes?.status;
  const quotes: any[] = referenceQuotes?.quotes ?? [];
  const state = status?.state ?? 'NAO_CONFIGURADA';

  return (
    <Card
      title="Cotacao de referencia"
      aside={
        <span className="row" style={{ gap: 6 }}>
          <Badge tone={STATE_TONE[state] ?? 'neutral'}>{STATE_LABEL[state] ?? state}</Badge>
          {status?.configured && (
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.refreshQuotes();
                } finally {
                  setBusy(false);
                }
              }}
            >
              Atualizar agora
            </button>
          )}
        </span>
      }
    >
      <div className="notice small" style={{ marginBottom: 12 }}>
        <strong>{status?.sourceLabel ?? 'Cotacao de referencia · AwesomeAPI'}.</strong>{' '}
        {status?.disclaimer ??
          'Preco de referencia de mercado, para exibicao e conferencia. Nao e preco executavel de corretora.'}
      </div>

      {state === 'NAO_CONFIGURADA' ? (
        <div className="notice notice-warn small">
          <strong>Integracao nao configurada.</strong>
          <p style={{ margin: '6px 0 0' }}>{status?.message}</p>
          <ol className="small" style={{ paddingLeft: 18, margin: '8px 0 0' }}>
            <li>
              Copie <span className="num">.env.example</span> para{' '}
              <span className="num">.env</span> na raiz do projeto.
            </li>
            <li>
              Preencha <span className="num">AWESOMEAPI_KEY=</span> com a sua chave.
            </li>
            <li>Reinicie o backend.</li>
          </ol>
          <p className="tiny dim" style={{ marginTop: 8 }}>
            A chave e lida apenas no backend. Ela nunca trafega para esta tela nem aparece em log.
          </p>
        </div>
      ) : quotes.length === 0 ? (
        <Empty>{status?.message ?? 'Sem cotacao disponivel.'}</Empty>
      ) : (
        <>
          {state !== 'OK' && (
            <div
              className={state === 'ERRO' ? 'notice notice-risk small' : 'notice notice-warn small'}
              style={{ marginBottom: 10 }}
            >
              {status?.message}
              {status?.error?.retryAfterSeconds != null && (
                <> Nova tentativa em {status.error.retryAfterSeconds} s.</>
              )}
            </div>
          )}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Par</th>
                  <th className="num">Compra</th>
                  <th className="num">Venda</th>
                  <th className="num">Maxima</th>
                  <th className="num">Minima</th>
                  <th className="num">Variacao</th>
                  <th className="num">%</th>
                  <th>Cotado em</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {quotes.map((q: any) => {
                  const d = digitsFor(q.symbol);
                  return (
                    <tr key={q.symbol}>
                      <td>
                        <div className="num">{q.symbol}</div>
                        <div className="tiny dim">{q.name}</div>
                      </td>
                      <td className="num">{num(q.bid, d)}</td>
                      <td className="num">{num(q.ask, d)}</td>
                      <td className="num">{num(q.high, d)}</td>
                      <td className="num">{num(q.low, d)}</td>
                      <td className={`num ${(q.varBid ?? 0) >= 0 ? 'gain' : 'loss'}`}>
                        {num(q.varBid, d)}
                      </td>
                      <td className={`num ${(q.pctChange ?? 0) >= 0 ? 'gain' : 'loss'}`}>
                        {q.pctChange == null ? '—' : `${q.pctChange.toFixed(2)}%`}
                      </td>
                      <td className="small num" title={`Horario da negociacao informado pelo provedor: ${dateTime(q.quotedAt)}`}>
                        {clock(q.quotedAt)}
                        <div className="tiny dim">{relative(q.quotedAt, now)}</div>
                      </td>
                      <td>
                        {q.stale ? (
                          <Badge tone="block">desatualizada</Badge>
                        ) : q.staleReason ? (
                          <Badge tone="neutral">fechamento</Badge>
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
        </>
      )}

      {status && (
        <dl className="param-note small" style={{ marginTop: 12 }}>
          <dt>Fonte</dt>
          <dd>{status.sourceLabel}</dd>
          <dt>Recebido</dt>
          <dd>
            {status.lastSuccessAt ? (
              <>
                {dateTime(status.lastSuccessAt)} · {relative(status.lastSuccessAt, now)}
                <span className="dim"> (horario em que o sistema recebeu a resposta)</span>
              </>
            ) : (
              'nenhuma resposta recebida ainda'
            )}
          </dd>
          <dt>Intervalo</dt>
          <dd className="num">
            {status.refreshSeconds} s · projecao de {status.estimatedMonthlyRequests.toLocaleString('pt-BR')}{' '}
            requisicoes em 30 dias · {status.requestsThisProcess} nesta execucao
          </dd>
          {status.unsupportedSymbols?.length > 0 && (
            <>
              <dt>Sem cobertura</dt>
              <dd>
                {status.unsupportedSymbols.join(', ')} — o provedor nao tem par correspondente. Sem
                substituto: turismo e PTAX nao equivalem a forex.
              </dd>
            </>
          )}
          <dt>Proxima</dt>
          <dd>{status.nextAttemptAt ? dateTime(status.nextAttemptAt) : '—'}</dd>
        </dl>
      )}

      <p className="tiny dim" style={{ marginTop: 8 }}>
        Uma consulta bem-sucedida nao garante preco novo: o provedor devolve a ultima negociacao
        conhecida, que fora do horario de mercado e o fechamento anterior.
      </p>
    </Card>
  );
}

/** Precos do simulador, rotulados sem ambiguidade. */
export function SimulatedQuotesCard({
  quotes,
  maxSpreadPips,
  marketId,
}: {
  quotes: any[];
  maxSpreadPips: number;
  marketId: MarketId;
}) {
  return (
    <Card
      title="Preco da conta simulada"
      aside={<Badge tone="watch">SIMULADO</Badge>}
      tight
    >
      <div className="notice small" style={{ margin: 14 }}>
        {marketId === 'CRYPTO'
          ? 'Preco gerado localmente. A integracao de cotacao real de Cripto sera feita em outra etapa.'
          : 'Preco usado pelo preenchimento simulado, alinhado ao nivel da cotacao de referencia a cada atualizacao. Entre atualizacoes ele continua sendo simulado.'}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Ativo</th>
              <th className="num">Compra</th>
              <th className="num">Venda</th>
              <th className="num">Spread</th>
            </tr>
          </thead>
          <tbody>
            {quotes.map((q: any) => (
              <tr key={q.symbol}>
                <td className="num">{q.symbol}</td>
                <td className="num">{q.ask}</td>
                <td className="num">{q.bid}</td>
                <td className="num" style={{ color: q.spreadPips > maxSpreadPips ? 'var(--block)' : undefined }}>
                  {q.spreadPips}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
