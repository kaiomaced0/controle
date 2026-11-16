/**
 * Teste do gatilho de vibração pelo teclado (ATI-025).
 *
 * Duas coisas se provam aqui, e as duas são de encerramento tanto quanto de função:
 * a tecla vira o pacote certo, e o ouvinte de `stdin` **sai** quando mandam sair — ouvinte
 * esquecido segura o event loop e o processo não volta do Ctrl+C.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { criarRegistrador } from '../log.js';
import {
  PADROES_HAPTICOS,
  TIPO_HAPTICO,
  TIPO_RUMBLE,
  criarDecodificador,
} from '../protocolo/indice.js';
import type { SessaoDeTransporte } from '../transporte/indice.js';
import {
  TECLA_HAPTICO,
  TECLA_RUMBLE,
  descreverTeclas,
  ligarTecladoDeVibracao,
  tratarTecla,
} from './teclado.js';

const registradorMudo = criarRegistrador('erro', 'teste', () => {
  // De propósito vazio.
});

function criarSessaoDeMentira(): { sessao: SessaoDeTransporte; enviados: Uint8Array[] } {
  const enviados: Uint8Array[] = [];
  const sessao = {
    id: 's-teste',
    estado: 'ativa',
    enviarTexto: () => true,
    enviarBinario: (pacote: Uint8Array) => {
      enviados.push(pacote.slice());
      return true;
    },
    encerrar: () => undefined,
  } as unknown as SessaoDeTransporte;
  return { sessao, enviados };
}

/** `stdin` de mentira: emite dados como um terminal, sem precisar de terminal. */
function criarEntradaDeMentira(): NodeJS.ReadStream & { pausada: boolean } {
  const emissor = new EventEmitter() as unknown as NodeJS.ReadStream & { pausada: boolean };
  const alvo = emissor as unknown as { isTTY: boolean; pausada: boolean; setEncoding: () => void; pause: () => void };
  alvo.isTTY = true;
  alvo.pausada = false;
  alvo.setEncoding = () => undefined;
  alvo.pause = () => {
    alvo.pausada = true;
  };
  return emissor;
}

describe('tratarTecla', () => {
  it('a tecla do háptico manda um HÁPTICO click', () => {
    const { sessao, enviados } = criarSessaoDeMentira();

    assert.equal(tratarTecla(TECLA_HAPTICO, { sessaoAtual: () => sessao, registrador: registradorMudo }), true);

    const decodificador = criarDecodificador();
    const pacote = enviados[0];
    assert.ok(pacote !== undefined);
    decodificador.decodificar(pacote);
    assert.equal(decodificador.saida.tipo, TIPO_HAPTICO);
    assert.equal(decodificador.saida.padrao, PADROES_HAPTICOS.click);
  });

  it('a tecla do rumble manda um RUMBLE', () => {
    const { sessao, enviados } = criarSessaoDeMentira();

    tratarTecla(TECLA_RUMBLE, { sessaoAtual: () => sessao, registrador: registradorMudo });

    const decodificador = criarDecodificador();
    const pacote = enviados[0];
    assert.ok(pacote !== undefined);
    decodificador.decodificar(pacote);
    assert.equal(decodificador.saida.tipo, TIPO_RUMBLE);
  });

  it('as teclas 1 a 5 são os cinco padrões da seção 5.2, na ordem', () => {
    const { sessao, enviados } = criarSessaoDeMentira();
    const opcoes = { sessaoAtual: () => sessao, registrador: registradorMudo };

    for (const tecla of ['1', '2', '3', '4', '5']) tratarTecla(tecla, opcoes);

    const decodificador = criarDecodificador();
    const esperados = Object.values(PADROES_HAPTICOS);
    assert.equal(enviados.length, esperados.length);
    enviados.forEach((pacote, indice) => {
      decodificador.decodificar(pacote);
      assert.equal(decodificador.saida.padrao, esperados[indice]);
    });
  });

  it('tecla sem comando (inclusive Enter) não manda nada', () => {
    const { sessao, enviados } = criarSessaoDeMentira();
    const opcoes = { sessaoAtual: () => sessao, registrador: registradorMudo };

    for (const tecla of ['\n', '\r', 'x', '9', '0', ' ']) {
      assert.equal(tratarTecla(tecla, opcoes), false);
    }
    assert.equal(enviados.length, 0);
  });

  it('sem aparelho conectado devolve false, sem estourar', () => {
    assert.equal(
      tratarTecla(TECLA_HAPTICO, { sessaoAtual: () => undefined, registrador: registradorMudo }),
      false,
    );
  });

  it('a ajuda cita as teclas que existem de verdade', () => {
    const ajuda = descreverTeclas();

    assert.match(ajuda, new RegExp(`${TECLA_HAPTICO}=háptico`));
    assert.match(ajuda, new RegExp(`${TECLA_RUMBLE}=rumble`));
    for (const nome of Object.keys(PADROES_HAPTICOS)) assert.ok(ajuda.includes(nome));
  });
});

describe('ligarTecladoDeVibracao', () => {
  it('lê o que foi digitado e para de ler quando desligam', () => {
    const { sessao, enviados } = criarSessaoDeMentira();
    const entrada = criarEntradaDeMentira();

    const desligar = ligarTecladoDeVibracao({
      sessaoAtual: () => sessao,
      registrador: registradorMudo,
      entrada,
    });

    entrada.emit('data', `${TECLA_HAPTICO}\n`);
    assert.equal(enviados.length, 1);

    desligar();
    entrada.emit('data', `${TECLA_HAPTICO}\n`);

    assert.equal(enviados.length, 1, 'depois de desligado não pode mais enviar');
    assert.equal(entrada.pausada, true, 'stdin precisa ficar pausado, senão o processo não sai');
  });

  it('desligar duas vezes não faz nada na segunda', () => {
    const { sessao } = criarSessaoDeMentira();
    const entrada = criarEntradaDeMentira();
    const desligar = ligarTecladoDeVibracao({
      sessaoAtual: () => sessao,
      registrador: registradorMudo,
      entrada,
    });

    desligar();
    assert.doesNotThrow(() => {
      desligar();
    });
  });

  it('com a entrada encanada (sem terminal) nem chega a assinar nada', () => {
    const { sessao, enviados } = criarSessaoDeMentira();
    const entrada = criarEntradaDeMentira();
    (entrada as unknown as { isTTY: boolean }).isTTY = false;

    const desligar = ligarTecladoDeVibracao({
      sessaoAtual: () => sessao,
      registrador: registradorMudo,
      entrada,
    });
    entrada.emit('data', TECLA_HAPTICO);
    desligar();

    assert.equal(enviados.length, 0);
  });
});
