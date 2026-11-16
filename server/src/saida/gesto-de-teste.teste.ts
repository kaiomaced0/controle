/**
 * Teste do gesto de `--teste-mouse`.
 *
 * Roda inteiro contra a dubla, com a espera injetada — nenhum cursor de verdade se mexe e a
 * suíte não fica 4 segundos parada esperando contagem regressiva.
 *
 * O que interessa provar aqui: o quadrado **fecha** (soma dos movimentos = zero nos dois eixos),
 * a posição original volta, e o cancelamento no meio do clique não deixa botão preso — que é o
 * caso em que este gesto poderia estragar a sessão de quem está usando a máquina.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { criarBackendDubla, type EventoDaDubla } from './dubla.js';
import { LADO_PADRAO, PASSO_PADRAO, executarGestoDeTeste } from './gesto-de-teste.js';

/** Espera de mentira: devolve na hora e conta quantas vezes o gesto quis dormir. */
function esperaInstantanea(): { esperar: (ms: number) => Promise<void>; esperas: () => number } {
  let esperas = 0;
  return {
    esperar: () => {
      esperas += 1;
      return Promise.resolve();
    },
    esperas: () => esperas,
  };
}

function somaDosMovimentos(eventos: readonly EventoDaDubla[]): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  for (const evento of eventos) {
    if (evento.tipo === 'mover') {
      dx += evento.dx;
      dy += evento.dy;
    }
  }
  return { dx, dy };
}

describe('executarGestoDeTeste', () => {
  it('desenha um quadrado que fecha e devolve o cursor ao ponto de partida', async () => {
    const dubla = criarBackendDubla({ posicaoInicial: { x: 400, y: 300 } });
    const { esperar } = esperaInstantanea();

    const resultado = await executarGestoDeTeste(dubla, { esperar, avisoMs: 0 });

    assert.equal(resultado.cancelado, false);
    assert.equal(resultado.movimentos, (LADO_PADRAO / PASSO_PADRAO) * 4);
    assert.deepEqual(somaDosMovimentos(dubla.eventos), { dx: 0, dy: 0 });
    assert.deepEqual(resultado.origem, { x: 400, y: 300 });
    assert.equal(resultado.restaurou, true);
    assert.deepEqual(dubla.lerPosicaoDoMouse(), { x: 400, y: 300 });
    assert.equal(dubla.pressionados(), 0);
  });

  it('fecha o quadrado mesmo quando o lado não é múltiplo do passo', async () => {
    const dubla = criarBackendDubla();
    const { esperar } = esperaInstantanea();

    await executarGestoDeTeste(dubla, { esperar, avisoMs: 0, lado: 25, passo: 8, clicar: false });

    assert.deepEqual(somaDosMovimentos(dubla.eventos), { dx: 0, dy: 0 });
    // 25 px em passos de 8: 8 + 8 + 8 + 1, quatro vezes.
    assert.equal(dubla.eventos.filter((evento) => evento.tipo === 'mover').length, 16);
  });

  it('o clique é aperto e soltura separados, nesta ordem', async () => {
    const dubla = criarBackendDubla();
    const { esperar } = esperaInstantanea();

    const resultado = await executarGestoDeTeste(dubla, { esperar, avisoMs: 0, lado: 8, passo: 8 });

    const cliques = dubla.eventos.filter((evento) => evento.tipo === 'botao');
    assert.deepEqual(cliques, [
      { tipo: 'botao', botao: 'esquerdo', pressionado: true },
      { tipo: 'botao', botao: 'esquerdo', pressionado: false },
    ]);
    assert.equal(resultado.clicou, true);
  });

  it('sem clicar quando o pedido é só o movimento', async () => {
    const dubla = criarBackendDubla();
    const { esperar } = esperaInstantanea();

    const resultado = await executarGestoDeTeste(dubla, {
      esperar,
      avisoMs: 0,
      lado: 8,
      passo: 8,
      clicar: false,
    });

    assert.equal(resultado.clicou, false);
    assert.equal(dubla.eventos.some((evento) => evento.tipo === 'botao'), false);
  });

  it('cancelado no meio: para de andar, solta o que estava preso e restaura a posição', async () => {
    const dubla = criarBackendDubla({ posicaoInicial: { x: 500, y: 500 } });
    let passos = 0;
    const esperar = (): Promise<void> => {
      passos += 1;
      return Promise.resolve();
    };

    const resultado = await executarGestoDeTeste(dubla, {
      esperar,
      avisoMs: 0,
      cancelado: () => passos >= 5,
    });

    assert.equal(resultado.cancelado, true);
    assert.equal(resultado.clicou, false);
    assert.equal(dubla.pressionados(), 0);
    assert.deepEqual(dubla.lerPosicaoDoMouse(), { x: 500, y: 500 });
    assert.ok(resultado.movimentos < (LADO_PADRAO / PASSO_PADRAO) * 4);
  });

  it('cancelado durante a contagem regressiva não chega a mexer no cursor', async () => {
    const dubla = criarBackendDubla({ posicaoInicial: { x: 10, y: 10 } });
    const avisos: string[] = [];

    const resultado = await executarGestoDeTeste(dubla, {
      esperar: () => Promise.resolve(),
      avisoMs: 3000,
      cancelado: () => true,
      avisar: (mensagem) => avisos.push(mensagem),
    });

    assert.equal(resultado.cancelado, true);
    assert.equal(resultado.movimentos, 0);
    assert.equal(dubla.eventos.length, 0);
    assert.deepEqual(dubla.lerPosicaoDoMouse(), { x: 10, y: 10 });
    assert.ok(avisos.some((mensagem) => mensagem.includes('cancelado')));
  });

  it('avisa antes de tomar o cursor, e o aviso diz que vai clicar', async () => {
    const dubla = criarBackendDubla();
    const avisos: string[] = [];

    await executarGestoDeTeste(dubla, {
      esperar: () => Promise.resolve(),
      avisoMs: 3000,
      lado: 8,
      passo: 8,
      avisar: (mensagem) => avisos.push(mensagem),
    });

    const primeiro = avisos[0] ?? '';
    assert.match(primeiro, /quadrado/);
    assert.match(primeiro, /clicar/);
    assert.match(primeiro, /Ctrl\+C/);
    // Três avisos de contagem (3, 2, 1) entre o primeiro e o resumo final.
    assert.equal(avisos.filter((mensagem) => /teste de mouse em \d\.\.\./.test(mensagem)).length, 3);
    assert.match(avisos.at(-1) ?? '', /concluído/);
  });

  it('sem conseguir ler a posição original, anda mas não tenta restaurar nada', async () => {
    const dubla = criarBackendDubla({ posicaoInicial: { x: 700, y: 200 } });
    // `GetCursorPos` recusado é o caso do UIPI e o de área de trabalho trocada no meio: o gesto
    // não pode chutar um ponto de volta, porque chutar é jogar o cursor para outro lugar.
    dubla.recusarProximasLeiturasDoCursor(1);
    const avisos: string[] = [];

    const resultado = await executarGestoDeTeste(dubla, {
      esperar: () => Promise.resolve(),
      avisoMs: 0,
      lado: 8,
      passo: 8,
      clicar: false,
      avisar: (mensagem) => avisos.push(mensagem),
    });

    assert.equal(resultado.origem, undefined);
    assert.equal(resultado.restaurou, false);
    assert.equal(
      dubla.eventos.some((evento) => evento.tipo === 'posicionar'),
      false,
    );
    assert.match(avisos.at(-1) ?? '', /sem posição original para restaurar/);
    assert.equal(dubla.contadores.chamadasComErro, 1);
    // O quadrado fecha sozinho, então o cursor volta ao ponto de partida mesmo sem restauração.
    assert.deepEqual(dubla.lerPosicaoDoMouse(), { x: 700, y: 200 });
    assert.equal(dubla.pressionados(), 0);
  });

  it('falha no meio do clique ainda solta o botão antes de propagar o erro', async () => {
    const dubla = criarBackendDubla({ posicaoInicial: { x: 44, y: 55 } });
    let chamadas = 0;
    // Quatro esperas de movimento (lado 8, passo 8) e a quinta é a do botão apertado: é ali que
    // este relógio de mentira estoura. Sem o `finally`, o botão ficaria apertado no sistema.
    const esperar = (): Promise<void> => {
      chamadas += 1;
      return chamadas >= 5 ? Promise.reject(new Error('relógio quebrou')) : Promise.resolve();
    };

    await assert.rejects(
      () => executarGestoDeTeste(dubla, { esperar, avisoMs: 0, lado: 8, passo: 8 }),
      /relógio quebrou/,
    );

    assert.equal(dubla.pressionados(), 0);
    assert.deepEqual(dubla.eventos.at(-2), {
      tipo: 'botao',
      botao: 'esquerdo',
      pressionado: false,
    });
    assert.deepEqual(dubla.eventos.at(-1), { tipo: 'posicionar', x: 44, y: 55 });
  });
});
