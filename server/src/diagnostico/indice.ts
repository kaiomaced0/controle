/**
 * Porta de entrada do cliente web de diagnóstico (ATI-025).
 *
 * Quem sobe o servidor importa daqui:
 *
 * ```ts
 * import { criarAtendenteDeDiagnostico, ligarTecladoDeVibracao } from './diagnostico/indice.js';
 * ```
 *
 * Divisão interna:
 * - `estaticos.ts` — rota `/diagnostico`, os estáticos e o codec servido ao navegador
 * - `pagina.html` / `pagina.js` — o cliente que roda no celular (não são compilados pelo `tsc`)
 * - `vibracao.ts` — RUMBLE e HÁPTICO do PC para o aparelho
 * - `teclado.ts` — o gatilho de vibração pelo terminal de quem está com o celular na mão
 */

export * from './estaticos.js';
export * from './teclado.js';
export * from './vibracao.js';
