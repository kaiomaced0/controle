/**
 * Relógio monotônico do lado JS.
 *
 * `Date.now()` é relógio de parede: um ajuste de horário (NTP, fuso, usuário) muda o valor para
 * trás e envenena qualquer medida de intervalo. `performance.now()` é monotônico e é o que o
 * React Native expõe no ambiente JS; o `typeof` protege ambientes que não o definam.
 */

declare const performance: {now(): number} | undefined;

/** Milissegundos desde uma origem arbitrária, sempre crescente. */
export function agoraMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
