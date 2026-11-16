/**
 * Backend dublê — o que os testes usam, e a razão de `npm test` nunca mexer no cursor.
 *
 * Tem gente trabalhando nesta máquina. Um teste automático que chamasse `SendInput` roubaria o
 * mouse de quem está do outro lado da tela no meio da suíte — por isso a regra deste sprint é
 * dura: **todo teste fala com a dubla**, e o `SendInput` de verdade só é exercitado à mão, por
 * `ferramentas/provar-mouse.mjs`, atrás de uma variável de ambiente.
 *
 * A dubla não é um objeto vazio: ela mantém um cursor virtual (posição e limites de tela) e usa o
 * **mesmo** registro de pressionados do backend do Windows (`pressionados.ts`). É o que faz um
 * teste de "o quadrado voltou ao ponto de partida" ou de "não sobrou botão preso" dizer alguma
 * coisa sobre o código que roda de verdade.
 *
 * Ela também sabe falhar **das mesmas três maneiras** que o backend do Windows, e isso não é
 * capricho: falha que a dubla não sabe produzir é ramo que nenhum teste alcança.
 *
 * | Falha do Windows | Como a dubla produz | Onde aparece |
 * |---|---|---|
 * | `SendInput` recusado (UIPI) | `recusarProximos(n)` | `eventosRecusados` |
 * | `SetCursorPos` recusado | `recusarProximosPosicionamentos(n)` | `chamadasComErro` |
 * | `GetCursorPos` recusado | `recusarProximasLeiturasDoCursor(n)` | `chamadasComErro` |
 * | `GetSystemMetrics` em 0 | opção `semTela` | `chamadasComErro` |
 *
 * Ela **aloca** um objeto por evento — de propósito: a lista de eventos é o que o teste
 * inspeciona. Nunca use a dubla no caminho quente de produção.
 */

import { criarRegistroDePressionados } from './pressionados.js';
import type { DescricaoDaSaidaDoMouse } from './saida-do-mouse.js';
import {
  criarContadoresDeSaida,
  ehBotaoDoMouse,
  zerarContadoresDeSaida,
  type BackendDeEntrada,
  type BotaoDoMouse,
  type PosicaoDoMouse,
  type TamanhoDaTela,
} from './tipos.js';

/** Um evento como a dubla o registrou. */
export type EventoDaDubla =
  | { readonly tipo: 'mover'; readonly dx: number; readonly dy: number }
  | { readonly tipo: 'posicionar'; readonly x: number; readonly y: number }
  | { readonly tipo: 'botao'; readonly botao: BotaoDoMouse; readonly pressionado: boolean }
  | { readonly tipo: 'scroll'; readonly vertical: number; readonly horizontal: number }
  | { readonly tipo: 'tecla'; readonly scancode: number; readonly pressionada: boolean };

export interface BackendDubla extends BackendDeEntrada {
  /** Tudo que foi pedido, na ordem em que foi pedido. */
  readonly eventos: readonly EventoDaDubla[];
  /** Quantas vezes `encerrar()` foi chamado — o encerramento tem de acontecer, e uma vez só. */
  encerramentos(): number;
  /**
   * Esvazia a lista de eventos, zera os contadores e cancela as recusas pendentes. Cursor e
   * estado preso continuam como estão.
   */
  limpar(): void;
  /**
   * Faz as próximas `quantidade` injeções falharem — é assim que o teste exercita o caminho de
   * recusa (janela elevada, UIPI) sem precisar de uma janela elevada.
   */
  recusarProximos(quantidade: number): void;
  /**
   * Faz as próximas `quantidade` leituras de cursor falharem, como um `GetCursorPos` recusado.
   *
   * O backend real devolve `undefined` e soma em `chamadasComErro` (`windows/backend.ts`); sem
   * este gatilho, o ramo "não deu para ler onde o cursor estava" — o que decide se o gesto de
   * teste restaura a posição — não teria como ser exercitado por teste nenhum.
   */
  recusarProximasLeiturasDoCursor(quantidade: number): void;
  /**
   * Faz os próximos `quantidade` posicionamentos falharem, como um `SetCursorPos` recusado.
   * O cursor virtual **não** anda, e a falha aparece em `chamadasComErro`.
   */
  recusarProximosPosicionamentos(quantidade: number): void;
}

export interface OpcoesDaDubla {
  readonly tela?: TamanhoDaTela;
  readonly posicaoInicial?: PosicaoDoMouse;
  /**
   * `true` faz `tamanhoDaTela()` devolver `undefined` e somar em `chamadasComErro`, como um
   * `GetSystemMetrics` que respondeu 0 (é o que o backend do Windows faz).
   */
  readonly semTela?: boolean;
  /**
   * O que a dubla diz sobre a saída do mouse e a aceleração de ponteiro (ATI-026). Sem isto, ela não
   * diz nada — como um backend sem curva para ler. Existe para o teste afirmar o aviso de partida e a
   * linha do painel sem depender da configuração de mouse da máquina que roda a suíte.
   */
  readonly saidaDoMouse?: DescricaoDaSaidaDoMouse;
}

/** Tela padrão da dubla: 1920×1080, a resolução da máquina de bancada do projeto. */
export const TELA_PADRAO: TamanhoDaTela = Object.freeze({ largura: 1920, altura: 1080 });

/** Código que o Windows devolve quando o UIPI barra a injeção (`ERROR_ACCESS_DENIED`). */
export const ERRO_ACESSO_NEGADO = 5;

function limitar(valor: number, minimo: number, maximo: number): number {
  if (valor < minimo) return minimo;
  if (valor > maximo) return maximo;
  return valor;
}

export function criarBackendDubla(opcoes: OpcoesDaDubla = {}): BackendDubla {
  const tela = opcoes.tela ?? TELA_PADRAO;
  const eventos: EventoDaDubla[] = [];
  const contadores = criarContadoresDeSaida();
  const registro = criarRegistroDePressionados();

  let x = opcoes.posicaoInicial?.x ?? Math.floor(tela.largura / 2);
  let y = opcoes.posicaoInicial?.y ?? Math.floor(tela.altura / 2);
  let recusasPendentes = 0;
  let leiturasRecusadas = 0;
  let posicionamentosRecusados = 0;
  let encerramentos = 0;

  /** Mesma contabilidade do backend real: evento aceito, ou recusa com código de erro. */
  function enviar(): boolean {
    if (recusasPendentes > 0) {
      recusasPendentes -= 1;
      contadores.eventosRecusados += 1;
      contadores.ultimoCodigoDeErro = ERRO_ACESSO_NEGADO;
      return false;
    }
    contadores.eventosEnviados += 1;
    return true;
  }

  /**
   * A **segunda** forma de falhar do backend real: chamada de apoio recusada
   * (`SetCursorPos`, `GetCursorPos`, `GetSystemMetrics`) — que não é injeção e por isso não entra
   * em `eventosRecusados`.
   *
   * O código de erro é sempre o mesmo aqui; no Windows ele varia com a chamada (5, 6, 87…). O que
   * o teste precisa afirmar é que `chamadasComErro` subiu e que `ultimoCodigoDeErro` deixou de
   * ser 0 — inventar o código exato da `user32` seria a dubla mentindo com mais precisão.
   */
  function falharChamadaDeApoio(): void {
    contadores.chamadasComErro += 1;
    contadores.ultimoCodigoDeErro = ERRO_ACESSO_NEGADO;
  }

  function soltarBotaoNaForca(botao: BotaoDoMouse): void {
    eventos.push({ tipo: 'botao', botao, pressionado: false });
    enviar();
  }

  function soltarTeclaNaForca(scancode: number): void {
    eventos.push({ tipo: 'tecla', scancode, pressionada: false });
    enviar();
  }

  function soltarTudo(): void {
    contadores.soltasDeSeguranca += registro.soltar(soltarBotaoNaForca, soltarTeclaNaForca);
  }

  return {
    nome: 'dubla',
    contadores,
    saidaDoMouse: opcoes.saidaDoMouse,
    eventos,

    moverMouseRelativo(dx, dy) {
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
        contadores.pedidosInvalidos += 1;
        return;
      }
      const px = Math.trunc(dx);
      const py = Math.trunc(dy);
      if (px === 0 && py === 0) {
        contadores.pedidosNulos += 1;
        return;
      }
      eventos.push({ tipo: 'mover', dx: px, dy: py });
      if (!enviar()) return;
      // O cursor do Windows para na borda da tela; a dubla faz o mesmo, senão um teste de
      // deslocamento acumulado leria um número que a máquina real nunca produziria.
      x = limitar(x + px, 0, tela.largura - 1);
      y = limitar(y + py, 0, tela.altura - 1);
    },

    posicionarMouse(destinoX, destinoY) {
      if (!Number.isFinite(destinoX) || !Number.isFinite(destinoY)) {
        contadores.pedidosInvalidos += 1;
        return;
      }
      const alvoX = Math.trunc(destinoX);
      const alvoY = Math.trunc(destinoY);
      // O pedido entra na lista mesmo quando o sistema recusa: `eventos` é "o que foi pedido", e
      // é assim que o teste distingue "não pediu" de "pediu e o Windows barrou".
      eventos.push({ tipo: 'posicionar', x: alvoX, y: alvoY });
      if (posicionamentosRecusados > 0) {
        posicionamentosRecusados -= 1;
        falharChamadaDeApoio();
        return;
      }
      x = limitar(alvoX, 0, tela.largura - 1);
      y = limitar(alvoY, 0, tela.altura - 1);
    },

    botaoMouse(botao, pressionado) {
      // Mesma guarda do backend do Windows: botão fora dos três é pedido inválido, nunca estado
      // preso que ninguém saberia soltar.
      if (!ehBotaoDoMouse(botao)) {
        contadores.pedidosInvalidos += 1;
        return;
      }
      if (registro.botaoPreso(botao) === pressionado) {
        contadores.pedidosRedundantes += 1;
        return;
      }
      eventos.push({ tipo: 'botao', botao, pressionado });
      if (enviar()) registro.marcarBotao(botao, pressionado);
    },

    scroll(vertical, horizontal) {
      if (!Number.isFinite(vertical) || !Number.isFinite(horizontal)) {
        contadores.pedidosInvalidos += 1;
        return;
      }
      if (vertical === 0 && horizontal === 0) {
        contadores.pedidosNulos += 1;
        return;
      }
      // Guarda o pedido em **entalhes**, que é a unidade da interface; a conversão para
      // `WHEEL_DELTA` é assunto do backend do Windows.
      eventos.push({ tipo: 'scroll', vertical, horizontal });
      // Igual ao backend real: vertical e horizontal são dois eventos de sistema.
      if (vertical !== 0) enviar();
      if (horizontal !== 0) enviar();
    },

    tecla(scancode, pressionada) {
      if (!Number.isInteger(scancode) || scancode <= 0 || scancode > 0xffff) {
        contadores.pedidosInvalidos += 1;
        return;
      }
      if (registro.teclaPresa(scancode) === pressionada) {
        contadores.pedidosRedundantes += 1;
        return;
      }
      if (pressionada && !registro.cabeMaisUmaTecla()) {
        contadores.pedidosInvalidos += 1;
        return;
      }
      eventos.push({ tipo: 'tecla', scancode, pressionada });
      if (enviar()) registro.marcarTecla(scancode, pressionada);
    },

    tamanhoDaTela(): TamanhoDaTela | undefined {
      if (opcoes.semTela === true) {
        falharChamadaDeApoio();
        return undefined;
      }
      return tela;
    },

    lerPosicaoDoMouse(): PosicaoDoMouse | undefined {
      if (leiturasRecusadas > 0) {
        leiturasRecusadas -= 1;
        falharChamadaDeApoio();
        return undefined;
      }
      return { x, y };
    },

    pressionados: () => registro.quantidade(),

    soltarTudo,

    encerrar() {
      soltarTudo();
      encerramentos += 1;
    },

    encerramentos: () => encerramentos,

    limpar() {
      eventos.length = 0;
      zerarContadoresDeSaida(contadores);
      recusasPendentes = 0;
      leiturasRecusadas = 0;
      posicionamentosRecusados = 0;
    },

    recusarProximos(quantidade) {
      recusasPendentes = quantidade;
    },

    recusarProximasLeiturasDoCursor(quantidade) {
      leiturasRecusadas = quantidade;
    },

    recusarProximosPosicionamentos(quantidade) {
      posicionamentosRecusados = quantidade;
    },
  };
}
