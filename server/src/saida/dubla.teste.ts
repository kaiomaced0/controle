/**
 * Teste do backend dublê.
 *
 * A dubla é a base de todo o teste do sprint 2 — se ela mentir, todos os testes acima dela
 * mentem junto. Por isso ela é testada contra as mesmas regras do backend do Windows: pedido
 * redundante descartado, marca só depois de o sistema aceitar, `soltarTudo()` idempotente e
 * cursor que para na borda da tela.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ERRO_ACESSO_NEGADO, TELA_PADRAO, criarBackendDubla } from './dubla.js';
import type { BotaoDoMouse } from './tipos.js';

describe('cursor virtual', () => {
  it('começa no centro da tela e anda com o movimento relativo', () => {
    const dubla = criarBackendDubla();

    assert.deepEqual(dubla.lerPosicaoDoMouse(), { x: 960, y: 540 });

    dubla.moverMouseRelativo(10, -20);

    assert.deepEqual(dubla.lerPosicaoDoMouse(), { x: 970, y: 520 });
    assert.deepEqual(dubla.eventos, [{ tipo: 'mover', dx: 10, dy: -20 }]);
  });

  it('para na borda, como o cursor de verdade', () => {
    const dubla = criarBackendDubla({ posicaoInicial: { x: 5, y: 5 } });

    dubla.moverMouseRelativo(-100, -100);

    assert.deepEqual(dubla.lerPosicaoDoMouse(), { x: 0, y: 0 });

    dubla.moverMouseRelativo(10_000, 10_000);

    assert.deepEqual(dubla.lerPosicaoDoMouse(), {
      x: TELA_PADRAO.largura - 1,
      y: TELA_PADRAO.altura - 1,
    });
  });

  it('posicionarMouse leva ao ponto pedido e registra o evento', () => {
    const dubla = criarBackendDubla();

    dubla.posicionarMouse(123, 456);

    assert.deepEqual(dubla.lerPosicaoDoMouse(), { x: 123, y: 456 });
    assert.deepEqual(dubla.eventos.at(-1), { tipo: 'posicionar', x: 123, y: 456 });
  });

  it('movimento de zero pixel não vira evento', () => {
    const dubla = criarBackendDubla();

    dubla.moverMouseRelativo(0.2, -0.3);

    assert.equal(dubla.eventos.length, 0);
    assert.equal(dubla.contadores.pedidosNulos, 1);
  });

  it('tela pode não estar disponível — e aí tamanhoDaTela devolve undefined', () => {
    assert.deepEqual(criarBackendDubla().tamanhoDaTela(), TELA_PADRAO);

    const semTela = criarBackendDubla({ semTela: true });
    assert.equal(semTela.tamanhoDaTela(), undefined);
    // Igual ao Windows: `GetSystemMetrics` em 0 é chamada de apoio que falhou, não injeção
    // recusada — por isso conta em `chamadasComErro` e não em `eventosRecusados`.
    assert.equal(semTela.contadores.chamadasComErro, 1);
    assert.equal(semTela.contadores.eventosRecusados, 0);
  });
});

describe('as outras duas formas de falhar', () => {
  it('leitura de cursor recusada devolve undefined e conta chamada com erro', () => {
    const dubla = criarBackendDubla({ posicaoInicial: { x: 30, y: 40 } });
    dubla.recusarProximasLeiturasDoCursor(1);

    assert.equal(dubla.lerPosicaoDoMouse(), undefined);
    assert.equal(dubla.contadores.chamadasComErro, 1);
    assert.equal(dubla.contadores.ultimoCodigoDeErro, ERRO_ACESSO_NEGADO);
    // A recusa vale para a leitura pedida, e só: a seguinte volta a responder.
    assert.deepEqual(dubla.lerPosicaoDoMouse(), { x: 30, y: 40 });
    assert.equal(dubla.contadores.chamadasComErro, 1);
  });

  it('posicionamento recusado não move o cursor, mas o pedido fica registrado', () => {
    const dubla = criarBackendDubla({ posicaoInicial: { x: 30, y: 40 } });
    dubla.recusarProximosPosicionamentos(1);

    dubla.posicionarMouse(800, 600);

    assert.deepEqual(dubla.lerPosicaoDoMouse(), { x: 30, y: 40 });
    assert.equal(dubla.contadores.chamadasComErro, 1);
    // "Não pediu" e "pediu e o sistema barrou" são coisas diferentes, e o teste tem de conseguir
    // separar as duas.
    assert.deepEqual(dubla.eventos.at(-1), { tipo: 'posicionar', x: 800, y: 600 });
  });

  it('limpar cancela as recusas pendentes das três', () => {
    const dubla = criarBackendDubla({ posicaoInicial: { x: 1, y: 2 } });
    dubla.recusarProximos(1);
    dubla.recusarProximasLeiturasDoCursor(1);
    dubla.recusarProximosPosicionamentos(1);

    dubla.limpar();
    dubla.moverMouseRelativo(3, 4);
    dubla.posicionarMouse(500, 500);

    assert.deepEqual(dubla.lerPosicaoDoMouse(), { x: 500, y: 500 });
    assert.equal(dubla.contadores.eventosRecusados, 0);
    assert.equal(dubla.contadores.chamadasComErro, 0);
  });
});

describe('estado preso', () => {
  it('descarta pedido redundante de botão e de tecla', () => {
    const dubla = criarBackendDubla();

    dubla.botaoMouse('esquerdo', true);
    dubla.botaoMouse('esquerdo', true);
    dubla.tecla(0x1e, false);

    assert.equal(dubla.eventos.length, 1);
    assert.equal(dubla.contadores.pedidosRedundantes, 2);
  });

  it('soltarTudo devolve o sistema ao estado neutro e é idempotente', () => {
    const dubla = criarBackendDubla();

    dubla.botaoMouse('direito', true);
    dubla.tecla(0x2a, true);
    assert.equal(dubla.pressionados(), 2);

    dubla.soltarTudo();
    assert.equal(dubla.pressionados(), 0);
    assert.equal(dubla.contadores.soltasDeSeguranca, 2);
    assert.deepEqual(dubla.eventos.slice(-2), [
      { tipo: 'tecla', scancode: 0x2a, pressionada: false },
      { tipo: 'botao', botao: 'direito', pressionado: false },
    ]);

    const antes = dubla.eventos.length;
    dubla.soltarTudo();
    assert.equal(dubla.eventos.length, antes);
  });

  it('injeção recusada não deixa marca de botão preso', () => {
    const dubla = criarBackendDubla();
    dubla.recusarProximos(1);

    dubla.botaoMouse('esquerdo', true);

    assert.equal(dubla.pressionados(), 0);
    assert.equal(dubla.contadores.eventosRecusados, 1);
    assert.equal(dubla.contadores.ultimoCodigoDeErro, ERRO_ACESSO_NEGADO);
  });

  it('botão que não existe é pedido inválido, não estado preso invisível', () => {
    const dubla = criarBackendDubla();

    // É assim que o defeito chegaria: o mapeador de perfis (ATI-008/ATI-018) traduz o
    // `idControle` que veio do fio para um destes três nomes, e mapa errado entrega outra coisa.
    dubla.botaoMouse('lateral' as unknown as BotaoDoMouse, true);

    assert.equal(dubla.eventos.length, 0);
    assert.equal(dubla.pressionados(), 0);
    assert.equal(dubla.contadores.pedidosInvalidos, 1);
  });

  it('encerrar solta o que estava preso e conta o encerramento', () => {
    const dubla = criarBackendDubla();

    dubla.tecla(0x1e, true);
    dubla.encerrar();

    assert.equal(dubla.pressionados(), 0);
    assert.equal(dubla.encerramentos(), 1);
  });
});

describe('scroll e teclas', () => {
  it('guarda o scroll em entalhes e conta um evento por eixo', () => {
    const dubla = criarBackendDubla();

    dubla.scroll(1, -2);

    assert.deepEqual(dubla.eventos, [{ tipo: 'scroll', vertical: 1, horizontal: -2 }]);
    assert.equal(dubla.contadores.eventosEnviados, 2);
  });

  it('recusa scancode fora da faixa', () => {
    const dubla = criarBackendDubla();

    dubla.tecla(0, true);
    dubla.tecla(0x1_0000, true);

    assert.equal(dubla.eventos.length, 0);
    assert.equal(dubla.contadores.pedidosInvalidos, 2);
  });
});

describe('limpar', () => {
  it('zera eventos e contadores no mesmo objeto de contadores', () => {
    const dubla = criarBackendDubla();
    const contadores = dubla.contadores;

    dubla.moverMouseRelativo(1, 1);
    dubla.limpar();

    assert.equal(dubla.eventos.length, 0);
    assert.equal(contadores.eventosEnviados, 0);
    // Quem guardou a referência continua lendo os mesmos contadores — não uma cópia órfã.
    assert.equal(dubla.contadores, contadores);
  });
});
