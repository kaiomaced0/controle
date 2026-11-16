/**
 * O backend de entrada do Windows — o lugar onde o giroscópio vira cursor de verdade.
 *
 * Todo evento sai por `SendInput`, um evento por chamada, escrito num `INPUT` de 40 bytes que é
 * **o mesmo buffer desde a partida** (`api.quadro`). Nada é alocado por evento: a 100 Hz, um
 * objeto por amostra seriam 6 mil objetos por minuto entregues ao coletor de lixo, e uma pausa de
 * coleta no meio de uma mira é exatamente o defeito que este projeto existe para não ter
 * (CLAUDE.md, regra 2).
 *
 * ## O que este arquivo garante
 *
 * - **Nada de clique atômico.** Aperto e soltura são eventos separados; é o que faz arrastar.
 * - **Só solta o que ele apertou.** O estado de botão é global no Windows: injetar um "solta o
 *   esquerdo" que nós não apertamos soltaria o botão que a pessoa está segurando com a mão. Por
 *   isso todo pedido passa pelo registro de `pressionados.ts` e o redundante é descartado.
 * - **Marca depois de o sistema aceitar.** Se o `SendInput` do aperto for recusado (é o que
 *   acontece quando a janela em primeiro plano é elevada — UIPI), o botão **não** entra no
 *   registro; senão o `soltarTudo()` mandaria depois uma soltura de algo que nunca foi apertado.
 * - **Rede de segurança na saída do processo.** Além do `soltarTudo()` que o encerramento
 *   registra, o próprio backend pendura um `process.once('exit')`: se o processo terminar por um
 *   caminho que não passa pelo Ctrl+C, a última coisa que ele faz é soltar o que estava preso.
 *
 * ## A saída do mouse (ATI-026)
 *
 * `moverMouseRelativo` tem três caminhos até o sistema, escolhidos **uma vez**, na criação:
 *
 * - `relativo` — `MOUSEEVENTF_MOVE` com o deslocamento cru. Passa pela aceleração de ponteiro do
 *   Windows (40 × 1 px viram ~24 px nesta máquina), mas é o que jogo com *raw input* precisa;
 * - `absoluto` — lê o cursor, soma o deslocamento e posiciona em coordenada normalizada sobre a
 *   área virtual (`MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`). Não passa pela curva;
 * - `compensado` — só de bancada: o relativo com a curva inversa (`aceleracao.ts`).
 *
 * A configuração de ponteiro é **lida**, nunca escrita. Ver `saida-do-mouse.ts`.
 *
 * ## O que ele não consegue garantir
 *
 * `SendInput` marca os eventos como **injetados** (`LLMHF_INJECTED`). A maioria dos programas e
 * jogos aceita; título com anti-cheat rigoroso pode ignorar. Para esses o caminho é o gamepad
 * virtual da fase 5 (ADR-1 e seção 2.3 do ARQUITETURA.md). Também não há como injetar em janela
 * com privilégio maior que o do servidor: aí o `SendInput` devolve 0 e o contador
 * `eventosRecusados` sobe — é assim que esse caso aparece, em vez de sumir.
 */

import {
  criarContadoresDeSaida,
  ehBotaoDoMouse,
  type BackendDeEntrada,
  type BotaoDoMouse,
  type PosicaoDoMouse,
  type TamanhoDaTela,
} from '../tipos.js';
import type { DescricaoDaSaidaDoMouse, PedidoDeSaidaDoMouse } from '../saida-do-mouse.js';
import { criarRegistroDePressionados } from '../pressionados.js';
import { paraCoordenadaNormalizada } from './absoluto.js';
import {
  MICKEY_X,
  MICKEY_Y,
  criarCompensadorDaAceleracao,
  criarModeloDaAceleracao,
  descreverSaidaDoMouse,
  resolverSaidaDoMouse,
  type ConstantesDoModelo,
  type ParametrosDoPonteiro,
} from './aceleracao.js';
import { carregarApiDoWindows, type ApiDeEntradaDoWindows } from './api.js';
import {
  DESLOCAMENTO_MOUSE_DADOS,
  DESLOCAMENTO_MOUSE_DX,
  DESLOCAMENTO_MOUSE_DY,
  DESLOCAMENTO_MOUSE_SINALIZADORES,
  DESLOCAMENTO_POINT_X,
  DESLOCAMENTO_POINT_Y,
  DESLOCAMENTO_TECLA_SCAN,
  DESLOCAMENTO_TECLA_SINALIZADORES,
  DESLOCAMENTO_TIPO,
  DESLOCAMENTO_UNIAO,
  INPUT_KEYBOARD,
  INPUT_MOUSE,
  KEYEVENTF_EXTENDEDKEY,
  KEYEVENTF_KEYUP,
  KEYEVENTF_SCANCODE,
  MAIOR_SCANCODE,
  MOUSEEVENTF_ABSOLUTE,
  MOUSEEVENTF_HWHEEL,
  MOUSEEVENTF_MOVE,
  MOUSEEVENTF_VIRTUALDESK,
  MOUSEEVENTF_WHEEL,
  PREFIXO_ESTENDIDO,
  SINALIZADORES_DOS_BOTOES,
  SM_CXSCREEN,
  SM_CXVIRTUALSCREEN,
  SM_CYSCREEN,
  SM_CYVIRTUALSCREEN,
  SM_XVIRTUALSCREEN,
  SM_YVIRTUALSCREEN,
  TAMANHO_INPUT,
  WHEEL_DELTA,
} from './constantes.js';

/** `dwFlags` da saída absoluta: move, em coordenada normalizada, sobre todos os monitores. */
const SINALIZADORES_ABSOLUTOS = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;

const MAIOR_INT32 = 2_147_483_647;
const MENOR_INT32 = -2_147_483_648;

/**
 * Trunca e satura para caber num `LONG`.
 *
 * Saturar em vez de recusar segue a mesma linha do codec do protocolo (seção 3.4 do
 * PROTOCOLO.md): valor absurdo vira o limite, e não uma exceção no meio do caminho quente.
 * `Buffer.writeInt32LE` **lança** com valor fora da faixa — sem esta função, um `dx` gigante
 * derrubaria a sessão em vez de grudar o cursor na borda.
 */
function paraInt32(valor: number): number {
  const inteiro = Math.trunc(valor);
  if (inteiro > MAIOR_INT32) return MAIOR_INT32;
  if (inteiro < MENOR_INT32) return MENOR_INT32;
  return inteiro;
}

/**
 * Se o scancode é dos **estendidos** (setas, Ctrl/Alt direitos, teclas de navegação).
 *
 * No fio o teclado manda `0xE0` e depois o código; o `SendInput` não recebe o par — recebe o byte
 * de baixo em `wScan` e o bit `KEYEVENTF_EXTENDEDKEY` em `dwFlags`.
 */
function ehEstendida(scancode: number): boolean {
  return (scancode & 0xff00) === PREFIXO_ESTENDIDO;
}

/** O que vai em `wScan`: o scancode inteiro, ou só o byte de baixo quando é estendido. */
function scanParaOWindows(scancode: number): number {
  return ehEstendida(scancode) ? scancode & 0xff : scancode;
}

/** `dwFlags` da tecla. Uma função só, para aperto e soltura nunca divergirem. */
function sinalizadoresDaTecla(scancode: number, pressionada: boolean): number {
  return (
    KEYEVENTF_SCANCODE |
    (pressionada ? 0 : KEYEVENTF_KEYUP) |
    (ehEstendida(scancode) ? KEYEVENTF_EXTENDEDKEY : 0)
  );
}

export interface OpcoesDoBackendWindows {
  /**
   * Ponte com o sistema. O padrão carrega a `user32.dll` de verdade; o teste passa uma dubla e,
   * com isso, confere o quadro byte a byte **sem mexer no cursor de quem roda a suíte**.
   */
  readonly api?: ApiDeEntradaDoWindows;
  /**
   * Registra a rede de segurança da saída do processo e devolve como cancelá-la. O padrão é
   * `process.once('exit', ...)`; a costura existe para o teste poder disparar a rede na mão (e
   * para não deixar ouvinte pendurado a cada backend criado num teste).
   */
  readonly registrarSaidaDoProcesso?: (tarefa: () => void) => () => void;
  /**
   * Como `moverMouseRelativo` chega ao sistema (ATI-026). O padrão **deste backend** é `relativo` —
   * o mecanismo cru, o mesmo de antes da ATI-026 —; quem decide a saída da execução é a
   * configuração (`CONTROLE_SAIDA_MOUSE`, padrão `auto`), que a montagem passa para cá.
   */
  readonly saidaDoMouse?: PedidoDeSaidaDoMouse;
  /** Só bancada: as escalas do modelo da curva para o `compensado` (ver `aceleracao.ts`). */
  readonly constantesDoModelo?: ConstantesDoModelo;
}

/** Lê a configuração de ponteiro sem deixar uma falha de leitura impedir o backend de existir. */
function lerParametrosComSeguranca(api: ApiDeEntradaDoWindows): ParametrosDoPonteiro | undefined {
  try {
    return api.lerParametrosDoPonteiro();
  } catch {
    return undefined;
  }
}

/** Rede de segurança padrão: solta tudo quando o processo estiver saindo, por qualquer caminho. */
function pendurarNaSaidaDoProcesso(tarefa: () => void): () => void {
  const aoSair = (): void => {
    tarefa();
  };
  process.once('exit', aoSair);
  return () => {
    process.removeListener('exit', aoSair);
  };
}

/**
 * Cria o backend do Windows.
 *
 * @throws {ErroDeSaida} quando a `user32.dll` não carrega ou quando as estruturas não batem com
 *   o tamanho que o Windows de 64 bits espera (ver `api.ts`). Depois desta função, nada mais
 *   lança: erro vira contador.
 */
export function criarBackendWindows(opcoes: OpcoesDoBackendWindows = {}): BackendDeEntrada {
  const api = opcoes.api ?? carregarApiDoWindows();
  const registrarSaidaDoProcesso = opcoes.registrarSaidaDoProcesso ?? pendurarNaSaidaDoProcesso;

  const contadores = criarContadoresDeSaida();
  const registro = criarRegistroDePressionados();
  const quadro = api.quadro;

  /**
   * ⚠️ Caminho quente. Zera a união inteira antes de escrever o evento seguinte.
   *
   * Não é zelo: a `MOUSEINPUT` e a `KEYBDINPUT` têm **buraco de alinhamento** (4 bytes entre
   * `time` e `dwExtraInfo`, que é `ULONG_PTR` e precisa cair em múltiplo de 8), e os dois usam
   * partes diferentes dos 32 bytes da união. Escrever só os campos deixaria sobra do evento
   * anterior nesses vãos — e "buffer com sobra" é como nasce o clique que ninguém pediu.
   *
   * Um `fill` de 32 bytes é um memset: não aloca e sai mais barato do que as escritas de zero que
   * ele substitui.
   */
  function limparUniao(): void {
    quadro.fill(0, DESLOCAMENTO_UNIAO, TAMANHO_INPUT);
  }

  /** ⚠️ Caminho quente. Escreve um `INPUT` de mouse no buffer compartilhado. */
  function escreverMouse(dx: number, dy: number, dados: number, sinalizadores: number): void {
    limparUniao();
    quadro.writeUInt32LE(INPUT_MOUSE, DESLOCAMENTO_TIPO);
    quadro.writeInt32LE(dx, DESLOCAMENTO_MOUSE_DX);
    quadro.writeInt32LE(dy, DESLOCAMENTO_MOUSE_DY);
    // `mouseData` é DWORD, mas carrega valor **com sinal** na roda (rolar para baixo é negativo);
    // por isso a escrita é assinada: os 4 bytes são os mesmos, e assim -120 não vira exceção.
    quadro.writeInt32LE(dados, DESLOCAMENTO_MOUSE_DADOS);
    quadro.writeUInt32LE(sinalizadores, DESLOCAMENTO_MOUSE_SINALIZADORES);
    // `time` e `dwExtraInfo` ficam em 0, já zerados pelo `limparUniao()`. `time` 0 quer dizer
    // "carimbe com a hora de agora" — carimbar nós mesmos só criaria a chance de mandar um
    // evento com hora do passado.
  }

  /** Escreve um `INPUT` de teclado no mesmo buffer. Não é caminho quente (tecla vem de toque). */
  function escreverTecla(scancode: number, sinalizadores: number): void {
    limparUniao();
    quadro.writeUInt32LE(INPUT_KEYBOARD, DESLOCAMENTO_TIPO);
    // `wVk` fica em 0 (já zerado): com KEYEVENTF_SCANCODE o Windows lê `wScan` e ignora o
    // virtual-key.
    quadro.writeUInt16LE(scancode, DESLOCAMENTO_TECLA_SCAN);
    quadro.writeUInt32LE(sinalizadores, DESLOCAMENTO_TECLA_SINALIZADORES);
  }

  /**
   * ⚠️ Caminho quente. Manda o quadro e contabiliza o retorno.
   *
   * `SendInput` devolve **quantos eventos entraram na fila**. Qualquer coisa diferente de 1 é
   * recusa — e a recusa mais comum não é bug nosso: é o Windows protegendo uma janela elevada
   * (UIPI). Por isso ela vira número, com o `GetLastError` junto, em vez de exceção.
   */
  function enviar(): boolean {
    const enviados = api.enviarUmaEntrada();
    if (enviados === 1) {
      contadores.eventosEnviados += 1;
      return true;
    }
    contadores.eventosRecusados += 1;
    contadores.ultimoCodigoDeErro = api.ultimoErro();
    return false;
  }

  function soltarBotaoNaForca(botao: BotaoDoMouse): void {
    escreverMouse(0, 0, 0, SINALIZADORES_DOS_BOTOES[botao].solta);
    enviar();
  }

  function soltarTeclaNaForca(scancode: number): void {
    escreverTecla(scanParaOWindows(scancode), sinalizadoresDaTecla(scancode, false));
    enviar();
  }

  function soltarTudo(): void {
    const soltas = registro.soltar(soltarBotaoNaForca, soltarTeclaNaForca);
    contadores.soltasDeSeguranca += soltas;
  }

  const cancelarRedeDeSeguranca = registrarSaidaDoProcesso(soltarTudo);

  /* ------------------------------------------------ a saída do mouse (ATI-026) */

  const pedidoDeSaida = opcoes.saidaDoMouse ?? 'relativo';
  const parametros = lerParametrosComSeguranca(api);
  const modelo =
    parametros === undefined ? undefined : criarModeloDaAceleracao(parametros, opcoes.constantesDoModelo);
  const resolvida = resolverSaidaDoMouse(pedidoDeSaida, parametros, modelo);
  let motivoDaSaida = resolvida.motivo;
  if (resolvida.efetivo === 'absoluto' && !api.ativarDpiPorMonitor()) {
    // Sem a consciência de DPI por monitor, num monitor com escala diferente da do primário a régua
    // do `GetCursorPos` deixa de ser a da coordenada normalizada. Com todos em 100 % não muda nada —
    // por isso é dito, e não recusado.
    motivoDaSaida += '; sem consciência de DPI por monitor (Windows anterior ao 10 1607)';
  }
  const saidaDoMouse: DescricaoDaSaidaDoMouse = Object.freeze(
    descreverSaidaDoMouse(pedidoDeSaida, parametros, { efetivo: resolvida.efetivo, motivo: motivoDaSaida }),
  );
  const compensador =
    resolvida.efetivo === 'compensado' && modelo !== undefined
      ? criarCompensadorDaAceleracao(modelo)
      : undefined;
  const ponto = api.ponto;

  /** ⚠️ Caminho quente. O relativo cru: o deslocamento vai como veio e passa pela curva do Windows. */
  function moverRelativo(px: number, py: number): void {
    escreverMouse(px, py, 0, MOUSEEVENTF_MOVE);
    enviar();
  }

  /**
   * ⚠️ Caminho quente. A saída absoluta: lê onde o cursor está **agora** e posiciona em
   * `atual + deslocamento`, em coordenada normalizada sobre a área virtual inteira.
   *
   * Partir da posição lida a cada evento, e não de um alvo guardado, é o que convive com o mouse
   * físico: o que a mão moveu entre dois pacotes já está no `GetCursorPos`. E é o que impede o
   * cursor de "grudar" na borda: um destino que o Windows encostou na borda não deixa resto
   * acumulado para desfazer na volta.
   *
   * Cinco chamadas ao sistema por evento (`GetCursorPos` e as quatro métricas da área virtual) e
   * nenhuma alocação. A área é lida a cada evento porque monitor entra e sai com o servidor de pé, e
   * uma régua velha manda o cursor para o lugar errado.
   *
   * Se a leitura falhar, o deslocamento sai **relativo** em vez de sumir: distorcido é melhor que
   * parado, e a falha fica contada em `chamadasComErro`.
   */
  function moverAbsoluto(px: number, py: number): void {
    const largura = api.metricaDoSistema(SM_CXVIRTUALSCREEN);
    const altura = api.metricaDoSistema(SM_CYVIRTUALSCREEN);
    if (largura <= 0 || altura <= 0 || !api.lerCursorNoPonto()) {
      contadores.chamadasComErro += 1;
      contadores.ultimoCodigoDeErro = api.ultimoErro();
      moverRelativo(px, py);
      return;
    }
    const esquerda = api.metricaDoSistema(SM_XVIRTUALSCREEN);
    const topo = api.metricaDoSistema(SM_YVIRTUALSCREEN);
    const alvoX = ponto.readInt32LE(DESLOCAMENTO_POINT_X) + px;
    const alvoY = ponto.readInt32LE(DESLOCAMENTO_POINT_Y) + py;
    escreverMouse(
      paraCoordenadaNormalizada(alvoX - esquerda, largura),
      paraCoordenadaNormalizada(alvoY - topo, altura),
      0,
      SINALIZADORES_ABSOLUTOS,
    );
    enviar();
  }

  /** ⚠️ Caminho quente. O `compensado` (bancada): o mickey que a curva inversa manda mandar. */
  function moverCompensado(px: number, py: number): void {
    if (compensador === undefined) {
      moverRelativo(px, py);
      return;
    }
    if (!compensador.compensar(px, py)) {
      // O pedido não se perdeu: ficou na diferença entre alvo e previsão, e sai no próximo.
      contadores.pedidosNulos += 1;
      return;
    }
    moverRelativo(compensador.mickeys[MICKEY_X] ?? 0, compensador.mickeys[MICKEY_Y] ?? 0);
  }

  // Escolhido uma vez: o caminho quente não pergunta o modo a cada pacote.
  const moverNoSistema =
    resolvida.efetivo === 'absoluto'
      ? moverAbsoluto
      : resolvida.efetivo === 'compensado'
        ? moverCompensado
        : moverRelativo;

  return {
    nome: 'windows',
    contadores,
    saidaDoMouse,

    moverMouseRelativo(dx, dy) {
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
        contadores.pedidosInvalidos += 1;
        return;
      }
      const px = paraInt32(dx);
      const py = paraInt32(dy);
      // Movimento de zero pixel não é evento: mandaria um `WM_MOUSEMOVE` que tira o protetor de
      // tela do lugar e não move nada. O acumulador de subpixel (ATI-008) produz muitos desses.
      if (px === 0 && py === 0) {
        contadores.pedidosNulos += 1;
        return;
      }
      moverNoSistema(px, py);
    },

    posicionarMouse(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        contadores.pedidosInvalidos += 1;
        return;
      }
      // `SetCursorPos` em vez de MOUSEEVENTF_ABSOLUTE: para "vá exatamente para este pixel" ele é o
      // direto, sem a conversão para coordenada normalizada (que só a saída absoluta da ATI-026,
      // em `moverAbsoluto`, precisa fazer — e faz sobre a área virtual inteira).
      if (!api.definirPosicaoDoCursor(paraInt32(x), paraInt32(y))) {
        contadores.chamadasComErro += 1;
        contadores.ultimoCodigoDeErro = api.ultimoErro();
      }
    },

    botaoMouse(botao, pressionado) {
      // Única porta desta camada em que o valor vem de um mapa (perfil → botão) e não de uma
      // conta: nome fora dos três daria `SINALIZADORES_DOS_BOTOES[botao] === undefined` e um
      // `TypeError` na linha seguinte, dentro do caminho quente e contra a promessa escrita no
      // cabeçalho desta função ("depois desta função, nada mais lança").
      if (!ehBotaoDoMouse(botao)) {
        contadores.pedidosInvalidos += 1;
        return;
      }
      if (registro.botaoPreso(botao) === pressionado) {
        contadores.pedidosRedundantes += 1;
        return;
      }
      const sinalizadores = SINALIZADORES_DOS_BOTOES[botao];
      escreverMouse(0, 0, 0, pressionado ? sinalizadores.aperta : sinalizadores.solta);
      // Só entra no registro se o sistema aceitou: ver o cabeçalho deste arquivo.
      if (enviar()) registro.marcarBotao(botao, pressionado);
    },

    scroll(deltaVertical, deltaHorizontal) {
      if (!Number.isFinite(deltaVertical) || !Number.isFinite(deltaHorizontal)) {
        contadores.pedidosInvalidos += 1;
        return;
      }
      const vertical = paraInt32(Math.round(deltaVertical * WHEEL_DELTA));
      const horizontal = paraInt32(Math.round(deltaHorizontal * WHEEL_DELTA));
      if (vertical === 0 && horizontal === 0) {
        contadores.pedidosNulos += 1;
        return;
      }
      // Dois eventos separados: `mouseData` carrega um valor só, então roda vertical e roda
      // horizontal não cabem no mesmo INPUT.
      if (vertical !== 0) {
        escreverMouse(0, 0, vertical, MOUSEEVENTF_WHEEL);
        enviar();
      }
      if (horizontal !== 0) {
        escreverMouse(0, 0, horizontal, MOUSEEVENTF_HWHEEL);
        enviar();
      }
    },

    tecla(scancode, pressionada) {
      if (!Number.isInteger(scancode) || scancode <= 0 || scancode > MAIOR_SCANCODE) {
        contadores.pedidosInvalidos += 1;
        return;
      }
      if (registro.teclaPresa(scancode) === pressionada) {
        contadores.pedidosRedundantes += 1;
        return;
      }
      if (pressionada && !registro.cabeMaisUmaTecla()) {
        // Apertar sem conseguir registrar seria apertar sem ninguém para soltar — exatamente o
        // bug que a regra 5 do CLAUDE.md proíbe. Melhor não apertar.
        contadores.pedidosInvalidos += 1;
        return;
      }

      escreverTecla(scanParaOWindows(scancode), sinalizadoresDaTecla(scancode, pressionada));

      // Igual ao botão: o registro só muda quando o sistema aceitou. Soltura recusada mantém a
      // tecla marcada, para o `soltarTudo()` do encerramento tentar de novo.
      if (enviar()) registro.marcarTecla(scancode, pressionada);
    },

    tamanhoDaTela(): TamanhoDaTela | undefined {
      const largura = api.metricaDoSistema(SM_CXSCREEN);
      const altura = api.metricaDoSistema(SM_CYSCREEN);
      if (largura <= 0 || altura <= 0) {
        contadores.chamadasComErro += 1;
        contadores.ultimoCodigoDeErro = api.ultimoErro();
        return undefined;
      }
      return { largura, altura };
    },

    lerPosicaoDoMouse(): PosicaoDoMouse | undefined {
      const posicao = api.lerPosicaoDoCursor();
      if (posicao === undefined) {
        contadores.chamadasComErro += 1;
        contadores.ultimoCodigoDeErro = api.ultimoErro();
      }
      return posicao;
    },

    pressionados: () => registro.quantidade(),

    soltarTudo,

    encerrar() {
      soltarTudo();
      cancelarRedeDeSeguranca();
    },
  };
}
