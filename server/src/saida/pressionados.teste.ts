/**
 * Teste do registro do que está preso.
 *
 * Este módulo é pequeno e é o mais perigoso do sprint: é ele que decide o que `soltarTudo()` vai
 * soltar. Um erro aqui não aparece como teste vermelho em outro lugar — aparece como tecla presa
 * no Windows de quem estava usando a máquina.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAXIMO_DE_TECLAS_PRESAS, criarRegistroDePressionados } from './pressionados.js';
import type { BotaoDoMouse } from './tipos.js';

/** Coleta o que a soltura pediu, na ordem. */
function coletar(registro: ReturnType<typeof criarRegistroDePressionados>): {
  readonly botoes: BotaoDoMouse[];
  readonly teclas: number[];
  readonly total: number;
} {
  const botoes: BotaoDoMouse[] = [];
  const teclas: number[] = [];
  const total = registro.soltar(
    (botao) => botoes.push(botao),
    (scancode) => teclas.push(scancode),
  );
  return { botoes, teclas, total };
}

describe('marcação', () => {
  it('marca e desmarca botão, recusando o pedido redundante', () => {
    const registro = criarRegistroDePressionados();

    assert.equal(registro.marcarBotao('esquerdo', true), true);
    assert.equal(registro.marcarBotao('esquerdo', true), false);
    assert.equal(registro.botaoPreso('esquerdo'), true);
    assert.equal(registro.quantidade(), 1);

    assert.equal(registro.marcarBotao('esquerdo', false), true);
    assert.equal(registro.marcarBotao('esquerdo', false), false);
    assert.equal(registro.quantidade(), 0);
  });

  it('conta botões e teclas juntos', () => {
    const registro = criarRegistroDePressionados();

    registro.marcarBotao('direito', true);
    registro.marcarTecla(0x2a, true);
    registro.marcarTecla(0x1e, true);

    assert.equal(registro.quantidade(), 3);
    assert.equal(registro.teclaPresa(0x1e), true);
    assert.equal(registro.teclaPresa(0x99), false);
  });

  it('não aceita mais teclas do que a lista comporta', () => {
    const registro = criarRegistroDePressionados();

    for (let scancode = 1; scancode <= MAXIMO_DE_TECLAS_PRESAS; scancode += 1) {
      assert.equal(registro.marcarTecla(scancode, true), true);
    }

    assert.equal(registro.cabeMaisUmaTecla(), false);
    assert.equal(registro.marcarTecla(0x7f, true), false);
    assert.equal(registro.quantidade(), MAXIMO_DE_TECLAS_PRESAS);
  });

  it('soltar uma tecla do meio preserva a ordem de aperto das outras', () => {
    const registro = criarRegistroDePressionados();

    registro.marcarTecla(0x10, true);
    registro.marcarTecla(0x11, true);
    registro.marcarTecla(0x12, true);
    registro.marcarTecla(0x11, false);

    const { teclas } = coletar(registro);
    assert.deepEqual(teclas, [0x12, 0x10]);
  });
});

describe('soltar', () => {
  it('solta na ordem inversa do aperto: as teclas primeiro, o modificador por último', () => {
    const registro = criarRegistroDePressionados();

    registro.marcarTecla(0x2a, true); // Shift esquerdo
    registro.marcarTecla(0x1e, true); // A
    registro.marcarBotao('esquerdo', true);
    registro.marcarBotao('meio', true);

    const { botoes, teclas, total } = coletar(registro);

    // Soltar o Shift antes do A entregaria à janela em foco um "A↑ sem Shift" que nunca aconteceu.
    assert.deepEqual(teclas, [0x1e, 0x2a]);
    assert.deepEqual(botoes, ['meio', 'esquerdo']);
    assert.equal(total, 4);
    assert.equal(registro.quantidade(), 0);
  });

  it('botão sai na ordem inversa do APERTO, não na da lista canônica', () => {
    const registro = criarRegistroDePressionados();

    // A distinção só aparece com esta ordem. Apertando `esquerdo`→`direito`, a inversa do aperto
    // e a inversa da lista canônica (`esquerdo`, `direito`, `meio`) dão o mesmo resultado — e um
    // teste assim passaria mesmo se o registro não guardasse ordem nenhuma.
    registro.marcarBotao('meio', true);
    registro.marcarBotao('esquerdo', true);

    assert.deepEqual(coletar(registro).botoes, ['esquerdo', 'meio']);
  });

  it('soltar um botão do meio preserva a ordem de aperto dos outros', () => {
    const registro = criarRegistroDePressionados();

    registro.marcarBotao('direito', true);
    registro.marcarBotao('meio', true);
    registro.marcarBotao('esquerdo', true);
    registro.marcarBotao('meio', false);

    assert.deepEqual(coletar(registro).botoes, ['esquerdo', 'direito']);
  });

  it('botão fora da lista canônica não entra no registro', () => {
    const registro = criarRegistroDePressionados();

    assert.equal(registro.marcarBotao('lateral' as unknown as BotaoDoMouse, true), false);
    assert.equal(registro.quantidade(), 0);
    assert.equal(coletar(registro).total, 0);
  });

  it('é idempotente: a segunda chamada não pede soltura nenhuma', () => {
    const registro = criarRegistroDePressionados();
    registro.marcarBotao('esquerdo', true);

    assert.equal(coletar(registro).total, 1);
    assert.equal(coletar(registro).total, 0);
  });

  it('limpa o registro antes de chamar quem solta — reentrar não repete evento', () => {
    const registro = criarRegistroDePressionados();
    registro.marcarBotao('esquerdo', true);
    registro.marcarTecla(0x1e, true);

    const soltos: string[] = [];
    let reentrancias = 0;
    registro.soltar(
      (botao) => {
        soltos.push(`botao:${botao}`);
        // Um encerramento disparado duas vezes cai exatamente aqui. Se `soltar` não tivesse
        // limpado o registro antes, esta chamada de dentro repetiria tudo.
        if (reentrancias === 0) {
          reentrancias += 1;
          assert.equal(registro.quantidade(), 0);
          registro.soltar(
            () => soltos.push('reentrou'),
            () => soltos.push('reentrou'),
          );
        }
      },
      (scancode) => soltos.push(`tecla:${String(scancode)}`),
    );

    assert.deepEqual(soltos, ['tecla:30', 'botao:esquerdo']);
  });
});
