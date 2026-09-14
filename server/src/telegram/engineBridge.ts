import type { Engine } from '../engine/engine.ts';
import type { TelegramEngineBridge } from './telegramService.ts';
import type { TelegramRoom } from './types.ts';

/**
 * Liga as salas do Telegram ao motor de convergencia.
 *
 * Cada sala monitorada vira UMA fonte, com id derivado do id estavel do peer —
 * nunca do titulo, que muda. Salas que replicam a mesma origem compartilham o
 * `independenceGroupId` e por isso contam como um voto so, exatamente como
 * qualquer outra fonte do sistema.
 */
export function createTelegramEngineBridge(engine: Engine): TelegramEngineBridge {
  const sourceIdOf = (room: TelegramRoom) => room.sourceId ?? `src_tg_${room.peerId}`;

  return {
    nowIso: () => engine.clock.nowIso(),

    upsertSource(room: TelegramRoom): string {
      const sourceId = sourceIdOf(room);
      const patch = {
        name: room.displayName,
        markets: room.markets,
        /*
         * `enabled` controla apenas a participacao na convergencia. Mensagem de
         * sala com voto desligado continua sendo recebida, registrada e exibida —
         * ela so nao entra na contagem.
         */
        enabled: room.participatesInConvergence,
        independenceGroupId: room.independenceGroupId,
        notes: `Sala do Telegram ${room.peerId}${room.username ? ` (@${room.username})` : ''}.`,
      };

      const existing = engine.sources.find((s) => s.id === sourceId);
      if (existing) {
        engine.updateSource(sourceId, patch);
      } else {
        engine.addSource({ id: sourceId, kind: 'TELEGRAM', tags: ['telegram'], ...patch });
      }
      return sourceId;
    },

    removeSource(sourceId: string): void {
      engine.removeSource(sourceId);
    },

    ingestSignal(input) {
      return engine.ingestSignal(input);
    },
  };
}
