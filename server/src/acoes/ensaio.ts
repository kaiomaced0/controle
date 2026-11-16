/**
 * Destino de **ensaio** para as ações: o toque percorre a cadeia inteira e ninguém clica.
 *
 * É o destino **padrão**, e aqui a razão é ainda mais dura que a do movimento (`movimento/
 * ensaio.ts`): um cursor que anda sozinho atrapalha; um **clique** injetado acontece onde o
 * cursor estiver, e ali pode ter um botão de verdade — "excluir", "enviar", "confirmar". Enquanto
 * houver gente trabalhando nesta máquina, clique só sai com `CONTROLE_MOVIMENTO=sistema`, pedido
 * de propósito, na mesma chave que já liga o cursor.
 *
 * Ele não é um objeto vazio: usa o **mesmo** registro de pressionados do backend do Windows
 * (`saida/pressionados.ts`), então "nada ficou preso" continua sendo uma afirmação verificável no
 * modo padrão, e conta os entalhes que teriam rolado. É com esses números que se responde, depois
 * de uma passada com o celular na mão, "o que teria acontecido" — sem ter acontecido.
 *
 * Diferença para `saida/dubla.ts`, que continua sendo o dublê dos **testes**: a dubla implementa o
 * `BackendDeEntrada` inteiro e aloca um objeto por evento, porque é a lista de eventos que o teste
 * inspeciona. Este aqui é código de produção: só números, nenhuma alocação por toque.
 */

import { criarRegistroDePressionados } from '../saida/pressionados.js';
import { ehBotaoDoMouse, type BotaoDoMouse } from '../saida/tipos.js';
import type { DestinoDeAcoes } from './tipos.js';

export interface DestinoDeAcoesDeEnsaio extends DestinoDeAcoes {
  /** Quantos apertos de botão o mapeador pediu. */
  readonly apertos: number;
  /** Quantas solturas de botão o mapeador pediu. */
  readonly solturas: number;
  /** Quantos apertos de cada botão — é o que separa "clicou" de "clicou com o botão errado". */
  apertosDoBotao(botao: BotaoDoMouse): number;
  /** Soma com sinal dos entalhes verticais pedidos (positivo = para cima). */
  readonly entalhesVerticais: number;
  /** Soma com sinal dos entalhes horizontais pedidos (positivo = para a direita). */
  readonly entalhesHorizontais: number;
  /** Pedidos recusados por não serem número finito, ou por botão fora dos três da v1. */
  readonly pedidosInvalidos: number;
  /** Botões que `soltarTudo()` encontrou presos. */
  readonly soltasDeSeguranca: number;
  /** Zera tudo. Fora do caminho de entrada (fim de sessão, troca de perfil). */
  zerar(): void;
  /** Uma linha para o log de fim de sessão. Aloca — nunca chame por toque. */
  resumir(): string;
}

export function criarDestinoDeAcoesDeEnsaio(): DestinoDeAcoesDeEnsaio {
  const registro = criarRegistroDePressionados();
  // Um contador por botão, indexado como em `BOTOES_DO_MOUSE`. Objeto fixo: nada aloca por toque.
  const apertosPorBotao = { esquerdo: 0, direito: 0, meio: 0 };

  let apertos = 0;
  let solturas = 0;
  let entalhesVerticais = 0;
  let entalhesHorizontais = 0;
  let pedidosInvalidos = 0;
  let soltasDeSeguranca = 0;

  function soltarNaForca(_botao: BotaoDoMouse): void {
    // O ensaio não tem para onde mandar a soltura: o registro já foi drenado por quem chamou, e
    // é isso que "soltar" significa aqui. A contagem é feita em `soltarTudo`.
  }

  return {
    nome: 'ensaio',

    botaoMouse(botao, pressionado) {
      // Mesma guarda do backend real: nome fora dos três é pedido inválido, nunca estado preso
      // que ninguém saberia soltar (`saida/tipos.ts`).
      if (!ehBotaoDoMouse(botao)) {
        pedidosInvalidos += 1;
        return;
      }
      if (!registro.marcarBotao(botao, pressionado)) return;
      if (pressionado) {
        apertos += 1;
        apertosPorBotao[botao] += 1;
        return;
      }
      solturas += 1;
    },

    scroll(deltaVertical, deltaHorizontal) {
      if (!Number.isFinite(deltaVertical) || !Number.isFinite(deltaHorizontal)) {
        pedidosInvalidos += 1;
        return;
      }
      entalhesVerticais += deltaVertical;
      entalhesHorizontais += deltaHorizontal;
    },

    pressionados: () => registro.quantidade(),

    soltarTudo() {
      soltasDeSeguranca += registro.soltar(soltarNaForca, () => {
        // O mapeador de ações da ATI-010 não aperta tecla; a soltura de tecla é da ATI-012.
      });
    },

    get apertos() {
      return apertos;
    },
    get solturas() {
      return solturas;
    },
    apertosDoBotao: (botao) => apertosPorBotao[botao],
    get entalhesVerticais() {
      return entalhesVerticais;
    },
    get entalhesHorizontais() {
      return entalhesHorizontais;
    },
    get pedidosInvalidos() {
      return pedidosInvalidos;
    },
    get soltasDeSeguranca() {
      return soltasDeSeguranca;
    },

    zerar() {
      apertos = 0;
      solturas = 0;
      apertosPorBotao.esquerdo = 0;
      apertosPorBotao.direito = 0;
      apertosPorBotao.meio = 0;
      entalhesVerticais = 0;
      entalhesHorizontais = 0;
      pedidosInvalidos = 0;
      soltasDeSeguranca = 0;
    },

    resumir() {
      return (
        `apertos=${apertos} (esq=${apertosPorBotao.esquerdo} dir=${apertosPorBotao.direito} ` +
        `meio=${apertosPorBotao.meio}) solturas=${solturas} ` +
        `entalhes=${entalhesVerticais.toFixed(2)}/${entalhesHorizontais.toFixed(2)}`
      );
    },
  };
}
