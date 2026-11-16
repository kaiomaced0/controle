/**
 * Porta de entrada do modo telemetria.
 *
 * Quem usa a telemetria importa daqui, não dos arquivos internos:
 *
 * ```ts
 * import { criarPainel, montarQuadro } from './telemetria/indice.js';
 * ```
 *
 * Divisão interna:
 * - `quadro.ts` — as linhas de texto (só formatação, sem efeito nenhum)
 * - `painel.ts` — a escrita na tela sem piscar e sem rolar (escapes de terminal)
 * - `cpu.ts`    — o por cento de CPU do próprio processo, em janela de 1 s
 */

export * from './cpu.js';
export * from './painel.js';
export * from './quadro.js';
