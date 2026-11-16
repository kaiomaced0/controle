/**
 * Porta de entrada da camada de saída (injeção de entrada real no sistema).
 *
 * Quem quer mexer no cursor importa daqui, não dos arquivos internos:
 *
 * ```ts
 * import { criarBackendDeEntrada, centralizarCursor } from './saida/indice.js';
 * ```
 *
 * Divisão interna:
 * - `tipos.ts`          — a interface `BackendDeEntrada` (ARQUITETURA.md, seção 2.3) e os contadores
 * - `saida-do-mouse.ts` — relativo, absoluto ou auto, e o aviso da aceleração de ponteiro (ATI-026)
 * - `pressionados.ts`   — o registro do que está preso, que faz `soltarTudo()` existir
 * - `escolha.ts`        — detecção de plataforma; é ela que devolve o backend
 * - `dubla.ts`          — backend dublê: é com ele que **todo** teste automático fala
 * - `centralizar.ts`    — o comando interno "centralizar" (ADR-7)
 * - `gesto-de-teste.ts` — o quadrado de `npm run dev -- --teste-mouse`
 * - `windows/`          — `SendInput` via `koffi` (o único código que fala com o sistema)
 *
 * A **dubla fica de fora desta porta**, de propósito: quem importa daqui é código de produção, e
 * ali `criarBackendDubla` na mesma linha de `criarBackendDeEntrada` é um pedido de acidente —
 * escolher a dubla por engano é um servidor que sobe, loga tudo certo e não mexe no cursor. Teste
 * importa `./dubla.js` direto, que é uma linha a mais e nenhuma dúvida.
 */

export * from './tipos.js';
export * from './saida-do-mouse.js';
export * from './pressionados.js';
export * from './escolha.js';
export * from './centralizar.js';
export * from './gesto-de-teste.js';
