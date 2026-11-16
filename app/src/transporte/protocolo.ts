/**
 * Codec do protocolo v0.1 no lado do celular — espelho de `server/src/protocolo/`.
 *
 * ⚠️ ESPELHO CONSCIENTE. O app não compartilha build com o servidor na v1, então o mesmo formato
 * existe escrito duas vezes: aqui e em `server/src/protocolo/{tipos,binario,sessao}.ts`. Mudou um
 * byte em `docs/PROTOCOLO.md`, mudam os **dois** arquivos na mesma entrega. O que impede a dupla
 * de divergir em silêncio são os testes com vetores de bytes fixos, que existem idênticos nos
 * dois lados (`__tests__/protocolo.test.ts` aqui, `binario.teste.ts` lá), mais o
 * `espelho.teste.ts` do servidor, que lê este arquivo e compara as constantes.
 *
 * ⚠️ CAMINHO QUENTE. `codificarMovimento` roda 100 vezes por segundo: buffer e fatias nascem uma
 * vez, na construção do codificador, e cada chamada só escreve por cima. Nada de objeto novo por
 * amostra, nada de log por amostra (regra 2 do CLAUDE.md).
 *
 * `littleEndian = true` explícito em toda leitura e escrita multibyte — o formato é do protocolo,
 * não da máquina que roda o app.
 */

/* eslint-disable no-bitwise --
 * Operador de bit aqui não é esperteza: `flags` é campo de bits do protocolo, `& 0xffff` é a
 * volta do `seq` documentada na seção 4.1 e `>>> 0` é o u32 cíclico do relógio do aparelho.
 * Escrever isso com aritmética seria mais lento e menos parecido com a tabela do PROTOCOLO.md.
 */

/* ------------------------------------------------------------------ tipos de pacote */

/** `0x01` MOVIMENTO — app → servidor, 100 Hz. */
export const TIPO_MOVIMENTO = 0x01;
/** `0x02` BOTÃO — app → servidor. */
export const TIPO_BOTAO = 0x02;
/** `0x03` EIXO — app → servidor (sticks e sliders). */
export const TIPO_EIXO = 0x03;
/** `0x04` SCROLL — app → servidor. */
export const TIPO_SCROLL = 0x04;
/** `0x81` RUMBLE — servidor → app. */
export const TIPO_RUMBLE = 0x81;
/** `0x82` HÁPTICO — servidor → app. */
export const TIPO_HAPTICO = 0x82;

/* ------------------------------------------------------------------------ tamanhos */

/** MOVIMENTO sem acelerômetro (bit0 de `flags` em 0). */
export const TAMANHO_MOVIMENTO = 24;
/** MOVIMENTO com acelerômetro (bit0 de `flags` em 1). */
export const TAMANHO_MOVIMENTO_COM_ACELEROMETRO = 36;
export const TAMANHO_BOTAO = 8;
export const TAMANHO_EIXO = 16;
export const TAMANHO_SCROLL = 12;
export const TAMANHO_RUMBLE = 8;
export const TAMANHO_HAPTICO = 4;

/** Maior pacote do protocolo v0.1. Dimensiona o buffer reaproveitado do codificador. */
export const TAMANHO_MAXIMO_PACOTE = TAMANHO_MOVIMENTO_COM_ACELEROMETRO;

/* --------------------------------------------------------------- flags do MOVIMENTO */

/** bit0 — o pacote traz `ax`/`ay`/`az` (e portanto tem 36 bytes, não 24). */
export const FLAG_ACELEROMETRO = 0b0000_0001;
/** bit1 — o botão de "ativar giro" está pressionado neste instante. */
export const FLAG_GATILHO_GIRO = 0b0000_0010;
/** bit2 — primeira amostra depois de retomar; o servidor não integra `dt` contra o passado. */
export const FLAG_PRIMEIRA_APOS_RETOMAR = 0b0000_0100;

/* ------------------------------------------------------------------ campos numéricos */

/** `seq` é u16: passou daqui, dá a volta (PROTOCOLO.md, seção 4.1). */
export const SEQ_MAXIMO = 0xffff;

/**
 * Único valor de `estado` do BOTÃO que significa pressionado (PROTOCOLO.md, seção 4.2).
 *
 * A tabela declara o conjunto `{0 solto, 1 pressionado}`, e a dúvida resolve para **solto**:
 * botão preso é o pior defeito possível deste projeto (regra 5 do CLAUDE.md), então um byte
 * corrompido num pacote de soltura não pode virar "continua pressionado".
 */
export const ESTADO_PRESSIONADO = 1;

/** Próximo `seq` da sequência, já com a volta em 65535 aplicada. */
export function proximoSeq(seq: number): number {
  return (seq + 1) & SEQ_MAXIMO;
}

/* -------------------------------------------------------------- padrões de vibração */

/** Códigos do campo `padrao` do pacote HÁPTICO (PROTOCOLO.md, seção 5.2). */
export const PADROES_HAPTICOS = Object.freeze({
  click: 1,
  tick: 2,
  sucesso: 3,
  erro: 4,
  aviso: 5,
} as const);

export type NomeDePadraoHaptico = keyof typeof PADROES_HAPTICOS;
export type CodigoDePadraoHaptico =
  (typeof PADROES_HAPTICOS)[NomeDePadraoHaptico];

const NOMES_DE_PADRAO_HAPTICO = Object.freeze(
  Object.keys(PADROES_HAPTICOS) as readonly NomeDePadraoHaptico[],
);

/** Nome do padrão a partir do código no fio, ou `undefined` se o código não existir. */
export function nomeDoPadraoHaptico(
  codigo: number,
): NomeDePadraoHaptico | undefined {
  for (const nome of NOMES_DE_PADRAO_HAPTICO) {
    if (PADROES_HAPTICOS[nome] === codigo) {
      return nome;
    }
  }
  return undefined;
}

/* ------------------------------------------------------- resultado da decodificação */

/**
 * Retorno do decodificador. É **número**, não objeto nem string — mesmo motivo do servidor:
 * nada pode ser alocado por pacote.
 */
export const RESULTADO_DECODIFICACAO = Object.freeze({
  /** Pacote lido; a saída está preenchida. */
  OK: 0,
  /** Bytes de menos para o tipo declarado — pacote truncado, descartado. */
  TAMANHO_INVALIDO: 1,
  /** Primeiro byte não é um tipo conhecido — descartado (PROTOCOLO.md, seção 6, regra 2). */
  TIPO_DESCONHECIDO: 2,
} as const);

export type ResultadoDeDecodificacao =
  (typeof RESULTADO_DECODIFICACAO)[keyof typeof RESULTADO_DECODIFICACAO];

/* ------------------------------------------------------------- pacote decodificado */

/**
 * Destino mutável da decodificação — um objeto só, reaproveitado a cada pacote. Os campos que
 * não pertencem ao tipo lido são zerados, para que sobra do pacote anterior não passe por dado
 * novo. No app só chegam RUMBLE e HÁPTICO, mas a forma acompanha a do servidor de propósito:
 * espelho torto é espelho que engana.
 */
export type PacoteDecodificado = {
  tipo: number;
  tamanho: number;

  // MOVIMENTO (0x01)
  flags: number;
  seq: number;
  tDispositivoMs: number;
  dtMs: number;
  gx: number;
  gy: number;
  gz: number;
  temAcelerometro: boolean;
  ax: number;
  ay: number;
  az: number;

  // BOTÃO (0x02)
  /** Byte 1 cru do fio, sem normalização — para diagnóstico. Quem decide usa `pressionado`. */
  estado: number;
  /** `estado === ESTADO_PRESSIONADO`, decidido no codec para não virar `if (estado)` na ponta. */
  pressionado: boolean;
  idControle: number;
  pressao: number;

  // EIXO (0x03)
  x: number;
  y: number;

  // SCROLL (0x04)
  deltaVertical: number;
  deltaHorizontal: number;

  // RUMBLE (0x81)
  motorForte: number;
  motorFraco: number;
  duracaoMs: number;

  // HÁPTICO (0x82)
  padrao: number;
  intensidade: number;
};

/**
 * Contadores de diagnóstico do codec (PROTOCOLO.md, seção 7). Os nomes são os da tabela da
 * seção 7, letra por letra — quem expuser telemetria não precisa traduzir nome no caminho.
 */
export type ContadoresDoCodec = {
  pacotesRecebidos: number;
  bytesRecebidos: number;
  descartadosPorTamanho: number;
  descartadosPorTipo: number;
  comBytesExtras: number;
  /** Quantas `DataView` precisaram ser criadas — a medida do "zero alocação por pacote". */
  visoesCriadas: number;
};

/* ============================================================== saturação de campos */

/** Toda leitura e escrita multibyte usa este valor — nunca o padrão da plataforma. */
const LITTLE_ENDIAN = true;

/**
 * Campos inteiros têm faixa fechada e `DataView.setUint8` trunca em silêncio (`300` viraria
 * `44`). Aqui o valor fora da faixa é **saturado**, como manda a seção 3.4 do PROTOCOLO.md.
 */
function paraU8(valor: number): number {
  if (Number.isNaN(valor)) {
    return 0;
  }
  const inteiro = Math.trunc(valor);
  if (inteiro <= 0) {
    return 0;
  }
  return inteiro >= 0xff ? 0xff : inteiro;
}

function paraU16(valor: number): number {
  if (Number.isNaN(valor)) {
    return 0;
  }
  const inteiro = Math.trunc(valor);
  if (inteiro <= 0) {
    return 0;
  }
  return inteiro >= 0xffff ? 0xffff : inteiro;
}

/** `seq` é o único inteiro que **dá a volta** em vez de saturar (PROTOCOLO.md, seção 4.1). */
function paraSeq(valor: number): number {
  if (!Number.isFinite(valor)) {
    return 0;
  }
  return Math.trunc(valor) & SEQ_MAXIMO;
}

/** `tDispositivoMs` é o relógio monotônico em u32: também é cíclico (~49,7 dias). */
function paraU32Ciclico(valor: number): number {
  if (!Number.isFinite(valor)) {
    return 0;
  }
  return Math.trunc(valor) >>> 0;
}

/* ========================================================================= codificador */

/**
 * Escritor de pacotes com buffer reaproveitado.
 *
 * ⚠️ O `Uint8Array` devolvido é uma **janela sobre o buffer interno**, válida só até a próxima
 * chamada. `WebSocket.send` copia na hora, então enviar direto é seguro; guardar a referência
 * para usar depois lê o pacote seguinte. Para guardar, use `copiar()`.
 */
export type Codificador = {
  /** Buffer interno completo (36 bytes). Exposto para diagnóstico e teste. */
  readonly bytes: Uint8Array;

  /** `0x01` MOVIMENTO sem acelerômetro — 24 bytes. bit0 de `flags` é forçado a 0. */
  movimento(
    seq: number,
    tDispositivoMs: number,
    dtMs: number,
    gx: number,
    gy: number,
    gz: number,
    flags?: number,
  ): Uint8Array;

  /** `0x01` MOVIMENTO com acelerômetro — 36 bytes. bit0 de `flags` é forçado a 1. */
  movimentoComAcelerometro(
    seq: number,
    tDispositivoMs: number,
    dtMs: number,
    gx: number,
    gy: number,
    gz: number,
    ax: number,
    ay: number,
    az: number,
    flags?: number,
  ): Uint8Array;

  /** `0x02` BOTÃO — 8 bytes. `pressao` 0–255 (255 quando não há força disponível). */
  botao(
    seq: number,
    idControle: number,
    pressionado: boolean,
    pressao?: number,
  ): Uint8Array;

  /** `0x03` EIXO — 16 bytes. `x`/`y` de −1,0 a 1,0. */
  eixo(seq: number, idControle: number, x: number, y: number): Uint8Array;

  /** `0x04` SCROLL — 12 bytes. Deltas em cliques de roda, fracionários. */
  scroll(
    seq: number,
    deltaVertical: number,
    deltaHorizontal: number,
  ): Uint8Array;

  /** `0x81` RUMBLE — 8 bytes. Existe para o teste de ida e volta bater com o do servidor. */
  rumble(motorForte: number, motorFraco: number, duracaoMs: number): Uint8Array;

  /** `0x82` HÁPTICO — 4 bytes. Existe pelo mesmo motivo do `rumble`. */
  haptico(padrao: number, intensidade: number): Uint8Array;
};

/** Cópia independente de um pacote — para quando o envio não for síncrono. */
export function copiar(pacote: Uint8Array): Uint8Array {
  return pacote.slice();
}

export function criarCodificador(): Codificador {
  const buffer = new ArrayBuffer(TAMANHO_MAXIMO_PACOTE);
  const visao = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // As fatias nascem aqui, uma vez. `subarray` por chamada seria um objeto novo por pacote.
  const fatiaMovimento = bytes.subarray(0, TAMANHO_MOVIMENTO);
  const fatiaMovimentoComAcelerometro = bytes.subarray(
    0,
    TAMANHO_MOVIMENTO_COM_ACELEROMETRO,
  );
  const fatiaBotao = bytes.subarray(0, TAMANHO_BOTAO);
  const fatiaEixo = bytes.subarray(0, TAMANHO_EIXO);
  const fatiaScroll = bytes.subarray(0, TAMANHO_SCROLL);
  const fatiaRumble = bytes.subarray(0, TAMANHO_RUMBLE);
  const fatiaHaptico = bytes.subarray(0, TAMANHO_HAPTICO);

  function escreverMovimento(
    flags: number,
    seq: number,
    tDispositivoMs: number,
    dtMs: number,
    gx: number,
    gy: number,
    gz: number,
  ): void {
    visao.setUint8(0, TIPO_MOVIMENTO);
    visao.setUint8(1, paraU8(flags));
    visao.setUint16(2, paraSeq(seq), LITTLE_ENDIAN);
    visao.setUint32(4, paraU32Ciclico(tDispositivoMs), LITTLE_ENDIAN);
    visao.setFloat32(8, dtMs, LITTLE_ENDIAN);
    visao.setFloat32(12, gx, LITTLE_ENDIAN);
    visao.setFloat32(16, gy, LITTLE_ENDIAN);
    visao.setFloat32(20, gz, LITTLE_ENDIAN);
  }

  return {
    bytes,

    movimento(seq, tDispositivoMs, dtMs, gx, gy, gz, flags = 0) {
      // bit0 descreve o tamanho do pacote; deixar quem chama mentir aqui produziria um pacote
      // de 24 bytes que o outro lado tentaria ler como 36.
      escreverMovimento(
        paraU8(flags) & ~FLAG_ACELEROMETRO,
        seq,
        tDispositivoMs,
        dtMs,
        gx,
        gy,
        gz,
      );
      return fatiaMovimento;
    },

    movimentoComAcelerometro(
      seq,
      tDispositivoMs,
      dtMs,
      gx,
      gy,
      gz,
      ax,
      ay,
      az,
      flags = 0,
    ) {
      escreverMovimento(
        paraU8(flags) | FLAG_ACELEROMETRO,
        seq,
        tDispositivoMs,
        dtMs,
        gx,
        gy,
        gz,
      );
      visao.setFloat32(24, ax, LITTLE_ENDIAN);
      visao.setFloat32(28, ay, LITTLE_ENDIAN);
      visao.setFloat32(32, az, LITTLE_ENDIAN);
      return fatiaMovimentoComAcelerometro;
    },

    botao(seq, idControle, pressionado, pressao = 0xff) {
      visao.setUint8(0, TIPO_BOTAO);
      visao.setUint8(1, pressionado ? 1 : 0);
      visao.setUint16(2, paraSeq(seq), LITTLE_ENDIAN);
      visao.setUint16(4, paraU16(idControle), LITTLE_ENDIAN);
      visao.setUint8(6, paraU8(pressao));
      visao.setUint8(7, 0); // reservado
      return fatiaBotao;
    },

    eixo(seq, idControle, x, y) {
      visao.setUint8(0, TIPO_EIXO);
      visao.setUint8(1, 0); // reservado
      visao.setUint16(2, paraSeq(seq), LITTLE_ENDIAN);
      visao.setUint16(4, paraU16(idControle), LITTLE_ENDIAN);
      visao.setUint16(6, 0, LITTLE_ENDIAN); // reservado
      visao.setFloat32(8, x, LITTLE_ENDIAN);
      visao.setFloat32(12, y, LITTLE_ENDIAN);
      return fatiaEixo;
    },

    scroll(seq, deltaVertical, deltaHorizontal) {
      visao.setUint8(0, TIPO_SCROLL);
      visao.setUint8(1, 0); // reservado
      visao.setUint16(2, paraSeq(seq), LITTLE_ENDIAN);
      visao.setFloat32(4, deltaVertical, LITTLE_ENDIAN);
      visao.setFloat32(8, deltaHorizontal, LITTLE_ENDIAN);
      return fatiaScroll;
    },

    rumble(motorForte, motorFraco, duracaoMs) {
      visao.setUint8(0, TIPO_RUMBLE);
      visao.setUint8(1, paraU8(motorForte));
      visao.setUint8(2, paraU8(motorFraco));
      visao.setUint8(3, 0); // reservado
      visao.setUint16(4, paraU16(duracaoMs), LITTLE_ENDIAN);
      visao.setUint16(6, 0, LITTLE_ENDIAN); // reservado
      return fatiaRumble;
    },

    haptico(padrao, intensidade) {
      visao.setUint8(0, TIPO_HAPTICO);
      visao.setUint8(1, paraU8(padrao));
      visao.setUint8(2, paraU8(intensidade));
      visao.setUint8(3, 0); // reservado
      return fatiaHaptico;
    },
  };
}

/* ======================================================================= decodificador */

/** Cria o destino mutável da decodificação, com todos os campos já alocados. */
export function criarPacoteDecodificado(): PacoteDecodificado {
  return {
    tipo: 0,
    tamanho: 0,
    flags: 0,
    seq: 0,
    tDispositivoMs: 0,
    dtMs: 0,
    gx: 0,
    gy: 0,
    gz: 0,
    temAcelerometro: false,
    ax: 0,
    ay: 0,
    az: 0,
    estado: 0,
    pressionado: false,
    idControle: 0,
    pressao: 0,
    x: 0,
    y: 0,
    deltaVertical: 0,
    deltaHorizontal: 0,
    motorForte: 0,
    motorFraco: 0,
    duracaoMs: 0,
    padrao: 0,
    intensidade: 0,
  };
}

/** Zera todos os campos antes de preencher os do tipo lido — o objeto é reaproveitado. */
function zerarPacote(saida: PacoteDecodificado): void {
  saida.tipo = 0;
  saida.tamanho = 0;
  saida.flags = 0;
  saida.seq = 0;
  saida.tDispositivoMs = 0;
  saida.dtMs = 0;
  saida.gx = 0;
  saida.gy = 0;
  saida.gz = 0;
  saida.temAcelerometro = false;
  saida.ax = 0;
  saida.ay = 0;
  saida.az = 0;
  saida.estado = 0;
  saida.pressionado = false;
  saida.idControle = 0;
  saida.pressao = 0;
  saida.x = 0;
  saida.y = 0;
  saida.deltaVertical = 0;
  saida.deltaHorizontal = 0;
  saida.motorForte = 0;
  saida.motorFraco = 0;
  saida.duracaoMs = 0;
  saida.padrao = 0;
  saida.intensidade = 0;
}

/**
 * Lê **um** pacote de `visao`, a partir de `inicio`, com `disponivel` bytes até o fim do quadro.
 * Função pura, sem estado e que não lança: defeito de formato vira código de retorno.
 *
 * ⚠️ `saida` só vale quando o retorno é `RESULTADO_DECODIFICACAO.OK`. Nos outros casos ela fica
 * **zerada** (`tipo === 0`), nunca com o pacote anterior.
 */
export function decodificarEm(
  visao: DataView,
  inicio: number,
  disponivel: number,
  saida: PacoteDecodificado,
): ResultadoDeDecodificacao {
  // Zerado ANTES de qualquer validação, de propósito: é o que garante que quadro descartado
  // não deixe sobra do pacote anterior visível em `saida`.
  zerarPacote(saida);

  if (disponivel < 1) {
    return RESULTADO_DECODIFICACAO.TAMANHO_INVALIDO;
  }

  const tipo = visao.getUint8(inicio);

  switch (tipo) {
    case TIPO_MOVIMENTO: {
      if (disponivel < TAMANHO_MOVIMENTO) {
        return RESULTADO_DECODIFICACAO.TAMANHO_INVALIDO;
      }
      const flags = visao.getUint8(inicio + 1);
      const temAcelerometro = (flags & FLAG_ACELEROMETRO) !== 0;
      if (temAcelerometro && disponivel < TAMANHO_MOVIMENTO_COM_ACELEROMETRO) {
        return RESULTADO_DECODIFICACAO.TAMANHO_INVALIDO;
      }
      saida.tipo = tipo;
      saida.tamanho = temAcelerometro
        ? TAMANHO_MOVIMENTO_COM_ACELEROMETRO
        : TAMANHO_MOVIMENTO;
      saida.flags = flags;
      saida.seq = visao.getUint16(inicio + 2, LITTLE_ENDIAN);
      saida.tDispositivoMs = visao.getUint32(inicio + 4, LITTLE_ENDIAN);
      saida.dtMs = visao.getFloat32(inicio + 8, LITTLE_ENDIAN);
      saida.gx = visao.getFloat32(inicio + 12, LITTLE_ENDIAN);
      saida.gy = visao.getFloat32(inicio + 16, LITTLE_ENDIAN);
      saida.gz = visao.getFloat32(inicio + 20, LITTLE_ENDIAN);
      saida.temAcelerometro = temAcelerometro;
      if (temAcelerometro) {
        saida.ax = visao.getFloat32(inicio + 24, LITTLE_ENDIAN);
        saida.ay = visao.getFloat32(inicio + 28, LITTLE_ENDIAN);
        saida.az = visao.getFloat32(inicio + 32, LITTLE_ENDIAN);
      }
      return RESULTADO_DECODIFICACAO.OK;
    }

    case TIPO_BOTAO: {
      if (disponivel < TAMANHO_BOTAO) {
        return RESULTADO_DECODIFICACAO.TAMANHO_INVALIDO;
      }
      saida.tipo = tipo;
      saida.tamanho = TAMANHO_BOTAO;
      saida.estado = visao.getUint8(inicio + 1);
      // A tabela 4.2 declara o conjunto {0, 1}: só o 1 é pressionado, e qualquer outro byte
      // resolve para solto. Decidido aqui, uma vez, para não virar `if (estado)` na ponta.
      saida.pressionado = saida.estado === ESTADO_PRESSIONADO;
      saida.seq = visao.getUint16(inicio + 2, LITTLE_ENDIAN);
      saida.idControle = visao.getUint16(inicio + 4, LITTLE_ENDIAN);
      saida.pressao = visao.getUint8(inicio + 6);
      // byte 7 é reservado: lido como nada, para o dia em que virar campo.
      return RESULTADO_DECODIFICACAO.OK;
    }

    case TIPO_EIXO: {
      if (disponivel < TAMANHO_EIXO) {
        return RESULTADO_DECODIFICACAO.TAMANHO_INVALIDO;
      }
      saida.tipo = tipo;
      saida.tamanho = TAMANHO_EIXO;
      saida.seq = visao.getUint16(inicio + 2, LITTLE_ENDIAN);
      saida.idControle = visao.getUint16(inicio + 4, LITTLE_ENDIAN);
      saida.x = visao.getFloat32(inicio + 8, LITTLE_ENDIAN);
      saida.y = visao.getFloat32(inicio + 12, LITTLE_ENDIAN);
      return RESULTADO_DECODIFICACAO.OK;
    }

    case TIPO_SCROLL: {
      if (disponivel < TAMANHO_SCROLL) {
        return RESULTADO_DECODIFICACAO.TAMANHO_INVALIDO;
      }
      saida.tipo = tipo;
      saida.tamanho = TAMANHO_SCROLL;
      saida.seq = visao.getUint16(inicio + 2, LITTLE_ENDIAN);
      saida.deltaVertical = visao.getFloat32(inicio + 4, LITTLE_ENDIAN);
      saida.deltaHorizontal = visao.getFloat32(inicio + 8, LITTLE_ENDIAN);
      return RESULTADO_DECODIFICACAO.OK;
    }

    case TIPO_RUMBLE: {
      if (disponivel < TAMANHO_RUMBLE) {
        return RESULTADO_DECODIFICACAO.TAMANHO_INVALIDO;
      }
      saida.tipo = tipo;
      saida.tamanho = TAMANHO_RUMBLE;
      saida.motorForte = visao.getUint8(inicio + 1);
      saida.motorFraco = visao.getUint8(inicio + 2);
      saida.duracaoMs = visao.getUint16(inicio + 4, LITTLE_ENDIAN);
      return RESULTADO_DECODIFICACAO.OK;
    }

    case TIPO_HAPTICO: {
      if (disponivel < TAMANHO_HAPTICO) {
        return RESULTADO_DECODIFICACAO.TAMANHO_INVALIDO;
      }
      saida.tipo = tipo;
      saida.tamanho = TAMANHO_HAPTICO;
      saida.padrao = visao.getUint8(inicio + 1);
      saida.intensidade = visao.getUint8(inicio + 2);
      return RESULTADO_DECODIFICACAO.OK;
    }

    default:
      return RESULTADO_DECODIFICACAO.TIPO_DESCONHECIDO;
  }
}

/** Leitor de pacotes com estado reaproveitado e contadores de diagnóstico. */
export type Decodificador = {
  /**
   * Destino padrão da decodificação — o **mesmo objeto** em todas as chamadas.
   *
   * ⚠️ **Só vale quando `decodificar()` devolveu `RESULTADO_DECODIFICACAO.OK`.** Em qualquer
   * descarte a saída fica zerada (`tipo === 0`), nunca com o pacote anterior.
   */
  readonly saida: PacoteDecodificado;
  /** Contadores da seção 7 do PROTOCOLO.md. O objeto nunca é trocado, só somado. */
  readonly contadores: ContadoresDoCodec;
  decodificar(
    dados: ArrayBufferView | ArrayBufferLike,
    destino?: PacoteDecodificado,
  ): ResultadoDeDecodificacao;
  zerarContadores(): void;
};

/**
 * Vista de zero byte compartilhada por todos os decodificadores. Serve de estado inicial e de
 * lugar para onde soltar a referência ao último `ArrayBuffer` visto — ver `zerarContadores`.
 */
const VISAO_VAZIA = new DataView(new ArrayBuffer(0));

export function criarDecodificador(): Decodificador {
  const saida = criarPacoteDecodificado();
  const contadores: ContadoresDoCodec = {
    pacotesRecebidos: 0,
    bytesRecebidos: 0,
    descartadosPorTamanho: 0,
    descartadosPorTipo: 0,
    comBytesExtras: 0,
    visoesCriadas: 0,
  };

  // Criar uma `DataView` por pacote seria alocação por pacote. Guardar a última e só refazê-la
  // quando o `ArrayBuffer` de origem muda deixa o custo em zero na prática — `visoesCriadas`
  // mede exatamente isso.
  let visao: DataView<ArrayBufferLike> = VISAO_VAZIA;
  let bufferDaVisao: ArrayBufferLike = visao.buffer;

  function vistaDe(buffer: ArrayBufferLike): DataView {
    if (bufferDaVisao !== buffer) {
      visao = new DataView(buffer);
      bufferDaVisao = buffer;
      contadores.visoesCriadas += 1;
    }
    return visao;
  }

  return {
    saida,
    contadores,

    decodificar(dados, destino = saida) {
      let buffer: ArrayBufferLike;
      let inicio: number;
      let disponivel: number;
      if (ArrayBuffer.isView(dados)) {
        buffer = dados.buffer;
        inicio = dados.byteOffset;
        disponivel = dados.byteLength;
      } else {
        buffer = dados;
        inicio = 0;
        disponivel = dados.byteLength;
      }

      contadores.bytesRecebidos += disponivel;
      const resultado = decodificarEm(
        vistaDe(buffer),
        inicio,
        disponivel,
        destino,
      );

      if (resultado === RESULTADO_DECODIFICACAO.OK) {
        contadores.pacotesRecebidos += 1;
        // Bytes sobrando = versão futura acrescentou campo no fim (seção 6, regra 1).
        if (disponivel > destino.tamanho) {
          contadores.comBytesExtras += 1;
        }
      } else if (resultado === RESULTADO_DECODIFICACAO.TAMANHO_INVALIDO) {
        contadores.descartadosPorTamanho += 1;
      } else {
        contadores.descartadosPorTipo += 1;
      }
      return resultado;
    },

    zerarContadores() {
      contadores.pacotesRecebidos = 0;
      contadores.bytesRecebidos = 0;
      contadores.descartadosPorTamanho = 0;
      contadores.descartadosPorTipo = 0;
      contadores.comBytesExtras = 0;
      contadores.visoesCriadas = 0;

      // Solta o último `ArrayBuffer` visto, para ele não ficar vivo junto com o decodificador
      // depois de a sessão morrer. `zerarContadores()` roda ao abrir sessão nova.
      visao = VISAO_VAZIA;
      bufferDaVisao = visao.buffer;
    },
  };
}

/* ============================================================ mensagens JSON (seção 3) */

/** Versão do protocolo falada por este app (campo `v` do handshake). */
export const VERSAO_PROTOCOLO = 1;

export const CODIGOS_DE_ERRO = [
  'VERSAO_INCOMPATIVEL',
  'PAREAMENTO_NECESSARIO',
  'TOKEN_INVALIDO',
  'SESSAO_SUBSTITUIDA',
  'PROTOCOLO_INVALIDO',
  'PERFIL_INEXISTENTE',
] as const;
export type CodigoDeErro = (typeof CODIGOS_DE_ERRO)[number];

export const COMANDOS = [
  'centralizar',
  'calibrar-inicio',
  'calibrar-fim',
  'trocar-perfil',
  'pausar',
  'retomar',
] as const;
export type Comando = (typeof COMANDOS)[number];

/**
 * Códigos de `aviso` (PROTOCOLO.md, seção 3.8). Conjunto fechado, como o de `erro`: um aviso novo
 * entra aqui, no servidor e na tabela do documento, na mesma entrega.
 */
export const CODIGOS_DE_AVISO = ['BIAS_ALTO'] as const;
export type CodigoDeAviso = (typeof CODIGOS_DE_AVISO)[number];

export const SISTEMAS_DE_APARELHO = ['android', 'ios'] as const;
export type SistemaDeAparelho = (typeof SISTEMAS_DE_APARELHO)[number];

export const TRANSPORTES = ['usb', 'wifi'] as const;
export type Transporte = (typeof TRANSPORTES)[number];

export const ESPACOS_DE_GIRO = ['local', 'mundo'] as const;
export type EspacoDeGiro = (typeof ESPACOS_DE_GIRO)[number];

export type AparelhoDoHello = {
  readonly id: string;
  readonly nome: string;
  readonly so: SistemaDeAparelho;
  readonly versaoSo: string;
  readonly modelo: string;
};

export type MensagemHello = {
  readonly t: 'hello';
  readonly v: number;
  readonly aparelho: AparelhoDoHello;
  readonly capacidades: readonly string[];
  readonly taxaHzDesejada: number;
  readonly token?: string | undefined;
  readonly codigoPareamento?: string | undefined;
};

export type ServidorDoWelcome = {
  readonly nome: string;
  readonly versao: string;
  readonly so: string;
};

export type SessaoDoWelcome = {
  readonly id: string;
  readonly taxaHz: number;
  readonly transporte: Transporte;
};

export type TelaDoWelcome = {
  readonly largura: number;
  readonly altura: number;
};

export type PerfilResumido = {
  readonly id: string;
  readonly nome: string;
};

export type MensagemWelcome = {
  readonly t: 'welcome';
  readonly v: number;
  readonly servidor: ServidorDoWelcome;
  readonly sessao: SessaoDoWelcome;
  readonly tela: TelaDoWelcome;
  /** Objeto completo do perfil; o schema é validado pelo módulo de perfis, não pelo codec. */
  readonly perfilAtivo: Readonly<Record<string, unknown>>;
  readonly perfis: readonly PerfilResumido[];
  readonly token?: string | undefined;
};

export type MensagemErro = {
  readonly t: 'erro';
  readonly codigo: CodigoDeErro;
  readonly mensagem?: string | undefined;
};

export type AjustesDeGiro = {
  readonly sensX?: number | undefined;
  readonly sensY?: number | undefined;
  readonly deadzone?: number | undefined;
  readonly suavizacao?: number | undefined;
  readonly inverterX?: boolean | undefined;
  readonly inverterY?: boolean | undefined;
  readonly espaco?: EspacoDeGiro | undefined;
};

export type MensagemConfig = {
  readonly t: 'config';
  readonly gyro: AjustesDeGiro;
};

export type MensagemConfigOk = {
  readonly t: 'config-ok';
  /** Valores **efetivos** depois dos limites da seção 3.4 do PROTOCOLO.md. */
  readonly gyro: AjustesDeGiro;
};

export type MensagemCmd = {
  readonly t: 'cmd';
  readonly comando: Comando;
  readonly perfilId?: string | undefined;
};

export type MensagemCmdOk = {
  readonly t: 'cmd-ok';
  readonly comando: Comando;
  readonly resultado?: Readonly<Record<string, unknown>> | undefined;
};

export type MensagemCmdErro = {
  readonly t: 'cmd-erro';
  readonly comando: Comando;
  readonly motivo: string;
};

export type MensagemPing = {
  readonly t: 'ping';
  readonly n: number;
  readonly tServidorMs: number;
};

export type MensagemPong = {
  readonly t: 'pong';
  readonly n: number;
  readonly tServidorMs: number;
  readonly tDispositivoMs: number;
};

export type MensagemBye = {
  readonly t: 'bye';
  readonly motivo?: string | undefined;
};

/**
 * Aviso do servidor para a tela (PROTOCOLO.md, seção 3.8) — estado, e não evento: o último
 * `aviso` de cada `codigo` vale até chegar outro do mesmo código. O texto vem pronto do PC; o app
 * mostra, não decide (CLAUDE.md, regra 4).
 */
export type MensagemAviso = {
  readonly t: 'aviso';
  readonly codigo: CodigoDeAviso;
  /** `true` acende (ou troca o texto de) o aviso deste código; `false` o tira da tela. */
  readonly ativo: boolean;
  /** Texto para pessoa ler. Obrigatório quando `ativo` é `true`. */
  readonly mensagem?: string | undefined;
};

export type MensagemDeTexto =
  | MensagemHello
  | MensagemWelcome
  | MensagemErro
  | MensagemConfig
  | MensagemConfigOk
  | MensagemCmd
  | MensagemCmdOk
  | MensagemCmdErro
  | MensagemPing
  | MensagemPong
  | MensagemBye
  | MensagemAviso;

export type ResultadoDeTexto =
  | {readonly ok: true; readonly mensagem: MensagemDeTexto}
  | {readonly ok: false; readonly codigo: CodigoDeErro; readonly motivo: string};

function recusar(
  motivo: string,
  codigo: CodigoDeErro = 'PROTOCOLO_INVALIDO',
): ResultadoDeTexto {
  return {ok: false, codigo, motivo};
}

function aceitar(mensagem: MensagemDeTexto): ResultadoDeTexto {
  return {ok: true, mensagem};
}

/**
 * Marcador de **campo presente com valor imprestável**.
 *
 * Sem ele, "ausente" e "presente e errado" cairiam os dois em `undefined`, e campo opcional
 * inválido viraria "não veio" em silêncio — que é justamente o que a seção 3 do PROTOCOLO.md
 * proíbe. Com o marcador, `undefined` quer dizer só "ausente"; qualquer outra falha vira
 * `INVALIDO` e quem chama recusa a mensagem inteira.
 */
const INVALIDO = Symbol('campo presente com valor inválido');
type Invalido = typeof INVALIDO;

/** Campo lido: o valor, `undefined` se ausente, `INVALIDO` se presente e imprestável. */
type Lido<T> = T | undefined | Invalido;

function ehInvalido(lido: unknown): lido is Invalido {
  return lido === INVALIDO;
}

/** Campo obrigatório: ausente e inválido dão no mesmo, e quem chama recusa dos dois jeitos. */
function exigido<T>(lido: Lido<T>): T | undefined {
  if (lido === undefined || lido === INVALIDO) {
    return undefined;
  }
  return lido;
}

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function texto(origem: Record<string, unknown>, campo: string): Lido<string> {
  const valor = origem[campo];
  if (valor === undefined) {
    return undefined;
  }
  return typeof valor === 'string' ? valor : INVALIDO;
}

/**
 * Número **finito**: `NaN` e infinito são recusados, porque envenenam qualquer conta adiante.
 * `JSON.parse('1e999')` devolve `Infinity` sem erro nenhum — é por aqui que ele entraria.
 */
function numero(origem: Record<string, unknown>, campo: string): Lido<number> {
  const valor = origem[campo];
  if (valor === undefined) {
    return undefined;
  }
  if (typeof valor !== 'number' || !Number.isFinite(valor)) {
    return INVALIDO;
  }
  return valor;
}

function booleano(
  origem: Record<string, unknown>,
  campo: string,
): Lido<boolean> {
  const valor = origem[campo];
  if (valor === undefined) {
    return undefined;
  }
  return typeof valor === 'boolean' ? valor : INVALIDO;
}

function objeto(
  origem: Record<string, unknown>,
  campo: string,
): Lido<Record<string, unknown>> {
  const valor = origem[campo];
  if (valor === undefined) {
    return undefined;
  }
  return ehObjeto(valor) ? valor : INVALIDO;
}

function lista(
  origem: Record<string, unknown>,
  campo: string,
): Lido<readonly unknown[]> {
  const valor = origem[campo];
  if (valor === undefined) {
    return undefined;
  }
  return Array.isArray(valor) ? (valor as readonly unknown[]) : INVALIDO;
}

/** Texto de conjunto fechado: fora do conjunto é `INVALIDO`, nunca "ausente". */
function daLista<T extends string>(
  valores: readonly T[],
  candidato: Lido<string>,
): Lido<T> {
  if (candidato === undefined) {
    return undefined;
  }
  if (ehInvalido(candidato)) {
    return INVALIDO;
  }
  return valores.includes(candidato as T) ? (candidato as T) : INVALIDO;
}

function lerAparelho(
  bruto: Record<string, unknown>,
): AparelhoDoHello | undefined {
  const id = exigido(texto(bruto, 'id'));
  const nome = exigido(texto(bruto, 'nome'));
  const so = exigido(daLista(SISTEMAS_DE_APARELHO, texto(bruto, 'so')));
  const versaoSo = exigido(texto(bruto, 'versaoSo'));
  const modelo = exigido(texto(bruto, 'modelo'));
  if (id === undefined || nome === undefined || so === undefined) {
    return undefined;
  }
  if (versaoSo === undefined || modelo === undefined) {
    return undefined;
  }
  return {id, nome, so, versaoSo, modelo};
}

/**
 * Leitura dos ajustes de giro. Todos os campos são **opcionais**, e é por isso que o retorno
 * carrega o nome do campo que reprovou: sem ele a recusa não diria o que o usuário mexeu.
 */
type LeituraDeGiro =
  | {readonly ok: true; readonly gyro: AjustesDeGiro}
  | {readonly ok: false; readonly campo: string};

function lerAjustesDeGiro(bruto: Record<string, unknown>): LeituraDeGiro {
  const sensX = numero(bruto, 'sensX');
  if (ehInvalido(sensX)) {
    return {ok: false, campo: 'sensX'};
  }
  const sensY = numero(bruto, 'sensY');
  if (ehInvalido(sensY)) {
    return {ok: false, campo: 'sensY'};
  }
  const deadzone = numero(bruto, 'deadzone');
  if (ehInvalido(deadzone)) {
    return {ok: false, campo: 'deadzone'};
  }
  const suavizacao = numero(bruto, 'suavizacao');
  if (ehInvalido(suavizacao)) {
    return {ok: false, campo: 'suavizacao'};
  }
  const inverterX = booleano(bruto, 'inverterX');
  if (ehInvalido(inverterX)) {
    return {ok: false, campo: 'inverterX'};
  }
  const inverterY = booleano(bruto, 'inverterY');
  if (ehInvalido(inverterY)) {
    return {ok: false, campo: 'inverterY'};
  }
  const espaco = daLista(ESPACOS_DE_GIRO, texto(bruto, 'espaco'));
  if (ehInvalido(espaco)) {
    return {ok: false, campo: 'espaco'};
  }
  return {
    ok: true,
    gyro: {sensX, sensY, deadzone, suavizacao, inverterX, inverterY, espaco},
  };
}

function lerHello(bruto: Record<string, unknown>): ResultadoDeTexto {
  const v = exigido(numero(bruto, 'v'));
  if (v === undefined) {
    return recusar('hello: campo "v" ausente ou não é número finito');
  }

  const aparelhoBruto = exigido(objeto(bruto, 'aparelho'));
  if (aparelhoBruto === undefined) {
    return recusar('hello: campo "aparelho" ausente ou inválido');
  }
  const aparelho = lerAparelho(aparelhoBruto);
  if (aparelho === undefined) {
    return recusar('hello: "aparelho" incompleto ou com "so" inválido');
  }

  const capacidadesBrutas = exigido(lista(bruto, 'capacidades'));
  if (capacidadesBrutas === undefined) {
    return recusar('hello: campo "capacidades" não é lista');
  }
  const capacidades: string[] = [];
  for (const item of capacidadesBrutas) {
    if (typeof item !== 'string') {
      return recusar('hello: "capacidades" só aceita texto');
    }
    capacidades.push(item);
  }

  const taxaHzDesejada = exigido(numero(bruto, 'taxaHzDesejada'));
  if (taxaHzDesejada === undefined) {
    return recusar('hello: "taxaHzDesejada" ausente ou não é número finito');
  }

  const token = texto(bruto, 'token');
  if (ehInvalido(token)) {
    return recusar('hello: "token" precisa ser texto quando presente');
  }
  const codigoPareamento = texto(bruto, 'codigoPareamento');
  if (ehInvalido(codigoPareamento)) {
    return recusar('hello: "codigoPareamento" precisa ser texto quando presente');
  }

  return aceitar({
    t: 'hello',
    v,
    aparelho,
    capacidades,
    taxaHzDesejada,
    token,
    codigoPareamento,
  });
}

function lerWelcome(bruto: Record<string, unknown>): ResultadoDeTexto {
  const v = exigido(numero(bruto, 'v'));
  if (v === undefined) {
    return recusar('welcome: campo "v" ausente ou não é número finito');
  }

  const servidorBruto = exigido(objeto(bruto, 'servidor'));
  if (servidorBruto === undefined) {
    return recusar('welcome: "servidor" ausente ou não é objeto');
  }
  const nome = exigido(texto(servidorBruto, 'nome'));
  const versao = exigido(texto(servidorBruto, 'versao'));
  const soServidor = exigido(texto(servidorBruto, 'so'));
  if (nome === undefined || versao === undefined || soServidor === undefined) {
    return recusar('welcome: "servidor" incompleto');
  }

  const sessaoBruta = exigido(objeto(bruto, 'sessao'));
  if (sessaoBruta === undefined) {
    return recusar('welcome: "sessao" ausente ou não é objeto');
  }
  const idSessao = exigido(texto(sessaoBruta, 'id'));
  const taxaHz = exigido(numero(sessaoBruta, 'taxaHz'));
  const transporte = exigido(
    daLista(TRANSPORTES, texto(sessaoBruta, 'transporte')),
  );
  if (
    idSessao === undefined ||
    taxaHz === undefined ||
    transporte === undefined
  ) {
    return recusar('welcome: "sessao" incompleta ou com "transporte" inválido');
  }

  const telaBruta = exigido(objeto(bruto, 'tela'));
  if (telaBruta === undefined) {
    return recusar('welcome: "tela" ausente ou não é objeto');
  }
  const largura = exigido(numero(telaBruta, 'largura'));
  const altura = exigido(numero(telaBruta, 'altura'));
  if (largura === undefined || altura === undefined) {
    return recusar('welcome: "tela" incompleta');
  }

  const perfilAtivo = exigido(objeto(bruto, 'perfilAtivo'));
  if (perfilAtivo === undefined) {
    return recusar('welcome: "perfilAtivo" ausente ou não é objeto');
  }

  const perfisBrutos = exigido(lista(bruto, 'perfis'));
  if (perfisBrutos === undefined) {
    return recusar('welcome: "perfis" não é lista');
  }
  const perfis: PerfilResumido[] = [];
  for (const item of perfisBrutos) {
    if (!ehObjeto(item)) {
      return recusar('welcome: item de "perfis" não é objeto');
    }
    const idPerfil = exigido(texto(item, 'id'));
    const nomePerfil = exigido(texto(item, 'nome'));
    if (idPerfil === undefined || nomePerfil === undefined) {
      return recusar('welcome: item de "perfis" precisa de "id" e "nome"');
    }
    perfis.push({id: idPerfil, nome: nomePerfil});
  }

  const token = texto(bruto, 'token');
  if (ehInvalido(token)) {
    return recusar('welcome: "token" precisa ser texto quando presente');
  }

  return aceitar({
    t: 'welcome',
    v,
    servidor: {nome, versao, so: soServidor},
    sessao: {id: idSessao, taxaHz, transporte},
    tela: {largura, altura},
    perfilAtivo,
    perfis,
    token,
  });
}

function lerErro(bruto: Record<string, unknown>): ResultadoDeTexto {
  const codigo = exigido(daLista(CODIGOS_DE_ERRO, texto(bruto, 'codigo')));
  if (codigo === undefined) {
    return recusar('erro: "codigo" ausente ou desconhecido');
  }
  const mensagem = texto(bruto, 'mensagem');
  if (ehInvalido(mensagem)) {
    return recusar('erro: "mensagem" precisa ser texto quando presente');
  }
  return aceitar({t: 'erro', codigo, mensagem});
}

function lerConfig(
  bruto: Record<string, unknown>,
  tipo: 'config' | 'config-ok',
): ResultadoDeTexto {
  const gyroBruto = exigido(objeto(bruto, 'gyro'));
  if (gyroBruto === undefined) {
    return recusar(`${tipo}: campo "gyro" ausente ou não é objeto`);
  }
  const leitura = lerAjustesDeGiro(gyroBruto);
  if (!leitura.ok) {
    return recusar(
      `${tipo}: "gyro.${leitura.campo}" com tipo, valor ou número inválido`,
    );
  }
  const gyro = leitura.gyro;
  return aceitar(
    tipo === 'config' ? {t: 'config', gyro} : {t: 'config-ok', gyro},
  );
}

function lerCmd(bruto: Record<string, unknown>): ResultadoDeTexto {
  const comando = exigido(daLista(COMANDOS, texto(bruto, 'comando')));
  if (comando === undefined) {
    return recusar('cmd: "comando" ausente ou desconhecido');
  }
  const perfilId = texto(bruto, 'perfilId');
  if (ehInvalido(perfilId)) {
    return recusar('cmd: "perfilId" precisa ser texto quando presente');
  }
  if (comando === 'trocar-perfil' && perfilId === undefined) {
    return recusar('cmd: "trocar-perfil" exige "perfilId"');
  }
  return aceitar({t: 'cmd', comando, perfilId});
}

function lerCmdOk(bruto: Record<string, unknown>): ResultadoDeTexto {
  const comando = exigido(daLista(COMANDOS, texto(bruto, 'comando')));
  if (comando === undefined) {
    return recusar('cmd-ok: "comando" ausente ou desconhecido');
  }
  const resultado = objeto(bruto, 'resultado');
  if (ehInvalido(resultado)) {
    return recusar('cmd-ok: "resultado" precisa ser objeto quando presente');
  }
  return aceitar({t: 'cmd-ok', comando, resultado});
}

function lerCmdErro(bruto: Record<string, unknown>): ResultadoDeTexto {
  const comando = exigido(daLista(COMANDOS, texto(bruto, 'comando')));
  if (comando === undefined) {
    return recusar('cmd-erro: "comando" ausente ou desconhecido');
  }
  const motivo = exigido(texto(bruto, 'motivo'));
  if (motivo === undefined) {
    return recusar('cmd-erro: "motivo" ausente ou não textual');
  }
  return aceitar({t: 'cmd-erro', comando, motivo});
}

function lerPing(bruto: Record<string, unknown>): ResultadoDeTexto {
  const n = exigido(numero(bruto, 'n'));
  const tServidorMs = exigido(numero(bruto, 'tServidorMs'));
  if (n === undefined || tServidorMs === undefined) {
    return recusar('ping: "n" e "tServidorMs" são obrigatórios e finitos');
  }
  return aceitar({t: 'ping', n, tServidorMs});
}

function lerPong(bruto: Record<string, unknown>): ResultadoDeTexto {
  const n = exigido(numero(bruto, 'n'));
  const tServidorMs = exigido(numero(bruto, 'tServidorMs'));
  const tDispositivoMs = exigido(numero(bruto, 'tDispositivoMs'));
  if (
    n === undefined ||
    tServidorMs === undefined ||
    tDispositivoMs === undefined
  ) {
    return recusar(
      'pong: "n", "tServidorMs" e "tDispositivoMs" são obrigatórios e finitos',
    );
  }
  return aceitar({t: 'pong', n, tServidorMs, tDispositivoMs});
}

function lerBye(bruto: Record<string, unknown>): ResultadoDeTexto {
  const motivo = texto(bruto, 'motivo');
  if (ehInvalido(motivo)) {
    return recusar('bye: "motivo" precisa ser texto quando presente');
  }
  return aceitar({t: 'bye', motivo});
}

function lerAviso(bruto: Record<string, unknown>): ResultadoDeTexto {
  const codigo = exigido(daLista(CODIGOS_DE_AVISO, texto(bruto, 'codigo')));
  if (codigo === undefined) {
    return recusar('aviso: "codigo" ausente ou desconhecido');
  }
  const ativo = exigido(booleano(bruto, 'ativo'));
  if (ativo === undefined) {
    return recusar('aviso: "ativo" ausente ou não é booleano');
  }
  const mensagem = texto(bruto, 'mensagem');
  if (ehInvalido(mensagem)) {
    return recusar('aviso: "mensagem" precisa ser texto quando presente');
  }
  // Aviso aceso sem texto não tem o que mostrar: a tela ficaria com um aviso em branco.
  if (ativo && mensagem === undefined) {
    return recusar('aviso: "ativo": true exige "mensagem"');
  }
  return aceitar({t: 'aviso', codigo, ativo, mensagem});
}

/**
 * Lê um quadro de texto e devolve a mensagem tipada ou o motivo da recusa.
 * Nunca lança — nem com JSON quebrado, nem com tipo desconhecido.
 *
 * O quadro de texto é **estrito nos dois sentidos** (PROTOCOLO.md, seção 3): `t` desconhecido,
 * campo obrigatório ausente, **valor fora do conjunto declarado**, **número não finito**
 * (`NaN`, `Infinity`) e **campo opcional presente com o tipo errado** viram recusa com
 * `PROTOCOLO_INVALIDO`. Só campo desconhecido a mais é ignorado. O "ignora silenciosamente" da
 * seção 6 vale só para os quadros binários.
 */
export function interpretarMensagemDeTexto(quadro: string): ResultadoDeTexto {
  let bruto: unknown;
  try {
    bruto = JSON.parse(quadro) as unknown;
  } catch {
    return recusar('JSON inválido');
  }
  if (!ehObjeto(bruto)) {
    return recusar('a mensagem precisa ser um objeto JSON');
  }

  const tipo = bruto.t;
  if (typeof tipo !== 'string') {
    return recusar('campo "t" ausente ou não textual');
  }

  switch (tipo) {
    case 'hello':
      return lerHello(bruto);
    case 'welcome':
      return lerWelcome(bruto);
    case 'erro':
      return lerErro(bruto);
    case 'config':
      return lerConfig(bruto, 'config');
    case 'config-ok':
      return lerConfig(bruto, 'config-ok');
    case 'cmd':
      return lerCmd(bruto);
    case 'cmd-ok':
      return lerCmdOk(bruto);
    case 'cmd-erro':
      return lerCmdErro(bruto);
    case 'ping':
      return lerPing(bruto);
    case 'pong':
      return lerPong(bruto);
    case 'bye':
      return lerBye(bruto);
    case 'aviso':
      return lerAviso(bruto);
    default:
      return recusar(`tipo de mensagem desconhecido: ${tipo}`);
  }
}

/**
 * Serializa uma mensagem para o quadro de texto.
 *
 * `JSON.stringify` já omite campo `undefined`, que é o que o protocolo quer: campo opcional
 * ausente é ausente no fio, não `null`.
 */
export function serializarMensagemDeTexto(mensagem: MensagemDeTexto): string {
  return JSON.stringify(mensagem);
}
