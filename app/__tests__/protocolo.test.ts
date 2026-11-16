/**
 * @format
 *
 * Teste do codec do protocolo v0.1 no lado do celular.
 *
 * O ponto deste arquivo é a tabela `VETORES`: são **bytes literais**, escritos à mão a partir
 * das tabelas do `docs/PROTOCOLO.md`, e a **mesma tabela existe em
 * `server/src/protocolo/binario.teste.ts`**. Ida e volta dentro de um lado só provaria apenas
 * que o app concorda consigo mesmo — inclusive num offset errado. Os vetores fixos são o que
 * impede o app e o servidor de divergirem em silêncio.
 */

/* eslint-disable no-bitwise -- combinar bits de `flags` é o próprio formato do protocolo. */

import {
  copiar,
  criarCodificador,
  criarDecodificador,
  criarPacoteDecodificado,
  FLAG_ACELEROMETRO,
  FLAG_GATILHO_GIRO,
  FLAG_PRIMEIRA_APOS_RETOMAR,
  interpretarMensagemDeTexto,
  nomeDoPadraoHaptico,
  PADROES_HAPTICOS,
  proximoSeq,
  RESULTADO_DECODIFICACAO,
  SEQ_MAXIMO,
  serializarMensagemDeTexto,
  TAMANHO_BOTAO,
  TAMANHO_EIXO,
  TAMANHO_MOVIMENTO,
  TIPO_BOTAO,
  TIPO_EIXO,
  TIPO_HAPTICO,
  TIPO_MOVIMENTO,
  TIPO_RUMBLE,
  TIPO_SCROLL,
} from '../src/transporte/protocolo';

/**
 * ⚠️ ESPELHO: esta tabela existe **idêntica** em `server/src/protocolo/binario.teste.ts`.
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
  for (const byte of bytes) {
    saida += byte.toString(16).padStart(2, '0');
  }
  return saida;
}

describe('vetores de bytes fixos — escrita', () => {
  const codificador = criarCodificador();

  it('MOVIMENTO sem acelerômetro sai com 24 bytes exatos', () => {
    const bytes = codificador.movimento(
      258,
      66051,
      10,
      0.5,
      -0.25,
      0,
      FLAG_GATILHO_GIRO,
    );
    expect(bytes.byteLength).toBe(24);
    expect(paraHex(bytes)).toBe(VETORES.movimento);
  });

  it('MOVIMENTO com acelerômetro sai com 36 bytes exatos', () => {
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
    expect(bytes.byteLength).toBe(36);
    expect(paraHex(bytes)).toBe(VETORES.movimentoComAcelerometro);
  });

  it('MOVIMENTO com infinito', () => {
    const bytes = codificador.movimento(
      0,
      0,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1,
      -1,
    );
    expect(paraHex(bytes)).toBe(VETORES.movimentoComInfinito);
  });

  it('BOTÃO sai com 8 bytes exatos', () => {
    const bytes = codificador.botao(1000, 513, true, 255);
    expect(bytes.byteLength).toBe(8);
    expect(paraHex(bytes)).toBe(VETORES.botao);
  });

  it('EIXO sai com 16 bytes exatos', () => {
    const bytes = codificador.eixo(2, 7, -1, 0.75);
    expect(bytes.byteLength).toBe(16);
    expect(paraHex(bytes)).toBe(VETORES.eixo);
  });

  it('SCROLL sai com 12 bytes exatos', () => {
    const bytes = codificador.scroll(65535, -3.5, 1);
    expect(bytes.byteLength).toBe(12);
    expect(paraHex(bytes)).toBe(VETORES.scroll);
  });

  it('RUMBLE sai com 8 bytes exatos', () => {
    const bytes = codificador.rumble(200, 32, 250);
    expect(bytes.byteLength).toBe(8);
    expect(paraHex(bytes)).toBe(VETORES.rumble);
  });

  it('HÁPTICO sai com 4 bytes exatos', () => {
    const bytes = codificador.haptico(PADROES_HAPTICOS.tick, 128);
    expect(bytes.byteLength).toBe(4);
    expect(paraHex(bytes)).toBe(VETORES.haptico);
  });
});

describe('vetores de bytes fixos — leitura', () => {
  const decodificador = criarDecodificador();

  it('MOVIMENTO sem acelerômetro', () => {
    const r = decodificador.decodificar(deHex(VETORES.movimento));
    const p = decodificador.saida;
    expect(r).toBe(RESULTADO_DECODIFICACAO.OK);
    expect(p.tipo).toBe(TIPO_MOVIMENTO);
    expect(p.tamanho).toBe(24);
    expect(p.flags).toBe(FLAG_GATILHO_GIRO);
    expect(p.seq).toBe(258);
    expect(p.tDispositivoMs).toBe(66051);
    expect(p.dtMs).toBe(10);
    expect(p.gx).toBe(0.5);
    expect(p.gy).toBe(-0.25);
    expect(p.gz).toBe(0);
    expect(p.temAcelerometro).toBe(false);
    // Campo de outro tipo fica zerado: sobra do pacote anterior não passa por dado novo.
    expect(p.idControle).toBe(0);
  });

  it('MOVIMENTO com acelerômetro', () => {
    decodificador.decodificar(deHex(VETORES.movimentoComAcelerometro));
    const p = decodificador.saida;
    expect(p.tamanho).toBe(36);
    expect(p.flags).toBe(FLAG_ACELEROMETRO | FLAG_PRIMEIRA_APOS_RETOMAR);
    expect(p.seq).toBe(65535);
    expect(p.tDispositivoMs).toBe(4294967295);
    expect(p.dtMs).toBe(9.75);
    expect([p.gx, p.gy, p.gz]).toEqual([-1.5, 2.25, -0.0625]);
    expect(p.temAcelerometro).toBe(true);
    expect([p.ax, p.ay, p.az]).toEqual([0, -9.5, 9.75]);
  });

  it('MOVIMENTO com infinito', () => {
    decodificador.decodificar(deHex(VETORES.movimentoComInfinito));
    const p = decodificador.saida;
    expect(p.dtMs).toBe(Number.POSITIVE_INFINITY);
    expect(p.gx).toBe(Number.NEGATIVE_INFINITY);
    expect(p.gy).toBe(1);
    expect(p.gz).toBe(-1);
  });

  it('BOTÃO', () => {
    decodificador.decodificar(deHex(VETORES.botao));
    const p = decodificador.saida;
    expect(p.tipo).toBe(TIPO_BOTAO);
    expect(p.estado).toBe(1);
    expect(p.pressionado).toBe(true);
    expect(p.seq).toBe(1000);
    expect(p.idControle).toBe(513);
    expect(p.pressao).toBe(255);
  });

  it('BOTÃO com estado fora do conjunto {0,1} é lido como SOLTO', () => {
    // Regra 5 do CLAUDE.md: na dúvida, solto. Byte corrompido num pacote de soltura não pode
    // virar "continua pressionado" — botão preso é o pior defeito possível deste projeto.
    decodificador.decodificar(deHex(VETORES.botaoEstadoInvalido));
    const p = decodificador.saida;
    expect(p.estado).toBe(7);
    expect(p.pressionado).toBe(false);
  });

  it('EIXO', () => {
    decodificador.decodificar(deHex(VETORES.eixo));
    const p = decodificador.saida;
    expect(p.tipo).toBe(TIPO_EIXO);
    expect(p.seq).toBe(2);
    expect(p.idControle).toBe(7);
    expect(p.x).toBe(-1);
    expect(p.y).toBe(0.75);
  });

  it('SCROLL', () => {
    decodificador.decodificar(deHex(VETORES.scroll));
    const p = decodificador.saida;
    expect(p.tipo).toBe(TIPO_SCROLL);
    expect(p.seq).toBe(65535);
    expect(p.deltaVertical).toBe(-3.5);
    expect(p.deltaHorizontal).toBe(1);
  });

  it('RUMBLE', () => {
    decodificador.decodificar(deHex(VETORES.rumble));
    const p = decodificador.saida;
    expect(p.tipo).toBe(TIPO_RUMBLE);
    expect(p.motorForte).toBe(200);
    expect(p.motorFraco).toBe(32);
    expect(p.duracaoMs).toBe(250);
  });

  it('HÁPTICO', () => {
    decodificador.decodificar(deHex(VETORES.haptico));
    const p = decodificador.saida;
    expect(p.tipo).toBe(TIPO_HAPTICO);
    expect(p.padrao).toBe(PADROES_HAPTICOS.tick);
    expect(nomeDoPadraoHaptico(p.padrao)).toBe('tick');
    expect(p.intensidade).toBe(128);
  });
});

describe('ida e volta e limites', () => {
  const codificador = criarCodificador();
  const decodificador = criarDecodificador();

  it('MOVIMENTO fracionário volta arredondado para f32', () => {
    const dt = 9.987654;
    const gx = 0.1234567;
    const gy = -3.14159265;
    codificador.movimento(41234, 123456789, dt, gx, gy, 1e-7);
    decodificador.decodificar(codificador.bytes.subarray(0, TAMANHO_MOVIMENTO));
    const p = decodificador.saida;
    expect(p.seq).toBe(41234);
    expect(p.tDispositivoMs).toBe(123456789);
    expect(p.dtMs).toBe(Math.fround(dt));
    expect(p.gx).toBe(Math.fround(gx));
    expect(p.gy).toBe(Math.fround(gy));
  });

  it('seq dá a volta em 65535', () => {
    expect(proximoSeq(SEQ_MAXIMO)).toBe(0);
    const casos: ReadonlyArray<readonly [number, number]> = [
      [65535, 65535],
      [65536, 0],
      [65537, 1],
      [131072, 0],
    ];
    for (const [enviado, esperado] of casos) {
      decodificador.decodificar(codificador.botao(enviado, 1, true));
      expect(decodificador.saida.seq).toBe(esperado);
    }
  });

  it('tDispositivoMs é u32 cíclico', () => {
    decodificador.decodificar(codificador.movimento(0, 4294967296, 1, 0, 0, 0));
    expect(decodificador.saida.tDispositivoMs).toBe(0);
  });

  it('campo inteiro fora da faixa satura em vez de truncar', () => {
    decodificador.decodificar(codificador.botao(1, 70000, true, 300));
    expect(decodificador.saida.idControle).toBe(65535);
    expect(decodificador.saida.pressao).toBe(255);

    decodificador.decodificar(codificador.botao(1, -5, true, -1));
    expect(decodificador.saida.idControle).toBe(0);
    expect(decodificador.saida.pressao).toBe(0);
  });

  it('NaN e zero negativo atravessam os campos f32', () => {
    decodificador.decodificar(
      codificador.movimento(1, 1, Number.NaN, 0, 0, -0),
    );
    const p = decodificador.saida;
    expect(Number.isNaN(p.dtMs)).toBe(true);
    expect(Object.is(p.gz, -0)).toBe(true);
  });

  it('o bit0 de flags nunca mente sobre o tamanho do pacote', () => {
    const curto = codificador.movimento(
      1,
      1,
      1,
      0,
      0,
      0,
      FLAG_ACELEROMETRO | FLAG_GATILHO_GIRO,
    );
    expect(curto.byteLength).toBe(24);
    expect(curto[1]).toBe(FLAG_GATILHO_GIRO);

    const longo = codificador.movimentoComAcelerometro(1, 1, 1, 0, 0, 0, 0, 0, 0);
    expect(longo.byteLength).toBe(36);
    expect(longo[1]).toBe(FLAG_ACELEROMETRO);
  });

  it('aceita um destino fornecido pelo chamador', () => {
    const meuPacote = criarPacoteDecodificado();
    decodificador.decodificar(codificador.botao(1, 2, true, 3), meuPacote);
    expect(meuPacote.idControle).toBe(2);
  });
});

describe('pacote defeituoso é descartado sem exceção', () => {
  it('truncado em qualquer tamanho é recusado', () => {
    const decodificador = criarDecodificador();
    const codificador = criarCodificador();
    const inteiro = copiar(
      codificador.movimentoComAcelerometro(1, 2, 3, 4, 5, 6, 7, 8, 9),
    );

    for (let tamanho = 0; tamanho < inteiro.byteLength; tamanho += 1) {
      expect(decodificador.decodificar(inteiro.subarray(0, tamanho))).toBe(
        RESULTADO_DECODIFICACAO.TAMANHO_INVALIDO,
      );
    }
    expect(decodificador.contadores.descartadosPorTamanho).toBe(
      inteiro.byteLength,
    );
    expect(decodificador.contadores.pacotesRecebidos).toBe(0);
  });

  it('tipo desconhecido é descartado', () => {
    const decodificador = criarDecodificador();
    for (const tipo of [0x00, 0x05, 0x83, 0xff]) {
      const bytes = new Uint8Array(36);
      bytes[0] = tipo;
      expect(decodificador.decodificar(bytes)).toBe(
        RESULTADO_DECODIFICACAO.TIPO_DESCONHECIDO,
      );
    }
    expect(decodificador.contadores.descartadosPorTipo).toBe(4);
  });

  it('bytes sobrando no fim são ignorados e contados', () => {
    const decodificador = criarDecodificador();
    const codificador = criarCodificador();
    const comSobra = new Uint8Array(TAMANHO_BOTAO + 4);
    comSobra.set(codificador.botao(5, 6, true, 7));

    expect(decodificador.decodificar(comSobra)).toBe(RESULTADO_DECODIFICACAO.OK);
    expect(decodificador.saida.idControle).toBe(6);
    expect(decodificador.contadores.comBytesExtras).toBe(1);
  });

  it('aceita ArrayBuffer cru, que é o que o WebSocket do app entrega', () => {
    const decodificador = criarDecodificador();
    const codificador = criarCodificador();
    const bytes = copiar(codificador.haptico(PADROES_HAPTICOS.erro, 90));
    expect(decodificador.decodificar(bytes.buffer)).toBe(
      RESULTADO_DECODIFICACAO.OK,
    );
    expect(decodificador.saida.padrao).toBe(PADROES_HAPTICOS.erro);
    expect(decodificador.saida.intensidade).toBe(90);
  });

  it('MOVIMENTO de 30 bytes com bit0 em 0 é pacote de 24 com 6 bytes do futuro', () => {
    // Vale a regra 3 da seção 4.0: menos que a tabela é descarte, mais é aceito e contado.
    const decodificador = criarDecodificador();
    const codificador = criarCodificador();
    const comSobra = new Uint8Array(TAMANHO_MOVIMENTO + 6);
    comSobra.set(codificador.movimento(77, 88, 1, 0.5, 0, 0));

    expect(decodificador.decodificar(comSobra)).toBe(RESULTADO_DECODIFICACAO.OK);
    expect(decodificador.saida.tamanho).toBe(TAMANHO_MOVIMENTO);
    expect(decodificador.saida.seq).toBe(77);
    expect(decodificador.contadores.comBytesExtras).toBe(1);
  });

  it('descarte não deixa o pacote anterior em `saida` (nada de clique fantasma)', () => {
    const decodificador = criarDecodificador();
    const codificador = criarCodificador();

    decodificador.decodificar(codificador.botao(1, 42, true, 255));
    expect(decodificador.saida.pressionado).toBe(true);

    decodificador.decodificar(new Uint8Array([0xee, 0, 0, 0]));
    expect(decodificador.saida.tipo).toBe(0);
    expect(decodificador.saida.pressionado).toBe(false);
    expect(decodificador.saida.idControle).toBe(0);
  });

  it('lê a partir do byteOffset certo em buffer compartilhado', () => {
    const decodificador = criarDecodificador();
    const codificador = criarCodificador();
    const pool = new Uint8Array(128);
    pool.set(codificador.eixo(11, 22, 0.5, -0.5), 40);

    const quadro = pool.subarray(40, 40 + TAMANHO_EIXO);
    expect(decodificador.decodificar(quadro)).toBe(RESULTADO_DECODIFICACAO.OK);
    expect(decodificador.saida.seq).toBe(11);
    expect(decodificador.saida.x).toBe(0.5);
  });
});

describe('zero alocação por pacote', () => {
  it('o objeto de saída e a DataView são reaproveitados', () => {
    const decodificador = criarDecodificador();
    const codificador = criarCodificador();
    const primeiro = decodificador.saida;

    for (let i = 0; i < 1000; i += 1) {
      decodificador.decodificar(codificador.movimento(i, i, 10, 1, 2, 3));
      expect(decodificador.saida).toBe(primeiro);
    }
    expect(decodificador.contadores.visoesCriadas).toBe(1);
    expect(decodificador.contadores.pacotesRecebidos).toBe(1000);
  });

  it('o codificador devolve sempre uma janela do mesmo buffer', () => {
    const codificador = criarCodificador();
    const a = codificador.movimento(1, 1, 1, 1, 1, 1);
    const b = codificador.movimento(2, 2, 2, 2, 2, 2);
    expect(a.buffer).toBe(b.buffer);
    // Consequência do reaproveitamento: `a` já mostra o segundo pacote.
    expect(a[2]).toBe(2);

    const guardado = copiar(codificador.movimento(3, 3, 3, 3, 3, 3));
    codificador.movimento(4, 4, 4, 4, 4, 4);
    expect(guardado[2]).toBe(3);
  });
});

describe('mensagens JSON de sessão', () => {
  it('hello completo sobrevive à ida e volta', () => {
    const original = {
      t: 'hello',
      v: 1,
      aparelho: {
        id: 'a1b2c3d4e5f6',
        nome: 'Pixel 7',
        so: 'android',
        versaoSo: '14',
        modelo: 'GVU6C',
      },
      capacidades: ['giroscopio', 'acelerometro', 'haptico', 'toque'],
      taxaHzDesejada: 100,
      token: 'token-de-teste',
      codigoPareamento: '482913',
    } as const;

    const resultado = interpretarMensagemDeTexto(
      serializarMensagemDeTexto(original),
    );
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) {
      return;
    }
    expect(resultado.mensagem).toEqual(original);
  });

  it('welcome do servidor é lido com perfil e lista de perfis', () => {
    const resultado = interpretarMensagemDeTexto(
      JSON.stringify({
        t: 'welcome',
        v: 1,
        servidor: {nome: 'PC-KAIO', versao: '0.1.0', so: 'windows'},
        sessao: {id: 's-17', taxaHz: 100, transporte: 'usb'},
        tela: {largura: 2560, altura: 1440},
        perfilAtivo: {id: 'mouse-basico'},
        perfis: [{id: 'mouse-basico', nome: 'Mouse básico'}],
      }),
    );
    expect(resultado.ok).toBe(true);
    if (!resultado.ok || resultado.mensagem.t !== 'welcome') {
      return;
    }
    expect(resultado.mensagem.sessao.transporte).toBe('usb');
    expect(resultado.mensagem.tela.largura).toBe(2560);
    expect(resultado.mensagem.perfis).toEqual([
      {id: 'mouse-basico', nome: 'Mouse básico'},
    ]);
    expect(resultado.mensagem.token).toBeUndefined();
  });

  it('campo opcional vazio some do fio (ausente, não null)', () => {
    expect(serializarMensagemDeTexto({t: 'bye', motivo: undefined})).toBe(
      '{"t":"bye"}',
    );
  });

  it('quadro defeituoso vira recusa tipada, nunca exceção', () => {
    const ruins = [
      '{"t":"welcome"',
      '',
      'null',
      '[1,2]',
      '{"v":1}',
      '{"t":"handshake"}',
      '{"t":"erro","codigo":"DEU_RUIM"}',
      '{"t":"ping","tServidorMs":1}',
      '{"t":"cmd","comando":"trocar-perfil"}',
    ];
    for (const quadro of ruins) {
      const resultado = interpretarMensagemDeTexto(quadro);
      expect(resultado.ok).toBe(false);
      if (resultado.ok) {
        continue;
      }
      expect(resultado.codigo).toBe('PROTOCOLO_INVALIDO');
    }
  });

  /**
   * ⚠️ ESPELHO: os mesmos quadros existem em `server/src/protocolo/sessao.teste.ts`. É a
   * diferença entre "ausente" e "presente e imprestável" — confundir as duas faz o servidor
   * responder `config-ok` para um ajuste que ele jogou fora, sem erro nem contador.
   */
  it('campo opcional presente e inválido é recusado, não tratado como ausente', () => {
    const ruins = [
      '{"t":"config","gyro":{"espaco":"mundial"}}',
      '{"t":"config","gyro":{"sensX":"35"}}',
      '{"t":"config","gyro":{"deadzone":1e999}}',
      '{"t":"config","gyro":{"inverterY":"sim"}}',
      '{"t":"config","gyro":{"sensY":null}}',
      '{"t":"config-ok","gyro":{"espaco":"global"}}',
      '{"t":"erro","codigo":"TOKEN_INVALIDO","mensagem":42}',
      '{"t":"cmd-ok","comando":"pausar","resultado":"tudo certo"}',
      '{"t":"cmd","comando":"trocar-perfil","perfilId":7}',
      '{"t":"bye","motivo":7}',
      '{"t":"ping","n":1,"tServidorMs":1e999}',
      '{"t":"aviso","codigo":"BIAS_ALTO","ativo":false,"mensagem":7}',
    ];
    for (const quadro of ruins) {
      const resultado = interpretarMensagemDeTexto(quadro);
      expect(resultado.ok).toBe(false);
      if (resultado.ok) {
        continue;
      }
      expect(resultado.codigo).toBe('PROTOCOLO_INVALIDO');
    }
  });

  /**
   * ⚠️ ESPELHO: os mesmos quadros de `aviso` existem em `server/src/protocolo/sessao.teste.ts`
   * (PROTOCOLO.md, seção 3.8 — ATI-029).
   */
  it('aviso aceso traz o texto pronto para a tela; apagado vem sem texto', () => {
    const aceso = {
      t: 'aviso',
      codigo: 'BIAS_ALTO',
      ativo: true,
      mensagem: 'bias alto detectado (2,0 °/s) — use sincronizar',
    } as const;
    const lidoAceso = interpretarMensagemDeTexto(serializarMensagemDeTexto(aceso));
    expect(lidoAceso.ok).toBe(true);
    if (!lidoAceso.ok) {
      return;
    }
    expect(lidoAceso.mensagem).toEqual(aceso);

    const quadroApagado = '{"t":"aviso","codigo":"BIAS_ALTO","ativo":false}';
    const lidoApagado = interpretarMensagemDeTexto(quadroApagado);
    expect(lidoApagado.ok).toBe(true);
    if (!lidoApagado.ok || lidoApagado.mensagem.t !== 'aviso') {
      return;
    }
    expect(lidoApagado.mensagem.ativo).toBe(false);
    expect(lidoApagado.mensagem.mensagem).toBeUndefined();
    expect(
      serializarMensagemDeTexto({t: 'aviso', codigo: 'BIAS_ALTO', ativo: false}),
    ).toBe(quadroApagado);
  });

  it('aviso defeituoso vira recusa, nunca exceção', () => {
    const ruins = [
      '{"t":"aviso","codigo":"BATERIA_FRACA","ativo":true,"mensagem":"x"}',
      '{"t":"aviso","codigo":"BIAS_ALTO","mensagem":"x"}',
      '{"t":"aviso","codigo":"BIAS_ALTO","ativo":"sim","mensagem":"x"}',
      '{"t":"aviso","codigo":"BIAS_ALTO","ativo":true}',
    ];
    for (const quadro of ruins) {
      const resultado = interpretarMensagemDeTexto(quadro);
      expect(resultado.ok).toBe(false);
      if (resultado.ok) {
        continue;
      }
      expect(resultado.codigo).toBe('PROTOCOLO_INVALIDO');
    }
  });

  it('campo opcional ausente continua válido (config parcial é o caso normal)', () => {
    const resultado = interpretarMensagemDeTexto('{"t":"config","gyro":{"sensX":35}}');
    expect(resultado.ok).toBe(true);
    if (!resultado.ok || resultado.mensagem.t !== 'config') {
      return;
    }
    expect(resultado.mensagem.gyro.sensX).toBe(35);
    expect(resultado.mensagem.gyro.espaco).toBeUndefined();
  });
});
