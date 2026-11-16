/**
 * Teste do destino de ensaio — o dublê de **produção** do pipeline.
 *
 * Ele é o padrão da configuração (`CONTROLE_MOVIMENTO=ensaio`), então o que ele mede é o que
 * aparece no log de fim de sessão de quem está com o celular na mão. Medida errada aqui é pior do
 * que medida nenhuma: levaria a ajustar sensibilidade contra um número inventado.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { criarDestinoDeEnsaio } from './ensaio.js';

describe('destino de ensaio', () => {
  it('soma o que foi pedido, por eixo, com sinal', () => {
    const ensaio = criarDestinoDeEnsaio();

    ensaio.moverMouseRelativo(10, -4);
    ensaio.moverMouseRelativo(-3, -1);

    assert.equal(ensaio.nome, 'ensaio');
    assert.equal(ensaio.chamadas, 2);
    assert.equal(ensaio.pixelsX, 7);
    assert.equal(ensaio.pixelsY, -5);
  });

  it('guarda o maior pulo de uma amostra, em módulo', () => {
    const ensaio = criarDestinoDeEnsaio();

    ensaio.moverMouseRelativo(3, -40);
    ensaio.moverMouseRelativo(-17, 2);

    assert.equal(ensaio.maiorPuloX, 17);
    assert.equal(ensaio.maiorPuloY, 40);
  });

  it('pedido não finito é recusado e contado, nunca somado', () => {
    const ensaio = criarDestinoDeEnsaio();

    ensaio.moverMouseRelativo(Number.NaN, 5);
    ensaio.moverMouseRelativo(1, Number.POSITIVE_INFINITY);

    assert.equal(ensaio.pedidosInvalidos, 2);
    assert.equal(ensaio.chamadas, 0);
    assert.equal(ensaio.pixelsX, 0);
    assert.equal(ensaio.pixelsY, 0);
  });

  it('zerar apaga tudo, e o resumo cabe numa linha de log', () => {
    const ensaio = criarDestinoDeEnsaio();
    ensaio.moverMouseRelativo(5, 5);

    assert.match(ensaio.resumir(), /chamadas=1 pixelsX=5 pixelsY=5 maiorPulo=5\/5/);

    ensaio.zerar();

    assert.equal(ensaio.chamadas, 0);
    assert.equal(ensaio.pixelsX, 0);
    assert.equal(ensaio.maiorPuloY, 0);
    assert.equal(ensaio.pedidosInvalidos, 0);
  });

  it('não aloca por chamada', () => {
    const chamadas = 200_000;
    const ensaio = criarDestinoDeEnsaio();
    for (let indice = 0; indice < 10_000; indice += 1) ensaio.moverMouseRelativo(1, -1);

    const antes = process.memoryUsage().heapUsed;
    for (let indice = 0; indice < chamadas; indice += 1) ensaio.moverMouseRelativo(1, -1);
    const depois = process.memoryUsage().heapUsed;

    assert.ok(
      (depois - antes) / chamadas < 1,
      `heap cresceu ${String(depois - antes)} bytes em ${String(chamadas)} chamadas`,
    );
  });
});
