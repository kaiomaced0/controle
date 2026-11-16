/**
 * Teste do disparo de vibração pelo PC (ATI-025).
 *
 * O que importa aqui é que os bytes que saem sejam **exatamente** os do PROTOCOLO.md, seções 5.1
 * e 5.2 — quem está do outro lado é um motor de verdade, e byte trocado vira "apertei e não
 * vibrou", que é indistinguível de cabo ruim.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PADROES_HAPTICOS,
  TAMANHO_HAPTICO,
  TAMANHO_RUMBLE,
  TIPO_HAPTICO,
  TIPO_RUMBLE,
  criarCodificador,
  criarDecodificador,
} from '../protocolo/indice.js';
import type { SessaoDeTransporte } from '../transporte/indice.js';
import { INTENSIDADE_PADRAO, RUMBLE_PADRAO, enviarHaptico, enviarRumble } from './vibracao.js';

interface SessaoDeMentira {
  readonly sessao: SessaoDeTransporte;
  readonly enviados: Uint8Array[];
}

/** Sessão que só guarda o que foi enviado — nada de socket no teste de unidade. */
function criarSessaoDeMentira(aberta = true): SessaoDeMentira {
  const enviados: Uint8Array[] = [];
  const sessao = {
    id: 's-teste',
    estado: 'ativa',
    aparelho: undefined,
    noDelayAplicado: true,
    instantaneo: () => {
      throw new Error('não usado neste teste');
    },
    enviarTexto: () => aberta,
    enviarBinario: (pacote: Uint8Array) => {
      if (!aberta) return false;
      // Cópia aqui de propósito: se `vibracao.ts` deixasse de copiar, o teste veria o buffer
      // reaproveitado mudar debaixo dele — e é justamente esse defeito que se quer pegar.
      enviados.push(pacote.slice());
      return true;
    },
    encerrar: () => undefined,
  } as unknown as SessaoDeTransporte;

  return { sessao, enviados };
}

describe('enviarHaptico', () => {
  it('manda os 4 bytes do HÁPTICO com o padrão e a intensidade pedidos', () => {
    const { sessao, enviados } = criarSessaoDeMentira();

    assert.equal(enviarHaptico(sessao, 'sucesso'), true);

    const pacote = enviados[0];
    assert.ok(pacote !== undefined);
    assert.equal(pacote.byteLength, TAMANHO_HAPTICO);

    const decodificador = criarDecodificador();
    decodificador.decodificar(pacote);
    assert.equal(decodificador.saida.tipo, TIPO_HAPTICO);
    assert.equal(decodificador.saida.padrao, PADROES_HAPTICOS.sucesso);
    assert.equal(decodificador.saida.intensidade, INTENSIDADE_PADRAO);
  });

  it('sai igual ao codificador de referência, byte a byte', () => {
    const { sessao, enviados } = criarSessaoDeMentira();
    const referencia = criarCodificador().haptico(PADROES_HAPTICOS.click, INTENSIDADE_PADRAO);

    enviarHaptico(sessao, 'click');

    assert.deepEqual(enviados[0], referencia.slice());
  });

  it('sem sessão (ou com o socket fechado) devolve false em vez de estourar', () => {
    const fechada = criarSessaoDeMentira(false);

    assert.equal(enviarHaptico(undefined, 'click'), false);
    assert.equal(enviarHaptico(fechada.sessao, 'click'), false);
    assert.equal(fechada.enviados.length, 0);
  });
});

describe('enviarRumble', () => {
  it('manda os 8 bytes do RUMBLE com os dois motores e a duração', () => {
    const { sessao, enviados } = criarSessaoDeMentira();

    assert.equal(enviarRumble(sessao), true);

    const pacote = enviados[0];
    assert.ok(pacote !== undefined);
    assert.equal(pacote.byteLength, TAMANHO_RUMBLE);

    const decodificador = criarDecodificador();
    decodificador.decodificar(pacote);
    assert.equal(decodificador.saida.tipo, TIPO_RUMBLE);
    assert.equal(decodificador.saida.motorForte, RUMBLE_PADRAO.motorForte);
    assert.equal(decodificador.saida.motorFraco, RUMBLE_PADRAO.motorFraco);
    assert.equal(decodificador.saida.duracaoMs, RUMBLE_PADRAO.duracaoMs);
  });

  it('cada envio carrega os próprios valores, sem sobra do anterior', () => {
    const { sessao, enviados } = criarSessaoDeMentira();

    enviarRumble(sessao, 10, 20, 30);
    enviarRumble(sessao, 200, 100, 500);

    const decodificador = criarDecodificador();
    const primeiro = enviados[0];
    const segundo = enviados[1];
    assert.ok(primeiro !== undefined && segundo !== undefined);

    decodificador.decodificar(primeiro);
    assert.equal(decodificador.saida.motorForte, 10);
    assert.equal(decodificador.saida.duracaoMs, 30);

    decodificador.decodificar(segundo);
    assert.equal(decodificador.saida.motorForte, 200);
    assert.equal(decodificador.saida.duracaoMs, 500);
  });

  it('sem sessão devolve false', () => {
    assert.equal(enviarRumble(undefined), false);
  });
});
