/**
 * Teste do codec binário.
 *
 * Três redes de proteção diferentes, de propósito:
 *
 * 1. **Vetores de bytes fixos** (`VETORES`). Escritos à mão a partir das tabelas do
 *    PROTOCOLO.md, com valores cujo IEEE-754 é derivável no papel (potências de dois e somas
 *    simples). Um teste de ida e volta sozinho passaria feliz mesmo se o codificador e o
 *    decodificador combinassem o offset errado entre si; o vetor fixo não deixa.
 * 2. **A mesma tabela existe em `app/__tests__/protocolo.test.ts`.** É isso que impede os dois
 *    lados de divergirem em silêncio. Mudou aqui, muda lá — e muda o PROTOCOLO.md.
 * 3. **Ida e volta** para cada tipo, nos limites: `seq` dando a volta em 65535, negativos,
 *    NaN, infinito, truncado, tipo desconhecido.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  copiar,
  criarCodificador,
  criarDecodificador,
  criarPacoteDecodificado,
} from './binario.js';
import {
  FLAG_ACELEROMETRO,
  FLAG_GATILHO_GIRO,
  FLAG_PRIMEIRA_APOS_RETOMAR,
  PADROES_HAPTICOS,
  RESULTADO_DECODIFICACAO,
  SEQ_MAXIMO,
  TAMANHO_BOTAO,
  TAMANHO_EIXO,
  TAMANHO_HAPTICO,
  TAMANHO_MOVIMENTO,
  TAMANHO_MOVIMENTO_COM_ACELEROMETRO,
  TAMANHO_RUMBLE,
  TAMANHO_SCROLL,
  TIPO_BOTAO,
  TIPO_EIXO,
  TIPO_HAPTICO,
  TIPO_MOVIMENTO,
  TIPO_RUMBLE,
  TIPO_SCROLL,
  nomeDoPadraoHaptico,
  proximoSeq,
} from './tipos.js';

/* ============================================================ vetores de bytes fixos */

/**
 * ⚠️ ESPELHO: esta tabela existe **idêntica** em `app/__tests__/protocolo.test.ts`.
 * Mudou um byte aqui, muda lá e muda `docs/PROTOCOLO.md` — na mesma entrega.
 *
 * Os floats foram escolhidos por serem exatos em f32 e conferíveis no papel:
 * 10 = 0x41200000 · 0,5 = 0x3F000000 · −0,25 = 0xBE800000 · 9,75 = 0x411C0000 ·
 * −1,5 = 0xBFC00000 · 2,25 = 0x40100000 · −0,0625 = 0xBD800000 · −9,5 = 0xC1180000 ·
 * −1 = 0xBF800000 · 0,75 = 0x3F400000 · −3,5 = 0xC0600000 · 1 = 0x3F800000 ·
 * +∞ = 0x7F800000 · −∞ = 0xFF800000. Little-endian inverte os quatro bytes de cada um.
 */
const VETORES = {
  /** MOVIMENTO 24 B: flags=gatilho, seq=258, t=66051, dt=10, g=(0,5; −0,25; 0). */
  movimento: '0102020103020100000020410000003f000080be00000000',
  /** MOVIMENTO 36 B: flags=acel+retomar, seq=65535, t=0xFFFFFFFF, dt=9,75. */
  movimentoComAcelerometro:
    '0105ffffffffffff00001c410000c0bf00001040000080bd00000000000018c100001c41',
  /** MOVIMENTO 24 B com dt=+∞ e gx=−∞ — o fio aceita, quem decide é o pipeline. */
  movimentoComInfinito: '01000000000000000000807f000080ff0000803f000080bf',
  /** BOTÃO: pressionado, seq=1000, idControle=513, pressao=255. */
  botao: '0201e8030102ff00',
  /** BOTÃO com `estado` fora do conjunto {0,1}: byte 7 no lugar do 1 — tem de ler como solto. */
  botaoEstadoInvalido: '0207e8030102ff00',
  /** EIXO: seq=2, idControle=7, x=−1, y=0,75. */
  eixo: '0300020007000000000080bf0000403f',
  /** SCROLL: seq=65535, vertical=−3,5, horizontal=1. */
  scroll: '0400ffff000060c00000803f',
  /** RUMBLE: forte=200, fraco=32, duracao=250 ms. */
  rumble: '81c82000fa000000',
  /** HÁPTICO: padrao=tick(2), intensidade=128. */
  haptico: '82028000',
} as const;

function deHex(texto: string): Uint8Array {
  const bytes = new Uint8Array(texto.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(texto.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function paraHex(bytes: Uint8Array): string {
  let saida = '';
  for (const byte of bytes) saida += byte.toString(16).padStart(2, '0');
  return saida;
}

/* ================================================================ tamanhos das tabelas */

describe('tamanhos conferem com as tabelas do PROTOCOLO.md', () => {
  const codificador = criarCodificador();

  it('cada tipo produz exatamente o número de bytes documentado', () => {
    assert.equal(codificador.movimento(1, 2, 3, 4, 5, 6).byteLength, 24);
    assert.equal(TAMANHO_MOVIMENTO, 24);

    assert.equal(
      codificador.movimentoComAcelerometro(1, 2, 3, 4, 5, 6, 7, 8, 9).byteLength,
      36,
    );
    assert.equal(TAMANHO_MOVIMENTO_COM_ACELEROMETRO, 36);

    assert.equal(codificador.botao(1, 2, true).byteLength, 8);
    assert.equal(TAMANHO_BOTAO, 8);

    assert.equal(codificador.eixo(1, 2, 0, 0).byteLength, 16);
    assert.equal(TAMANHO_EIXO, 16);

    assert.equal(codificador.scroll(1, 0, 0).byteLength, 12);
    assert.equal(TAMANHO_SCROLL, 12);

    assert.equal(codificador.rumble(0, 0, 0).byteLength, 8);
    assert.equal(TAMANHO_RUMBLE, 8);

    assert.equal(codificador.haptico(1, 0).byteLength, 4);
    assert.equal(TAMANHO_HAPTICO, 4);
  });

  it('os códigos de tipo são os da tabela', () => {
    assert.equal(TIPO_MOVIMENTO, 0x01);
    assert.equal(TIPO_BOTAO, 0x02);
    assert.equal(TIPO_EIXO, 0x03);
    assert.equal(TIPO_SCROLL, 0x04);
    assert.equal(TIPO_RUMBLE, 0x81);
    assert.equal(TIPO_HAPTICO, 0x82);
  });

  it('os bits de flags são os da tabela', () => {
    assert.equal(FLAG_ACELEROMETRO, 1);
    assert.equal(FLAG_GATILHO_GIRO, 2);
    assert.equal(FLAG_PRIMEIRA_APOS_RETOMAR, 4);
  });

  it('os padrões hápticos são os da tabela 5.2', () => {
    assert.deepEqual({ ...PADROES_HAPTICOS }, {
      click: 1,
      tick: 2,
      sucesso: 3,
      erro: 4,
      aviso: 5,
    });
    assert.equal(nomeDoPadraoHaptico(2), 'tick');
    assert.equal(nomeDoPadraoHaptico(9), undefined);
  });
});

/* =============================================================== escrita: vetor a vetor */

describe('o codificador produz exatamente os bytes do vetor fixo', () => {
  const codificador = criarCodificador();

  it('MOVIMENTO sem acelerômetro', () => {
    const bytes = codificador.movimento(258, 66051, 10, 0.5, -0.25, 0, FLAG_GATILHO_GIRO);
    assert.equal(paraHex(bytes), VETORES.movimento);
  });

  it('MOVIMENTO com acelerômetro', () => {
    const bytes = codificador.movimentoComAcelerometro(
      65535,
      0xffffffff,
      9.75,
      -1.5,
      2.25,
      -0.0625,
      0,
      -9.5,
      9.75,
      FLAG_PRIMEIRA_APOS_RETOMAR,
    );
    assert.equal(paraHex(bytes), VETORES.movimentoComAcelerometro);
  });

  it('MOVIMENTO com infinito', () => {
    const bytes = codificador.movimento(0, 0, Number.POSITIVE_INFINITY, -Infinity, 1, -1);
    assert.equal(paraHex(bytes), VETORES.movimentoComInfinito);
  });

  it('BOTÃO', () => {
    assert.equal(paraHex(codificador.botao(1000, 513, true, 255)), VETORES.botao);
  });

  it('EIXO', () => {
    assert.equal(paraHex(codificador.eixo(2, 7, -1, 0.75)), VETORES.eixo);
  });

  it('SCROLL', () => {
    assert.equal(paraHex(codificador.scroll(65535, -3.5, 1)), VETORES.scroll);
  });

  it('RUMBLE', () => {
    assert.equal(paraHex(codificador.rumble(200, 32, 250)), VETORES.rumble);
  });

  it('HÁPTICO', () => {
    assert.equal(paraHex(codificador.haptico(PADROES_HAPTICOS.tick, 128)), VETORES.haptico);
  });
});

/* ================================================================ leitura: vetor a vetor */

describe('o decodificador lê exatamente os campos do vetor fixo', () => {
  const decodificador = criarDecodificador();

  it('MOVIMENTO sem acelerômetro', () => {
    const r = decodificador.decodificar(deHex(VETORES.movimento));
    const p = decodificador.saida;
    assert.equal(r, RESULTADO_DECODIFICACAO.OK);
    assert.equal(p.tipo, TIPO_MOVIMENTO);
    assert.equal(p.tamanho, 24);
    assert.equal(p.flags, FLAG_GATILHO_GIRO);
    assert.equal(p.seq, 258);
    assert.equal(p.tDispositivoMs, 66051);
    assert.equal(p.dtMs, 10);
    assert.equal(p.gx, 0.5);
    assert.equal(p.gy, -0.25);
    assert.equal(p.gz, 0);
    assert.equal(p.temAcelerometro, false);
    // Campos de outro tipo ficam zerados — sobra do pacote anterior não passa por dado novo.
    assert.equal(p.ax, 0);
    assert.equal(p.idControle, 0);
  });

  it('MOVIMENTO com acelerômetro', () => {
    const r = decodificador.decodificar(deHex(VETORES.movimentoComAcelerometro));
    const p = decodificador.saida;
    assert.equal(r, RESULTADO_DECODIFICACAO.OK);
    assert.equal(p.tamanho, 36);
    assert.equal(p.flags, FLAG_ACELEROMETRO | FLAG_PRIMEIRA_APOS_RETOMAR);
    assert.equal(p.seq, 65535);
    assert.equal(p.tDispositivoMs, 4294967295);
    assert.equal(p.dtMs, 9.75);
    assert.equal(p.gx, -1.5);
    assert.equal(p.gy, 2.25);
    assert.equal(p.gz, -0.0625);
    assert.equal(p.temAcelerometro, true);
    assert.equal(p.ax, 0);
    assert.equal(p.ay, -9.5);
    assert.equal(p.az, 9.75);
  });

  it('MOVIMENTO com infinito', () => {
    decodificador.decodificar(deHex(VETORES.movimentoComInfinito));
    const p = decodificador.saida;
    assert.equal(p.dtMs, Number.POSITIVE_INFINITY);
    assert.equal(p.gx, Number.NEGATIVE_INFINITY);
    assert.equal(p.gy, 1);
    assert.equal(p.gz, -1);
  });

  it('BOTÃO', () => {
    decodificador.decodificar(deHex(VETORES.botao));
    const p = decodificador.saida;
    assert.equal(p.tipo, TIPO_BOTAO);
    assert.equal(p.tamanho, 8);
    assert.equal(p.estado, 1);
    assert.equal(p.pressionado, true);
    assert.equal(p.seq, 1000);
    assert.equal(p.idControle, 513);
    assert.equal(p.pressao, 255);
    assert.equal(p.gx, 0);
  });

  it('BOTÃO com estado fora do conjunto {0,1} é lido como SOLTO', () => {
    // Regra 5 do CLAUDE.md: na dúvida, solto. Um byte corrompido num pacote de soltura não
    // pode virar "continua pressionado" — botão preso é o pior defeito possível aqui.
    decodificador.decodificar(deHex(VETORES.botaoEstadoInvalido));
    const p = decodificador.saida;
    assert.equal(p.estado, 7, 'o byte cru continua disponível para diagnóstico');
    assert.equal(p.pressionado, false, 'só o 1 é pressionado (PROTOCOLO.md, seção 4.2)');
  });

  it('EIXO', () => {
    decodificador.decodificar(deHex(VETORES.eixo));
    const p = decodificador.saida;
    assert.equal(p.tipo, TIPO_EIXO);
    assert.equal(p.tamanho, 16);
    assert.equal(p.seq, 2);
    assert.equal(p.idControle, 7);
    assert.equal(p.x, -1);
    assert.equal(p.y, 0.75);
  });

  it('SCROLL', () => {
    decodificador.decodificar(deHex(VETORES.scroll));
    const p = decodificador.saida;
    assert.equal(p.tipo, TIPO_SCROLL);
    assert.equal(p.tamanho, 12);
    assert.equal(p.seq, 65535);
    assert.equal(p.deltaVertical, -3.5);
    assert.equal(p.deltaHorizontal, 1);
  });

  it('RUMBLE', () => {
    decodificador.decodificar(deHex(VETORES.rumble));
    const p = decodificador.saida;
    assert.equal(p.tipo, TIPO_RUMBLE);
    assert.equal(p.tamanho, 8);
    assert.equal(p.motorForte, 200);
    assert.equal(p.motorFraco, 32);
    assert.equal(p.duracaoMs, 250);
  });

  it('HÁPTICO', () => {
    decodificador.decodificar(deHex(VETORES.haptico));
    const p = decodificador.saida;
    assert.equal(p.tipo, TIPO_HAPTICO);
    assert.equal(p.tamanho, 4);
    assert.equal(p.padrao, PADROES_HAPTICOS.tick);
    assert.equal(p.intensidade, 128);
  });
});

/* ============================================================================ ida e volta */

describe('ida e volta de todos os tipos', () => {
  const codificador = criarCodificador();
  const decodificador = criarDecodificador();

  it('MOVIMENTO com valores fracionários (f32 arredonda, e é o combinado)', () => {
    const dt = 9.987654;
    const gx = 0.1234567;
    const gy = -3.14159265;
    const gz = 1e-7;
    codificador.movimento(41234, 123456789, dt, gx, gy, gz, FLAG_GATILHO_GIRO);
    decodificador.decodificar(codificador.bytes.subarray(0, TAMANHO_MOVIMENTO));
    const p = decodificador.saida;
    assert.equal(p.seq, 41234);
    assert.equal(p.tDispositivoMs, 123456789);
    assert.equal(p.dtMs, Math.fround(dt));
    assert.equal(p.gx, Math.fround(gx));
    assert.equal(p.gy, Math.fround(gy));
    assert.equal(p.gz, Math.fround(gz));
  });

  it('MOVIMENTO com acelerômetro leva os seis eixos de volta', () => {
    const pacote = codificador.movimentoComAcelerometro(
      7,
      8,
      10.5,
      -0.5,
      0.25,
      -0.125,
      1.5,
      -2,
      9.75,
    );
    decodificador.decodificar(pacote);
    const p = decodificador.saida;
    assert.equal(p.temAcelerometro, true);
    assert.deepEqual(
      [p.gx, p.gy, p.gz, p.ax, p.ay, p.az],
      [-0.5, 0.25, -0.125, 1.5, -2, 9.75],
    );
  });

  it('BOTÃO leva estado, id e pressão de volta', () => {
    for (const pressionado of [true, false]) {
      decodificador.decodificar(codificador.botao(9, 65535, pressionado, 7));
      const p = decodificador.saida;
      assert.equal(p.estado, pressionado ? 1 : 0);
      assert.equal(p.pressionado, pressionado);
      assert.equal(p.idControle, 65535);
      assert.equal(p.pressao, 7);
    }
  });

  it('EIXO leva os extremos de −1 a 1 de volta', () => {
    decodificador.decodificar(codificador.eixo(3, 12, -1, 1));
    assert.equal(decodificador.saida.x, -1);
    assert.equal(decodificador.saida.y, 1);
  });

  it('SCROLL leva delta fracionário e negativo de volta', () => {
    decodificador.decodificar(codificador.scroll(4, -0.25, 2.5));
    assert.equal(decodificador.saida.deltaVertical, -0.25);
    assert.equal(decodificador.saida.deltaHorizontal, 2.5);
  });

  it('RUMBLE leva os dois motores e a duração de volta', () => {
    decodificador.decodificar(codificador.rumble(255, 0, 65535));
    const p = decodificador.saida;
    assert.equal(p.motorForte, 255);
    assert.equal(p.motorFraco, 0);
    assert.equal(p.duracaoMs, 65535);
  });

  it('HÁPTICO leva padrão e intensidade de volta', () => {
    for (const nome of ['click', 'tick', 'sucesso', 'erro', 'aviso'] as const) {
      decodificador.decodificar(codificador.haptico(PADROES_HAPTICOS[nome], 200));
      assert.equal(nomeDoPadraoHaptico(decodificador.saida.padrao), nome);
      assert.equal(decodificador.saida.intensidade, 200);
    }
  });

  it('aceita um destino fornecido pelo chamador, em vez do interno', () => {
    const meuPacote = criarPacoteDecodificado();
    decodificador.decodificar(codificador.botao(1, 2, true, 3), meuPacote);
    assert.equal(meuPacote.idControle, 2);
    // O objeto interno não foi tocado nesta chamada.
    assert.notEqual(decodificador.saida, meuPacote);
  });
});

/* ======================================================================= casos de limite */

describe('limites numéricos', () => {
  const codificador = criarCodificador();
  const decodificador = criarDecodificador();

  it('seq dá a volta em 65535, como manda a seção 4.1', () => {
    assert.equal(proximoSeq(SEQ_MAXIMO), 0);
    assert.equal(proximoSeq(0), 1);

    for (const [enviado, esperado] of [
      [65535, 65535],
      [65536, 0],
      [65537, 1],
      [131071, 65535],
      [131072, 0],
    ] as const) {
      decodificador.decodificar(codificador.botao(enviado, 1, true));
      assert.equal(decodificador.saida.seq, esperado, `seq ${enviado}`);
    }
  });

  it('tDispositivoMs é u32 cíclico: 2^32 volta para 0', () => {
    decodificador.decodificar(codificador.movimento(0, 4294967296, 1, 0, 0, 0));
    assert.equal(decodificador.saida.tDispositivoMs, 0);
    decodificador.decodificar(codificador.movimento(0, 4294967295, 1, 0, 0, 0));
    assert.equal(decodificador.saida.tDispositivoMs, 4294967295);
  });

  it('campo inteiro fora da faixa satura, em vez de truncar em silêncio', () => {
    decodificador.decodificar(codificador.botao(1, 70000, true, 300));
    assert.equal(decodificador.saida.idControle, 65535);
    assert.equal(decodificador.saida.pressao, 255);

    decodificador.decodificar(codificador.botao(1, -5, true, -1));
    assert.equal(decodificador.saida.idControle, 0);
    assert.equal(decodificador.saida.pressao, 0);

    decodificador.decodificar(codificador.rumble(Number.NaN, Infinity, -Infinity));
    assert.equal(decodificador.saida.motorForte, 0);
    assert.equal(decodificador.saida.motorFraco, 255);
    assert.equal(decodificador.saida.duracaoMs, 0);
  });

  it('NaN e infinito atravessam os campos f32 sem virar exceção', () => {
    decodificador.decodificar(
      codificador.movimento(1, 1, Number.NaN, Infinity, -Infinity, -0),
    );
    const p = decodificador.saida;
    assert.ok(Number.isNaN(p.dtMs), 'dtMs deveria voltar NaN');
    assert.equal(p.gx, Number.POSITIVE_INFINITY);
    assert.equal(p.gy, Number.NEGATIVE_INFINITY);
    assert.ok(Object.is(p.gz, -0), 'zero negativo deveria sobreviver');
  });

  it('valores negativos nos eixos e no scroll sobrevivem à ida e volta', () => {
    decodificador.decodificar(codificador.eixo(1, 1, -0.5, -1));
    assert.equal(decodificador.saida.x, -0.5);
    assert.equal(decodificador.saida.y, -1);

    decodificador.decodificar(codificador.scroll(1, -128.25, -0.5));
    assert.equal(decodificador.saida.deltaVertical, -128.25);
    assert.equal(decodificador.saida.deltaHorizontal, -0.5);
  });

  it('o bit0 de flags nunca mente sobre o tamanho do pacote', () => {
    // Quem chama pede acelerômetro no pacote de 24 bytes: o bit é apagado.
    const curto = codificador.movimento(1, 1, 1, 0, 0, 0, FLAG_ACELEROMETRO | FLAG_GATILHO_GIRO);
    assert.equal(curto.byteLength, 24);
    assert.equal(curto[1], FLAG_GATILHO_GIRO);

    // E quem esquece o bit no pacote de 36 bytes: o bit é aceso.
    const longo = codificador.movimentoComAcelerometro(1, 1, 1, 0, 0, 0, 0, 0, 0, 0);
    assert.equal(longo.byteLength, 36);
    assert.equal(longo[1], FLAG_ACELEROMETRO);
  });
});

/* ==================================================================== pacote defeituoso */

describe('pacote defeituoso é descartado e contabilizado, sem exceção', () => {
  it('pacote truncado em qualquer tamanho é recusado', () => {
    const decodificador = criarDecodificador();
    const codificador = criarCodificador();
    const inteiro = copiar(codificador.movimentoComAcelerometro(1, 2, 3, 4, 5, 6, 7, 8, 9));

    for (let tamanho = 0; tamanho < inteiro.byteLength; tamanho += 1) {
      const resultado = decodificador.decodificar(inteiro.subarray(0, tamanho));
      // Abaixo de 24 bytes falta até o cabeçalho; entre 24 e 35, falta o acelerômetro
      // prometido pelo bit0. Nos dois casos o veredito é o mesmo.
      assert.equal(
        resultado,
        RESULTADO_DECODIFICACAO.TAMANHO_INVALIDO,
        `tamanho ${tamanho} deveria ser recusado`,
      );
    }
    assert.equal(decodificador.contadores.descartadosPorTamanho, inteiro.byteLength);
    assert.equal(decodificador.contadores.pacotesRecebidos, 0);
  });

  it('quadro vazio é recusado sem estourar', () => {
    const decodificador = criarDecodificador();
    assert.equal(
      decodificador.decodificar(new Uint8Array(0)),
      RESULTADO_DECODIFICACAO.TAMANHO_INVALIDO,
    );
  });

  it('tipo desconhecido é descartado, não derruba nada (seção 6, regra 2)', () => {
    const decodificador = criarDecodificador();
    for (const tipo of [0x00, 0x05, 0x7f, 0x80, 0x83, 0xff]) {
      const bytes = new Uint8Array(36);
      bytes[0] = tipo;
      assert.equal(
        decodificador.decodificar(bytes),
        RESULTADO_DECODIFICACAO.TIPO_DESCONHECIDO,
        `tipo 0x${tipo.toString(16)}`,
      );
    }
    assert.equal(decodificador.contadores.descartadosPorTipo, 6);
    assert.equal(decodificador.contadores.pacotesRecebidos, 0);
  });

  it('bytes sobrando no fim são ignorados e contados (evolução da seção 6, regra 1)', () => {
    const decodificador = criarDecodificador();
    const codificador = criarCodificador();
    const comSobra = new Uint8Array(TAMANHO_BOTAO + 4);
    comSobra.set(codificador.botao(5, 6, true, 7));

    assert.equal(decodificador.decodificar(comSobra), RESULTADO_DECODIFICACAO.OK);
    assert.equal(decodificador.saida.idControle, 6);
    assert.equal(decodificador.saida.tamanho, TAMANHO_BOTAO);
    assert.equal(decodificador.contadores.comBytesExtras, 1);
  });

  it('MOVIMENTO de 30 bytes com bit0 em 0 é pacote de 24 com 6 bytes do futuro', () => {
    // É o caso que a seção 4.0 (regra 3) e a 4.1 discordavam antes desta entrega. Vale a 4.0:
    // menos que a tabela é descarte, mais é aceito com o excedente contado.
    const decodificador = criarDecodificador();
    const codificador = criarCodificador();
    const comSobra = new Uint8Array(TAMANHO_MOVIMENTO + 6);
    comSobra.set(codificador.movimento(77, 88, 1, 0.5, 0, 0));

    assert.equal(decodificador.decodificar(comSobra), RESULTADO_DECODIFICACAO.OK);
    assert.equal(decodificador.saida.tamanho, TAMANHO_MOVIMENTO);
    assert.equal(decodificador.saida.seq, 77);
    assert.equal(decodificador.saida.gx, 0.5);
    assert.equal(decodificador.saida.temAcelerometro, false);
    assert.equal(decodificador.contadores.comBytesExtras, 1);
  });

  it('lê a partir do byteOffset certo quando o quadro vem de um buffer compartilhado', () => {
    // É o caso real do `ws`, que entrega `Buffer` recortado de um pool.
    const decodificador = criarDecodificador();
    const codificador = criarCodificador();
    const pool = new Uint8Array(128);
    pool.set(codificador.eixo(11, 22, 0.5, -0.5), 40);

    const quadro = pool.subarray(40, 40 + TAMANHO_EIXO);
    assert.equal(decodificador.decodificar(quadro), RESULTADO_DECODIFICACAO.OK);
    assert.equal(decodificador.saida.seq, 11);
    assert.equal(decodificador.saida.idControle, 22);
    assert.equal(decodificador.saida.x, 0.5);
    assert.equal(decodificador.saida.y, -0.5);
  });

  it('aceita ArrayBuffer cru, que é o que o WebSocket do app entrega', () => {
    const decodificador = criarDecodificador();
    const codificador = criarCodificador();
    const bytes = copiar(codificador.haptico(PADROES_HAPTICOS.erro, 90));
    assert.equal(decodificador.decodificar(bytes.buffer), RESULTADO_DECODIFICACAO.OK);
    assert.equal(decodificador.saida.padrao, PADROES_HAPTICOS.erro);
    assert.equal(decodificador.saida.intensidade, 90);
  });

  it('descarte não deixa o pacote anterior em `saida` (nada de clique fantasma)', () => {
    // O contrato manda olhar o retorno, mas quem esquecer não pode herdar um BOTÃO
    // pressionado do passado: seria um clique que ninguém deu (regra 5 do CLAUDE.md).
    const decodificador = criarDecodificador();
    const codificador = criarCodificador();

    decodificador.decodificar(codificador.botao(1, 42, true, 255));
    assert.equal(decodificador.saida.pressionado, true, 'preparo: o clique aconteceu');

    for (const quadroRuim of [
      new Uint8Array([0xee, 0, 0, 0]), // tipo desconhecido
      new Uint8Array([TIPO_BOTAO, 1, 0]), // truncado
      new Uint8Array(0), // quadro vazio
    ]) {
      decodificador.decodificar(quadroRuim);
      const p = decodificador.saida;
      assert.equal(p.tipo, 0, 'tipo zerado depois do descarte');
      assert.equal(p.pressionado, false, 'o clique anterior não pode sobreviver');
      assert.equal(p.estado, 0);
      assert.equal(p.idControle, 0);
      assert.equal(p.tamanho, 0);
    }
  });

  it('os contadores somam o que passou e zeram sob comando', () => {
    const decodificador = criarDecodificador();
    const codificador = criarCodificador();
    decodificador.decodificar(codificador.botao(1, 1, true));
    decodificador.decodificar(new Uint8Array([0xee]));
    decodificador.decodificar(new Uint8Array([TIPO_MOVIMENTO, 0, 0]));

    const c = decodificador.contadores;
    assert.equal(c.pacotesRecebidos, 1);
    assert.equal(c.bytesRecebidos, TAMANHO_BOTAO + 1 + 3);
    assert.equal(c.descartadosPorTipo, 1);
    assert.equal(c.descartadosPorTamanho, 1);

    decodificador.zerarContadores();
    assert.deepEqual(
      [
        c.pacotesRecebidos,
        c.bytesRecebidos,
        c.descartadosPorTipo,
        c.descartadosPorTamanho,
        c.comBytesExtras,
      ],
      [0, 0, 0, 0, 0],
    );
  });
});

/* =========================================================== zero alocação por pacote */

describe('zero alocação por pacote', () => {
  it('o decodificador reaproveita o mesmo objeto de saída em todas as chamadas', () => {
    const decodificador = criarDecodificador();
    const codificador = criarCodificador();
    const primeiro = decodificador.saida;

    for (let i = 0; i < 1000; i += 1) {
      decodificador.decodificar(codificador.movimento(i, i, 10, 1, 2, 3));
      assert.equal(decodificador.saida, primeiro);
    }
    assert.equal(decodificador.contadores.pacotesRecebidos, 1000);
  });

  it('o decodificador cria uma DataView só enquanto o buffer de origem não muda', () => {
    const decodificador = criarDecodificador();
    const codificador = criarCodificador();

    for (let i = 0; i < 1000; i += 1) {
      decodificador.decodificar(codificador.movimento(i, i, 10, 1, 2, 3));
    }
    // 1000 pacotes, 1 `DataView`: é isto que "zero alocação por pacote" quer dizer na prática.
    assert.equal(decodificador.contadores.visoesCriadas, 1);
  });

  it('zerarContadores solta a referência ao buffer da sessão anterior', () => {
    // Com o `ws`, o buffer visto é o pool de 8 KB do Node. Segurá-lo depois da sessão morrer
    // manteria os 8 KB vivos junto com o decodificador. A prova observável de que a referência
    // foi solta é a `DataView` ter de nascer de novo para o **mesmo** buffer.
    const decodificador = criarDecodificador();
    const codificador = criarCodificador();

    decodificador.decodificar(codificador.movimento(1, 1, 1, 0, 0, 0));
    assert.equal(decodificador.contadores.visoesCriadas, 1);

    decodificador.zerarContadores();
    decodificador.decodificar(codificador.movimento(2, 2, 2, 0, 0, 0));
    assert.equal(
      decodificador.contadores.visoesCriadas,
      1,
      'a vista renasceu, logo a referência antiga tinha sido solta',
    );
  });

  it('o codificador devolve sempre uma janela do mesmo buffer', () => {
    const codificador = criarCodificador();
    const a = codificador.movimento(1, 1, 1, 1, 1, 1);
    const b = codificador.movimento(2, 2, 2, 2, 2, 2);
    assert.equal(a.buffer, b.buffer);
    assert.equal(a.buffer, codificador.bytes.buffer);
    // Consequência do reaproveitamento: `a` já mostra o segundo pacote.
    assert.equal(a[2], 2);
    // `copiar()` é a saída para quem precisa guardar o pacote.
    const guardado = copiar(codificador.movimento(3, 3, 3, 3, 3, 3));
    codificador.movimento(4, 4, 4, 4, 4, 4);
    assert.equal(guardado[2], 3);
  });
});
