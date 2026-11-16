/**
 * Destino de **ensaio**: o pipeline roda inteiro e ninguém encosta no cursor.
 *
 * É o destino **padrão** da ATI-008 (`CONTROLE_MOVIMENTO=ensaio`), e a razão é a mesma que fez
 * `npm test` falar com a dubla desde a ATI-007: tem gente trabalhando nesta máquina. Ligar o
 * `SendInput` de verdade no primeiro dia em que existe uma cadeia que transforma giroscópio em
 * pixel é como se rouba o mouse de quem está do outro lado da tela — e um cursor que sai andando
 * sozinho por causa de um sinal invertido é exatamente o defeito que esta atividade existe para
 * caçar. Quem quiser o cursor de verdade pede: `CONTROLE_MOVIMENTO=sistema`.
 *
 * Ele não é um objeto vazio: soma o que o pipeline pediu, guarda o maior pulo de uma amostra e
 * conta as chamadas. É com esses números que se responde, depois de uma passada com o celular na
 * mão, "para que lado o cursor teria ido e quanto ele teria andado" — sem ter andado.
 *
 * Diferença para `saida/dubla.ts`, que continua sendo o dublê dos **testes**: a dubla implementa
 * o `BackendDeEntrada` inteiro (botão, tecla, scroll, cursor virtual limitado pela tela) e aloca
 * um objeto por evento, porque é a lista de eventos que o teste inspeciona. Este aqui é código de
 * produção no caminho quente: só números, nenhuma alocação por amostra.
 */

import type { DestinoDeMovimento } from './tipos.js';

export interface DestinoDeEnsaio extends DestinoDeMovimento {
  /** Quantas vezes o pipeline pediu movimento. */
  readonly chamadas: number;
  /** Soma dos pixels pedidos no eixo horizontal (positivo = direita). */
  readonly pixelsX: number;
  /** Soma dos pixels pedidos no eixo vertical (positivo = para baixo). */
  readonly pixelsY: number;
  /** Maior deslocamento de **uma** amostra em cada eixo, em módulo — o pico do percurso. */
  readonly maiorPuloX: number;
  readonly maiorPuloY: number;
  /** Pedidos recusados por não serem número finito. Nunca deveria acontecer; se acontecer, aparece. */
  readonly pedidosInvalidos: number;
  /** Zera tudo. Fora do caminho quente (fim de sessão, troca de perfil). */
  zerar(): void;
  /** Uma linha para o log de fim de sessão. Aloca — nunca chame por amostra. */
  resumir(): string;
}

export function criarDestinoDeEnsaio(): DestinoDeEnsaio {
  let chamadas = 0;
  let pixelsX = 0;
  let pixelsY = 0;
  let maiorPuloX = 0;
  let maiorPuloY = 0;
  let pedidosInvalidos = 0;

  return {
    nome: 'ensaio',

    moverMouseRelativo(dx, dy) {
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
        pedidosInvalidos += 1;
        return;
      }
      chamadas += 1;
      pixelsX += dx;
      pixelsY += dy;
      const moduloX = dx < 0 ? -dx : dx;
      const moduloY = dy < 0 ? -dy : dy;
      if (moduloX > maiorPuloX) maiorPuloX = moduloX;
      if (moduloY > maiorPuloY) maiorPuloY = moduloY;
    },

    get chamadas() {
      return chamadas;
    },
    get pixelsX() {
      return pixelsX;
    },
    get pixelsY() {
      return pixelsY;
    },
    get maiorPuloX() {
      return maiorPuloX;
    },
    get maiorPuloY() {
      return maiorPuloY;
    },
    get pedidosInvalidos() {
      return pedidosInvalidos;
    },

    zerar() {
      chamadas = 0;
      pixelsX = 0;
      pixelsY = 0;
      maiorPuloX = 0;
      maiorPuloY = 0;
      pedidosInvalidos = 0;
    },

    resumir() {
      return (
        `chamadas=${chamadas} pixelsX=${pixelsX} pixelsY=${pixelsY} ` +
        `maiorPulo=${maiorPuloX}/${maiorPuloY}`
      );
    },
  };
}
