/**
 * Codificação e decodificação dos quadros binários (PROTOCOLO.md, seções 4 e 5).
 *
 * ⚠️ CAMINHO QUENTE. Este arquivo roda 100 vezes por segundo, para sempre. Vale a regra 2 do
 * CLAUDE.md em toda linha:
 *
 * - **Zero alocação por pacote no decodificador.** O resultado é escrito num
 *   `PacoteDecodificado` mutável reaproveitado (o do próprio decodificador ou um fornecido
 *   pelo chamador) e o retorno é um **número** (`RESULTADO_DECODIFICACAO`), não um objeto.
 *   A `DataView` também é reaproveitada: só nasce outra quando o `ArrayBuffer` de origem muda
 *   (o contador `visoesCriadas` deixa isso mensurável).
 * - **Zero alocação por pacote no codificador.** Um `ArrayBuffer` de 36 bytes e as fatias de
 *   cada tamanho são criados uma vez, na construção; cada chamada só escreve por cima.
 * - **Zero log por pacote.** Erro de formato vira contador, nunca linha de log.
 *
 * `littleEndian = true` aparece explícito em **toda** leitura e escrita de mais de um byte.
 * Sem isso o código dependeria da ordem de bytes da máquina — que é little-endian no x86 e no
 * ARM do celular, mas não é garantia de linguagem nenhuma.
 */

import {
  ESTADO_PRESSIONADO,
  FLAG_ACELEROMETRO,
  RESULTADO_DECODIFICACAO,
  SEQ_MAXIMO,
  TAMANHO_BOTAO,
  TAMANHO_EIXO,
  TAMANHO_HAPTICO,
  TAMANHO_MAXIMO_PACOTE,
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
  type ContadoresDoCodec,
  type PacoteDecodificado,
  type ResultadoDeDecodificacao,
} from './tipos.js';

/** Toda leitura e escrita multibyte usa este valor — nunca o padrão da plataforma. */
const LITTLE_ENDIAN = true;

/* ================================================================== saturação de campos */

/**
 * Campos inteiros do protocolo têm faixa fechada (0–255, 0–65535). `DataView.setUint8` trunca
 * em silêncio: `300` viraria `44`, e o defeito só apareceria como um clique no botão errado.
 * Aqui o valor fora da faixa é **saturado**, na mesma linha da seção 3.4 do PROTOCOLO.md
 * ("o servidor satura valores fora da faixa em vez de recusar"). NaN e infinito viram 0/limite.
 */
function paraU8(valor: number): number {
  if (Number.isNaN(valor)) return 0;
  const inteiro = Math.trunc(valor);
  if (inteiro <= 0) return 0;
  return inteiro >= 0xff ? 0xff : inteiro;
}

function paraU16(valor: number): number {
  if (Number.isNaN(valor)) return 0;
  const inteiro = Math.trunc(valor);
  if (inteiro <= 0) return 0;
  return inteiro >= 0xffff ? 0xffff : inteiro;
}

/**
 * `seq` é o único inteiro que **dá a volta** em vez de saturar: é assim que o PROTOCOLO.md
 * (seção 4.1) define a sequência. `65536` vira `0`, `65538` vira `2`.
 */
function paraSeq(valor: number): number {
  if (!Number.isFinite(valor)) return 0;
  return Math.trunc(valor) & SEQ_MAXIMO;
}

/**
 * `tDispositivoMs` também é cíclico: é o relógio monotônico do aparelho em u32, que dá a volta
 * a cada ~49,7 dias. Saturar aqui congelaria o carimbo de tempo em vez de deixá-lo virar.
 */
function paraU32Ciclico(valor: number): number {
  if (!Number.isFinite(valor)) return 0;
  return Math.trunc(valor) >>> 0;
}

/* ============================================================================ codificador */

/**
 * Escritor de pacotes com buffer reaproveitado.
 *
 * ⚠️ O `Uint8Array` devolvido é uma **janela sobre o buffer interno**, válida só até a próxima
 * chamada. Quem envia precisa consumir o resultado de forma síncrona (é o caso de
 * `WebSocket.send`, que copia para a fila do socket na hora) ou copiar com `copiar()`. Guardar
 * a referência para usar depois lê o pacote seguinte.
 */
export interface Codificador {
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
  botao(seq: number, idControle: number, pressionado: boolean, pressao?: number): Uint8Array;

  /** `0x03` EIXO — 16 bytes. `x`/`y` de −1,0 a 1,0 (não são saturados: o fio aceita f32). */
  eixo(seq: number, idControle: number, x: number, y: number): Uint8Array;

  /** `0x04` SCROLL — 12 bytes. Deltas em cliques de roda, fracionários. */
  scroll(seq: number, deltaVertical: number, deltaHorizontal: number): Uint8Array;

  /** `0x81` RUMBLE — 8 bytes. `duracaoMs` 0 = manter até o próximo comando. */
  rumble(motorForte: number, motorFraco: number, duracaoMs: number): Uint8Array;

  /** `0x82` HÁPTICO — 4 bytes. `padrao` conforme `PADROES_HAPTICOS`. */
  haptico(padrao: number, intensidade: number): Uint8Array;
}

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
  const fatiaMovimentoComAcelerometro = bytes.subarray(0, TAMANHO_MOVIMENTO_COM_ACELEROMETRO);
  const fatiaBotao = bytes.subarray(0, TAMANHO_BOTAO);
  const fatiaEixo = bytes.subarray(0, TAMANHO_EIXO);
  const fatiaScroll = bytes.subarray(0, TAMANHO_SCROLL);
  const fatiaRumble = bytes.subarray(0, TAMANHO_RUMBLE);
  const fatiaHaptico = bytes.subarray(0, TAMANHO_HAPTICO);

  /** Cabeçalho comum do MOVIMENTO, sem o acelerômetro. */
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
      // bit0 descreve o tamanho do pacote; deixar quem chama mentir aqui produziria um
      // pacote de 24 bytes que o outro lado tentaria ler como 36.
      escreverMovimento(paraU8(flags) & ~FLAG_ACELEROMETRO, seq, tDispositivoMs, dtMs, gx, gy, gz);
      return fatiaMovimento;
    },

    movimentoComAcelerometro(seq, tDispositivoMs, dtMs, gx, gy, gz, ax, ay, az, flags = 0) {
      escreverMovimento(paraU8(flags) | FLAG_ACELEROMETRO, seq, tDispositivoMs, dtMs, gx, gy, gz);
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

/* =========================================================================== decodificador */

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

/**
 * Zera todos os campos antes de preencher os do tipo lido.
 *
 * Existe porque o objeto de saída é reaproveitado: sem isto, um `gx` do pacote anterior
 * sobreviveria dentro de um BOTÃO e passaria por dado novo. São ~26 escritas de número — nada
 * é alocado, e o custo a 100 Hz é irrelevante perto do risco de ler sobra.
 */
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
 *
 * Função pura e sem estado — o reaproveitamento de `DataView` e os contadores ficam por conta
 * de `criarDecodificador()`. Não lança: todo defeito de formato vira código de retorno.
 *
 * ⚠️ `saida` só vale quando o retorno é `RESULTADO_DECODIFICACAO.OK`. Nos outros casos ela fica
 * **zerada** (`tipo === 0`), nunca com o pacote anterior: se um descarte deixasse para trás um
 * BOTÃO com `pressionado: true`, quem esquecesse de olhar o retorno produziria um clique
 * fantasma — e clique fantasma é a versão barulhenta do botão preso (regra 5 do CLAUDE.md).
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

  if (disponivel < 1) return RESULTADO_DECODIFICACAO.TAMANHO_INVALIDO;

  const tipo = visao.getUint8(inicio);

  switch (tipo) {
    case TIPO_MOVIMENTO: {
      if (disponivel < TAMANHO_MOVIMENTO) return RESULTADO_DECODIFICACAO.TAMANHO_INVALIDO;
      const flags = visao.getUint8(inicio + 1);
      const temAcelerometro = (flags & FLAG_ACELEROMETRO) !== 0;
      if (temAcelerometro && disponivel < TAMANHO_MOVIMENTO_COM_ACELEROMETRO) {
        return RESULTADO_DECODIFICACAO.TAMANHO_INVALIDO;
      }
      saida.tipo = tipo;
      saida.tamanho = temAcelerometro ? TAMANHO_MOVIMENTO_COM_ACELEROMETRO : TAMANHO_MOVIMENTO;
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
      if (disponivel < TAMANHO_BOTAO) return RESULTADO_DECODIFICACAO.TAMANHO_INVALIDO;
      saida.tipo = tipo;
      saida.tamanho = TAMANHO_BOTAO;
      saida.estado = visao.getUint8(inicio + 1);
      // A tabela 4.2 declara o conjunto {0, 1}: só o 1 é pressionado, e qualquer outro byte
      // resolve para solto. Decidido aqui, uma vez, para não virar `if (estado)` na ponta.
      saida.pressionado = saida.estado === ESTADO_PRESSIONADO;
      saida.seq = visao.getUint16(inicio + 2, LITTLE_ENDIAN);
      saida.idControle = visao.getUint16(inicio + 4, LITTLE_ENDIAN);
      saida.pressao = visao.getUint8(inicio + 6);
      // byte 7 é reservado: lido como nada, para o dia em que virar campo (seção 6, regra 1).
      return RESULTADO_DECODIFICACAO.OK;
    }

    case TIPO_EIXO: {
      if (disponivel < TAMANHO_EIXO) return RESULTADO_DECODIFICACAO.TAMANHO_INVALIDO;
      saida.tipo = tipo;
      saida.tamanho = TAMANHO_EIXO;
      saida.seq = visao.getUint16(inicio + 2, LITTLE_ENDIAN);
      saida.idControle = visao.getUint16(inicio + 4, LITTLE_ENDIAN);
      saida.x = visao.getFloat32(inicio + 8, LITTLE_ENDIAN);
      saida.y = visao.getFloat32(inicio + 12, LITTLE_ENDIAN);
      return RESULTADO_DECODIFICACAO.OK;
    }

    case TIPO_SCROLL: {
      if (disponivel < TAMANHO_SCROLL) return RESULTADO_DECODIFICACAO.TAMANHO_INVALIDO;
      saida.tipo = tipo;
      saida.tamanho = TAMANHO_SCROLL;
      saida.seq = visao.getUint16(inicio + 2, LITTLE_ENDIAN);
      saida.deltaVertical = visao.getFloat32(inicio + 4, LITTLE_ENDIAN);
      saida.deltaHorizontal = visao.getFloat32(inicio + 8, LITTLE_ENDIAN);
      return RESULTADO_DECODIFICACAO.OK;
    }

    case TIPO_RUMBLE: {
      if (disponivel < TAMANHO_RUMBLE) return RESULTADO_DECODIFICACAO.TAMANHO_INVALIDO;
      saida.tipo = tipo;
      saida.tamanho = TAMANHO_RUMBLE;
      saida.motorForte = visao.getUint8(inicio + 1);
      saida.motorFraco = visao.getUint8(inicio + 2);
      saida.duracaoMs = visao.getUint16(inicio + 4, LITTLE_ENDIAN);
      return RESULTADO_DECODIFICACAO.OK;
    }

    case TIPO_HAPTICO: {
      if (disponivel < TAMANHO_HAPTICO) return RESULTADO_DECODIFICACAO.TAMANHO_INVALIDO;
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
export interface Decodificador {
  /**
   * Destino padrão da decodificação — o **mesmo objeto** em todas as chamadas.
   *
   * ⚠️ **Só vale quando `decodificar()` devolveu `RESULTADO_DECODIFICACAO.OK`.** Quem é o dono
   * da verdade é o retorno, não o objeto: em qualquer descarte a saída fica zerada
   * (`tipo === 0`), nunca com o pacote anterior. Ler `saida` sem olhar o retorno é o caminho
   * para um clique fantasma.
   */
  readonly saida: PacoteDecodificado;
  /** Contadores da seção 7 do PROTOCOLO.md. O objeto nunca é trocado, só somado. */
  readonly contadores: ContadoresDoCodec;
  /**
   * Lê um quadro. Nunca lança e nunca aloca: o resultado vai para `saida` (ou para o objeto
   * passado em `destino`) e o retorno diz se deu certo.
   */
  decodificar(
    dados: ArrayBufferView | ArrayBufferLike,
    destino?: PacoteDecodificado,
  ): ResultadoDeDecodificacao;
  /** Zera os contadores (usado ao abrir sessão nova e nos testes). */
  zerarContadores(): void;
}

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

  // A `DataView` é cara de criar e seria uma alocação por pacote. Como o `ws` entrega os
  // quadros a partir do mesmo pool de `Buffer`, guardar a última vista e só refazê-la quando o
  // `ArrayBuffer` de origem muda deixa o custo em zero na prática — `visoesCriadas` mede isso.
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
      const resultado = decodificarEm(vistaDe(buffer), inicio, disponivel, destino);

      if (resultado === RESULTADO_DECODIFICACAO.OK) {
        contadores.pacotesRecebidos += 1;
        // Bytes sobrando = versão futura acrescentou campo no fim (seção 6, regra 1). O pacote
        // vale, e o excedente vira contador para a sobra não passar despercebida.
        if (disponivel > destino.tamanho) contadores.comBytesExtras += 1;
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

      // Solta o último `ArrayBuffer` visto. Com o `ws` esse buffer é o pool de 8 KB do Node:
      // segurá-lo manteria 8 KB vivos enquanto o decodificador viver, mesmo depois de a sessão
      // morrer. `zerarContadores()` roda ao abrir sessão nova — é o lugar natural para soltar.
      visao = VISAO_VAZIA;
      bufferDaVisao = visao.buffer;
    },
  };
}
