/**
 * O painel: primeiro quadro escreve, os seguintes reescrevem no mesmo lugar, o log sai acima e
 * o Ctrl+C devolve o cursor. Tudo verificado nos bytes que sairiam para o terminal.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ENCERRAR_DESTAQUE,
  ESCONDER_CURSOR,
  INICIAR_DESTAQUE,
  LIMPAR_ATE_O_FIM_DA_LINHA,
  LIMPAR_DAQUI_PARA_BAIXO,
  MOSTRAR_CURSOR,
  criarPainel,
  subirLinhas,
} from './painel.js';

function capturar(ansi: boolean) {
  const saida: string[] = [];
  const painel = criarPainel({ escrever: (texto) => saida.push(texto), ansi });
  return { painel, saida };
}

describe('criarPainel com ANSI', () => {
  it('o primeiro quadro esconde o cursor e não termina com quebra de linha', () => {
    const { painel, saida } = capturar(true);

    painel.desenhar(['um', 'dois', 'três']);

    const quadro = saida.join('');
    assert.ok(quadro.startsWith(ESCONDER_CURSOR));
    // Sem `\n` no fim é o que impede o terminal de rolar uma linha a cada quadro.
    assert.ok(!quadro.endsWith('\n'));
    assert.ok(quadro.endsWith(`três${LIMPAR_ATE_O_FIM_DA_LINHA}`));
  });

  it('o quadro seguinte volta ao começo do painel em vez de escrever embaixo', () => {
    const { painel, saida } = capturar(true);

    painel.desenhar(['um', 'dois', 'três']);
    saida.length = 0;
    painel.desenhar(['um', 'dois', 'três']);

    const quadro = saida.join('');
    // Cursor na última das três linhas: volta à coluna 0 e sobe duas.
    assert.ok(quadro.startsWith(`\r${subirLinhas(2)}`));
    // Nada de limpar a tela inteira — é isso que faria o painel piscar.
    assert.ok(!quadro.includes('\x1b[2J'));
    assert.ok(!quadro.includes(ESCONDER_CURSOR));
  });

  it('apaga o resto de cada linha, para o quadro anterior não vazar', () => {
    const { painel, saida } = capturar(true);

    painel.desenhar(['linha comprida de verdade']);
    saida.length = 0;
    painel.desenhar(['curta']);

    assert.ok(saida.join('').includes(`curta${LIMPAR_ATE_O_FIM_DA_LINHA}`));
  });

  it('quadro que encolhe limpa as linhas que sobraram embaixo', () => {
    const { painel, saida } = capturar(true);

    painel.desenhar(['a', 'b', 'c']);
    saida.length = 0;
    painel.desenhar(['a']);

    assert.ok(saida.join('').endsWith(LIMPAR_DAQUI_PARA_BAIXO));
  });

  it('log antes do primeiro quadro sai na hora; depois dele, sai acima do painel', () => {
    const { painel, saida } = capturar(true);

    painel.escreverAcima('partida');
    assert.equal(saida.join(''), 'partida\n');

    painel.desenhar(['quadro']);
    saida.length = 0;

    painel.escreverAcima('sessão aberta');
    // Enfileirado: nada sai enquanto o próximo quadro não é desenhado.
    assert.equal(saida.join(''), '');

    painel.desenhar(['quadro']);
    const texto = saida.join('');
    assert.ok(texto.includes(`${LIMPAR_DAQUI_PARA_BAIXO}sessão aberta\n`));
    assert.ok(texto.indexOf('sessão aberta') < texto.indexOf('quadro'));
  });

  it('encerrar sai de baixo do painel, descarrega o log pendente e devolve o cursor', () => {
    const { painel, saida } = capturar(true);

    painel.desenhar(['quadro']);
    painel.escreverAcima('transporte fechado');
    saida.length = 0;

    painel.encerrar();

    assert.equal(saida.join(''), `\ntransporte fechado\n${MOSTRAR_CURSOR}`);
  });

  it('encerrar é idempotente e o painel não desenha mais depois dele', () => {
    const { painel, saida } = capturar(true);

    painel.desenhar(['quadro']);
    painel.encerrar();
    saida.length = 0;

    painel.encerrar();
    painel.desenhar(['outro']);

    assert.equal(saida.join(''), '');
  });
});

describe('criarPainel com a primeira linha em destaque (ATI-027)', () => {
  it('a primeira linha sai em vídeo inverso, e só ela', () => {
    const saida: string[] = [];
    const painel = criarPainel({
      escrever: (texto) => saida.push(texto),
      ansi: true,
      destacarPrimeiraLinha: true,
    });

    painel.desenhar(['ENSAIO (o cursor não se mexe)', 'resto']);

    const quadro = saida.join('');
    assert.ok(
      quadro.includes(
        `${INICIAR_DESTAQUE}ENSAIO (o cursor não se mexe)${ENCERRAR_DESTAQUE}${LIMPAR_ATE_O_FIM_DA_LINHA}\n`,
      ),
      'o destaque fecha antes do apagar-até-o-fim, senão o resto da linha sairia invertido',
    );
    assert.ok(quadro.endsWith(`\nresto${LIMPAR_ATE_O_FIM_DA_LINHA}`), 'as outras linhas saem sem destaque');
    assert.equal(quadro.split(INICIAR_DESTAQUE).length - 1, 1);
  });

  it('sem terminal não há destaque: o texto do quadro sai como veio', () => {
    const saida: string[] = [];
    const painel = criarPainel({
      escrever: (texto) => saida.push(texto),
      ansi: false,
      destacarPrimeiraLinha: true,
    });

    painel.desenhar(['ENSAIO', 'resto']);

    assert.equal(saida.join(''), 'ENSAIO\nresto\n\n');
  });
});

describe('criarPainel sem ANSI', () => {
  it('não emite escape nenhum: cada quadro é um bloco de texto puro', () => {
    const { painel, saida } = capturar(false);

    painel.escreverAcima('log');
    painel.desenhar(['um', 'dois']);
    painel.desenhar(['um', 'dois']);
    painel.encerrar();

    const texto = saida.join('');
    assert.ok(!texto.includes('\x1b'), 'saída sem terminal não pode levar escape');
    assert.equal(texto, 'log\num\ndois\n\num\ndois\n\n');
  });
});

describe('subirLinhas', () => {
  it('não gera escape quando não há para onde subir', () => {
    assert.equal(subirLinhas(0), '');
    assert.equal(subirLinhas(-3), '');
    assert.equal(subirLinhas(4), '\x1b[4A');
  });
});
