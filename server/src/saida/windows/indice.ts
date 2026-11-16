/**
 * Porta de entrada do backend do Windows.
 *
 * Quase ninguém importa daqui: o resto do servidor pede o backend a `saida/escolha.ts`, que é
 * quem sabe qual plataforma tem qual implementação. Este barril existe para o teste da ponte e
 * para as ferramentas de bancada (`ferramentas/provar-mouse.mjs`).
 *
 * Divisão interna:
 * - `constantes.ts` — os números do Win32 e o mapa de bytes das estruturas em x64
 * - `api.ts`        — a ponte `koffi` com `user32.dll` (e a conferência de tamanho na partida)
 * - `aceleracao.ts` — a configuração de ponteiro, o modelo da curva e a escolha da saída (ATI-026)
 * - `absoluto.ts`   — a régua da saída absoluta: pixel ↔ coordenada normalizada (ATI-026)
 * - `backend.ts`    — o `BackendDeEntrada` propriamente dito
 */

export * from './constantes.js';
export * from './api.js';
export * from './aceleracao.js';
export * from './absoluto.js';
export * from './backend.js';
