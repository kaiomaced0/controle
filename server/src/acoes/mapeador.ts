/**
 * O mapeador de ações (ATI-010): onde o toque no celular vira clique, arrastar e scroll no PC.
 *
 * Ele fecha o caminho que estava aberto desde a ATI-025: o BOTÃO (`0x02`) e o SCROLL (`0x04`)
 * chegavam ao servidor, entravam nos contadores e **paravam ali**.
 *
 * ```
 * BOTÃO 0x02  → tabela do perfil (idControle → ação) → botaoMouse(botao, pressionado)
 * SCROLL 0x04 → acumulador de entalhes                → scroll(vertical, horizontal)
 * ```
 *
 * ## Por que não há clique atômico aqui dentro
 *
 * O pacote traz `pressionado`, e é ele que manda: aperto e soltura são duas chamadas separadas ao
 * destino. É o que faz **arrastar** existir — selecionar texto, mover janela, desenhar. Um
 * "clicar()" que apertasse e soltasse na mesma chamada seria mais curto de escrever e tiraria
 * metade do que um mouse faz.
 *
 * ## Estado preso (CLAUDE.md, regra 5)
 *
 * O mapeador **não guarda** quem está apertado — quem guarda é o destino, no mesmo registro que o
 * backend do Windows usa (`saida/pressionados.ts`). Guardar de novo aqui criaria duas verdades
 * sobre o mesmo botão, e a hora de descobrir que elas divergiram seria com o botão preso.
 *
 * O que ele guarda é a **fração de entalhe** que ainda não completou um passo, e por isso
 * `reiniciar()` existe: a sobra de uma sessão não pode sair como scroll na primeira amostra da
 * seguinte (é a mesma decisão do acumulador de subpixel do pipeline, ATI-008). A fração é
 * guardada **por origem** — ver `AcumuladorDeEntalhe`, logo abaixo.
 *
 * ## Caminho quente
 *
 * BOTÃO e SCROLL não vêm a 100 Hz como o MOVIMENTO — vêm no ritmo do dedo. Ainda assim, nada aqui
 * aloca por pacote: a busca na tabela é um `Map.get`, os acumuladores são números e o háptico só
 * sai quando um evento de verdade aconteceu.
 */

import { enviarHaptico } from '../diagnostico/indice.js';
import type { Registrador } from '../log.js';
import {
  TIPO_BOTAO,
  TIPO_SCROLL,
  type NomeDePadraoHaptico,
  type PacoteDecodificado,
} from '../protocolo/indice.js';
import type { SessaoDeTransporte } from '../transporte/indice.js';
import { TABELA_MOUSE_BASICO } from './mouse-basico.js';
import {
  RESULTADO_DE_ACAO,
  criarContadoresDasAcoes,
  resumirContadoresDasAcoes,
  somarContadoresDasAcoes,
  zerarContadoresDasAcoes,
  type ContadoresDasAcoes,
  type DestinoDeAcoes,
  type ResultadoDeAcao,
  type TabelaDeControles,
} from './tipos.js';

/**
 * Menor pedaço de entalhe que sai para o destino.
 *
 * Existe por dois motivos. O primeiro é aritmético: o Windows converte entalhe em `WHEEL_DELTA`
 * (120) e **arredonda**, então qualquer coisa abaixo de 1/240 de entalhe viraria zero e seria
 * jogada fora — arrastar o dedo devagar não rolaria nada, para sempre. O segundo é de ritmo: o
 * dedo numa faixa produz dezenas de eventos por segundo, e mandar um evento de roda por pixel de
 * dedo é rajada, não rolagem.
 *
 * 1/8 de entalhe são 15 unidades de roda: sobra folga sobre o arredondamento e ainda dá oito
 * degraus dentro de um entalhe, que é mais resolução do que a mão percebe.
 */
export const PASSO_MINIMO_DE_ENTALHE = 1 / 8;

/**
 * Teto de entalhes que **um** pacote pode pedir, em cada eixo.
 *
 * O `f32` do fio passa cru (PROTOCOLO.md, seção 4.0, regra 7): um cliente com defeito pode mandar
 * `1e30` num `deltaVertical`. Sem teto, esse número entraria no acumulador e a rolagem ficaria
 * presa nele por horas. Saturar segue a linha da seção 3.4 do PROTOCOLO.md — valor absurdo vira o
 * limite, não exceção. 30 entalhes é mais do que um gesto humano inteiro produz num só pacote.
 */
export const TETO_DE_ENTALHES_POR_PACOTE = 30;

export interface MapeadorDeAcoes {
  /** Para onde as ações vão: o backend de verdade ou o ensaio. */
  readonly destino: DestinoDeAcoes;
  /** A tabela `idControle → ação` em vigor. */
  readonly tabela: TabelaDeControles;
  /**
   * Contadores **da sessão atual**; o objeto é sempre o mesmo. Zerados em `reiniciar()`, logo
   * depois de a linha de resumo ir para o log (ATI-028) — antes, a segunda sessão relatava os
   * apertos da primeira somados aos dela.
   */
  readonly contadores: ContadoresDasAcoes;
  /** O total **do processo**: as sessões já fechadas mais a atual. Aloca — nunca por pacote. */
  totalDoProcesso(): ContadoresDasAcoes;
  /**
   * ⚠️ Caminho de entrada. Trata BOTÃO e SCROLL; devolve `NAO_E_ACAO` para o resto.
   *
   * `sessao` só é usada para o retorno háptico (o `click` do botão e o `tick` da detente); sem
   * ela a ação acontece do mesmo jeito, só não vibra.
   */
  processar(pacote: PacoteDecodificado, sessao?: SessaoDeTransporte): ResultadoDeAcao;
  /** Solta tudo que este mapeador apertou. Idempotente (CLAUDE.md, regra 5). */
  soltarTudo(): void;
  /**
   * Fim de sessão, pausa ou troca de perfil: solta tudo **e** joga fora a fração de entalhe
   * guardada. Sem a segunda parte, a sobra do aparelho anterior sairia como rolagem no primeiro
   * gesto do próximo.
   *
   * Também fecha a conta: põe o resumo de `contadores` no log, soma-os no total do processo e os
   * zera — nessa ordem, para o resumo falar só do que aconteceu desde o `reiniciar()` anterior.
   */
  reiniciar(): void;
  /** Uma linha com os contadores **da sessão atual**. Aloca — nunca chame por pacote. */
  resumir(): string;
}

export interface OpcoesDoMapeadorDeAcoes {
  /** Backend de entrada de verdade, ou o destino de ensaio. */
  readonly destino: DestinoDeAcoes;
  /** A tabela do perfil ativo; o padrão é o Mouse básico (ATI-010). */
  readonly tabela?: TabelaDeControles | undefined;
  /** Envio do háptico; o padrão é o `enviarHaptico` da página de diagnóstico (ATI-025). */
  readonly haptico?:
    | ((sessao: SessaoDeTransporte | undefined, padrao: NomeDePadraoHaptico) => boolean)
    | undefined;
  /** Log de eventos de **sessão**, nunca por pacote. */
  readonly registrador?: Registrador | undefined;
}

/**
 * A sobra de entalhe de **uma** origem de scroll.
 *
 * Existe um destes por origem, e é a correção do defeito que a revisão da rodada 1 reproduziu:
 * com um acumulador só, a migalha de dedo que a faixa deixou guardada (abaixo do passo mínimo,
 * portanto invisível) era descontada do toque seguinte no **botão de passo**, e o entalhe inteiro
 * que ele promete saía como 0,875 — 105 unidades de roda contra 120, ou seja, menos de uma volta
 * para o Windows e nenhuma detente. Quem aperta um botão escrito "scroll +1" para rolar contando
 * recebia menos que um passo, sem estalo, e não tinha como saber por quê.
 *
 * As duas origens são de naturezas diferentes e não podem dividir sobra:
 *
 * - a **contínua** (faixa, roda) é um fluxo de frações no ritmo do dedo; ela precisa do
 *   acumulador justamente porque cada pedaço sozinho é pequeno demais para sair;
 * - o **impulso** (botão de passo) é um pedido fechado por toque. Quando o passo é múltiplo do
 *   mínimo — como o entalhe inteiro do Mouse básico — ele sai igualzinho ao que a tabela do perfil
 *   declarou; um passo menor que o mínimo (que a ATI-016 vai permitir escrever) soma entre toques
 *   em vez de sumir, que é para isso que ele também tem acumulador em vez de atalho.
 *
 * Objeto mutável criado **uma vez por mapeador**, no mesmo padrão dos contadores: o caminho de
 * entrada só lê e escreve campo já alocado (CLAUDE.md, regra 2). Origem nova (o eixo de um
 * gamepad, na ATI-018) é um objeto novo aqui, e não mais um `let` solto.
 */
interface AcumuladorDeEntalhe {
  vertical: number;
  horizontal: number;
}

/** Satura no teto, preservando o sinal. */
function limitarEntalhes(valor: number): number {
  if (valor > TETO_DE_ENTALHES_POR_PACOTE) return TETO_DE_ENTALHES_POR_PACOTE;
  if (valor < -TETO_DE_ENTALHES_POR_PACOTE) return -TETO_DE_ENTALHES_POR_PACOTE;
  return valor;
}

/** Quanto do acumulado já dá para mandar, em múltiplos do passo mínimo (trunca **para o zero**). */
function partePronta(acumulado: number): number {
  return Math.trunc(acumulado / PASSO_MINIMO_DE_ENTALHE) * PASSO_MINIMO_DE_ENTALHE;
}

export function criarMapeadorDeAcoes(opcoes: OpcoesDoMapeadorDeAcoes): MapeadorDeAcoes {
  const destino = opcoes.destino;
  const tabela = opcoes.tabela ?? TABELA_MOUSE_BASICO;
  const haptico = opcoes.haptico ?? enviarHaptico;
  const registrador = opcoes.registrador;
  /** Da sessão atual — o único que o caminho de entrada toca. */
  const contadores = criarContadoresDasAcoes();
  /** Soma das sessões já fechadas; escrito só em `reiniciar()`, uma vez por sessão. */
  const sessoesAnteriores = criarContadoresDasAcoes();

  /** Sobra da faixa e da roda: fluxo contínuo de frações (pacote SCROLL `0x04`). */
  const acumuladoContinuo: AcumuladorDeEntalhe = { vertical: 0, horizontal: 0 };
  /** Sobra dos botões de passo: um pedido fechado por toque (BOTÃO `0x02` → tabela do perfil). */
  const acumuladoDeImpulso: AcumuladorDeEntalhe = { vertical: 0, horizontal: 0 };
  /**
   * Quanto de entalhe já rolou desde a última detente — é ele que vira `tick`.
   *
   * Este, sim, é **um só** para as duas origens, e de propósito: a detente é o estalo da roda, e
   * a roda é uma só. Um entalhe inteiro somado aqui sempre fecha exatamente uma detente, qualquer
   * que seja a sobra pendente (ela vale menos de 1 por construção) — então o botão de passo estala
   * sempre, e a faixa não perde o pedaço que já andou.
   */
  let desdeADetente = 0;

  /** Uma linha com o que os toques desta sessão viraram. Aloca — nunca por pacote. */
  function resumo(): string {
    return resumirContadoresDasAcoes(contadores);
  }

  function vibrar(sessao: SessaoDeTransporte | undefined, padrao: NomeDePadraoHaptico): void {
    if (sessao === undefined) return;
    if (haptico(sessao, padrao)) contadores.hapticosEnviados += 1;
  }

  /**
   * Manda a roda girar, guardando a sobra **no acumulador da origem do pedido**.
   *
   * A detente é contada em entalhes **inteiros** percorridos, e o `tick` sai no máximo uma vez por
   * pacote: um gesto rápido que atravesse três entalhes de uma vez conta três detentes e vibra
   * uma. Vibrar três vezes seguidas seria a rajada que a ATI-010 pede para não existir — e o motor
   * do celular não distinguiria mesmo.
   */
  function aplicarScroll(
    vertical: number,
    horizontal: number,
    acumulado: AcumuladorDeEntalhe,
    sessao: SessaoDeTransporte | undefined,
  ): ResultadoDeAcao {
    if (!Number.isFinite(vertical) || !Number.isFinite(horizontal)) {
      contadores.pedidosInvalidos += 1;
      return RESULTADO_DE_ACAO.INVALIDA;
    }

    const verticalLimitado = limitarEntalhes(vertical);
    const horizontalLimitado = limitarEntalhes(horizontal);
    if (verticalLimitado !== vertical || horizontalLimitado !== horizontal) {
      contadores.pedidosLimitados += 1;
    }

    acumulado.vertical += verticalLimitado;
    acumulado.horizontal += horizontalLimitado;

    const pedacoVertical = partePronta(acumulado.vertical);
    const pedacoHorizontal = partePronta(acumulado.horizontal);
    if (pedacoVertical === 0 && pedacoHorizontal === 0) return RESULTADO_DE_ACAO.SEM_EFEITO;

    acumulado.vertical -= pedacoVertical;
    acumulado.horizontal -= pedacoHorizontal;

    destino.scroll(pedacoVertical, pedacoHorizontal);
    contadores.giradasDeRoda += 1;
    contadores.entalhesVerticais += pedacoVertical;
    contadores.entalhesHorizontais += pedacoHorizontal;

    desdeADetente += Math.abs(pedacoVertical) + Math.abs(pedacoHorizontal);
    if (desdeADetente >= 1) {
      const inteiros = Math.floor(desdeADetente);
      desdeADetente -= inteiros;
      contadores.detentes += inteiros;
      vibrar(sessao, 'tick');
    }
    return RESULTADO_DE_ACAO.APLICADA;
  }

  function tratarBotao(
    pacote: PacoteDecodificado,
    sessao: SessaoDeTransporte | undefined,
  ): ResultadoDeAcao {
    const acao = tabela.get(pacote.idControle);
    if (acao === undefined) {
      // Controle que este perfil não conhece. Não é erro de formato nem motivo para derrubar
      // nada: é um botão de outro perfil, ou de uma versão mais nova do app.
      contadores.semMapeamento += 1;
      return RESULTADO_DE_ACAO.SEM_MAPEAMENTO;
    }

    if (acao.tipo === 'mouse') {
      // `pacote.pressionado` já vem decidido pelo codec — e resolvido para **solto** em byte
      // estranho (PROTOCOLO.md, seção 4.2). Reinterpretar aqui seria criar a segunda leitura do
      // mesmo byte, que é como se prende botão.
      destino.botaoMouse(acao.botao, pacote.pressionado);
      if (pacote.pressionado) {
        contadores.botoesApertados += 1;
        vibrar(sessao, 'click');
      } else {
        contadores.botoesSoltos += 1;
      }
      return RESULTADO_DE_ACAO.APLICADA;
    }

    // Scroll por botão é **impulso**: acontece no aperto e a soltura não faz nada. Não existe
    // "roda pressionada", e é por isso que este caminho nunca deixa estado preso.
    if (!pacote.pressionado) return RESULTADO_DE_ACAO.SEM_EFEITO;
    // Acumulador **do impulso**, e não o da faixa: o entalhe que a tabela promete não pode ser
    // diluído pela migalha que outro controle deixou guardada (ver `AcumuladorDeEntalhe`).
    return aplicarScroll(
      acao.entalhesVertical,
      acao.entalhesHorizontal,
      acumuladoDeImpulso,
      sessao,
    );
  }

  return {
    destino,
    tabela,
    contadores,

    processar(pacote, sessao) {
      if (pacote.tipo === TIPO_BOTAO) return tratarBotao(pacote, sessao);
      if (pacote.tipo === TIPO_SCROLL) {
        // Faixa e roda: origem contínua (PROTOCOLO.md, seção 4.4 — o SCROLL não traz `idControle`).
        return aplicarScroll(
          pacote.deltaVertical,
          pacote.deltaHorizontal,
          acumuladoContinuo,
          sessao,
        );
      }
      return RESULTADO_DE_ACAO.NAO_E_ACAO;
    },

    soltarTudo() {
      destino.soltarTudo();
    },

    reiniciar() {
      const presos = destino.pressionados();
      destino.soltarTudo();
      acumuladoContinuo.vertical = 0;
      acumuladoContinuo.horizontal = 0;
      acumuladoDeImpulso.vertical = 0;
      acumuladoDeImpulso.horizontal = 0;
      desdeADetente = 0;

      // Uma linha por **sessão**, nunca por pacote: é o resumo do que os toques daquele aparelho
      // viraram, e é o que se lê depois de uma passada com o celular na mão.
      registrador?.info('ações — resumo da sessão', { destino: destino.nome, resumo: resumo() });
      // Só **depois** do resumo a conta da sessão entra no total e volta a zero: a sessão seguinte
      // relata só o que foi dela (ATI-028).
      somarContadoresDasAcoes(sessoesAnteriores, contadores);
      zerarContadoresDasAcoes(contadores);
      if (presos > 0) {
        // Alguém saiu com o dedo no botão e o PC desfez isso (CLAUDE.md, regra 5). Vale aviso, e
        // não informação: é o caminho que, sem esta chamada, prenderia o botão no Windows inteiro.
        registrador?.aviso('soltei botão que ficou preso no fim da sessão', { presos });
      }
    },

    resumir: resumo,

    totalDoProcesso() {
      const total = criarContadoresDasAcoes();
      somarContadoresDasAcoes(total, sessoesAnteriores);
      somarContadoresDasAcoes(total, contadores);
      return total;
    },
  };
}
