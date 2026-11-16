/**
 * Porta de entrada do mapeador de ações (ATI-010).
 *
 * Quem quer transformar toque em clique importa daqui, não dos arquivos internos:
 *
 * ```ts
 * import { criarMapeadorDeAcoes, criarDestinoDeAcoesDeEnsaio } from './acoes/indice.js';
 * ```
 *
 * Divisão interna:
 * - `tipos.ts`        — vocabulário: ação, destino, contadores e códigos de resultado
 * - `mouse-basico.ts` — a tabela `idControle → ação` do perfil de referência
 * - `mapeador.ts`     — BOTÃO e SCROLL virando evento no destino (⚠️ caminho de entrada)
 * - `ensaio.ts`       — destino que conta e **não clica**; é o padrão, como no movimento
 */

export * from './tipos.js';
export * from './mouse-basico.js';
export * from './mapeador.js';
export * from './ensaio.js';
