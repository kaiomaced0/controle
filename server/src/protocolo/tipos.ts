/**
 * Constantes e formas do protocolo binário — espelho fiel de `docs/PROTOCOLO.md`, seções 4 e 5.
 *
 * Este arquivo é a **fonte única do formato** no lado do PC. O mesmo conteúdo existe em
 * `app/src/transporte/protocolo.ts`; a duplicação é consciente (o app não compartilha build com
 * o servidor na v1) e é vigiada por `espelho.teste.ts`, que compara os dois arquivos byte a byte
 * nas constantes.
 *
 * Regra do projeto: mudou byte aqui, muda `docs/PROTOCOLO.md` e o app **na mesma entrega**.
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
 * corrompido num pacote de soltura não pode virar "continua pressionado". Quem lê usa
 * `pacote.pressionado`, já normalizado aqui, em vez de inventar `if (estado)` na ponta.
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
export type CodigoDePadraoHaptico = (typeof PADROES_HAPTICOS)[NomeDePadraoHaptico];

const NOMES_DE_PADRAO_HAPTICO = Object.freeze(
  Object.keys(PADROES_HAPTICOS) as readonly NomeDePadraoHaptico[],
);

/** Nome do padrão a partir do código no fio, ou `undefined` se o código não existir. */
export function nomeDoPadraoHaptico(codigo: number): NomeDePadraoHaptico | undefined {
  for (const nome of NOMES_DE_PADRAO_HAPTICO) {
    if (PADROES_HAPTICOS[nome] === codigo) return nome;
  }
  return undefined;
}

/* ------------------------------------------------------- resultado da decodificação */

/**
 * Retorno do decodificador. É **número**, não objeto nem string: o decodificador roda a
 * 100 Hz e não pode alocar nada por pacote (regra 2 do CLAUDE.md).
 */
export const RESULTADO_DECODIFICACAO = Object.freeze({
  /** Pacote lido; `saida` está preenchida. */
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
 * Destino mutável da decodificação — **um objeto só, reaproveitado a cada pacote**.
 *
 * Por que não uma união discriminada com um objeto por tipo: cada `{...}` por pacote seria
 * lixo para o coletor 100 vezes por segundo, para sempre. Aqui todos os campos de todos os
 * tipos convivem no mesmo objeto de forma plana; quem lê olha `tipo` primeiro e só então os
 * campos daquele tipo. Os campos que não pertencem ao tipo lido são **zerados** pelo
 * decodificador, para que sobra do pacote anterior nunca passe por dado novo.
 */
export interface PacoteDecodificado {
  /** Código do tipo lido (`TIPO_*`). */
  tipo: number;
  /** Bytes consumidos por este pacote — 24/36 no MOVIMENTO, fixo nos demais. */
  tamanho: number;

  // MOVIMENTO (0x01)
  flags: number;
  seq: number;
  tDispositivoMs: number;
  dtMs: number;
  gx: number;
  gy: number;
  gz: number;
  /** Cópia de `flags & FLAG_ACELEROMETRO`, já resolvida para quem consome. */
  temAcelerometro: boolean;
  ax: number;
  ay: number;
  az: number;

  // BOTÃO (0x02) — `seq` acima também vale aqui
  /** Byte 1 cru do fio, sem normalização — para diagnóstico. Quem decide usa `pressionado`. */
  estado: number;
  /**
   * `estado === ESTADO_PRESSIONADO`, já decidido aqui no codec.
   *
   * Existe porque `if (estado)` e `if (estado === 1)` divergem para qualquer byte fora de
   * `{0, 1}` — um leria "pressionado" e o outro "solto" para o mesmo pacote. Deixar essa
   * escolha para cada consumidor é como se produz botão preso.
   */
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
}

/**
 * Contadores de diagnóstico do codec (PROTOCOLO.md, seção 7). Objeto mutável, nunca trocado.
 *
 * Os nomes são os **da tabela da seção 7**, letra por letra: quem for expor telemetria não
 * deve precisar traduzir nome nenhum no caminho.
 */
export interface ContadoresDoCodec {
  /** Pacotes decodificados com sucesso. */
  pacotesRecebidos: number;
  /** Bytes entregues ao decodificador, incluindo os descartados. */
  bytesRecebidos: number;
  /** Descartados por bytes de menos (truncado). */
  descartadosPorTamanho: number;
  /** Descartados por tipo desconhecido. */
  descartadosPorTipo: number;
  /** Aceitos, mas com bytes sobrando no fim (versão futura do protocolo). */
  comBytesExtras: number;
  /**
   * Quantas `DataView` o decodificador precisou criar desde o último `zerarContadores()`.
   * É a prova mensurável do "zero alocação por pacote": num fluxo real ela para de crescer.
   */
  visoesCriadas: number;
}
