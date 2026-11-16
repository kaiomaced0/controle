/**
 * Teste da tabela de eixos (etapa 2 da cadeia).
 *
 * A tabela é derivação em papel, não medição — nenhum aparelho confirmou os sinais nesta máquina
 * (ATI-024 impede o build Android). O que estes testes seguram é a **coerência**: que o eixo
 * ignorado de cada pegada não mexe no cursor, que cada orientação usa um eixo por direção e que
 * nenhum coeficiente vira outro número por acidente numa edição futura — por isso cada pegada tem o
 * próprio teste com os seis coeficientes, sinal incluído. Se o sinal está certo **na mão**, só a
 * bancada com o aparelho confirma.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAPAS_DE_EIXOS, mapaDeEixos } from './eixos.js';
import { ORIENTACOES, ehOrientacao } from './tipos.js';

describe('mapaDeEixos', () => {
  it('retrato: horizontal vem de −gy e vertical de −gx', () => {
    const mapa = mapaDeEixos('retrato');

    assert.equal(mapa.horizontalDeGy, -1);
    assert.equal(mapa.horizontalDeGx, 0);
    assert.equal(mapa.verticalDeGx, -1);
    assert.equal(mapa.verticalDeGy, 0);
  });

  it('paisagem: os papéis trocam — horizontal vem de −gx e vertical de +gy', () => {
    const mapa = mapaDeEixos('paisagem');

    assert.equal(mapa.horizontalDeGx, -1);
    assert.equal(mapa.horizontalDeGy, 0);
    assert.equal(mapa.verticalDeGy, 1);
    assert.equal(mapa.verticalDeGx, 0);
  });

  it('apontador: quem aponta para os lados move o cursor, e o pulso não', () => {
    // A pegada que o Kaio pediu: aparelho deitado, tela para cima, topo apontando para a tela.
    // O vertical do mundo passa a ser o `z` do aparelho, então é `gz` que vira horizontal.
    const mapa = mapaDeEixos('apontador');

    // Apontar para a direita é sentido horário visto de cima: `gz < 0` tem de dar cursor para
    // a direita, ou seja peso negativo.
    assert.equal(mapa.horizontalDeGz, -1, 'apontar para os lados move na horizontal');
    assert.equal(mapa.verticalDeGx, -1, 'levantar o nariz do aparelho sobe o cursor');

    // E o gesto que NÃO pode mover nada: torcer o pulso (roll em torno de `y`, o eixo que aponta).
    assert.equal(mapa.horizontalDeGy, 0, 'torcer o pulso não move na horizontal');
    assert.equal(mapa.verticalDeGy, 0, 'torcer o pulso não move na vertical');

    // O contraste com `retrato` é exatamente o defeito sentido na mão: lá, quem move na
    // horizontal é `gy` — que nesta pegada é o pulso.
    assert.equal(mapaDeEixos('retrato').horizontalDeGy, -1);
    assert.equal(mapaDeEixos('retrato').horizontalDeGz, 0);
  });

  it('apontador-torcao: apontar move na horizontal, torcer (+gy) desce o cursor, inclinar não move', () => {
    // A pegada deitada com o vertical na torção do antebraço (ATI-032, item 5). Os seis
    // coeficientes um por um: os testes genéricos aceitariam `verticalDeGy: -1` sem falhar, e o
    // sinal é a única coisa que separa "torcer para a direita desce" de "torcer para a direita sobe".
    assert.deepEqual(
      { ...mapaDeEixos('apontador-torcao') },
      {
        horizontalDeGx: 0,
        horizontalDeGy: 0,
        horizontalDeGz: -1,
        verticalDeGx: 0,
        verticalDeGy: 1,
        verticalDeGz: 0,
      },
    );

    // O horizontal é o mesmo do `apontador`; só o vertical troca de eixo.
    assert.equal(mapaDeEixos('apontador-torcao').horizontalDeGz, mapaDeEixos('apontador').horizontalDeGz);
    assert.equal(mapaDeEixos('apontador').verticalDeGy, 0, 'no apontador a torção não move');
    assert.equal(mapaDeEixos('apontador-torcao').verticalDeGx, 0, 'na torção a inclinação não move');
  });

  it('o eixo ignorado da pegada não entra — e qual é depende da pegada', () => {
    // Nas três primeiras pegadas o ignorado é o roll, o giro em torno do eixo que **aponta**:
    // torcer não muda a mira. Com a tela virada para a pessoa quem aponta é `−z`, logo o roll é
    // `gz`; deitado apontando para a tela (`apontador`), quem aponta é `+y`, e o roll passa a ser
    // `gy`. Na `apontador-torcao` o roll vira o vertical de propósito, e quem sai de cena é a
    // inclinação (`gx`). Fixar "gz nunca entra" seria fixar a pegada, não a regra.
    const EIXO_IGNORADO: Readonly<Record<(typeof ORIENTACOES)[number], 'Gx' | 'Gy' | 'Gz'>> = {
      retrato: 'Gz',
      paisagem: 'Gz',
      apontador: 'Gy',
      'apontador-torcao': 'Gx',
    };

    for (const orientacao of ORIENTACOES) {
      const mapa = mapaDeEixos(orientacao);
      const ignorado = EIXO_IGNORADO[orientacao];
      assert.equal(mapa[`horizontalDe${ignorado}`], 0, `${orientacao}: horizontal usa ${ignorado}`);
      assert.equal(mapa[`verticalDe${ignorado}`], 0, `${orientacao}: vertical usa ${ignorado}`);
    }
  });

  it('cada orientação usa um eixo do sensor por direção, e nunca o mesmo nas duas', () => {
    for (const orientacao of ORIENTACOES) {
      const mapa = mapaDeEixos(orientacao);
      const horizontais = [mapa.horizontalDeGx, mapa.horizontalDeGy, mapa.horizontalDeGz];
      const verticais = [mapa.verticalDeGx, mapa.verticalDeGy, mapa.verticalDeGz];

      assert.equal(horizontais.filter((peso) => peso !== 0).length, 1, orientacao);
      assert.equal(verticais.filter((peso) => peso !== 0).length, 1, orientacao);
      // Se o mesmo eixo alimentasse os dois, todo movimento sairia na diagonal.
      for (let indice = 0; indice < 3; indice += 1) {
        assert.ok(
          horizontais[indice] === 0 || verticais[indice] === 0,
          `${orientacao}: o eixo ${indice} alimenta as duas direções`,
        );
      }
      // Coeficiente é sempre ±1: escala é assunto da etapa 5.
      for (const peso of [...horizontais, ...verticais]) {
        assert.ok(peso === 0 || peso === 1 || peso === -1, `${orientacao}: peso ${peso}`);
      }
    }
  });

  it('os mapas são congelados', () => {
    assert.ok(Object.isFrozen(MAPAS_DE_EIXOS));
    for (const orientacao of ORIENTACOES) {
      assert.ok(Object.isFrozen(MAPAS_DE_EIXOS[orientacao]), orientacao);
    }
  });
});

describe('ehOrientacao', () => {
  it('aceita as quatro pegadas e recusa o resto', () => {
    assert.equal(ehOrientacao('retrato'), true);
    assert.equal(ehOrientacao('paisagem'), true);
    assert.equal(ehOrientacao('apontador'), true);
    assert.equal(ehOrientacao('apontador-torcao'), true);
    assert.deepEqual([...ORIENTACOES], ['retrato', 'paisagem', 'apontador', 'apontador-torcao']);

    assert.equal(ehOrientacao('mundo'), false);
    // A grafia é exata: maiúscula e espaço quem resolve é a configuração, antes de perguntar aqui.
    assert.equal(ehOrientacao('apontador_torcao'), false);
    assert.equal(ehOrientacao('Apontador'), false);
    assert.equal(ehOrientacao(undefined), false);
    assert.equal(ehOrientacao(1), false);
  });

  it('toda orientação tem mapa, e todo mapa é de uma orientação', () => {
    assert.deepEqual(Object.keys(MAPAS_DE_EIXOS), [...ORIENTACOES]);
  });
});
