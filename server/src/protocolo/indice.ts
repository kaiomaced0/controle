/**
 * Porta de entrada do codec do protocolo v0.1 no lado do PC.
 *
 * Quem precisa falar com o celular importa daqui, não dos arquivos internos:
 *
 * ```ts
 * import { criarCodificador, criarDecodificador, RESULTADO_DECODIFICACAO } from './protocolo/indice.js';
 * ```
 *
 * Divisão interna:
 * - `tipos.ts`   — constantes e formas do formato binário (espelho do PROTOCOLO.md, seções 4 e 5)
 * - `binario.ts` — leitura e escrita dos quadros binários (caminho quente, zero alocação)
 * - `sessao.ts`  — mensagens JSON de sessão (seção 3), baixa frequência
 */

export * from './tipos.js';
export * from './binario.js';
export * from './sessao.js';
