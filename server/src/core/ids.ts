import { randomUUID } from 'node:crypto';

let counter = 0;

/** Identificador curto e legivel, com prefixo por tipo de entidade. */
export function id(prefix: string): string {
  counter += 1;
  const stamp = Date.now().toString(36);
  const seq = counter.toString(36).padStart(3, '0');
  return `${prefix}_${stamp}${seq}`;
}

export function uuid(): string {
  return randomUUID();
}

/**
 * Identificador de cliente para a ordem. Deterministico por oportunidade e versao:
 * reenvios apos timeout usam a MESMA chave, o que permite a corretora deduplicar
 * e permite a reconciliacao local antes de um novo envio.
 */
export function clientOrderIdFor(opportunityId: string, version: number): string {
  return `opp-${opportunityId}-v${version}`;
}

/** Hash estavel e curto, usado para detectar mensagens duplicadas. */
export function stableHash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
