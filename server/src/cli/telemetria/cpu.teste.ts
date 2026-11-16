/** CPU do processo: janela de 1 s, média desde a partida e nada de por cento negativo. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JANELA_DE_CPU_MS, criarMedidorDeCpu, type TempoDeCpu } from './cpu.js';

/** Leitura de CPU controlada pelo teste: o valor muda quando o teste mandar, não sozinho. */
function cpuControlada(inicial: TempoDeCpu = { user: 0, system: 0 }) {
  let atual = inicial;
  return {
    ler: () => atual,
    definir(user: number, system: number) {
      atual = { user, system };
    },
  };
}

describe('criarMedidorDeCpu', () => {
  it('não publica janela antes de ela fechar, mas a média já vale', () => {
    const cpu = cpuControlada();
    const medidor = criarMedidorDeCpu({ lerCpu: cpu.ler, inicioMs: 0 });

    // 5 ms de CPU em 500 ms = 1 % de média; a janela de 1 s ainda não venceu.
    cpu.definir(5_000, 0);
    medidor.atualizar(JANELA_DE_CPU_MS / 2);

    assert.equal(medidor.janela, 0);
    assert.equal(medidor.media, 1);
  });

  it('soma user e system e divide pelo tempo decorrido de verdade', () => {
    const cpu = cpuControlada();
    const medidor = criarMedidorDeCpu({ lerCpu: cpu.ler, inicioMs: 0 });

    // 50 ms de CPU (30 user + 20 system, em microssegundos) num segundo = 5 %.
    cpu.definir(30_000, 20_000);
    medidor.atualizar(1000);

    assert.equal(medidor.janela, 5);
    assert.equal(medidor.media, 5);
  });

  it('repete o valor da janela entre fechamentos, para o número não tremer na tela', () => {
    const cpu = cpuControlada();
    const medidor = criarMedidorDeCpu({ lerCpu: cpu.ler, inicioMs: 0 });

    cpu.definir(10_000, 0);
    medidor.atualizar(1000);
    assert.equal(medidor.janela, 1);

    // Segundo seguinte inteiro sem gastar CPU: a janela só troca quando ela fecha.
    medidor.atualizar(1100);
    medidor.atualizar(1900);
    assert.equal(medidor.janela, 1);
    medidor.atualizar(2000);
    assert.equal(medidor.janela, 0);
  });

  it('a média dilui o degrau da contabilidade do Windows', () => {
    const cpu = cpuControlada();
    const medidor = criarMedidorDeCpu({ lerCpu: cpu.ler, inicioMs: 0 });

    // Nove segundos lidos como zero e um segundo com o degrau de 15,6 ms de uma vez.
    for (let segundo = 1; segundo <= 9; segundo += 1) medidor.atualizar(segundo * 1000);
    cpu.definir(15_600, 0);
    medidor.atualizar(10_000);

    // A janela vê 1,56 %; a média vê 0,156 % — que é o gasto de verdade.
    assert.equal(Number(medidor.janela.toFixed(2)), 1.56);
    assert.equal(Number(medidor.media.toFixed(3)), 0.156);
  });

  it('leitura que anda para trás não vira por cento negativo', () => {
    const cpu = cpuControlada({ user: 50_000, system: 0 });
    const medidor = criarMedidorDeCpu({ lerCpu: cpu.ler, inicioMs: 0 });

    cpu.definir(0, 0);
    medidor.atualizar(1000);

    assert.equal(medidor.janela, 0);
    assert.equal(medidor.media, 0);
  });
});
