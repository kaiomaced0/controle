/**
 * Teste do comando "centralizar" (ADR-7).
 *
 * É o botão que existe porque o giroscópio é relativo: depois de girar bastante, a mão está numa
 * posição confortável e o cursor está no canto. Centralizar reconcilia os dois.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { centralizarCursor } from './centralizar.js';
import { criarBackendDubla } from './dubla.js';

describe('centralizarCursor', () => {
  it('leva o cursor ao meio da tela e devolve o ponto usado', () => {
    const dubla = criarBackendDubla({
      tela: { largura: 2560, altura: 1440 },
      posicaoInicial: { x: 0, y: 0 },
    });

    const centro = centralizarCursor(dubla);

    assert.deepEqual(centro, { x: 1280, y: 720 });
    assert.deepEqual(dubla.lerPosicaoDoMouse(), { x: 1280, y: 720 });
    assert.deepEqual(dubla.eventos, [{ tipo: 'posicionar', x: 1280, y: 720 }]);
  });

  it('arredonda para baixo em tela de dimensão ímpar', () => {
    const dubla = criarBackendDubla({ tela: { largura: 1365, altura: 767 } });

    assert.deepEqual(centralizarCursor(dubla), { x: 682, y: 383 });
  });

  it('sem resolução conhecida não move nada — chute jogaria o cursor no quadrante errado', () => {
    const dubla = criarBackendDubla({ semTela: true, posicaoInicial: { x: 7, y: 9 } });

    assert.equal(centralizarCursor(dubla), undefined);
    assert.equal(dubla.eventos.length, 0);
    assert.deepEqual(dubla.lerPosicaoDoMouse(), { x: 7, y: 9 });
  });

  it('posicionamento recusado: o pedido saiu, o cursor não andou, e o erro está no contador', () => {
    const dubla = criarBackendDubla({
      tela: { largura: 1920, altura: 1080 },
      posicaoInicial: { x: 7, y: 9 },
    });
    dubla.recusarProximosPosicionamentos(1);

    // `centralizarCursor` devolve o ponto que **pediu**, não o que o sistema aceitou: ele é regra,
    // não injeção. Quem quer saber se o cursor andou lê `chamadasComErro` — que é como o UIPI
    // aparece nesta camada, em vez de sumir.
    assert.deepEqual(centralizarCursor(dubla), { x: 960, y: 540 });
    assert.deepEqual(dubla.eventos, [{ tipo: 'posicionar', x: 960, y: 540 }]);
    assert.deepEqual(dubla.lerPosicaoDoMouse(), { x: 7, y: 9 });
    assert.equal(dubla.contadores.chamadasComErro, 1);
  });
});
