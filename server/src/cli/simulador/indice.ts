/**
 * Porta de entrada do simulador de aparelho (ATI-023).
 *
 * Quem quer verificar servidor, protocolo ou pipeline **sem celular na mesa** importa daqui:
 *
 * ```ts
 * import { executarBancada } from './cli/simulador/indice.js';
 * ```
 *
 * Divisão interna:
 * - `gerador.ts` — números pseudoaleatórios com semente (é o que torna tudo repetível)
 * - `padroes.ts` — parado, rotacao, tremor, pico e gravado → sequência de amostras
 * - `cliente.ts` — o aparelho de mentira: handshake, `pong`, envio no ritmo, `bye`
 * - `bancada.ts` — servidor + simulador no mesmo processo, para `node:test`
 *
 * A linha de comando (`npm run simulador`) mora um nível acima, em `../simulador.ts`.
 */

export * from './gerador.js';
export * from './padroes.js';
export * from './cliente.js';
export * from './bancada.js';
