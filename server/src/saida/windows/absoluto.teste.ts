/**
 * A régua da saída absoluta (ATI-026): pixel → coordenada normalizada → pixel tem de voltar ao
 * **mesmo** pixel, em toda a extensão. Se um único pixel não fechar, o pedido de +1 px que cai nele
 * volta para o pixel de origem — e o cursor trava ali.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { daCoordenadaNormalizada, paraCoordenadaNormalizada } from './absoluto.js';
import { MAIOR_COORDENADA_ABSOLUTA } from './constantes.js';

describe('paraCoordenadaNormalizada × daCoordenadaNormalizada', () => {
  // 1920 e 1080: o primário desta máquina. 3000 e 1920: a área virtual com o monitor em retrato.
  // 7680: três 4K lado a lado. 1 e 2: o degenerado.
  for (const extensao of [1, 2, 1080, 1920, 3000, 7680]) {
    it(`todo pixel de 0 a ${String(extensao - 1)} volta a si mesmo`, () => {
      for (let pixel = 0; pixel < extensao; pixel += 1) {
        const normalizado = paraCoordenadaNormalizada(pixel, extensao);
        assert.ok(normalizado >= 0 && normalizado <= MAIOR_COORDENADA_ABSOLUTA);
        assert.equal(daCoordenadaNormalizada(normalizado, extensao), pixel, `pixel ${String(pixel)}`);
      }
    });
  }

  it('toda largura de 1 a 7680: todo pixel volta a si mesmo', () => {
    // A área virtual pode ter qualquer largura (1920 + 1080 = 3000 aqui; 3840 + 1080 noutro PC).
    // ~29,5 milhões de pares: o assert fica fora do laço, senão o teste levaria segundos.
    let conferidos = 0;
    let primeiraFalha: string | undefined;
    for (let extensao = 1; extensao <= 7680 && primeiraFalha === undefined; extensao += 1) {
      for (let pixel = 0; pixel < extensao; pixel += 1) {
        const normalizado = paraCoordenadaNormalizada(pixel, extensao);
        if (
          normalizado < 0 ||
          normalizado > MAIOR_COORDENADA_ABSOLUTA ||
          daCoordenadaNormalizada(normalizado, extensao) !== pixel
        ) {
          primeiraFalha = `largura ${String(extensao)}, pixel ${String(pixel)} → ${String(normalizado)}`;
          break;
        }
        conferidos += 1;
      }
    }
    assert.equal(primeiraFalha, undefined);
    assert.equal(conferidos, (7680 * 7681) / 2);
  });

  it('fora da área encosta na borda, sem estourar a faixa de 0 a 65535', () => {
    assert.equal(paraCoordenadaNormalizada(-5, 1920), 0);
    assert.equal(daCoordenadaNormalizada(paraCoordenadaNormalizada(5000, 1920), 1920), 1919);
    assert.ok(paraCoordenadaNormalizada(1e9, 1920) <= MAIOR_COORDENADA_ABSOLUTA);
  });

  it('é monotônica: pixel maior nunca vira coordenada menor', () => {
    let anterior = -1;
    for (let pixel = 0; pixel < 3000; pixel += 1) {
      const normalizado = paraCoordenadaNormalizada(pixel, 3000);
      assert.ok(normalizado > anterior);
      anterior = normalizado;
    }
  });
});
