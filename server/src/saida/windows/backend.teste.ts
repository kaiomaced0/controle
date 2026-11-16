/**
 * Teste do backend do Windows — **sem tocar no cursor de quem está rodando a suíte**.
 *
 * O truque é a `ApiDeEntradaDoWindows` de mentira: ela guarda uma cópia dos 40 bytes que o
 * backend montou e devolve o que a gente mandar como retorno do `SendInput`. Com isso dá para
 * afirmar o que realmente importa nesta camada — que o byte foi escrito no deslocamento certo,
 * com o sinalizador certo — em vez de afirmar que "chamou a função".
 *
 * Errar um deslocamento aqui não daria erro de compilação nem exceção: daria cursor andando
 * sozinho. Por isso o teste compara o quadro **inteiro**, e não campo por campo.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PedidoDeSaidaDoMouse } from '../saida-do-mouse.js';
import type { BotaoDoMouse, PosicaoDoMouse } from '../tipos.js';
import { daCoordenadaNormalizada } from './absoluto.js';
import {
  criarModeloDaAceleracao,
  magnitudeDoWindows,
  type ModeloDaAceleracao,
  type ParametrosDoPonteiro,
} from './aceleracao.js';
import type { ApiDeEntradaDoWindows } from './api.js';
import { criarBackendWindows } from './backend.js';
import {
  DESLOCAMENTO_MOUSE_DADOS,
  DESLOCAMENTO_MOUSE_DX,
  DESLOCAMENTO_MOUSE_DY,
  DESLOCAMENTO_MOUSE_SINALIZADORES,
  DESLOCAMENTO_POINT_X,
  DESLOCAMENTO_POINT_Y,
  DESLOCAMENTO_TECLA_SCAN,
  DESLOCAMENTO_TECLA_SINALIZADORES,
  DESLOCAMENTO_TECLA_VK,
  DESLOCAMENTO_TIPO,
  INPUT_KEYBOARD,
  INPUT_MOUSE,
  KEYEVENTF_EXTENDEDKEY,
  KEYEVENTF_KEYUP,
  KEYEVENTF_SCANCODE,
  MOUSEEVENTF_ABSOLUTE,
  MOUSEEVENTF_HWHEEL,
  MOUSEEVENTF_LEFTDOWN,
  MOUSEEVENTF_LEFTUP,
  MOUSEEVENTF_MIDDLEDOWN,
  MOUSEEVENTF_MIDDLEUP,
  MOUSEEVENTF_MOVE,
  MOUSEEVENTF_RIGHTDOWN,
  MOUSEEVENTF_RIGHTUP,
  MOUSEEVENTF_VIRTUALDESK,
  MOUSEEVENTF_WHEEL,
  SM_CXSCREEN,
  SM_CXVIRTUALSCREEN,
  SM_CYSCREEN,
  SM_CYVIRTUALSCREEN,
  SM_XVIRTUALSCREEN,
  SM_YVIRTUALSCREEN,
  TAMANHO_INPUT,
  TAMANHO_POINT,
  WHEEL_DELTA,
} from './constantes.js';

/**
 * A configuração de ponteiro desta máquina, como o Windows respondeu na sonda da ATI-026:
 * aceleração ligada, velocidade 11 e a curva de fábrica do registro (16.16 já convertido).
 */
const PONTEIRO_DESTA_MAQUINA: ParametrosDoPonteiro = Object.freeze({
  aceleracao: 1,
  limiar1: 6,
  limiar2: 10,
  velocidade: 11,
  curvaX: Object.freeze([0, 0.4300079345703125, 1.25, 3.8600006103515625, 40]),
  curvaY: Object.freeze([0, 1.0702667236328125, 4.140625, 18.984375, 443.75]),
  dpi: 96,
});

/** A mesma máquina com a aceleração desligada e a velocidade no neutro: o relativo sai 1:1. */
const PONTEIRO_NEUTRO: ParametrosDoPonteiro = Object.freeze({
  ...PONTEIRO_DESTA_MAQUINA,
  aceleracao: 0,
  velocidade: 10,
});

/** Um monitor da área de trabalho virtual de mentira: retângulo `[esquerda, direita) × [topo, base)`. */
interface MonitorDeMentira {
  readonly esquerda: number;
  readonly topo: number;
  readonly largura: number;
  readonly altura: number;
}

/**
 * A bancada de dois monitores desta máquina: primário 1920×1080 em (0, 0) e um 1080×1920 em retrato
 * à direita, com o topo 383 px acima — área virtual 3000×1920 com origem em (0, −383).
 */
const DOIS_MONITORES: readonly MonitorDeMentira[] = Object.freeze([
  { esquerda: 0, topo: 0, largura: 1920, altura: 1080 },
  { esquerda: 1920, topo: -383, largura: 1080, altura: 1920 },
]);

interface ApiDeMentira extends ApiDeEntradaDoWindows {
  /** Cópia dos 40 bytes de cada envio, na ordem. */
  readonly quadros: Buffer[];
  readonly posicoesDefinidas: PosicaoDoMouse[];
  readonly metricasPedidas: number[];
  /** Quantas vezes o backend pediu a consciência de DPI por monitor. */
  dpiPorMonitorPedido(): number;
  /** Onde o cursor de mentira está — o que o `GetCursorPos` responderia. */
  cursorAtual(): PosicaoDoMouse | undefined;
  /** Faz as próximas `n` chamadas de `SendInput` devolverem `retornoDaFalha`. */
  recusarProximos(n: number, retornoDaFalha?: number): void;
  definirTela(largura: number, altura: number): void;
  definirCursor(posicao: PosicaoDoMouse | undefined): void;
  definirPosicaoFalha(falha: boolean): void;
  /**
   * Monta uma área de trabalho de vários monitores. A área virtual é o retângulo que envolve todos;
   * o cursor, como no Windows, só existe **dentro** de algum monitor.
   */
  definirMonitores(monitores: readonly MonitorDeMentira[]): void;
  definirParametros(parametros: ParametrosDoPonteiro | undefined): void;
  /**
   * Liga a curva do Windows de mentira sobre o movimento **relativo**: cada evento anda
   * `mickeys × ganho(magnitude)`, com a fração guardada entre eventos — o que o Windows faz.
   */
  simularAceleracao(modelo: ModeloDaAceleracao | undefined): void;
}

function limitar(valor: number, minimo: number, maximo: number): number {
  return valor < minimo ? minimo : valor > maximo ? maximo : valor;
}

function criarApiDeMentira(): ApiDeMentira {
  const quadro = Buffer.alloc(TAMANHO_INPUT);
  const ponto = Buffer.alloc(TAMANHO_POINT);
  const quadros: Buffer[] = [];
  const posicoesDefinidas: PosicaoDoMouse[] = [];
  const metricasPedidas: number[] = [];
  let recusas = 0;
  let retornoDaFalha = 0;
  let largura = 1920;
  let altura = 1080;
  let monitores: readonly MonitorDeMentira[] | undefined;
  let cursor: PosicaoDoMouse | undefined = { x: 100, y: 200 };
  let posicaoFalha = false;
  let ultimoErro = 0;
  let parametros: ParametrosDoPonteiro | undefined;
  let aceleracao: ModeloDaAceleracao | undefined;
  let restoX = 0;
  let restoY = 0;
  let dpiPedido = 0;

  function listaDeMonitores(): readonly MonitorDeMentira[] {
    return monitores ?? [{ esquerda: 0, topo: 0, largura, altura }];
  }

  function areaVirtual(): MonitorDeMentira {
    const lista = listaDeMonitores();
    const esquerda = Math.min(...lista.map((m) => m.esquerda));
    const topo = Math.min(...lista.map((m) => m.topo));
    const direita = Math.max(...lista.map((m) => m.esquerda + m.largura));
    const base = Math.max(...lista.map((m) => m.topo + m.altura));
    return { esquerda, topo, largura: direita - esquerda, altura: base - topo };
  }

  /** O Windows encosta o cursor no monitor mais próximo: ponto fora de todos não existe. */
  function encostarNumMonitor(x: number, y: number): PosicaoDoMouse {
    let melhor: PosicaoDoMouse = { x, y };
    let menorDistancia = Number.POSITIVE_INFINITY;
    for (const m of listaDeMonitores()) {
      const cx = limitar(x, m.esquerda, m.esquerda + m.largura - 1);
      const cy = limitar(y, m.topo, m.topo + m.altura - 1);
      const distancia = (cx - x) ** 2 + (cy - y) ** 2;
      if (distancia < menorDistancia) {
        menorDistancia = distancia;
        melhor = { x: cx, y: cy };
      }
    }
    return melhor;
  }

  /** O que o Windows faria com o quadro de mouse que acabou de chegar. */
  function aplicarAoCursor(): void {
    if (cursor === undefined || quadro.readUInt32LE(DESLOCAMENTO_TIPO) !== INPUT_MOUSE) return;
    const sinalizadores = quadro.readUInt32LE(DESLOCAMENTO_MOUSE_SINALIZADORES);
    if ((sinalizadores & MOUSEEVENTF_MOVE) === 0) return;
    const dx = quadro.readInt32LE(DESLOCAMENTO_MOUSE_DX);
    const dy = quadro.readInt32LE(DESLOCAMENTO_MOUSE_DY);
    if ((sinalizadores & MOUSEEVENTF_ABSOLUTE) !== 0) {
      // Sem VIRTUALDESK, a régua é só o monitor primário — é o defeito que prende o cursor nele.
      const regua =
        (sinalizadores & MOUSEEVENTF_VIRTUALDESK) !== 0
          ? areaVirtual()
          : { esquerda: 0, topo: 0, largura, altura };
      cursor = encostarNumMonitor(
        regua.esquerda + daCoordenadaNormalizada(dx, regua.largura),
        regua.topo + daCoordenadaNormalizada(dy, regua.altura),
      );
      return;
    }
    const ganho = aceleracao?.ganho(magnitudeDoWindows(dx, dy)) ?? 1;
    const realX = dx * ganho + restoX;
    const realY = dy * ganho + restoY;
    const inteiroX = Math.trunc(realX);
    const inteiroY = Math.trunc(realY);
    restoX = realX - inteiroX;
    restoY = realY - inteiroY;
    cursor = encostarNumMonitor(cursor.x + inteiroX, cursor.y + inteiroY);
  }

  return {
    quadro,
    ponto,
    quadros,
    posicoesDefinidas,
    metricasPedidas,

    enviarUmaEntrada() {
      quadros.push(Buffer.from(quadro));
      if (recusas > 0) {
        recusas -= 1;
        ultimoErro = 5;
        return retornoDaFalha;
      }
      ultimoErro = 0;
      aplicarAoCursor();
      return 1;
    },

    definirPosicaoDoCursor(x, y) {
      posicoesDefinidas.push({ x, y });
      if (posicaoFalha) {
        ultimoErro = 87;
        return false;
      }
      cursor = { x, y };
      return true;
    },

    lerPosicaoDoCursor() {
      if (cursor === undefined) ultimoErro = 6;
      return cursor;
    },

    lerCursorNoPonto() {
      if (cursor === undefined) {
        ultimoErro = 6;
        return false;
      }
      ponto.writeInt32LE(cursor.x, DESLOCAMENTO_POINT_X);
      ponto.writeInt32LE(cursor.y, DESLOCAMENTO_POINT_Y);
      return true;
    },

    metricaDoSistema(indice) {
      metricasPedidas.push(indice);
      if (indice === SM_CXSCREEN) return largura;
      if (indice === SM_CYSCREEN) return altura;
      const area = areaVirtual();
      if (indice === SM_XVIRTUALSCREEN) return area.esquerda;
      if (indice === SM_YVIRTUALSCREEN) return area.topo;
      if (indice === SM_CXVIRTUALSCREEN) return largura === 0 ? 0 : area.largura;
      if (indice === SM_CYVIRTUALSCREEN) return altura === 0 ? 0 : area.altura;
      return 0;
    },

    lerParametrosDoPonteiro: () => parametros,
    ativarDpiPorMonitor() {
      dpiPedido += 1;
      return true;
    },

    ultimoErro: () => ultimoErro,

    dpiPorMonitorPedido: () => dpiPedido,
    cursorAtual: () => cursor,
    recusarProximos(n, retorno = 0) {
      recusas = n;
      retornoDaFalha = retorno;
    },
    definirTela(l, a) {
      largura = l;
      altura = a;
    },
    definirCursor(posicao) {
      cursor = posicao;
    },
    definirPosicaoFalha(falha) {
      posicaoFalha = falha;
    },
    definirMonitores(lista) {
      monitores = lista;
    },
    definirParametros(novos) {
      parametros = novos;
    },
    simularAceleracao(modelo) {
      aceleracao = modelo;
      restoX = 0;
      restoY = 0;
    },
  };
}

/** Opções do `montar()`: a API vem pronta para o teste ajustar **antes** de o backend nascer. */
interface OpcoesDeMontagem {
  readonly saidaDoMouse?: PedidoDeSaidaDoMouse;
  readonly prepararApi?: (api: ApiDeMentira) => void;
}

/** Backend com a API de mentira e sem rede de segurança pendurada no processo do teste. */
function montar(opcoes: OpcoesDeMontagem = {}): {
  readonly backend: ReturnType<typeof criarBackendWindows>;
  readonly api: ApiDeMentira;
  /** Dispara a rede de segurança que o backend registrou para a saída do processo. */
  readonly dispararRedeDeSeguranca: () => void;
  readonly redeCancelada: () => boolean;
} {
  const api = criarApiDeMentira();
  opcoes.prepararApi?.(api);
  let tarefaDaRede: (() => void) | undefined;
  let cancelada = false;
  const backend = criarBackendWindows({
    api,
    registrarSaidaDoProcesso: (tarefa) => {
      tarefaDaRede = tarefa;
      return () => {
        cancelada = true;
      };
    },
    ...(opcoes.saidaDoMouse === undefined ? {} : { saidaDoMouse: opcoes.saidaDoMouse }),
  });
  return {
    backend,
    api,
    dispararRedeDeSeguranca: () => tarefaDaRede?.(),
    redeCancelada: () => cancelada,
  };
}

/** Monta na mão o `INPUT` de mouse que se espera, para comparar os 40 bytes de uma vez. */
function quadroDeMouseEsperado(
  dx: number,
  dy: number,
  dados: number,
  sinalizadores: number,
): Buffer {
  const esperado = Buffer.alloc(TAMANHO_INPUT);
  esperado.writeUInt32LE(INPUT_MOUSE, DESLOCAMENTO_TIPO);
  esperado.writeInt32LE(dx, DESLOCAMENTO_MOUSE_DX);
  esperado.writeInt32LE(dy, DESLOCAMENTO_MOUSE_DY);
  esperado.writeInt32LE(dados, DESLOCAMENTO_MOUSE_DADOS);
  esperado.writeUInt32LE(sinalizadores, DESLOCAMENTO_MOUSE_SINALIZADORES);
  return esperado;
}

function quadroDeTeclaEsperado(scancode: number, sinalizadores: number): Buffer {
  const esperado = Buffer.alloc(TAMANHO_INPUT);
  esperado.writeUInt32LE(INPUT_KEYBOARD, DESLOCAMENTO_TIPO);
  esperado.writeUInt16LE(0, DESLOCAMENTO_TECLA_VK);
  esperado.writeUInt16LE(scancode, DESLOCAMENTO_TECLA_SCAN);
  esperado.writeUInt32LE(sinalizadores, DESLOCAMENTO_TECLA_SINALIZADORES);
  return esperado;
}

describe('moverMouseRelativo', () => {
  it('monta os 40 bytes do INPUT de movimento relativo, byte a byte', () => {
    const { backend, api } = montar();

    backend.moverMouseRelativo(7, -3);

    assert.equal(api.quadros.length, 1);
    assert.deepEqual(api.quadros[0], quadroDeMouseEsperado(7, -3, 0, MOUSEEVENTF_MOVE));
    assert.equal(backend.contadores.eventosEnviados, 1);
  });

  it('escreve dentro do Buffer da própria API — a struct é a mesma entre eventos', () => {
    const { backend, api } = montar();

    backend.moverMouseRelativo(7, -3);

    // Se o backend alocasse um INPUT por evento, este Buffer continuaria zerado.
    assert.deepEqual(api.quadro, quadroDeMouseEsperado(7, -3, 0, MOUSEEVENTF_MOVE));
  });

  // As três saídas (ATI-026) passam pela mesma régua: a absoluta lê o cursor e quatro métricas por
  // evento, e a compensada faz a conta da curva inversa — nenhuma das duas pode alocar para isso.
  for (const saida of ['relativo', 'absoluto', 'compensado'] as const) {
    it(`não aloca por evento no caminho quente (saída ${saida})`, () => {
      // A afirmação "zero alocação por pacote" (CLAUDE.md, regra 2) só vale medida. Uma API que
      // não guarda nada isola o custo do backend; 200 mil eventos alocando um objeto pequeno cada
      // deixariam rastro de megabytes no heap, muito acima do limite abaixo.
      const eventos = 200_000;
      let enviados = 0;
      const quadro = Buffer.alloc(TAMANHO_INPUT);
      const ponto = Buffer.alloc(TAMANHO_POINT);
      ponto.writeInt32LE(500, DESLOCAMENTO_POINT_X);
      ponto.writeInt32LE(500, DESLOCAMENTO_POINT_Y);
      const backend = criarBackendWindows({
        api: {
          quadro,
          ponto,
          enviarUmaEntrada: () => {
            enviados += 1;
            return 1;
          },
          definirPosicaoDoCursor: () => true,
          lerPosicaoDoCursor: () => undefined,
          lerCursorNoPonto: () => true,
          metricaDoSistema: (indice) =>
            indice === SM_CXVIRTUALSCREEN || indice === SM_CYVIRTUALSCREEN ? 1000 : 0,
          lerParametrosDoPonteiro: () => PONTEIRO_DESTA_MAQUINA,
          ativarDpiPorMonitor: () => true,
          ultimoErro: () => 0,
        },
        registrarSaidaDoProcesso: () => () => undefined,
        saidaDoMouse: saida,
      });
      assert.equal(backend.saidaDoMouse?.efetivo, saida);

      // Aquece: a primeira passagem paga a compilação do JIT e o crescimento inicial do heap. São
      // 50 mil, e não 10 mil, por causa da saída compensada: com 10 mil, a otimização dela ainda
      // terminava dentro da janela medida e o código compilado entrava na conta (0,5 a 1 MB numa
      // janela, variando de rodada para rodada; 0 B depois de aquecida).
      const aquecimento = 50_000;
      for (let i = 0; i < aquecimento; i += 1) backend.moverMouseRelativo(3, -2);

      const antes = process.memoryUsage().heapUsed;
      for (let i = 0; i < eventos; i += 1) backend.moverMouseRelativo(3, -2);
      const depois = process.memoryUsage().heapUsed;

      // O compensado guarda fração e pode adiar um evento; os outros dois mandam um por pedido.
      if (saida === 'compensado') assert.ok(enviados > (eventos + aquecimento) / 2);
      else assert.equal(enviados, eventos + aquecimento);
      const crescimentoPorEvento = (depois - antes) / eventos;
      assert.ok(
        crescimentoPorEvento < 1,
        `heap cresceu ${String(depois - antes)} bytes em ${String(eventos)} eventos ` +
          `(${crescimentoPorEvento.toFixed(3)} B/evento) — alguém voltou a alocar no caminho quente`,
      );
    });
  }

  it('trunca a fração e não manda evento quando o movimento é de zero pixel', () => {
    const { backend, api } = montar();

    backend.moverMouseRelativo(0.4, -0.9);

    assert.equal(api.quadros.length, 0);
    assert.equal(backend.contadores.pedidosNulos, 1);
    assert.equal(backend.contadores.eventosEnviados, 0);
  });

  it('recusa NaN e infinito sem mandar nada e sem estourar', () => {
    const { backend, api } = montar();

    backend.moverMouseRelativo(Number.NaN, 1);
    backend.moverMouseRelativo(1, Number.POSITIVE_INFINITY);

    assert.equal(api.quadros.length, 0);
    assert.equal(backend.contadores.pedidosInvalidos, 2);
  });

  it('satura em vez de estourar quando o pedido não cabe num LONG', () => {
    const { backend, api } = montar();

    // Sem saturação, `Buffer.writeInt32LE` lança — e a exceção subiria pelo caminho quente.
    backend.moverMouseRelativo(1e12, -1e12);

    const quadro = api.quadros[0];
    assert.ok(quadro !== undefined);
    assert.equal(quadro.readInt32LE(DESLOCAMENTO_MOUSE_DX), 2_147_483_647);
    assert.equal(quadro.readInt32LE(DESLOCAMENTO_MOUSE_DY), -2_147_483_648);
  });

  it('conta como recusa quando o SendInput devolve algo diferente de 1, com o código do erro', () => {
    const { backend, api } = montar();
    api.recusarProximos(1);

    backend.moverMouseRelativo(5, 5);

    assert.equal(backend.contadores.eventosRecusados, 1);
    assert.equal(backend.contadores.eventosEnviados, 0);
    assert.equal(backend.contadores.ultimoCodigoDeErro, 5);
  });
});

describe('botaoMouse', () => {
  it('manda o sinalizador certo de cada botão, aperto e soltura separados', () => {
    const { backend, api } = montar();

    backend.botaoMouse('esquerdo', true);
    backend.botaoMouse('esquerdo', false);
    backend.botaoMouse('direito', true);
    backend.botaoMouse('direito', false);
    backend.botaoMouse('meio', true);
    backend.botaoMouse('meio', false);

    const esperados = [
      MOUSEEVENTF_LEFTDOWN,
      MOUSEEVENTF_LEFTUP,
      MOUSEEVENTF_RIGHTDOWN,
      MOUSEEVENTF_RIGHTUP,
      MOUSEEVENTF_MIDDLEDOWN,
      MOUSEEVENTF_MIDDLEUP,
    ];
    assert.equal(api.quadros.length, esperados.length);
    esperados.forEach((sinalizador, indice) => {
      assert.deepEqual(api.quadros[indice], quadroDeMouseEsperado(0, 0, 0, sinalizador));
    });
  });

  it('botão apertado continua apertado — arrastar é mover com o botão preso', () => {
    const { backend, api } = montar();

    backend.botaoMouse('esquerdo', true);
    backend.moverMouseRelativo(10, 0);
    backend.moverMouseRelativo(10, 0);

    assert.equal(backend.pressionados(), 1);
    assert.equal(api.quadros.length, 3);
    assert.deepEqual(api.quadros[1], quadroDeMouseEsperado(10, 0, 0, MOUSEEVENTF_MOVE));
  });

  it('não repete o aperto de quem já está apertado nem solta quem não está', () => {
    const { backend, api } = montar();

    backend.botaoMouse('esquerdo', true);
    backend.botaoMouse('esquerdo', true);
    backend.botaoMouse('direito', false);

    assert.equal(api.quadros.length, 1);
    assert.equal(backend.contadores.pedidosRedundantes, 2);
  });

  it('botão que não existe é pedido inválido — não estoura no caminho quente', () => {
    const { backend, api } = montar();

    // O mapeador de perfis (ATI-008/ATI-018) é quem traduz `idControle` do fio para estes nomes.
    // Sem a guarda, `SINALIZADORES_DOS_BOTOES[botao]` daria `undefined` e a leitura de `.aperta`
    // viraria `TypeError` dentro do caminho quente — que é onde não há ninguém para tratar.
    backend.botaoMouse('lateral' as unknown as BotaoDoMouse, true);

    assert.deepEqual(api.quadros, []);
    assert.equal(backend.pressionados(), 0);
    assert.equal(backend.contadores.pedidosInvalidos, 1);
  });

  it('aperto recusado pelo sistema não entra no registro do que está preso', () => {
    const { backend, api } = montar();
    api.recusarProximos(1);

    backend.botaoMouse('esquerdo', true);

    assert.equal(backend.pressionados(), 0);
    backend.soltarTudo();
    // Nenhuma soltura: nada ficou preso de verdade, então mandar UP seria soltar o botão que a
    // pessoa pode estar segurando com a mão.
    assert.equal(api.quadros.length, 1);
  });

  it('soltura recusada mantém a marca, para o encerramento tentar de novo', () => {
    const { backend, api } = montar();

    backend.botaoMouse('esquerdo', true);
    api.recusarProximos(1);
    backend.botaoMouse('esquerdo', false);

    assert.equal(backend.pressionados(), 1);

    backend.soltarTudo();

    assert.equal(backend.pressionados(), 0);
    assert.deepEqual(api.quadros.at(-1), quadroDeMouseEsperado(0, 0, 0, MOUSEEVENTF_LEFTUP));
  });
});

describe('scroll', () => {
  it('multiplica o entalhe por WHEEL_DELTA e aceita valor negativo', () => {
    const { backend, api } = montar();

    backend.scroll(1, 0);
    backend.scroll(-2, 0);

    assert.deepEqual(api.quadros[0], quadroDeMouseEsperado(0, 0, WHEEL_DELTA, MOUSEEVENTF_WHEEL));
    assert.deepEqual(
      api.quadros[1],
      quadroDeMouseEsperado(0, 0, -2 * WHEEL_DELTA, MOUSEEVENTF_WHEEL),
    );
  });

  it('roda horizontal usa HWHEEL, e os dois eixos juntos viram dois eventos', () => {
    const { backend, api } = montar();

    backend.scroll(1, -1);

    assert.equal(api.quadros.length, 2);
    assert.deepEqual(api.quadros[0], quadroDeMouseEsperado(0, 0, WHEEL_DELTA, MOUSEEVENTF_WHEEL));
    assert.deepEqual(
      api.quadros[1],
      quadroDeMouseEsperado(0, 0, -WHEEL_DELTA, MOUSEEVENTF_HWHEEL),
    );
  });

  it('aceita fração de entalhe (rolagem suave) e ignora o pedido que arredonda para zero', () => {
    const { backend, api } = montar();

    backend.scroll(0.5, 0);
    backend.scroll(0.001, 0);

    assert.equal(api.quadros.length, 1);
    assert.equal(api.quadros[0]?.readInt32LE(DESLOCAMENTO_MOUSE_DADOS), 60);
    assert.equal(backend.contadores.pedidosNulos, 1);
  });
});

describe('tecla', () => {
  it('manda scancode com KEYEVENTF_SCANCODE e wVk em zero', () => {
    const { backend, api } = montar();

    backend.tecla(0x1e, true); // 'A' no teclado ABNT/US
    backend.tecla(0x1e, false);

    assert.deepEqual(api.quadros[0], quadroDeTeclaEsperado(0x1e, KEYEVENTF_SCANCODE));
    assert.deepEqual(
      api.quadros[1],
      quadroDeTeclaEsperado(0x1e, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP),
    );
  });

  it('tecla estendida vira byte de baixo + KEYEVENTF_EXTENDEDKEY', () => {
    const { backend, api } = montar();

    backend.tecla(0xe04d, true); // seta para a direita

    assert.deepEqual(
      api.quadros[0],
      quadroDeTeclaEsperado(0x4d, KEYEVENTF_SCANCODE | KEYEVENTF_EXTENDEDKEY),
    );
  });

  it('recusa scancode fora da faixa de um WORD e o scancode zero', () => {
    const { backend, api } = montar();

    backend.tecla(0, true);
    backend.tecla(-1, true);
    backend.tecla(0x1_0000, true);
    backend.tecla(1.5, true);

    assert.equal(api.quadros.length, 0);
    assert.equal(backend.contadores.pedidosInvalidos, 4);
  });

  it('não deixa apertar mais teclas do que consegue soltar depois', () => {
    const { backend } = montar();

    for (let scancode = 1; scancode <= 40; scancode += 1) backend.tecla(scancode, true);

    assert.equal(backend.pressionados(), 32);
    assert.equal(backend.contadores.pedidosInvalidos, 8);
  });
});

describe('soltarTudo', () => {
  it('solta tecla antes de botão, cada grupo na ordem inversa do aperto', () => {
    const { backend, api } = montar();

    backend.tecla(0x2a, true); // Shift esquerdo
    backend.tecla(0x1e, true); // A
    backend.botaoMouse('esquerdo', true);
    backend.botaoMouse('direito', true);
    api.quadros.length = 0;

    backend.soltarTudo();

    assert.deepEqual(api.quadros, [
      quadroDeTeclaEsperado(0x1e, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP),
      quadroDeTeclaEsperado(0x2a, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP),
      quadroDeMouseEsperado(0, 0, 0, MOUSEEVENTF_RIGHTUP),
      quadroDeMouseEsperado(0, 0, 0, MOUSEEVENTF_LEFTUP),
    ]);
    assert.equal(backend.pressionados(), 0);
    assert.equal(backend.contadores.soltasDeSeguranca, 4);
  });

  it('a ordem de soltura dos botões é a do aperto invertida, não a da lista canônica', () => {
    const { backend, api } = montar();

    // `meio` antes de `esquerdo`: é a única ordem em que "inversa do aperto" e "inversa da lista
    // canônica" discordam. O teste acima (esquerdo→direito) passaria dos dois jeitos.
    backend.botaoMouse('meio', true);
    backend.botaoMouse('esquerdo', true);
    api.quadros.length = 0;

    backend.soltarTudo();

    assert.deepEqual(api.quadros, [
      quadroDeMouseEsperado(0, 0, 0, MOUSEEVENTF_LEFTUP),
      quadroDeMouseEsperado(0, 0, 0, MOUSEEVENTF_MIDDLEUP),
    ]);
  });

  it('é idempotente: a segunda chamada não manda evento nenhum', () => {
    const { backend, api } = montar();

    backend.botaoMouse('esquerdo', true);
    backend.soltarTudo();
    const depoisDaPrimeira = api.quadros.length;
    backend.soltarTudo();
    backend.soltarTudo();

    assert.equal(api.quadros.length, depoisDaPrimeira);
    assert.equal(backend.contadores.soltasDeSeguranca, 1);
  });
});

describe('rede de segurança da saída do processo', () => {
  it('solta o que estava preso quando o processo está saindo', () => {
    const { backend, api, dispararRedeDeSeguranca } = montar();

    backend.botaoMouse('esquerdo', true);
    backend.tecla(0x2a, true);
    api.quadros.length = 0;

    dispararRedeDeSeguranca();

    assert.equal(api.quadros.length, 2);
    assert.equal(backend.pressionados(), 0);
  });

  it('encerrar() solta tudo e desliga a rede', () => {
    const { backend, api, redeCancelada } = montar();

    backend.botaoMouse('meio', true);
    backend.encerrar();

    assert.equal(backend.pressionados(), 0);
    assert.deepEqual(api.quadros.at(-1), quadroDeMouseEsperado(0, 0, 0, MOUSEEVENTF_MIDDLEUP));
    assert.equal(redeCancelada(), true);
  });
});

describe('tela e cursor', () => {
  it('lê a resolução por GetSystemMetrics', () => {
    const { backend, api } = montar();
    api.definirTela(2560, 1440);

    assert.deepEqual(backend.tamanhoDaTela(), { largura: 2560, altura: 1440 });
    assert.deepEqual(api.metricasPedidas, [SM_CXSCREEN, SM_CYSCREEN]);
  });

  it('resolução zerada vira undefined e entra em chamadasComErro', () => {
    const { backend, api } = montar();
    api.definirTela(0, 0);

    assert.equal(backend.tamanhoDaTela(), undefined);
    assert.equal(backend.contadores.chamadasComErro, 1);
  });

  it('posicionarMouse chama SetCursorPos e contabiliza a falha', () => {
    const { backend, api } = montar();

    backend.posicionarMouse(960.7, 540.2);
    assert.deepEqual(api.posicoesDefinidas.at(-1), { x: 960, y: 540 });

    api.definirPosicaoFalha(true);
    backend.posicionarMouse(10, 10);

    assert.equal(backend.contadores.chamadasComErro, 1);
    assert.equal(backend.contadores.ultimoCodigoDeErro, 87);
  });

  it('lerPosicaoDoMouse devolve undefined e conta erro quando o sistema recusa', () => {
    const { backend, api } = montar();

    assert.deepEqual(backend.lerPosicaoDoMouse(), { x: 100, y: 200 });

    api.definirCursor(undefined);
    assert.equal(backend.lerPosicaoDoMouse(), undefined);
    assert.equal(backend.contadores.chamadasComErro, 1);
  });

  it('posicionarMouse recusa coordenada que não é número', () => {
    const { backend, api } = montar();

    backend.posicionarMouse(Number.NaN, 0);

    assert.equal(api.posicoesDefinidas.length, 0);
    assert.equal(backend.contadores.pedidosInvalidos, 1);
  });
});

/* ======================================================================= saída do mouse (ATI-026) */

/** Lê o destino de um quadro absoluto como o Windows leria, na área virtual informada. */
function destinoDoQuadro(
  quadro: Buffer,
  area: { esquerda: number; topo: number; largura: number; altura: number },
): PosicaoDoMouse {
  return {
    x: area.esquerda + daCoordenadaNormalizada(quadro.readInt32LE(DESLOCAMENTO_MOUSE_DX), area.largura),
    y: area.topo + daCoordenadaNormalizada(quadro.readInt32LE(DESLOCAMENTO_MOUSE_DY), area.altura),
  };
}

/** A tabela da spec: 40 pedidos de +1 px e depois 1 de −40 px, lendo o cursor antes e depois. */
function tabelaDaSpec(
  backend: ReturnType<typeof criarBackendWindows>,
  api: ApiDeMentira,
): { ida: number; volta: number } {
  const inicio = api.cursorAtual();
  for (let i = 0; i < 40; i += 1) backend.moverMouseRelativo(1, 0);
  const meio = api.cursorAtual();
  backend.moverMouseRelativo(-40, 0);
  const fim = api.cursorAtual();
  assert.ok(inicio !== undefined && meio !== undefined && fim !== undefined);
  return { ida: meio.x - inicio.x, volta: fim.x - meio.x };
}

describe('saída do mouse — a escolha (ATI-026)', () => {
  it('sem pedido, o backend é o relativo cru de antes da ATI-026', () => {
    const { backend, api } = montar({ prepararApi: (a) => a.definirParametros(PONTEIRO_DESTA_MAQUINA) });

    backend.moverMouseRelativo(7, -3);

    assert.equal(backend.saidaDoMouse?.efetivo, 'relativo');
    assert.deepEqual(api.quadros[0], quadroDeMouseEsperado(7, -3, 0, MOUSEEVENTF_MOVE));
    // Relativo não precisa de régua física: a consciência de DPI fica como estava.
    assert.equal(api.dpiPorMonitorPedido(), 0);
  });

  it('auto com a aceleração ligada vira absoluto, e diz por quê', () => {
    const { backend, api } = montar({
      saidaDoMouse: 'auto',
      prepararApi: (a) => a.definirParametros(PONTEIRO_DESTA_MAQUINA),
    });

    assert.deepEqual(backend.saidaDoMouse, {
      pedido: 'auto',
      efetivo: 'absoluto',
      aceleracao: 'ligada',
      velocidade: 11,
      relativoSaiFiel: false,
      motivo: 'auto: aceleração de ponteiro ligada',
    });
    assert.equal(api.dpiPorMonitorPedido(), 1);
  });

  it('auto com a aceleração desligada e velocidade 10 fica no relativo — ele já sai 1:1', () => {
    const { backend, api } = montar({
      saidaDoMouse: 'auto',
      prepararApi: (a) => a.definirParametros(PONTEIRO_NEUTRO),
    });

    assert.equal(backend.saidaDoMouse?.efetivo, 'relativo');
    assert.equal(backend.saidaDoMouse?.aceleracao, 'desligada');
    assert.equal(backend.saidaDoMouse?.relativoSaiFiel, true);
    backend.moverMouseRelativo(4, 0);
    assert.deepEqual(api.quadros[0], quadroDeMouseEsperado(4, 0, 0, MOUSEEVENTF_MOVE));
  });

  it('auto com a aceleração desligada mas velocidade fora do 10 vai para o absoluto', () => {
    // Sem aceleração, a velocidade 11 multiplica o relativo por 1,25: o px/grau do perfil não seria
    // o px/grau da tela, que é o mesmo defeito da curva, só que linear.
    const { backend } = montar({
      saidaDoMouse: 'auto',
      prepararApi: (a) => a.definirParametros({ ...PONTEIRO_DESTA_MAQUINA, aceleracao: 0 }),
    });

    assert.equal(backend.saidaDoMouse?.efetivo, 'absoluto');
    assert.match(backend.saidaDoMouse?.motivo ?? '', /velocidade do ponteiro 11\/20/);
  });

  it('auto sem conseguir ler o ponteiro vai para o absoluto, que acerta com qualquer configuração', () => {
    const { backend } = montar({ saidaDoMouse: 'auto' });

    assert.equal(backend.saidaDoMouse?.efetivo, 'absoluto');
    assert.equal(backend.saidaDoMouse?.aceleracao, 'desconhecida');
    assert.equal(backend.saidaDoMouse?.relativoSaiFiel, undefined);
  });

  it('pedido explícito vale como veio, mesmo contra a configuração do sistema', () => {
    const relativo = montar({
      saidaDoMouse: 'relativo',
      prepararApi: (a) => a.definirParametros(PONTEIRO_DESTA_MAQUINA),
    });
    const absoluto = montar({
      saidaDoMouse: 'absoluto',
      prepararApi: (a) => a.definirParametros(PONTEIRO_NEUTRO),
    });

    assert.equal(relativo.backend.saidaDoMouse?.efetivo, 'relativo');
    assert.equal(relativo.backend.saidaDoMouse?.relativoSaiFiel, false);
    assert.equal(absoluto.backend.saidaDoMouse?.efetivo, 'absoluto');
  });

  it('compensado sem curva legível cai para o absoluto, dizendo por quê', () => {
    const { backend } = montar({
      saidaDoMouse: 'compensado',
      prepararApi: (a) =>
        a.definirParametros({ ...PONTEIRO_DESTA_MAQUINA, curvaX: undefined, curvaY: undefined }),
    });

    assert.equal(backend.saidaDoMouse?.efetivo, 'absoluto');
    assert.match(backend.saidaDoMouse?.motivo ?? '', /não pôde ser lida ou invertida/);
  });

  it('a leitura do ponteiro que estoura não impede o backend de existir', () => {
    const { backend } = montar({
      saidaDoMouse: 'auto',
      prepararApi: (a) => {
        a.lerParametrosDoPonteiro = () => {
          throw new Error('registro indisponível');
        };
      },
    });

    assert.equal(backend.saidaDoMouse?.aceleracao, 'desconhecida');
    assert.equal(backend.saidaDoMouse?.efetivo, 'absoluto');
  });
});

describe('saída absoluta (ATI-026)', () => {
  it('monta o INPUT com MOVE | ABSOLUTE | VIRTUALDESK e o destino = cursor + deslocamento', () => {
    const { backend, api } = montar({ saidaDoMouse: 'absoluto' });

    backend.moverMouseRelativo(7, -3);

    const quadro = api.quadros[0];
    assert.ok(quadro !== undefined);
    assert.equal(quadro.readUInt32LE(DESLOCAMENTO_TIPO), INPUT_MOUSE);
    assert.equal(
      quadro.readUInt32LE(DESLOCAMENTO_MOUSE_SINALIZADORES),
      MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
    );
    assert.deepEqual(destinoDoQuadro(quadro, { esquerda: 0, topo: 0, largura: 1920, altura: 1080 }), {
      x: 107,
      y: 197,
    });
    assert.deepEqual(api.cursorAtual(), { x: 107, y: 197 });
  });

  it('lê a área virtual a cada evento — monitor que entra com o servidor de pé vale', () => {
    const { backend, api } = montar({ saidaDoMouse: 'absoluto' });
    api.metricasPedidas.length = 0;

    backend.moverMouseRelativo(1, 0);

    assert.deepEqual(
      [...api.metricasPedidas].sort((a, b) => a - b),
      [SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN],
    );
  });

  it('a tabela da spec fecha com a aceleração LIGADA: 40 × +1 = +40 e 1 × −40 = −40', () => {
    const modelo = criarModeloDaAceleracao(PONTEIRO_DESTA_MAQUINA);
    const preparar = (a: ApiDeMentira): void => {
      a.definirCursor({ x: 960, y: 540 });
      a.simularAceleracao(modelo);
    };
    const relativo = montar({ saidaDoMouse: 'relativo', prepararApi: preparar });
    const absoluto = montar({ saidaDoMouse: 'absoluto', prepararApi: preparar });

    const antes = tabelaDaSpec(relativo.backend, relativo.api);
    const depois = tabelaDaSpec(absoluto.backend, absoluto.api);

    // O relativo, com a curva simulada, reproduz o defeito: o lento encolhe, o rápido estica.
    assert.ok(antes.ida < 30, `ida relativa: ${String(antes.ida)}`);
    assert.ok(antes.volta < -50, `volta relativa: ${String(antes.volta)}`);
    assert.deepEqual(depois, { ida: 40, volta: -40 });
  });

  it('com a aceleração desligada continua exato — o absoluto não depende dela', () => {
    const { backend, api } = montar({
      saidaDoMouse: 'absoluto',
      prepararApi: (a) => {
        a.definirParametros(PONTEIRO_NEUTRO);
        a.definirCursor({ x: 960, y: 540 });
      },
    });

    assert.deepEqual(tabelaDaSpec(backend, api), { ida: 40, volta: -40 });
  });

  it('atravessa para o segundo monitor (retrato, à direita, origem em y = −383)', () => {
    // A bancada desta máquina: primário 1920×1080 em (0, 0) e um 1080×1920 em retrato à direita,
    // com o topo 383 px acima — área virtual 3000×1920 com origem em (0, −383).
    const { backend, api } = montar({
      saidaDoMouse: 'absoluto',
      prepararApi: (a) => {
        a.definirMonitores(DOIS_MONITORES);
        a.definirCursor({ x: 1915, y: 500 });
      },
    });

    backend.moverMouseRelativo(10, 0);
    assert.deepEqual(api.cursorAtual(), { x: 1925, y: 500 }, 'não atravessou a borda do primário');

    // Já no segundo monitor, subir acima do topo do primário é território legítimo.
    backend.moverMouseRelativo(0, -700);
    assert.deepEqual(api.cursorAtual(), { x: 1925, y: -200 });

    // E volta para o primário pelo mesmo caminho.
    backend.moverMouseRelativo(0, 700);
    backend.moverMouseRelativo(-10, 0);
    assert.deepEqual(api.cursorAtual(), { x: 1915, y: 500 });
  });

  it('cada pixel da travessia é alcançável, nos dois sentidos — nenhum passo de 1 px se perde', () => {
    const { backend, api } = montar({
      saidaDoMouse: 'absoluto',
      prepararApi: (a) => {
        a.definirMonitores(DOIS_MONITORES);
        a.definirCursor({ x: 1900, y: 500 });
      },
    });

    for (let i = 0; i < 40; i += 1) backend.moverMouseRelativo(1, 0);
    assert.deepEqual(api.cursorAtual(), { x: 1940, y: 500 });
    for (let i = 0; i < 40; i += 1) backend.moverMouseRelativo(-1, 0);
    assert.deepEqual(api.cursorAtual(), { x: 1900, y: 500 });
  });

  it('não gruda na borda: o que a borda comeu não vira resto para desfazer na volta', () => {
    const { backend, api } = montar({
      saidaDoMouse: 'absoluto',
      prepararApi: (a) => {
        a.definirMonitores(DOIS_MONITORES);
        a.definirCursor({ x: 2990, y: 0 });
      },
    });

    // Borda direita da área virtual: 50 px pedidos, 9 andados.
    backend.moverMouseRelativo(50, 0);
    assert.deepEqual(api.cursorAtual(), { x: 2999, y: 0 });
    // A volta começa da borda, e não de 3040.
    backend.moverMouseRelativo(-10, 0);
    assert.deepEqual(api.cursorAtual(), { x: 2989, y: 0 });

    // O canto vazio ao lado do monitor em retrato (acima do primário): o Windows encosta o cursor
    // no monitor mais próximo, e o próximo pedido parte de lá.
    api.definirCursor({ x: 1925, y: -300 });
    backend.moverMouseRelativo(-100, 0);
    assert.deepEqual(api.cursorAtual(), { x: 1920, y: -300 });
    backend.moverMouseRelativo(5, 0);
    assert.deepEqual(api.cursorAtual(), { x: 1925, y: -300 });
  });

  it('sem VIRTUALDESK o cursor ficaria preso no primário — a régua é a área virtual', () => {
    // Prova de que o teste acima mede alguma coisa: o mesmo destino, normalizado sobre o primário
    // (o erro clássico), sai na borda direita dele.
    const { backend, api } = montar({
      saidaDoMouse: 'absoluto',
      prepararApi: (a) => {
        a.definirMonitores(DOIS_MONITORES);
        a.definirCursor({ x: 1915, y: 500 });
      },
    });

    backend.moverMouseRelativo(10, 0);
    const quadro = api.quadros[0];
    assert.ok(quadro !== undefined);
    const comoSeFossePrimario = destinoDoQuadro(quadro, {
      esquerda: 0,
      topo: 0,
      largura: 1920,
      altura: 1080,
    });
    assert.notDeepEqual(comoSeFossePrimario, { x: 1925, y: 500 });
    assert.deepEqual(
      destinoDoQuadro(quadro, { esquerda: 0, topo: -383, largura: 3000, altura: 1920 }),
      { x: 1925, y: 500 },
    );
  });

  it('convive com o mouse físico: o que a mão moveu entre dois pedidos é respeitado', () => {
    const { backend, api } = montar({ saidaDoMouse: 'absoluto' });

    backend.moverMouseRelativo(10, 0);
    api.definirCursor({ x: 500, y: 500 }); // a pessoa pegou o mouse
    backend.moverMouseRelativo(10, 0);

    assert.deepEqual(api.cursorAtual(), { x: 510, y: 500 });
  });

  it('GetCursorPos recusado: o pedido sai relativo em vez de sumir, e a falha é contada', () => {
    const { backend, api } = montar({ saidaDoMouse: 'absoluto' });
    api.definirCursor(undefined);

    backend.moverMouseRelativo(5, 2);

    assert.deepEqual(api.quadros[0], quadroDeMouseEsperado(5, 2, 0, MOUSEEVENTF_MOVE));
    assert.equal(backend.contadores.chamadasComErro, 1);
    assert.equal(backend.contadores.ultimoCodigoDeErro, 6);
    assert.equal(backend.contadores.eventosEnviados, 1);
  });

  it('área virtual sem resposta: mesmo recuo para o relativo', () => {
    const { backend, api } = montar({ saidaDoMouse: 'absoluto' });
    api.definirTela(0, 0);

    backend.moverMouseRelativo(5, 2);

    assert.deepEqual(api.quadros[0], quadroDeMouseEsperado(5, 2, 0, MOUSEEVENTF_MOVE));
    assert.equal(backend.contadores.chamadasComErro, 1);
  });

  it('movimento de zero pixel continua não sendo evento', () => {
    const { backend, api } = montar({ saidaDoMouse: 'absoluto' });

    backend.moverMouseRelativo(0.3, -0.2);

    assert.equal(api.quadros.length, 0);
    assert.equal(backend.contadores.pedidosNulos, 1);
  });
});

describe('saída compensada — bancada (ATI-026)', () => {
  it('com o modelo certo, a curva inversa fecha a tabela da spec dentro de ±1 px', () => {
    const modelo = criarModeloDaAceleracao(PONTEIRO_DESTA_MAQUINA);
    const { backend, api } = montar({
      saidaDoMouse: 'compensado',
      prepararApi: (a) => {
        a.definirParametros(PONTEIRO_DESTA_MAQUINA);
        a.definirCursor({ x: 960, y: 540 });
        a.simularAceleracao(modelo);
      },
    });

    const { ida, volta } = tabelaDaSpec(backend, api);

    assert.equal(backend.saidaDoMouse?.efetivo, 'compensado');
    assert.ok(Math.abs(ida - 40) <= 1, `ida compensada: ${String(ida)}`);
    assert.ok(Math.abs(volta + 40) <= 1, `volta compensada: ${String(volta)}`);
  });

  it('com a aceleração desligada e velocidade 10 é a identidade — não estraga o caso bom', () => {
    const { backend, api } = montar({
      saidaDoMouse: 'compensado',
      prepararApi: (a) => a.definirParametros(PONTEIRO_NEUTRO),
    });

    backend.moverMouseRelativo(1, 0);
    backend.moverMouseRelativo(-40, 3);

    assert.deepEqual(api.quadros, [
      quadroDeMouseEsperado(1, 0, 0, MOUSEEVENTF_MOVE),
      quadroDeMouseEsperado(-40, 3, 0, MOUSEEVENTF_MOVE),
    ]);
  });
});
