/**
 * Teste da escolha de backend por plataforma.
 *
 * Nenhum caso aqui cria o backend do Windows de verdade: ou a plataforma pedida não tem backend
 * (e o caso é a mensagem de erro), ou o teste injeta a `ApiDeEntradaDoWindows` de mentira. Assim
 * este arquivo continua rodando em qualquer sistema e sem tocar em `user32.dll`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PLATAFORMAS_SUPORTADAS,
  criarBackendDeEntrada,
  plataformaTemBackend,
} from './escolha.js';
import { ErroDeSaida } from './tipos.js';
import { TAMANHO_INPUT, TAMANHO_POINT } from './windows/constantes.js';

/** API de mentira mínima: nada aqui fala com o sistema. */
function apiDeMentira(): Parameters<typeof criarBackendDeEntrada>[0] {
  return {
    plataforma: 'win32',
    api: {
      quadro: Buffer.alloc(TAMANHO_INPUT),
      ponto: Buffer.alloc(TAMANHO_POINT),
      enviarUmaEntrada: () => 1,
      definirPosicaoDoCursor: () => true,
      lerPosicaoDoCursor: () => ({ x: 0, y: 0 }),
      lerCursorNoPonto: () => true,
      metricaDoSistema: () => 1024,
      lerParametrosDoPonteiro: () => undefined,
      ativarDpiPorMonitor: () => true,
      ultimoErro: () => 0,
    },
    registrarSaidaDoProcesso: () => () => undefined,
  };
}

describe('plataformaTemBackend', () => {
  it('hoje só o Windows tem backend', () => {
    assert.equal(plataformaTemBackend('win32'), true);
    assert.equal(plataformaTemBackend('linux'), false);
    assert.equal(plataformaTemBackend('darwin'), false);
    assert.deepEqual(PLATAFORMAS_SUPORTADAS, ['win32']);
  });
});

describe('criarBackendDeEntrada', () => {
  it('devolve o backend do Windows quando a plataforma é win32', () => {
    const backend = criarBackendDeEntrada(apiDeMentira());

    assert.equal(backend.nome, 'windows');
    assert.equal(backend.pressionados(), 0);
  });

  it('repassa a saída do mouse pedida ao backend do Windows (ATI-026)', () => {
    const relativo = criarBackendDeEntrada(apiDeMentira());
    const absoluto = criarBackendDeEntrada({ ...apiDeMentira(), saidaDoMouse: 'absoluto' });

    assert.equal(relativo.saidaDoMouse?.efetivo, 'relativo');
    assert.equal(absoluto.saidaDoMouse?.efetivo, 'absoluto');
  });

  it('recusa sistema sem backend com mensagem que diz o sistema e o caminho', () => {
    // Silêncio seria pior: um servidor que sobe e não move o cursor é bem mais difícil de
    // diagnosticar do que um que recusa a subir dizendo o porquê.
    assert.throws(
      () => criarBackendDeEntrada({ plataforma: 'linux' }),
      (erro: unknown) => {
        assert.ok(erro instanceof ErroDeSaida);
        assert.match(erro.message, /linux/);
        assert.match(erro.message, /win32/);
        assert.match(erro.message, /ARQUITETURA\.md/);
        return true;
      },
    );
  });

  it('nada é injetado quando a plataforma não tem backend', () => {
    let criou = false;
    try {
      criarBackendDeEntrada({
        plataforma: 'darwin',
        registrarSaidaDoProcesso: () => {
          criou = true;
          return () => undefined;
        },
      });
    } catch {
      // esperado
    }
    assert.equal(criou, false);
  });
});
