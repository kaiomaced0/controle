/**
 * Porta de entrada do transporte no lado do PC.
 *
 * Quem quer subir o servidor, ler telemetria de sessão ou pendurar o pipeline de movimento
 * importa daqui, não dos arquivos internos:
 *
 * ```ts
 * import { criarServidorDeTransporte } from './transporte/indice.js';
 * ```
 *
 * Divisão interna:
 * - `servidor.ts` — `WebSocketServer`, sessão única e ciclo de vida da porta
 * - `sessao.ts`   — handshake, heartbeat e roteamento de quadros de **uma** sessão
 * - `metricas.ts` — contadores e estatísticas por sessão (PROTOCOLO.md, seção 7)
 */

export * from './metricas.js';
export * from './sessao.js';
export * from './servidor.js';
