/**
 * Teste da aceleração de ponteiro (ATI-026): a leitura da curva, o modelo, o compensador e a escolha
 * da saída. Nada aqui fala com o sistema — é conta.
 *
 * O compensador é testado contra um "Windows de mentira" que usa o **mesmo** modelo: o que se prova
 * é a lógica (a fração guardada, a inversa, o arredondamento que não perde pixel), e não que o
 * modelo descreve o Windows de verdade. Isso só a bancada prova (`ferramentas/provar-aceleracao.mjs`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CONSTANTES_MEDIDAS,
  MICKEY_X,
  MICKEY_Y,
  MULTIPLICADORES_SEM_ACELERACAO,
  criarCompensadorDaAceleracao,
  criarModeloDaAceleracao,
  curvaInversivel,
  descreverSaidaDoMouse,
  interpretarCurva,
  magnitudeDoWindows,
  multiplicadorDaVelocidade,
  relativoSaiFiel,
  resolverSaidaDoMouse,
  type ModeloDaAceleracao,
  type ParametrosDoPonteiro,
} from './aceleracao.js';

/** Os 40 bytes de `SmoothMouseXCurve` desta máquina, como o registro devolve (curva de fábrica). */
const CURVA_X_DO_REGISTRO = Buffer.from(
  '0000000000000000156e000000000000004001000000000029dc0300000000000000280000000000',
  'hex',
);
const CURVA_Y_DO_REGISTRO = Buffer.from(
  '0000000000000000fd11010000000000002404000000000000fc12000000000000c0bb0100000000',
  'hex',
);

const PONTEIRO_DESTA_MAQUINA: ParametrosDoPonteiro = Object.freeze({
  aceleracao: 1,
  limiar1: 6,
  limiar2: 10,
  velocidade: 11,
  curvaX: interpretarCurva(CURVA_X_DO_REGISTRO, 40),
  curvaY: interpretarCurva(CURVA_Y_DO_REGISTRO, 40),
  dpi: 96,
});

const PONTEIRO_NEUTRO: ParametrosDoPonteiro = Object.freeze({
  ...PONTEIRO_DESTA_MAQUINA,
  aceleracao: 0,
  velocidade: 10,
});

/**
 * O Windows de mentira: cada evento anda `mickeys × ganho(magnitude)`, com a fração guardada entre
 * eventos e o inteiro truncado em direção ao zero.
 */
function criarWindowsDeMentira(modelo: ModeloDaAceleracao): {
  mover(mx: number, my: number): void;
  readonly x: number;
  readonly y: number;
} {
  let x = 0;
  let y = 0;
  let restoX = 0;
  let restoY = 0;
  return {
    mover(mx, my) {
      const ganho = modelo.ganho(magnitudeDoWindows(mx, my));
      const realX = mx * ganho + restoX;
      const realY = my * ganho + restoY;
      x += Math.trunc(realX);
      y += Math.trunc(realY);
      restoX = realX - Math.trunc(realX);
      restoY = realY - Math.trunc(realY);
    },
    get x() {
      return x;
    },
    get y() {
      return y;
    },
  };
}

describe('interpretarCurva', () => {
  it('lê os cinco pontos 16.16 da curva de fábrica', () => {
    assert.deepEqual(interpretarCurva(CURVA_X_DO_REGISTRO, 40), [
      0,
      0.4300079345703125,
      1.25,
      3.8600006103515625,
      40,
    ]);
    assert.deepEqual(interpretarCurva(CURVA_Y_DO_REGISTRO, 40), [
      0,
      1.0702667236328125,
      4.140625,
      18.984375,
      443.75,
    ]);
  });

  it('valor de tamanho diferente de 40 bytes não é curva', () => {
    assert.equal(interpretarCurva(CURVA_X_DO_REGISTRO, 32), undefined);
    assert.equal(interpretarCurva(Buffer.alloc(8), 40), undefined);
  });
});

describe('curvaInversivel', () => {
  it('a curva de fábrica é inversível', () => {
    assert.equal(curvaInversivel(PONTEIRO_DESTA_MAQUINA.curvaX, PONTEIRO_DESTA_MAQUINA.curvaY), true);
  });

  it('curva achatada, fora de ordem, sem origem ou ausente não é', () => {
    assert.equal(curvaInversivel([0, 0, 0, 0, 0], [0, 0, 0, 0, 0]), false);
    assert.equal(curvaInversivel([0, 2, 1, 3, 4], [0, 1, 2, 3, 4]), false);
    assert.equal(curvaInversivel([1, 2, 3, 4, 5], [0, 1, 2, 3, 4]), false);
    assert.equal(curvaInversivel([0, 1, 2, 3], [0, 1, 2, 3]), false);
    assert.equal(curvaInversivel(undefined, [0, 1, 2, 3, 4]), false);
  });
});

describe('multiplicadorDaVelocidade', () => {
  it('com aceleração, é velocidade/10', () => {
    assert.equal(multiplicadorDaVelocidade(10, true), 1);
    assert.equal(multiplicadorDaVelocidade(11, true), 1.1);
    assert.equal(multiplicadorDaVelocidade(20, true), 2);
  });

  it('sem aceleração, é a tabela do Windows (oitavos abaixo do 10, quartos acima)', () => {
    assert.equal(MULTIPLICADORES_SEM_ACELERACAO.length, 20);
    assert.equal(multiplicadorDaVelocidade(1, false), 1 / 32);
    assert.equal(multiplicadorDaVelocidade(6, false), 0.5);
    assert.equal(multiplicadorDaVelocidade(10, false), 1);
    assert.equal(multiplicadorDaVelocidade(11, false), 1.25);
    assert.equal(multiplicadorDaVelocidade(20, false), 3.5);
  });

  it('velocidade fora de 1 a 20 não inventa multiplicador', () => {
    assert.equal(multiplicadorDaVelocidade(0, false), 1);
    assert.equal(multiplicadorDaVelocidade(21, true), 1);
    assert.equal(multiplicadorDaVelocidade(10.5, true), 1);
  });
});

describe('magnitudeDoWindows', () => {
  it('é max + min/2, com sinal ignorado', () => {
    assert.equal(magnitudeDoWindows(40, 0), 40);
    assert.equal(magnitudeDoWindows(-40, 0), 40);
    assert.equal(magnitudeDoWindows(3, -4), 5.5);
    assert.equal(magnitudeDoWindows(0, 0), 0);
  });
});

describe('criarModeloDaAceleracao', () => {
  it('sem aceleração e velocidade 10, o ganho é 1 e a inversa é a identidade', () => {
    const modelo = criarModeloDaAceleracao(PONTEIRO_NEUTRO);
    assert.ok(modelo !== undefined);

    assert.equal(modelo.comCurva, false);
    for (const magnitude of [1, 7, 40, 300]) {
      assert.equal(modelo.ganho(magnitude), 1);
      assert.equal(modelo.entradaParaSaida(magnitude), magnitude);
    }
  });

  it('sem aceleração e velocidade 11, multiplica por 1,25 — e a inversa divide', () => {
    const modelo = criarModeloDaAceleracao({ ...PONTEIRO_NEUTRO, velocidade: 11 });
    assert.ok(modelo !== undefined);

    assert.equal(modelo.ganho(40), 1.25);
    assert.equal(modelo.entradaParaSaida(50), 40);
  });

  it('com a curva, o ganho cresce com a velocidade: o lento encolhe e o rápido estica', () => {
    const modelo = criarModeloDaAceleracao(PONTEIRO_DESTA_MAQUINA);
    assert.ok(modelo !== undefined);

    assert.equal(modelo.comCurva, true);
    assert.ok(modelo.ganho(1) < 1, `ganho lento: ${String(modelo.ganho(1))}`);
    assert.ok(modelo.ganho(40) > 1, `ganho rápido: ${String(modelo.ganho(40))}`);
    let anterior = 0;
    for (let magnitude = 1; magnitude <= 200; magnitude += 1) {
      const ganho = modelo.ganho(magnitude);
      assert.ok(ganho >= anterior - 1e-12, `o ganho caiu em ${String(magnitude)}`);
      anterior = ganho;
    }
  });

  it('a inversa desfaz a curva: saída(entradaParaSaida(s)) = s, em toda a faixa', () => {
    const modelo = criarModeloDaAceleracao(PONTEIRO_DESTA_MAQUINA);
    assert.ok(modelo !== undefined);

    for (const saida of [0.1, 0.5, 1, 2.5, 10, 40, 59, 200, 1000]) {
      const entrada = modelo.entradaParaSaida(saida);
      assert.ok(Math.abs(entrada * modelo.ganho(entrada) - saida) < 1e-9, `saída ${String(saida)}`);
    }
  });

  it('a DPI escala a saída: 120 DPI anda 1,25 × o de 96', () => {
    const a96 = criarModeloDaAceleracao(PONTEIRO_DESTA_MAQUINA);
    const a120 = criarModeloDaAceleracao({ ...PONTEIRO_DESTA_MAQUINA, dpi: 120 });
    assert.ok(a96 !== undefined && a120 !== undefined);

    assert.ok(Math.abs(a120.ganho(10) / a96.ganho(10) - 1.25) < 1e-12);
  });

  it('com a aceleração ligada e sem curva inversível, não há modelo', () => {
    assert.equal(
      criarModeloDaAceleracao({ ...PONTEIRO_DESTA_MAQUINA, curvaX: undefined }),
      undefined,
    );
    assert.equal(
      criarModeloDaAceleracao({ ...PONTEIRO_DESTA_MAQUINA, curvaY: [0, 0, 0, 0, 0] }),
      undefined,
    );
    assert.equal(
      criarModeloDaAceleracao(PONTEIRO_DESTA_MAQUINA, { entradaPorMickey: 0, saidaA96Dpi: 1 }),
      undefined,
    );
  });

  it('as constantes medidas são números positivos e finitos', () => {
    assert.ok(CONSTANTES_MEDIDAS.entradaPorMickey > 0 && Number.isFinite(CONSTANTES_MEDIDAS.entradaPorMickey));
    assert.ok(CONSTANTES_MEDIDAS.saidaA96Dpi > 0 && Number.isFinite(CONSTANTES_MEDIDAS.saidaA96Dpi));
  });
});

describe('criarCompensadorDaAceleracao', () => {
  function montar(parametros: ParametrosDoPonteiro): {
    compensar: (dx: number, dy: number) => void;
    windows: ReturnType<typeof criarWindowsDeMentira>;
    enviados: Array<[number, number]>;
  } {
    const modelo = criarModeloDaAceleracao(parametros);
    assert.ok(modelo !== undefined);
    const compensador = criarCompensadorDaAceleracao(modelo);
    const windows = criarWindowsDeMentira(modelo);
    const enviados: Array<[number, number]> = [];
    return {
      compensar(dx, dy) {
        if (compensador.compensar(dx, dy)) {
          const x = compensador.mickeys[MICKEY_X] ?? 0;
          const y = compensador.mickeys[MICKEY_Y] ?? 0;
          enviados.push([x, y]);
          windows.mover(x, y);
        }
      },
      windows,
      enviados,
    };
  }

  it('a tabela da spec fecha: 40 × +1 px = +40 (±1) e 1 × −40 px = −40 (±1)', () => {
    const { compensar, windows } = montar(PONTEIRO_DESTA_MAQUINA);

    for (let i = 0; i < 40; i += 1) compensar(1, 0);
    const ida = windows.x;
    compensar(-40, 0);
    const volta = windows.x - ida;

    assert.ok(Math.abs(ida - 40) <= 1, `ida: ${String(ida)}`);
    assert.ok(Math.abs(volta + 40) <= 1, `volta: ${String(volta)}`);
  });

  it('sem compensar, o mesmo Windows de mentira reproduz o defeito (prova de que o teste mede)', () => {
    const modelo = criarModeloDaAceleracao(PONTEIRO_DESTA_MAQUINA);
    assert.ok(modelo !== undefined);
    const windows = criarWindowsDeMentira(modelo);

    for (let i = 0; i < 40; i += 1) windows.mover(1, 0);
    const ida = windows.x;
    windows.mover(-40, 0);

    assert.ok(ida < 30, `ida crua: ${String(ida)}`);
    assert.ok(windows.x - ida < -50, `volta crua: ${String(windows.x - ida)}`);
  });

  it('mil pedidos variados, em diagonal: o erro acumulado fica abaixo de 1,5 px', () => {
    const { compensar, windows } = montar(PONTEIRO_DESTA_MAQUINA);
    let pedidoX = 0;
    let pedidoY = 0;
    // Sequência fixa (sem Math.random): o teste dá o mesmo resultado em toda execução.
    for (let i = 0; i < 1000; i += 1) {
      const dx = ((i * 37) % 23) - 11;
      const dy = ((i * 17) % 9) - 4;
      pedidoX += dx;
      pedidoY += dy;
      compensar(dx, dy);
      assert.ok(Math.abs(windows.x - pedidoX) <= 1.5, `x no passo ${String(i)}`);
      assert.ok(Math.abs(windows.y - pedidoY) <= 1.5, `y no passo ${String(i)}`);
    }
  });

  it('com a aceleração desligada e velocidade 10, manda exatamente o que recebeu', () => {
    const { compensar, enviados } = montar(PONTEIRO_NEUTRO);

    compensar(1, 0);
    compensar(-40, 3);
    compensar(7, -7);

    assert.deepEqual(enviados, [
      [1, 0],
      [-40, 3],
      [7, -7],
    ]);
  });

  it('reiniciar esquece a fração pendente', () => {
    const modelo = criarModeloDaAceleracao(PONTEIRO_DESTA_MAQUINA);
    assert.ok(modelo !== undefined);
    const compensador = criarCompensadorDaAceleracao(modelo);

    compensador.compensar(1, 0);
    compensador.reiniciar();

    assert.equal(compensador.compensar(0, 0), false);
    assert.deepEqual([...compensador.mickeys], [0, 0]);
  });
});

describe('resolverSaidaDoMouse', () => {
  const modelo = criarModeloDaAceleracao(PONTEIRO_DESTA_MAQUINA);

  it('auto: absoluto com aceleração, relativo sem ela e com velocidade 10', () => {
    assert.equal(resolverSaidaDoMouse('auto', PONTEIRO_DESTA_MAQUINA, modelo).efetivo, 'absoluto');
    assert.equal(resolverSaidaDoMouse('auto', PONTEIRO_NEUTRO, modelo).efetivo, 'relativo');
  });

  it('auto: velocidade fora do 10 também vai para o absoluto, mesmo sem aceleração', () => {
    const resolvida = resolverSaidaDoMouse('auto', { ...PONTEIRO_NEUTRO, velocidade: 6 }, modelo);
    assert.equal(resolvida.efetivo, 'absoluto');
    assert.match(resolvida.motivo, /6\/20/);
  });

  it('auto sem parâmetros: absoluto', () => {
    assert.equal(resolverSaidaDoMouse('auto', undefined, undefined).efetivo, 'absoluto');
  });

  it('pedido explícito não é discutido', () => {
    assert.equal(resolverSaidaDoMouse('relativo', PONTEIRO_DESTA_MAQUINA, modelo).efetivo, 'relativo');
    assert.equal(resolverSaidaDoMouse('absoluto', PONTEIRO_NEUTRO, modelo).efetivo, 'absoluto');
    assert.equal(resolverSaidaDoMouse('compensado', PONTEIRO_DESTA_MAQUINA, modelo).efetivo, 'compensado');
    assert.equal(resolverSaidaDoMouse('compensado', PONTEIRO_DESTA_MAQUINA, undefined).efetivo, 'absoluto');
  });

  it('o motivo do pedido explícito diz a chave, e não a variável de ambiente', () => {
    // O pedido pode ter vindo do controle.config.json: citar CONTROLE_SAIDA_MOUSE mandaria quem lê o
    // log procurar uma variável que não está definida.
    const relativo = resolverSaidaDoMouse('relativo', PONTEIRO_DESTA_MAQUINA, modelo).motivo;
    const absoluto = resolverSaidaDoMouse('absoluto', PONTEIRO_NEUTRO, modelo).motivo;

    assert.equal(relativo, 'pedido explícito (saidaMouse=relativo)');
    assert.equal(absoluto, 'pedido explícito (saidaMouse=absoluto)');
    assert.doesNotMatch(relativo, /CONTROLE_SAIDA_MOUSE/);
    assert.doesNotMatch(absoluto, /CONTROLE_SAIDA_MOUSE/);
  });

  it('a descrição junta o pedido, o estado da aceleração e se o relativo sai fiel', () => {
    const resolvida = resolverSaidaDoMouse('auto', PONTEIRO_DESTA_MAQUINA, modelo);
    assert.deepEqual(descreverSaidaDoMouse('auto', PONTEIRO_DESTA_MAQUINA, resolvida), {
      pedido: 'auto',
      efetivo: 'absoluto',
      aceleracao: 'ligada',
      velocidade: 11,
      relativoSaiFiel: false,
      motivo: resolvida.motivo,
    });
    assert.equal(relativoSaiFiel(PONTEIRO_NEUTRO), true);
    assert.equal(
      descreverSaidaDoMouse('auto', undefined, resolverSaidaDoMouse('auto', undefined, undefined))
        .aceleracao,
      'desconhecida',
    );
  });
});
