/**
 * O quadro da telemetria: barra centrada no zero, contagem fixa de linhas, largura travada e
 * valor imprestável.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { InstantaneoDaMontagem } from '../../montagem.js';
import { AJUSTES_PADRAO, resolverAjustes, textoDoAvisoDeBiasAlto } from '../../movimento/indice.js';
import type { DescricaoDaSaidaDoMouse } from '../../saida/saida-do-mouse.js';
import type { InstantaneoDaSessao, MedidasDaSessao } from '../../transporte/indice.js';
import {
  DESTINO_NO_TITULO,
  ESCALA_DA_BARRA_GRAUS_POR_S,
  LARGURA_DO_PAINEL,
  LIMITE_DO_NOME_DO_APARELHO,
  LINHAS_DO_QUADRO,
  MARCA_DE_CORTE,
  MEIA_BARRA,
  NOME_ILEGIVEL,
  formatarBarra,
  formatarComSinal,
  formatarDataEHora,
  formatarHora,
  formatarNumero,
  larguraDeExibicao,
  larguraDeTrabalho,
  montarQuadro,
  sanitizarTextoDoFio,
  truncarNaLargura,
  type EstadoDoQuadro,
} from './quadro.js';

/** Controle, formato, escape: tudo que o terminal interpreta em vez de desenhar. */
const CONTROLE_OU_ESCAPE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;

function medidas(parciais: Partial<MedidasDaSessao> = {}): MedidasDaSessao {
  return {
    pacotesRecebidos: 0,
    bytesRecebidos: 0,
    descartados: 0,
    descartadosPorTamanho: 0,
    descartadosPorTipo: 0,
    comBytesExtras: 0,
    visoesCriadas: 0,
    pacotesNoSentidoErrado: 0,
    foraDeOrdem: 0,
    descartadosForaDeOrdem: 0,
    taxaHzMedida: 0,
    dtMsMedio: 0,
    dtMsDesvio: 0,
    rttMsP50: 0,
    rttMsP95: 0,
    rttMsUltimo: 0,
    amostrasDeRtt: 0,
    pongsRecebidos: 0,
    pongsRecusados: 0,
    duracaoMs: 0,
    ...parciais,
  };
}

function estado(parciais: Partial<EstadoDoQuadro> = {}): EstadoDoQuadro {
  return {
    endereco: { host: '127.0.0.1', porta: 8765 },
    conexoesAbertas: 1,
    sessao: undefined,
    eixos: { gx: 0, gy: 0, gz: 0 },
    cpuPorCento: 0,
    cpuMediaPorCento: 0,
    intervaloDoQuadroMs: 100,
    largura: LARGURA_DO_PAINEL,
    montagem: montagem(),
    ...parciais,
  };
}

/** Graus por segundo em rad/s — o bias mora em rad/s no pipeline. */
function radPorS(grausPorS: number): number {
  return (grausPorS * Math.PI) / 180;
}

/**
 * O que a montagem mostra (ATI-027): ensaio, padrão de fábrica, nada calibrado, nada contado — o
 * servidor recém-subido, antes do primeiro aparelho.
 */
function montagem(parciais: Partial<InstantaneoDaMontagem> = {}): InstantaneoDaMontagem {
  return {
    cursor: 'ensaio',
    ajustes: AJUSTES_PADRAO,
    bias: { origem: 'nenhuma', desdeMs: Number.NaN },
    recalibracao: {
      ligada: true,
      aplicacoesNaSessao: 0,
      aplicacoesNaExecucao: 0,
      paradoMs: 0,
      avisoDeBiasAlto: undefined,
    },
    pixels: { sessaoX: 0, sessaoY: 0, execucaoX: 0, execucaoY: 0 },
    acoes: {
      cliquesNaSessao: 0,
      entalhesVerticaisNaSessao: 0,
      entalhesHorizontaisNaSessao: 0,
      presos: 0,
    },
    ponteiro: undefined,
    ...parciais,
  };
}

/** Uma sessão de ajuste de verdade: um giro de 90°, dois cliques, bias guardado, recalibração. */
function montagemRealista(parciais: Partial<InstantaneoDaMontagem> = {}): InstantaneoDaMontagem {
  return montagem({
    ajustes: resolverAjustes({
      orientacao: 'apontador',
      sensXPixelsPorGrau: 1920 / 45,
      sensYPixelsPorGrau: 1080 / 25,
      biasGxRadPorS: radPorS(0.29),
      biasGyRadPorS: radPorS(-0.012),
      biasGzRadPorS: radPorS(0.004),
    }),
    bias: { origem: 'guardado', desdeMs: new Date(2026, 7, 24, 2, 18).getTime() },
    recalibracao: {
      ligada: true,
      aplicacoesNaSessao: 12,
      aplicacoesNaExecucao: 340,
      paradoMs: 4200,
      avisoDeBiasAlto: undefined,
    },
    pixels: { sessaoX: -3840, sessaoY: 125, execucaoX: -7680, execucaoY: 250 },
    acoes: {
      cliquesNaSessao: 2,
      entalhesVerticaisNaSessao: 4,
      entalhesHorizontaisNaSessao: -1.5,
      presos: 0,
    },
    ...parciais,
  });
}

/** Uma hora de uso no limite de cada faixa: os números mais largos que o quadro pode receber. */
function montagemGorda(): InstantaneoDaMontagem {
  return montagem({
    cursor: 'real',
    ajustes: resolverAjustes({
      ativo: false,
      orientacao: 'apontador-torcao',
      sensXPixelsPorGrau: 199.99,
      sensYPixelsPorGrau: 199.99,
      zonaMortaGrausPorS: 9.99,
      inverterX: true,
      inverterY: true,
      biasGxRadPorS: -1,
      biasGyRadPorS: -1,
      biasGzRadPorS: -1,
    }),
    bias: { origem: 'calibracao', desdeMs: new Date(2026, 9, 14, 13, 2, 11).getTime() },
    recalibracao: {
      ligada: true,
      aplicacoesNaSessao: 7_200,
      aplicacoesNaExecucao: 1_234_567,
      paradoMs: 86_400_000,
      // O aviso de bias alto no maior número que ele aceita (o teto do `calibrar-fim`, ATI-029).
      avisoDeBiasAlto: textoDoAvisoDeBiasAlto(15),
    },
    pixels: {
      sessaoX: -12_345_678,
      sessaoY: 98_765_432,
      execucaoX: -123_456_789,
      execucaoY: 987_654_321,
    },
    acoes: {
      cliquesNaSessao: 123_456,
      entalhesVerticaisNaSessao: -12_345.5,
      entalhesHorizontaisNaSessao: 9_876.25,
      presos: 3,
    },
  });
}

/** Sessão de uma hora a 100 Hz, com todos os contadores em números grandes de verdade. */
function medidasGordas(): Partial<MedidasDaSessao> {
  return {
    pacotesRecebidos: 360_000,
    bytesRecebidos: 8_640_000,
    descartados: 12_345,
    descartadosPorTamanho: 6_000,
    descartadosPorTipo: 6_345,
    comBytesExtras: 4_321,
    visoesCriadas: 359_998,
    pacotesNoSentidoErrado: 999,
    foraDeOrdem: 8_888,
    descartadosForaDeOrdem: 7_777,
    taxaHzMedida: 100.7,
    dtMsMedio: 10.004,
    dtMsDesvio: 0.987,
    rttMsP50: 123.45,
    rttMsP95: 456.78,
    rttMsUltimo: 789.01,
    amostrasDeRtt: 256,
    pongsRecusados: 42,
    duracaoMs: 3_600_000,
  };
}

function sessaoAtiva(parciais: Partial<MedidasDaSessao> = {}): InstantaneoDaSessao {
  return {
    id: 's-1',
    estado: 'ativa',
    aparelho: {
      id: 'a1b2c3',
      nome: 'Pixel 8 Pro',
      so: 'android',
      versaoSo: '14',
      modelo: 'GVU6C',
    },
    transporte: 'usb',
    medidas: medidas(parciais),
  };
}

/**
 * Sessão cujo nome de aparelho é o que o **outro lado do fio** escolheu.
 *
 * O `hello` aceita qualquer string em `aparelho.nome` (PROTOCOLO.md, seção 3.1), então é por aqui
 * que entra tudo que a revisão da rodada 2 mediu contra o painel.
 */
function sessaoComNome(nome: string, parciais: Partial<MedidasDaSessao> = {}): InstantaneoDaSessao {
  return {
    ...sessaoAtiva(parciais),
    aparelho: { id: 'a1b2c3', nome, so: 'android', versaoSo: '14', modelo: 'GVU6C' },
  };
}

/** O nome hostil que a revisão da rodada 2 mandou pelo fio: quebra de linha + limpeza de tela. */
const NOME_COM_ESCAPE = 'Pixel\n\u001b[2J\u001b[10BFALSO';

/** 15 colunas de nome + 10 emoji = 35 colunas, mas só 25 pontos de código. */
const NOME_COM_EMOJI = `Celular do Kaio${'\u{1F642}'.repeat(10)}`;

/**
 * O contrário do emoji: 5 001 pontos de código que a conta de colunas vê como **uma** coluna.
 *
 * Marca combinante (U+0301, acento agudo) desenha em cima do caractere anterior e custa zero
 * coluna, então o corte por largura sozinho deixava a linha crescer sem limite — é a sugestão 3 da
 * revisão da rodada 3. Terminal que compõe a marca desenha uma coluna; o que não compõe (console
 * legado do Windows) desenha 5 001 células e a linha quebra sozinha.
 */
const MARCA_COMBINANTE = String.fromCodePoint(0x0301);
const NOME_ZALGO = `Z${MARCA_COMBINANTE.repeat(5000)}`;

describe('formatarBarra', () => {
  it('zero deixa a barra vazia, com o centro marcado', () => {
    const vazio = '.'.repeat(MEIA_BARRA);
    assert.equal(formatarBarra(0), `[${vazio}|${vazio}]`);
  });

  it('positivo cresce para a direita e negativo para a esquerda, no mesmo tamanho', () => {
    const direita = formatarBarra(ESCALA_DA_BARRA_GRAUS_POR_S / 2);
    const esquerda = formatarBarra(-ESCALA_DA_BARRA_GRAUS_POR_S / 2);

    assert.equal(direita.length, esquerda.length);
    assert.equal(direita.indexOf('|'), MEIA_BARRA + 1);
    // Metade da escala acende metade das células daquele lado.
    assert.equal(direita.slice(MEIA_BARRA + 2).split('.')[0], '#'.repeat(MEIA_BARRA / 2));
    assert.ok(esquerda.startsWith(`[${'.'.repeat(MEIA_BARRA / 2)}#`));
  });

  it('marca a saturação com a ponta, em vez de fingir que está no limite', () => {
    assert.ok(formatarBarra(ESCALA_DA_BARRA_GRAUS_POR_S * 3).includes('>'));
    assert.ok(formatarBarra(-ESCALA_DA_BARRA_GRAUS_POR_S * 3).includes('<'));
    // Exatamente no fundo de escala já é saturação: dali para cima a barra não anda mais.
    assert.ok(formatarBarra(ESCALA_DA_BARRA_GRAUS_POR_S).includes('>'));
    assert.ok(!formatarBarra(ESCALA_DA_BARRA_GRAUS_POR_S * 0.9).includes('>'));
  });

  it('NaN e infinito não viram barra cheia — viram barra vazia', () => {
    const vazio = `[${'.'.repeat(MEIA_BARRA)}|${'.'.repeat(MEIA_BARRA)}]`;
    assert.equal(formatarBarra(Number.NaN), vazio);
    assert.equal(formatarBarra(Number.POSITIVE_INFINITY), vazio);
  });
});

describe('formatarNumero e formatarComSinal', () => {
  it('valor não finito vira travessão, nunca "NaN" na tela', () => {
    assert.equal(formatarNumero(Number.NaN, 2), '—');
    assert.equal(formatarNumero(Number.NEGATIVE_INFINITY, 2), '—');
    assert.equal(formatarComSinal(Number.NaN, 4), '—');
  });

  it('o sinal aparece sempre, inclusive no positivo', () => {
    assert.equal(formatarComSinal(1.5, 1), '+1.5');
    assert.equal(formatarComSinal(-1.5, 1), '-1.5');
    assert.equal(formatarComSinal(0, 1), '+0.0');
  });
});

describe('montarQuadro', () => {
  it('tem sempre a mesma quantidade de linhas, com sessão ou sem sessão', () => {
    const semSessao = montarQuadro(estado());
    const comSessao = montarQuadro(estado({ sessao: sessaoAtiva() }));

    assert.equal(semSessao.length, LINHAS_DO_QUADRO);
    assert.equal(comSessao.length, LINHAS_DO_QUADRO);
  });

  it('nenhuma linha termina em espaço — quem apaga o resto é o escape do painel', () => {
    for (const linha of montarQuadro(estado({ sessao: sessaoAtiva() }))) {
      assert.equal(linha, linha.trimEnd(), `linha com espaço no fim: "${linha}"`);
    }
  });

  it('mostra as medidas da seção 7 do protocolo com os números recebidos', () => {
    const linhas = montarQuadro(
      estado({
        sessao: sessaoAtiva({
          pacotesRecebidos: 1234,
          bytesRecebidos: 29616,
          taxaHzMedida: 99.7,
          dtMsMedio: 10,
          dtMsDesvio: 0.04,
          rttMsP50: 0.38,
          rttMsP95: 1.05,
          foraDeOrdem: 2,
          descartadosForaDeOrdem: 1,
          descartados: 3,
          descartadosPorTamanho: 2,
          descartadosPorTipo: 1,
          pacotesNoSentidoErrado: 4,
          comBytesExtras: 5,
          pongsRecusados: 6,
          visoesCriadas: 1230,
          duracaoMs: 12300,
        }),
      }),
    );
    const texto = linhas.join('\n');

    assert.match(texto, /99\.7 Hz/);
    assert.match(texto, /10\.00 ± 0\.04 ms/);
    assert.match(texto, /p50 0\.38 ms/);
    assert.match(texto, /p95 1\.05 ms/);
    assert.match(texto, /1234 recebidos/);
    assert.match(texto, /29616 bytes/);
    assert.match(texto, /fora de ordem 2 \(1 descartados\)/);
    assert.match(texto, /3 no total/);
    assert.match(texto, /tamanho 2/);
    assert.match(texto, /tipo 1/);
    assert.match(texto, /sentido errado 4/);
    assert.match(texto, /bytes extras 5/);
    assert.match(texto, /pong recusado 6/);
    assert.match(texto, /Pixel 8 Pro/);
    assert.match(texto, /12\.3 s/);
  });

  it('expõe visoesCriadas, que o PROTOCOLO.md manda mostrar neste modo', () => {
    // É a métrica de alocação por pacote no caminho quente (seção 7). Ficou de fora da rodada 1
    // e virou o apontamento 3 da revisão: tabela do protocolo e painel não podem divergir.
    const texto = montarQuadro(estado({ sessao: sessaoAtiva({ visoesCriadas: 385 }) })).join('\n');

    assert.match(texto, /visões criadas 385/);
  });

  it('mostra a CPU da janela e a média, que é a leitura que vale no Windows', () => {
    const texto = montarQuadro(estado({ cpuPorCento: 1.56, cpuMediaPorCento: 0.156 })).join('\n');

    assert.match(texto, /CPU 1\.6 % \(média 0\.16 %\)/);
  });

  it('sem sessão, o painel diz isso em vez de mostrar zero como se fosse medida', () => {
    const texto = montarQuadro(estado({ conexoesAbertas: 0 })).join('\n');

    assert.match(texto, /nenhum aparelho pareado ainda/);
    assert.match(texto, /0 conexões/);
    // Zero pacote e zero Hz seriam indistinguíveis de "canal parado" — aqui não há canal.
    assert.doesNotMatch(texto, /recebidos/);
  });

  it('o eixo aparece cru em rad por segundo e convertido em graus por segundo', () => {
    const texto = montarQuadro(estado({ eixos: { gx: 1, gy: 0, gz: 0 } })).join('\n');

    assert.match(texto, /\+1\.0000 rad\/s/);
    // 1 rad/s = 57,2957…°/s
    assert.match(texto, /\+57\.3 °\/s/);
  });
});

/** As linhas do quadro pelo rótulo — a posição pode mudar, o rótulo é o que a pessoa procura. */
function linhaRotulada(linhas: readonly string[], rotulo: string): string {
  const achada = linhas.find((linha) => linha.startsWith(`${rotulo} `));
  assert.ok(achada !== undefined, `o quadro não tem a linha "${rotulo}"`);
  return achada;
}

describe('o que a montagem põe no quadro (ATI-027)', () => {
  it('a primeira linha diz para onde o movimento vai, antes de qualquer outra coisa', () => {
    const real = montarQuadro(estado({ montagem: montagem({ cursor: 'real' }) }))[0] ?? '';
    const ensaio = montarQuadro(estado({ montagem: montagem({ cursor: 'ensaio' }) }))[0] ?? '';
    const desligado = montarQuadro(estado({ montagem: montagem({ cursor: 'desligado' }) }))[0] ?? '';

    assert.ok(real.startsWith('MOUSE REAL (o cursor SE MEXE)'), real);
    assert.ok(ensaio.startsWith('ENSAIO (o cursor não se mexe)'), ensaio);
    assert.ok(desligado.startsWith('MOVIMENTO DESLIGADO'), desligado);
    // E a primeira linha continua cabendo inteira, com a dica de saída, no padrão de 78 colunas.
    for (const titulo of [real, ensaio, desligado]) {
      assert.ok(titulo.endsWith('Ctrl+C encerra'), titulo);
      assert.ok(larguraDeExibicao(titulo) <= LARGURA_DO_PAINEL);
    }
  });

  it('em ensaio, mostra os pixels que teriam saído — da sessão e da execução', () => {
    const linhas = montarQuadro(
      estado({
        montagem: montagem({
          pixels: { sessaoX: -350, sessaoY: 12, execucaoX: -700, execucaoY: 24 },
        }),
      }),
    );

    assert.equal(
      linhaRotulada(linhas, 'pixels'),
      'pixels      sessão -350/+12 · execução -700/+24 px (teriam saído)',
    );
  });

  it('com o mouse real, os pixels são os pedidos ao cursor', () => {
    const linhas = montarQuadro(
      estado({
        montagem: montagem({
          cursor: 'real',
          pixels: { sessaoX: 105, sessaoY: 0, execucaoX: 105, execucaoY: 0 },
        }),
      }),
    );

    assert.match(linhaRotulada(linhas, 'pixels'), /sessão \+105\/\+0 · execução \+105\/\+0 px \(pedidos ao cursor\)$/);
  });

  it('o bias em uso aparece por eixo, em °/s, com de onde ele veio', () => {
    const ajustes = resolverAjustes({
      biasGxRadPorS: radPorS(0.29),
      biasGyRadPorS: radPorS(-0.012),
      biasGzRadPorS: radPorS(0.004),
    });
    const calibradoEm = new Date(2026, 9, 14, 13, 2, 11).getTime();
    const guardadoEm = new Date(2026, 7, 24, 2, 18).getTime();

    const calibrado = montarQuadro(
      estado({ montagem: montagem({ ajustes, bias: { origem: 'calibracao', desdeMs: calibradoEm } }) }),
    );
    const guardado = montarQuadro(
      estado({ montagem: montagem({ ajustes, bias: { origem: 'guardado', desdeMs: guardadoEm } }) }),
    );
    const semCalibracao = montarQuadro(estado({ montagem: montagem({ ajustes }) }));

    assert.equal(
      linhaRotulada(calibrado, 'bias'),
      'bias        gx/gy/gz +0.290/-0.012/+0.004 °/s · calibrado às 13:02:11',
    );
    assert.match(linhaRotulada(guardado, 'bias'), /· guardado, de 24\/08 02:18$/);
    assert.match(linhaRotulada(semCalibracao, 'bias'), /· sem calibração guardada$/);
  });

  it('a recalibração ligada mostra os ajustes da sessão e o tempo parado; desligada diz como ligar', () => {
    const ligada = montarQuadro(
      estado({
        montagem: montagem({
          recalibracao: {
            ligada: true,
            aplicacoesNaSessao: 3,
            aplicacoesNaExecucao: 7,
            paradoMs: 3500,
            avisoDeBiasAlto: undefined,
          },
        }),
      }),
    );
    const umAjuste = montarQuadro(
      estado({
        montagem: montagem({
          recalibracao: {
            ligada: true,
            aplicacoesNaSessao: 1,
            aplicacoesNaExecucao: 1,
            paradoMs: 0,
            avisoDeBiasAlto: undefined,
          },
        }),
      }),
    );
    const desligada = montarQuadro(
      estado({
        montagem: montagem({
          recalibracao: {
            ligada: false,
            aplicacoesNaSessao: 0,
            aplicacoesNaExecucao: 0,
            paradoMs: 0,
            avisoDeBiasAlto: undefined,
          },
        }),
      }),
    );

    assert.equal(
      linhaRotulada(ligada, 'recalib.'),
      'recalib.    ligada · 3 ajustes na sessão, 7 na execução · parado 3.5 s',
    );
    assert.match(linhaRotulada(umAjuste, 'recalib.'), /ligada · 1 ajuste na sessão/);
    assert.match(linhaRotulada(desligada, 'recalib.'), /desligada \(CONTROLE_RECALIBRACAO=desligada\)/);
  });

  it('o aviso de bias alto vem na frente da linha recalib., inteiro no padrão de 78 colunas (ATI-029)', () => {
    const aviso = textoDoAvisoDeBiasAlto(2.03);
    const linhas = montarQuadro(
      estado({
        montagem: montagemRealista({
          recalibracao: {
            ligada: true,
            aplicacoesNaSessao: 0,
            aplicacoesNaExecucao: 340,
            paradoMs: 0,
            avisoDeBiasAlto: aviso,
          },
        }),
      }),
    );

    assert.equal(aviso, 'bias alto detectado (2,0 °/s) — use sincronizar');
    const recalib = linhaRotulada(linhas, 'recalib.');
    // O aviso é a resposta para "por que o cursor anda sozinho?": ele não pode ser o que o corte
    // leva. O que sobra da linha (ajustes e tempo parado) é que vai para o `…`.
    assert.ok(
      recalib.startsWith(`recalib.    ${aviso} · ligada`),
      `o aviso precisa abrir a linha: "${recalib}"`,
    );
    assert.equal(linhas.length, LINHAS_DO_QUADRO, 'o aviso não acrescenta linha ao quadro');
    for (const linha of linhas) {
      assert.ok(larguraDeExibicao(linha) <= LARGURA_DO_PAINEL, `linha larga demais: "${linha}"`);
    }
  });

  it('sem aviso de bias alto, a linha recalib. é a de sempre', () => {
    const linhas = montarQuadro(estado({ montagem: montagemRealista() }));

    assert.ok(!linhaRotulada(linhas, 'recalib.').includes('bias alto'));
  });

  it('os ajustes efetivos: orientação, px/grau de cada eixo e zona morta', () => {
    const linhas = montarQuadro(
      estado({
        montagem: montagem({
          ajustes: resolverAjustes({
            orientacao: 'apontador',
            sensXPixelsPorGrau: 1920 / 45,
            sensYPixelsPorGrau: 1080 / 45,
            zonaMortaGrausPorS: 0.35,
          }),
        }),
      }),
    );
    const invertido = montarQuadro(
      estado({ montagem: montagem({ ajustes: resolverAjustes({ inverterY: true }) }) }),
    );
    const giroDesligado = montarQuadro(
      estado({ montagem: montagem({ ajustes: resolverAjustes({ ativo: false, inverterX: true }) }) }),
    );

    assert.equal(
      linhaRotulada(linhas, 'ajustes'),
      'ajustes     apontador · 42.67/24.00 px/grau · zona morta 0.35 °/s',
    );
    assert.match(linhaRotulada(invertido, 'ajustes'), /· inverte Y$/);
    // Giro desligado vem na frente: é o que explica eixos mexendo com pixels parados, e é a última
    // coisa que um terminal estreito corta (a inversão, no fim, pode sair cortada).
    assert.match(linhaRotulada(giroDesligado, 'ajustes'), /^ajustes {5}giro DESLIGADO · retrato · /);
  });

  it('os cliques e entalhes da sessão, e quantos botões estão presos agora', () => {
    const ensaio = montarQuadro(
      estado({
        montagem: montagem({
          acoes: {
            cliquesNaSessao: 2,
            entalhesVerticaisNaSessao: 4,
            entalhesHorizontaisNaSessao: -1.5,
            presos: 1,
          },
        }),
      }),
    );
    const real = montarQuadro(estado({ montagem: montagem({ cursor: 'real' }) }));

    assert.equal(
      linhaRotulada(ensaio, 'ações'),
      'ações       sessão 2 cliques · entalhes +4.00/-1.50 · presos 1 (ensaio)',
    );
    assert.match(linhaRotulada(real, 'ações'), /sessão 0 cliques · .* \(de verdade\)$/);
  });

  it('sem pipeline, as linhas da cadeia dizem que o movimento está desligado — não mostram zero', () => {
    const linhas = montarQuadro(
      estado({ montagem: montagem({ cursor: 'desligado', ajustes: undefined, pixels: undefined }) }),
    );

    for (const rotulo of ['pixels', 'bias', 'recalib.', 'ajustes']) {
      assert.match(linhaRotulada(linhas, rotulo), /movimento desligado/);
    }
  });
});

describe('a linha do ponteiro (ATI-026)', () => {
  /** A descrição que o backend do Windows daria nesta máquina, com a saída pedida. */
  function ponteiro(parciais: Partial<DescricaoDaSaidaDoMouse> = {}): DescricaoDaSaidaDoMouse {
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

  it('avisa a aceleração ligada e diz que a saída absoluta não passa pela curva', () => {
    const linhas = montarQuadro(estado({ montagem: montagem({ ponteiro: ponteiro() }) }));

    assert.equal(
      linhaRotulada(linhas, 'ponteiro'),
      'ponteiro    aceleração LIGADA · vel. 11/20 · saída absoluto (sem curva)',
    );
  });

  it('relativo com a aceleração ligada diz que distorce', () => {
    const linhas = montarQuadro(
      estado({ montagem: montagem({ ponteiro: ponteiro({ pedido: 'relativo', efetivo: 'relativo' }) }) }),
    );

    assert.equal(
      linhaRotulada(linhas, 'ponteiro'),
      'ponteiro    aceleração LIGADA · vel. 11/20 · saída relativo (DISTORCE)',
    );
  });

  it('com a aceleração desligada e velocidade 10, o relativo é 1:1', () => {
    const linhas = montarQuadro(
      estado({
        montagem: montagem({
          ponteiro: ponteiro({
            efetivo: 'relativo',
            aceleracao: 'desligada',
            velocidade: 10,
            relativoSaiFiel: true,
          }),
        }),
      }),
    );

    assert.equal(
      linhaRotulada(linhas, 'ponteiro'),
      'ponteiro    aceleração desligada · vel. 10/20 · saída relativo (1:1)',
    );
  });

  it('sem backend do Windows a linha continua lá, dizendo que não há leitura', () => {
    const linhas = montarQuadro(estado());

    assert.equal(linhas.length, LINHAS_DO_QUADRO);
    assert.match(linhaRotulada(linhas, 'ponteiro'), /sem leitura do ponteiro/);
  });

  it('no padrão de 78 colunas nenhuma combinação é cortada', () => {
    for (const aceleracao of ['ligada', 'desligada', 'desconhecida'] as const) {
      for (const efetivo of ['absoluto', 'relativo', 'compensado'] as const) {
        for (const velocidade of [1, 10, 20, undefined]) {
          const linhas = montarQuadro(
            estado({ montagem: montagem({ ponteiro: ponteiro({ aceleracao, efetivo, velocidade }) }) }),
          );
          const linha = linhaRotulada(linhas, 'ponteiro');
          assert.ok(!linha.includes(MARCA_DE_CORTE), `linha cortada: "${linha}"`);
        }
      }
    }
  });
});

describe('formatarHora e formatarDataEHora', () => {
  it('hora local com dois dígitos em cada campo', () => {
    assert.equal(formatarHora(new Date(2026, 0, 2, 3, 4, 5).getTime()), '03:04:05');
    assert.equal(formatarDataEHora(new Date(2026, 0, 2, 3, 4, 5).getTime()), '02/01 03:04');
  });

  it('instante desconhecido vira travessão, nunca "NaN:NaN"', () => {
    assert.equal(formatarHora(Number.NaN), '—');
    assert.equal(formatarDataEHora(Number.NaN), '—');
  });
});

describe('largura do quadro', () => {
  /**
   * A regra que a rodada 1 não tinha e que a revisão cobrou (apontamento 1).
   *
   * Linha mais comprida que o terminal quebra sozinha, e cada quebra é uma linha **visual** que o
   * painel não conta ao subir o cursor: o quadro escorrega para baixo e a tela rola. O critério 4
   * da ATI-006 ("não pisca nem gera rolagem") depende disto, então é aqui que ele fica travado.
   */
  const larguras = [LARGURA_DO_PAINEL, 120, 92, 80, 60, 40, 24, 10, 1];

  const cenarios: ReadonlyArray<readonly [string, EstadoDoQuadro]> = [
    ['sem sessão', estado({ sessao: undefined, conexoesAbertas: 0, endereco: undefined })],
    ['sessão realista', estado({ sessao: sessaoAtiva({ pacotesRecebidos: 5996 }) })],
    ['contadores gordos', estado({ sessao: sessaoAtiva(medidasGordas()) })],
    [
      'nome de aparelho e host compridos',
      estado({
        endereco: { host: 'um-host-de-nome-absurdamente-comprido.local', porta: 65535 },
        conexoesAbertas: 12,
        sessao: {
          ...sessaoAtiva(medidasGordas()),
          aparelho: {
            id: 'a1b2c3',
            nome: 'Aparelho Com Nome Muito Muito Muito Comprido De Verdade',
            so: 'android',
            versaoSo: '14',
            modelo: 'GVU6C',
          },
        },
      }),
    ],
    [
      'eixos absurdos',
      estado({
        eixos: { gx: -1e21, gy: 1234567.89, gz: Number.NaN },
        sessao: sessaoAtiva(medidasGordas()),
      }),
    ],
    // Os três nomes escolhidos pelo outro lado do fio, medidos na revisão da rodada 2.
    ['nome com quebra de linha e escape', estado({ sessao: sessaoComNome(NOME_COM_ESCAPE) })],
    ['nome com emoji (largura dupla)', estado({ sessao: sessaoComNome(NOME_COM_EMOJI) })],
    // Sugestão 3 da revisão da rodada 3: o que cresce em ponto de código sem crescer em coluna.
    ['nome de marca combinante (Zalgo)', estado({ sessao: sessaoComNome(NOME_ZALGO) })],
    ['nome só de caractere de controle', estado({ sessao: sessaoComNome('\r\n\u001b[2J') })],
    // ATI-027: o que a montagem põe no quadro, nos números mais largos que ela pode mandar.
    [
      'montagem no limite de cada faixa',
      estado({ sessao: sessaoAtiva(medidasGordas()), montagem: montagemGorda() }),
    ],
    [
      'movimento desligado',
      estado({
        montagem: montagem({ cursor: 'desligado', ajustes: undefined, pixels: undefined }),
      }),
    ],
  ];

  for (const largura of larguras) {
    for (const [nome, base] of cenarios) {
      it(`nenhuma linha passa de ${largura} colunas — ${nome}`, () => {
        for (const linha of montarQuadro({ ...base, largura })) {
          assert.ok(
            larguraDeExibicao(linha) <= largura,
            `linha com ${larguraDeExibicao(linha)} colunas (limite ${largura}): "${linha}"`,
          );
        }
      });

      it(`nenhuma linha passa de ${largura} pontos de código — ${nome}`, () => {
        // A conta em colunas sozinha não limita o **tamanho** da linha: marca combinante custa
        // zero coluna. Num terminal que não compõe a marca (console legado do Windows), cada uma
        // ocupa célula e a linha quebra sozinha — a rolagem da regra 2 por uma terceira porta. Por
        // isso o teto em pontos é o **mesmo número** do teto em colunas: é a largura do terminal
        // valendo para os dois jeitos de o terminal contar.
        for (const linha of montarQuadro({ ...base, largura })) {
          const pontos = Array.from(linha).length;
          assert.ok(pontos <= largura, `linha com ${pontos} pontos de código (limite ${largura})`);
        }
      });

      it(`nenhuma linha carrega controle nem escape a ${largura} colunas — ${nome}`, () => {
        const linhas = montarQuadro({ ...base, largura });

        // Contagem fixa: uma quebra de linha dentro de um campo viraria linha visual a mais, e o
        // painel sobe o cursor por `LINHAS_DO_QUADRO` — a deriva de 5 linhas em 5 quadros que a
        // revisão da rodada 2 mediu vinha exatamente daí.
        assert.equal(linhas.length, LINHAS_DO_QUADRO);
        for (const linha of linhas) {
          assert.doesNotMatch(linha, CONTROLE_OU_ESCAPE, `linha com controle: ${JSON.stringify(linha)}`);
        }
      });
    }
  }

  it('no padrão de 78 colunas nada é cortado numa sessão realista', () => {
    // Cortar é a rede de segurança, não o normal: com o painel na largura de referência, a leitura
    // tem de ser inteira. Se um número novo empurrar a linha, este teste avisa antes do terminal.
    const linhas = montarQuadro(estado({ sessao: sessaoAtiva({ pacotesRecebidos: 5996 }) }));

    for (const linha of linhas) {
      assert.ok(!linha.includes(MARCA_DE_CORTE), `linha cortada no padrão: "${linha}"`);
    }
  });

  it('no padrão de 78 colunas nada da montagem é cortado, em nenhum destino nem origem de bias', () => {
    // As cinco linhas da ATI-027 com uma sessão de ajuste realista: um giro, cliques, bias guardado
    // ou calibrado, a recalibração trabalhando. É o que se olha durante o ajuste — tem de caber.
    const variacoes: InstantaneoDaMontagem[] = [];
    for (const cursor of ['real', 'ensaio'] as const) {
      variacoes.push(montagemRealista({ cursor }));
      variacoes.push(
        montagemRealista({
          cursor,
          bias: { origem: 'calibracao', desdeMs: new Date(2026, 9, 14, 13, 2, 11).getTime() },
        }),
      );
      variacoes.push(montagemRealista({ cursor, bias: { origem: 'nenhuma', desdeMs: Number.NaN } }));
    }
    variacoes.push(montagem({ cursor: 'desligado', ajustes: undefined, pixels: undefined }));

    for (const variacao of variacoes) {
      const linhas = montarQuadro(
        estado({ sessao: sessaoAtiva({ pacotesRecebidos: 5996 }), montagem: variacao }),
      );
      for (const linha of linhas) {
        assert.ok(!linha.includes(MARCA_DE_CORTE), `linha cortada no padrão: "${linha}"`);
      }
    }
  });

  it('a régua ocupa a largura inteira, e só ela', () => {
    const linhas = montarQuadro(estado({ largura: 40 }));

    assert.equal(linhas[1], '-'.repeat(40));
    assert.equal(linhas[4], '-'.repeat(40));
    assert.equal(linhas[8], '-'.repeat(40));
    // 15 e não 14 desde a ATI-026: a linha `ponteiro` entrou no fim do bloco da montagem.
    assert.equal(linhas[15], '-'.repeat(40));
  });

  it('terminal estreito perde a dica de saída antes de perder o nome do modo', () => {
    const estreito = montarQuadro(estado({ largura: 66 }))[0] ?? '';

    assert.ok(estreito.startsWith(`${DESTINO_NO_TITULO.ensaio} · telemetria · painel`));
    assert.ok(!estreito.includes('Ctrl+C'));
  });

  it('terminal mais estreito ainda perde o nome do modo antes de perder o destino (ATI-027)', () => {
    for (const destino of ['real', 'ensaio', 'desligado'] as const) {
      const texto = DESTINO_NO_TITULO[destino];
      // Uma coluna além do destino: o corte come o resto e a marca ocupa a coluna que sobrou.
      const largura = larguraDeExibicao(texto) + 1;
      const titulo = montarQuadro(estado({ largura, montagem: montagem({ cursor: destino }) }))[0];

      assert.equal(titulo, `${texto}${MARCA_DE_CORTE}`);
    }
  });
});

describe('larguraDeTrabalho', () => {
  it('deixa uma coluna de folga, porque escrever na última já quebra a linha', () => {
    assert.equal(larguraDeTrabalho(60), 59);
    assert.equal(larguraDeTrabalho(41), 40);
    assert.equal(larguraDeTrabalho(2), 1);
  });

  it('não estica o quadro num terminal largo', () => {
    assert.equal(larguraDeTrabalho(200), LARGURA_DO_PAINEL);
    assert.equal(larguraDeTrabalho(LARGURA_DO_PAINEL + 1), LARGURA_DO_PAINEL);
  });

  it('sem informação de largura (saída encanada), vale a largura de referência', () => {
    assert.equal(larguraDeTrabalho(undefined), LARGURA_DO_PAINEL);
    assert.equal(larguraDeTrabalho(Number.NaN), LARGURA_DO_PAINEL);
  });

  it('largura absurda não vira largura de referência — vira uma coluna', () => {
    // Sugestão 3 da revisão da rodada 2: "não sei a largura" e "a largura é 0" davam no mesmo, e
    // o quadro escolhia 78 justamente no caso em que 78 é a única largura que não cabe.
    assert.equal(larguraDeTrabalho(1), 1);
    assert.equal(larguraDeTrabalho(0), 1);
    assert.equal(larguraDeTrabalho(-5), 1);
  });
});

describe('truncarNaLargura', () => {
  it('texto que cabe passa inteiro, sem marca nenhuma', () => {
    assert.equal(sanitizarTextoDoFio('a\u200Db\u2060c', 40), 'abc', 'junção e juntador');
    assert.equal(truncarNaLargura('abc', 10), 'abc');
  });

  it('texto que não cabe sai na largura pedida, com a marca do corte', () => {
    assert.equal(truncarNaLargura('abcdef', 4), `abc${MARCA_DE_CORTE}`);
    assert.equal(truncarNaLargura('abcdef', 1), MARCA_DE_CORTE);
    assert.equal(truncarNaLargura('abcdef', 0), '');
  });

  it('conta coluna de exibição, não ponto de código: o emoji vale por dois', () => {
    // `·`, `±`, `°` e `—` aparecem no quadro e valem uma coluna cada; o emoji vale duas, e é o
    // caso que a revisão da rodada 2 mediu: 67 pontos de código ocupando 77 colunas.
    const cortado = truncarNaLargura('ação · 🙂 fim', 9);

    assert.equal(larguraDeExibicao(cortado), 8, 'o 🙂 não cabia nas 8 colunas antes da marca');
    assert.equal(cortado, `ação · ${MARCA_DE_CORTE}`);
    // Nenhum par substituto solto: o texto sobrevive à ida e volta pela codificação.
    assert.equal(cortado, Buffer.from(cortado, 'utf8').toString('utf8'));

    // Uma coluna a mais e o emoji entra inteiro — nunca pela metade.
    assert.equal(truncarNaLargura('ação · 🙂 fim', 10), `ação · 🙂${MARCA_DE_CORTE}`);
  });

  it('emoji seguido só é cortado em par, sempre dentro da largura', () => {
    assert.equal(truncarNaLargura('🙂🙂🙂🙂', 5), `🙂🙂${MARCA_DE_CORTE}`);
    assert.equal(larguraDeExibicao(truncarNaLargura('🙂🙂🙂🙂', 5)), 5);
    assert.equal(larguraDeExibicao(truncarNaLargura('🙂🙂🙂🙂', 4)), 3);
  });

  it('o teto de pontos corta o que a conta de colunas deixaria passar', () => {
    // Sem o segundo teto, `'Z' + 5 000 marcas` passava inteiro: 5 001 pontos de código contados
    // como uma coluna. O teto de pontos vale mesmo quando o de colunas nem chega perto.
    const cortado = truncarNaLargura(NOME_ZALGO, 40, 10);

    assert.equal(Array.from(cortado).length, 10, 'nove pontos do texto mais a marca');
    assert.ok(cortado.endsWith(MARCA_DE_CORTE), 'o corte fica visível, como no corte por coluna');
    assert.ok(larguraDeExibicao(cortado) < 40, 'a largura nunca era o problema deste texto');
  });

  it('sem teto de pontos, o comportamento antigo continua valendo', () => {
    // Duas coisas de uma vez: o parâmetro é opcional (quem chama com dois argumentos não muda de
    // vida) e texto que cabe em colunas passa inteiro por mais pontos que tenha.
    assert.equal(truncarNaLargura(NOME_ZALGO, 40), NOME_ZALGO);
    assert.equal(truncarNaLargura('abc', 10), truncarNaLargura('abc', 10, 100));
  });
});

describe('larguraDeExibicao', () => {
  it('ASCII e os sinais do painel valem uma coluna cada', () => {
    assert.equal(larguraDeExibicao('abc'), 3);
    assert.equal(larguraDeExibicao('· ± ° — …'), 9);
    assert.equal(larguraDeExibicao(''), 0);
  });

  it('emoji e ideograma valem duas colunas', () => {
    assert.equal(larguraDeExibicao('🙂'), 2);
    assert.equal(larguraDeExibicao('日本語'), 6);
    assert.equal(larguraDeExibicao(NOME_COM_EMOJI), 35, '15 letras + 10 emoji de 2 colunas');
  });

  it('acento combinante desenha em cima do anterior e não ocupa coluna', () => {
    // "a" + U+0301 (acento agudo combinante) sai como "á": duas unidades, uma coluna.
    assert.equal(larguraDeExibicao('á'), 1);
  });
});

describe('sanitizarTextoDoFio', () => {
  it('derruba a quebra de linha que empurrava o quadro para baixo', () => {
    // Medido na revisão da rodada 2: um `\n` no nome fazia o quadro ter 15 linhas visuais, o
    // painel subia 13 e a tela derivava 5 linhas em 5 quadros.
    const limpo = sanitizarTextoDoFio('Pixel\ndo Kaio', LIMITE_DO_NOME_DO_APARELHO);

    assert.equal(limpo, 'Pixeldo Kaio');
    assert.ok(!limpo.includes('\n'));
  });

  it('derruba a sequência ANSI inteira, e não só o ESC', () => {
    // O ponto do "inteira": tirar só o `ESC` deixaria `[2J` escrito na tela como texto.
    const limpo = sanitizarTextoDoFio(NOME_COM_ESCAPE, LIMITE_DO_NOME_DO_APARELHO);

    assert.equal(limpo, 'PixelFALSO');
    assert.doesNotMatch(limpo, CONTROLE_OU_ESCAPE);
    assert.ok(!limpo.includes('[2J'), 'o miolo da sequência também sai');
    assert.ok(!limpo.includes('[10B'));
  });

  it('derruba as outras famílias de escape que o terminal também interpreta', () => {
    // OSC (título de janela), Fs de um byte só (reset) e ESC solto.
    assert.equal(sanitizarTextoDoFio('a\u001b]0;título do terminal\u0007b', 40), 'ab', 'OSC');
    assert.equal(sanitizarTextoDoFio('a\u001bcb', 40), 'ab', 'Fs de um byte (reset)');
    // O terminal também come o byte seguinte a um ESC — é ele que fecha a sequência.
    assert.equal(sanitizarTextoDoFio('a\u001bb', 40), 'a', 'ESC leva o byte seguinte junto');
    assert.equal(sanitizarTextoDoFio('ab\u001b', 40), 'ab', 'ESC no fim, sem byte para levar');
    assert.equal(sanitizarTextoDoFio('a\u001b[31mvermelho\u001b[0mb', 40), 'avermelhob', 'cor');
  });

  it('derruba invisível que mexe no layout sem aparecer: BOM, direção e largura zero', () => {
    assert.equal(sanitizarTextoDoFio('a\uFEFFb\u200Bc\u202Ed', 40), 'abcd', 'BOM, largura zero, direção');
    assert.equal(sanitizarTextoDoFio('a\u200Db\u2060c', 40), 'abc', 'junção e juntador');
    assert.equal(sanitizarTextoDoFio('a\u2028b', 40), 'ab', 'separador de linha, que é \\n por outro nome');
  });

  it('corta no teto de colunas do campo, para o resto da linha não sumir', () => {
    const comprido = 'Aparelho Com Nome Muito Muito Comprido';
    const limpo = sanitizarTextoDoFio(comprido, LIMITE_DO_NOME_DO_APARELHO);

    assert.equal(larguraDeExibicao(limpo), LIMITE_DO_NOME_DO_APARELHO);
    assert.ok(limpo.endsWith(MARCA_DE_CORTE));
  });

  it('nome legível e dentro do teto passa exatamente como veio', () => {
    assert.equal(sanitizarTextoDoFio('Pixel 8 Pro', LIMITE_DO_NOME_DO_APARELHO), 'Pixel 8 Pro');
    assert.equal(
      sanitizarTextoDoFio('Samsung Galaxy S23 Ultra', LIMITE_DO_NOME_DO_APARELHO),
      'Samsung Galaxy S23 Ultra',
      'o teto foi escolhido para caber este nome inteiro',
    );
  });

  it('mede o corte em colunas, então dez emoji não passam por 10 caracteres', () => {
    const limpo = sanitizarTextoDoFio(NOME_COM_EMOJI, LIMITE_DO_NOME_DO_APARELHO);

    assert.equal(larguraDeExibicao(limpo), LIMITE_DO_NOME_DO_APARELHO);
    assert.ok(Array.from(limpo).length < LIMITE_DO_NOME_DO_APARELHO, 'menos pontos que colunas');
  });

  it('também tem teto em pontos de código: marca combinante não faz texto sem fim', () => {
    // Sugestão 3 da revisão da rodada 3, medida por ela: 'Z' + U+0301 ×5000 = 5 041 pontos de
    // código que a conta de colunas via como 41. Em terminal que não compõe a marca, isso é uma
    // linha de 5 041 células — a mesma rolagem, por uma terceira porta.
    const limpo = sanitizarTextoDoFio(NOME_ZALGO, LIMITE_DO_NOME_DO_APARELHO);

    assert.ok(Array.from(NOME_ZALGO).length > 5000, 'o texto que entrou era o do parecer');
    assert.equal(larguraDeExibicao(NOME_ZALGO), 1, 'e ele passava por uma coluna só');
    assert.ok(
      Array.from(limpo).length <= LIMITE_DO_NOME_DO_APARELHO,
      `sobraram ${Array.from(limpo).length} pontos de código (teto ${LIMITE_DO_NOME_DO_APARELHO})`,
    );
    assert.ok(limpo.startsWith('Z'), 'o que dava para ler continua legível');
  });

  it('nome com acento decomposto legítimo passa inteiro — o teto não é caça à marca', () => {
    // "José" com acento decomposto gasta um ponto de código a mais do que ocupa em coluna. É o
    // preço do teto de pontos, e é barato: só cobra de quem está exatamente no limite. Derrubar a
    // marca combinante resolveria a sugestão 3 e estragaria este nome, que é legítimo e comum.
    const decomposto = `Jose${MARCA_COMBINANTE} do Kaio`;

    assert.equal(sanitizarTextoDoFio(decomposto, LIMITE_DO_NOME_DO_APARELHO), decomposto);
    assert.equal(larguraDeExibicao(decomposto), 12, 'a marca não ocupa coluna');
    assert.equal(Array.from(decomposto).length, 13, 'mas ocupa um ponto de código');
  });
});

describe('nome de aparelho no quadro', () => {
  /** Linha `sessão` do quadro (índice 3 — ver a ordem em `montarQuadro`). */
  function linhaDaSessao(sessao: InstantaneoDaSessao, largura = LARGURA_DO_PAINEL): string {
    return montarQuadro(estado({ sessao, largura }))[3] ?? '';
  }

  it('o `\\n` no nome não vira linha a mais no quadro', () => {
    const linhas = montarQuadro(estado({ sessao: sessaoComNome(NOME_COM_ESCAPE) }));

    assert.equal(linhas.length, LINHAS_DO_QUADRO);
    assert.equal(linhas.join('\n').split('\n').length, LINHAS_DO_QUADRO);
  });

  it('o `ESC[2J` no nome não chega ao terminal', () => {
    // O byte que a entrega da rodada 2 contava como 0 ocorrências para provar que o painel não
    // pisca — e que a revisão fez aparecer 5 vezes só escolhendo o nome do aparelho.
    const linha = linhaDaSessao(sessaoComNome(NOME_COM_ESCAPE));

    assert.ok(!linha.includes('\u001b'), 'nenhum ESC');
    assert.ok(!linha.includes('[2J'), 'nem o miolo da sequência');
    assert.match(linha, /PixelFALSO/, 'o que sobrou do nome continua legível');
  });

  it('nome que era só controle vira aviso, não campo vazio', () => {
    const linha = linhaDaSessao(sessaoComNome('\r\n\u001b[2J'));

    assert.ok(linha.includes(NOME_ILEGIVEL), `linha sem o aviso: "${linha}"`);
    // Campo vazio daria "s-1 · ativa ·  · usb", que quem depura leria como "não mandou nome".
    assert.ok(!linha.includes('·  ·'));
  });

  it('o nome não empurra o resto da linha para fora do quadro', () => {
    const linha = linhaDaSessao(sessaoComNome('N'.repeat(200)));

    assert.ok(larguraDeExibicao(linha) <= LARGURA_DO_PAINEL);
    assert.match(linha, /usb/, 'transporte continua visível');
    assert.match(linha, /0\.0 s/, 'duração continua visível');
  });

  it('nome de marca combinante não vira linha de milhares de caracteres', () => {
    // O caso da sugestão 3, medido pela revisão da rodada 3 pelo caminho de verdade: a linha
    // `sessão` chegava a 5 041 pontos de código contados como 45 colunas.
    const linha = linhaDaSessao(sessaoComNome(NOME_ZALGO));

    assert.ok(larguraDeExibicao(linha) <= LARGURA_DO_PAINEL, 'em colunas, como sempre foi');
    assert.ok(
      Array.from(linha).length <= LARGURA_DO_PAINEL,
      `linha com ${Array.from(linha).length} pontos de código`,
    );
    assert.match(linha, /usb/, 'transporte continua visível');
  });
});
