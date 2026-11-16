/**
 * Os textos da saída do mouse (ATI-026): o aviso do log de partida e a linha do painel. O critério de
 * aceite é "avisar quando a aceleração está ligada, com uma linha que explica o efeito — nunca em
 * silêncio", e o texto é o que a pessoa lê: por isso ele é afirmado aqui.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  COMO_DESLIGAR_A_ACELERACAO,
  MODOS_DE_SAIDA_DO_MOUSE,
  avisoDaSaidaDoMouse,
  ehModoDeSaidaDoMouse,
  resumirSaidaDoMouse,
  type DescricaoDaSaidaDoMouse,
} from './saida-do-mouse.js';

function descricao(parciais: Partial<DescricaoDaSaidaDoMouse> = {}): DescricaoDaSaidaDoMouse {
  return {
    pedido: 'auto',
    efetivo: 'absoluto',
    aceleracao: 'ligada',
    velocidade: 11,
    relativoSaiFiel: false,
    motivo: 'auto: aceleração de ponteiro ligada',
    ...parciais,
  };
}

describe('ehModoDeSaidaDoMouse', () => {
  it('aceita os três da configuração e recusa o de bancada e o resto', () => {
    assert.deepEqual([...MODOS_DE_SAIDA_DO_MOUSE], ['auto', 'absoluto', 'relativo']);
    for (const modo of MODOS_DE_SAIDA_DO_MOUSE) assert.equal(ehModoDeSaidaDoMouse(modo), true);
    assert.equal(ehModoDeSaidaDoMouse('compensado'), false);
    assert.equal(ehModoDeSaidaDoMouse('absolute'), false);
    assert.equal(ehModoDeSaidaDoMouse(undefined), false);
  });
});

describe('avisoDaSaidaDoMouse', () => {
  it('com a aceleração ligada: diz o efeito, a saída escolhida, que nada é alterado e como desligar', () => {
    const aviso = avisoDaSaidaDoMouse(descricao()) ?? '';

    assert.match(aviso, /aceleração de ponteiro do Windows está LIGADA/);
    assert.match(aviso, /gesto lento encolhe e gesto rápido estica/);
    assert.match(aviso, /saída do mouse ABSOLUTA/);
    // Os números de exemplo são da bancada do projeto: o texto tem de dizer de onde vieram, e não
    // afirmar "medido" sobre o PC onde aparece.
    assert.match(aviso, /na bancada do projeto, com velocidade 11\/20 e 96 DPI/);
    assert.doesNotMatch(aviso, /\(medido:/);
    assert.match(aviso, /não altera a configuração do sistema/);
    assert.ok(aviso.includes(COMO_DESLIGAR_A_ACELERACAO));
    assert.match(COMO_DESLIGAR_A_ACELERACAO, /Aumentar a precisão do ponteiro/);
    assert.match(COMO_DESLIGAR_A_ACELERACAO, /Enhance pointer precision/);
  });

  it('relativo pedido com a aceleração ligada: avisa que o cursor anda distorcido', () => {
    const aviso = avisoDaSaidaDoMouse(descricao({ pedido: 'relativo', efetivo: 'relativo' })) ?? '';

    assert.match(aviso, /saída do mouse RELATIVA/);
    assert.match(aviso, /anda distorcido/);
    assert.match(aviso, /CONTROLE_SAIDA_MOUSE=auto/);
  });

  it('velocidade fora do 10 sem aceleração: avisa a multiplicação, sem o caminho de desligar', () => {
    const aviso =
      avisoDaSaidaDoMouse(descricao({ aceleracao: 'desligada', velocidade: 14 })) ?? '';

    assert.match(aviso, /velocidade do ponteiro do Windows está em 14\/20/);
    assert.ok(!aviso.includes(COMO_DESLIGAR_A_ACELERACAO));
  });

  it('configuração ilegível também é dita', () => {
    const aviso =
      avisoDaSaidaDoMouse(
        descricao({ aceleracao: 'desconhecida', velocidade: undefined, relativoSaiFiel: undefined }),
      ) ?? '';

    assert.match(aviso, /não consegui ler a configuração de ponteiro/);
  });

  it('relativo fiel (aceleração desligada, velocidade 10): nada a avisar', () => {
    assert.equal(
      avisoDaSaidaDoMouse(
        descricao({ efetivo: 'relativo', aceleracao: 'desligada', velocidade: 10, relativoSaiFiel: true }),
      ),
      undefined,
    );
  });
});

describe('resumirSaidaDoMouse', () => {
  it('cabe nas 66 colunas de conteúdo do painel em todas as combinações', () => {
    for (const aceleracao of ['ligada', 'desligada', 'desconhecida'] as const) {
      for (const efetivo of ['absoluto', 'relativo', 'compensado'] as const) {
        for (const velocidade of [1, 10, 20, undefined]) {
          const texto = resumirSaidaDoMouse(descricao({ aceleracao, efetivo, velocidade }));
          assert.ok(texto.length <= 66, `${String(texto.length)} colunas: "${texto}"`);
        }
      }
    }
  });
});
