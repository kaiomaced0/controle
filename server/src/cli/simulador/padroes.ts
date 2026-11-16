/**
 * Padrões de movimento do simulador — o que o "aparelho de mentira" faz com o giroscópio.
 *
 * O valor de um simulador não é fingir um celular: é entregar **movimento conhecido**. Quando a
 * execução declara "90° no eixo y", o deslocamento esperado do cursor na ponta vira conta, e a
 * conta vira teste (ATI-023, e a base dos testes do pipeline na ATI-008).
 *
 * Três decisões que valem para todos os padrões:
 *
 * 1. **A linha de comando fala em graus; o fio fala em rad/s.** Grau por segundo é a unidade em
 *    que as pessoas pensam (e a mesma da `deadzone` do perfil, ARQUITETURA.md seção 4); rad/s é
 *    o que o PROTOCOLO.md, seção 1, manda trafegar. A conversão acontece aqui, uma vez.
 * 2. **A primeira amostra vai com `dtMs` 0** e o bit `FLAG_PRIMEIRA_APOS_RETOMAR` ligado — ela
 *    não tem amostra anterior contra a qual integrar. Por isso uma execução de `n` intervalos
 *    tem `n + 1` amostras, e o total de graus se distribui pelos `n` intervalos de verdade.
 * 3. **O gerador é consumido na mesma ordem e na mesma quantidade em toda amostra**, mesmo com
 *    ruído zero. Assim mexer só no `--ruido` não embaralha o resto da sequência, e comparar duas
 *    execuções continua sendo comparar uma coisa de cada vez.
 */

import {
  FLAG_PRIMEIRA_APOS_RETOMAR,
  proximoSeq,
  type PacoteDecodificado,
} from '../../protocolo/indice.js';
import type { AmostraDeCaptura } from '../captura.js';
import { criarGerador, SEMENTE_PADRAO, type GeradorPseudoaleatorio } from './gerador.js';

/** Padrões aceitos em `--padrao`. */
export const PADROES = ['parado', 'rotacao', 'tremor', 'pico', 'gravado'] as const;
export type NomeDePadrao = (typeof PADROES)[number];

/** Eixos do giroscópio, aceitos em `--eixo`. */
export const EIXOS = ['x', 'y', 'z'] as const;
export type Eixo = (typeof EIXOS)[number];

export function ehNomeDePadrao(valor: string): valor is NomeDePadrao {
  return (PADROES as readonly string[]).includes(valor);
}

export function ehEixo(valor: string): valor is Eixo {
  return (EIXOS as readonly string[]).includes(valor);
}

const GRAUS_PARA_RADIANOS = Math.PI / 180;

/** Gravidade padrão, para o acelerômetro do aparelho parado de pé. */
const GRAVIDADE_MS2 = 9.80665;

/** Desvio do ruído do acelerômetro. Constante: ele não é o objeto de teste de nenhum padrão. */
const RUIDO_DO_ACELEROMETRO_MS2 = 0.02;

/**
 * Relógio inicial do aparelho de mentira.
 *
 * Não é zero de propósito: o `tDispositivoMs` real é o *uptime* do celular, e um simulador que
 * sempre começasse em 0 esconderia qualquer código que confundisse esse campo com "tempo desde
 * o início da sessão".
 */
export const TEMPO_INICIAL_DO_APARELHO_MS = 60_000;

/**
 * Proporção do bias entre os três eixos, na razão do exemplo do PROTOCOLO.md, seção 3.5
 * (`[0.0031, -0.0007, 0.0012]` rad/s): giroscópio parado não acusa zero, e não acusa o mesmo
 * valor nos três eixos. `--bias` escala esse vetor.
 */
const BIAS_RELATIVO: Readonly<Record<Eixo, number>> = Object.freeze({
  x: 0.62,
  y: -0.14,
  z: 0.24,
});

/* ------------------------------------------------------------------------------- padrões */

export const TAXA_HZ_PADRAO = 100;
export const DURACAO_S_PADRAO = 5;
export const EIXO_PADRAO: Eixo = 'y';
/** Velocidade da `rotacao` quando não se pede `--graus`. */
export const VELOCIDADE_PADRAO_GRAUS_POR_S = 90;
/** Amplitude do `tremor` — abaixo da `deadzone` de fábrica (0,35 °/s) de propósito. */
export const AMPLITUDE_PADRAO_GRAUS_POR_S = 0.3;
/** Frequência do `tremor`: alta perto dos 100 Hz de amostragem, como mão tremendo. */
export const FREQUENCIA_PADRAO_HZ = 8;
/** Desvio do ruído do giroscópio. Zero em `rotacao`, cujo ponto é o total exato de graus. */
export const RUIDO_PADRAO_GRAUS_POR_S = 0.05;
/** Bias de aparelho parado: 0,29 °/s ≈ 0,005 rad/s, a ordem de grandeza real. */
export const BIAS_PADRAO_GRAUS_POR_S = 0.29;
/** Amostra absurda do `pico`: 2000 °/s é o fundo de escala típico de um giroscópio de celular. */
export const PICO_PADRAO_GRAUS_POR_S = 2000;

/* ------------------------------------------------------------------------------- amostra */

/**
 * Uma amostra pronta para virar pacote MOVIMENTO.
 *
 * Objeto **mutável e reaproveitado**: a fonte preenche sempre o mesmo, na mesma linha do
 * `PacoteDecodificado` do codec (regra 2 do CLAUDE.md). Quem precisar guardar, copia.
 */
export interface AmostraSimulada {
  seq: number;
  tDispositivoMs: number;
  dtMs: number;
  gx: number;
  gy: number;
  gz: number;
  flags: number;
  temAcelerometro: boolean;
  ax: number;
  ay: number;
  az: number;
}

export function criarAmostraSimulada(): AmostraSimulada {
  return {
    seq: 0,
    tDispositivoMs: 0,
    dtMs: 0,
    gx: 0,
    gy: 0,
    gz: 0,
    flags: 0,
    temAcelerometro: false,
    ax: 0,
    ay: 0,
    az: 0,
  };
}

/** Cópia independente — para teste guardar sequência sem se enganar com o reaproveitamento. */
export function copiarAmostra(amostra: AmostraSimulada): AmostraSimulada {
  return { ...amostra };
}

/** Pedido de simulação inválido (padrão desconhecido, taxa zero, `gravado` sem arquivo...). */
export class ErroDoSimulador extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroDoSimulador';
  }
}

/* ---------------------------------------------------------------------------- parâmetros */

/** O que se pede; tudo opcional, os padrões acima preenchem o resto. */
export interface OpcoesDePadrao {
  readonly padrao?: NomeDePadrao | undefined;
  readonly taxaHz?: number | undefined;
  readonly duracaoS?: number | undefined;
  readonly eixo?: Eixo | undefined;
  /** Total de graus da `rotacao`. Quando vem, é ele que define quantas amostras a execução tem. */
  readonly graus?: number | undefined;
  readonly velocidadeGrausPorS?: number | undefined;
  readonly amplitudeGrausPorS?: number | undefined;
  readonly frequenciaHz?: number | undefined;
  readonly ruidoGrausPorS?: number | undefined;
  readonly biasGrausPorS?: number | undefined;
  readonly picoGrausPorS?: number | undefined;
  /** Em qual amostra o `pico` acontece. O padrão é o meio da execução. */
  readonly indiceDoPico?: number | undefined;
  readonly semente?: number | undefined;
  /** Envia `ax`/`ay`/`az` junto (pacote de 36 bytes em vez de 24). */
  readonly acelerometro?: boolean | undefined;
  /** Amostras lidas de um arquivo — obrigatório no padrão `gravado`. */
  readonly amostrasGravadas?: readonly AmostraDeCaptura[] | undefined;
}

/** O mesmo pedido, com todo campo resolvido e validado. */
export interface ParametrosDoPadrao {
  readonly padrao: NomeDePadrao;
  readonly taxaHz: number;
  readonly duracaoS: number;
  readonly eixo: Eixo;
  readonly graus: number | undefined;
  readonly velocidadeGrausPorS: number;
  readonly amplitudeGrausPorS: number;
  readonly frequenciaHz: number;
  readonly ruidoGrausPorS: number;
  readonly biasGrausPorS: number;
  readonly picoGrausPorS: number;
  readonly indiceDoPico: number | undefined;
  readonly semente: number;
  readonly acelerometro: boolean;
  readonly amostrasGravadas: readonly AmostraDeCaptura[] | undefined;
}

function exigirPositivo(valor: number, nome: string): number {
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new ErroDoSimulador(`${nome} precisa ser um número maior que zero; recebi ${valor}`);
  }
  return valor;
}

function exigirFinito(valor: number, nome: string): number {
  if (!Number.isFinite(valor)) {
    throw new ErroDoSimulador(`${nome} precisa ser um número finito; recebi ${valor}`);
  }
  return valor;
}

function exigirNaoNegativo(valor: number, nome: string): number {
  if (!Number.isFinite(valor) || valor < 0) {
    throw new ErroDoSimulador(`${nome} não pode ser negativo; recebi ${valor}`);
  }
  return valor;
}

/**
 * Aplica os padrões e valida a combinação pedida.
 *
 * @throws {ErroDoSimulador} com a mensagem pronta para o terminal.
 */
export function resolverParametros(opcoes: OpcoesDePadrao = {}): ParametrosDoPadrao {
  const padrao = opcoes.padrao ?? 'parado';
  const taxaHz = exigirPositivo(opcoes.taxaHz ?? TAXA_HZ_PADRAO, '--taxa');
  const duracaoS = exigirPositivo(opcoes.duracaoS ?? DURACAO_S_PADRAO, '--duracao');
  // O `rotacao` é o único padrão cujo ponto é um número exato; nele o ruído só entra se
  // alguém pedir. Nos outros, um sensor sem ruído nenhum não se parece com sensor nenhum.
  const ruidoGrausPorS = exigirNaoNegativo(
    opcoes.ruidoGrausPorS ?? (padrao === 'rotacao' ? 0 : RUIDO_PADRAO_GRAUS_POR_S),
    '--ruido',
  );

  if (padrao === 'gravado' && (opcoes.amostrasGravadas ?? []).length === 0) {
    throw new ErroDoSimulador(
      'o padrão "gravado" precisa de um arquivo de captura com amostras (--arquivo)',
    );
  }

  const graus = opcoes.graus === undefined ? undefined : exigirFinito(opcoes.graus, '--graus');
  if (graus !== undefined && graus === 0) {
    throw new ErroDoSimulador('--graus 0 não gera movimento nenhum; use o padrão "parado"');
  }

  const indiceDoPico =
    opcoes.indiceDoPico === undefined
      ? undefined
      : Math.trunc(exigirNaoNegativo(opcoes.indiceDoPico, '--indice-do-pico'));

  return {
    padrao,
    taxaHz,
    duracaoS,
    eixo: opcoes.eixo ?? EIXO_PADRAO,
    graus,
    velocidadeGrausPorS: exigirPositivo(
      opcoes.velocidadeGrausPorS ?? VELOCIDADE_PADRAO_GRAUS_POR_S,
      '--velocidade',
    ),
    amplitudeGrausPorS: exigirNaoNegativo(
      opcoes.amplitudeGrausPorS ?? AMPLITUDE_PADRAO_GRAUS_POR_S,
      '--amplitude',
    ),
    frequenciaHz: exigirPositivo(opcoes.frequenciaHz ?? FREQUENCIA_PADRAO_HZ, '--frequencia'),
    ruidoGrausPorS,
    biasGrausPorS: exigirFinito(opcoes.biasGrausPorS ?? BIAS_PADRAO_GRAUS_POR_S, '--bias'),
    picoGrausPorS: exigirFinito(opcoes.picoGrausPorS ?? PICO_PADRAO_GRAUS_POR_S, '--pico'),
    indiceDoPico,
    semente: opcoes.semente ?? SEMENTE_PADRAO,
    acelerometro: opcoes.acelerometro ?? false,
    amostrasGravadas: opcoes.amostrasGravadas,
  };
}

/* --------------------------------------------------------------------- fonte de amostras */

export interface FonteDeAmostras {
  readonly padrao: NomeDePadrao;
  /** Quantas amostras a execução inteira tem, incluindo a primeira (de `dtMs` 0). */
  readonly total: number;
  /** Duração prevista, do primeiro ao último envio. */
  readonly duracaoPrevistaMs: number;
  /**
   * Graus que a execução integra no eixo escolhido — o "movimento conhecido".
   *
   * É exato por construção na `rotacao` (a velocidade é derivada do total pedido, e não o
   * contrário). Nos outros padrões é 0: ali o total não é o ponto.
   */
  readonly grausTotais: number;
  /** Uma linha para o resumo da execução. */
  readonly descricao: string;
  /** Preenche `destino` com a próxima amostra; `false` quando a sequência acabou. */
  proxima(destino: AmostraSimulada): boolean;
  /** Recomeça do zero, com a mesma semente — a mesma sequência sai de novo. */
  reiniciar(): void;
}

/** Quantos intervalos (não amostras) a execução tem, e a velocidade efetiva da rotação. */
function dimensionar(parametros: ParametrosDoPadrao): {
  intervalos: number;
  velocidadeEfetivaGrausPorS: number;
} {
  const dtS = 1 / parametros.taxaHz;

  if (parametros.padrao === 'rotacao' && parametros.graus !== undefined) {
    // Primeiro quantas amostras cabem no giro pedido, depois a velocidade que fecha a conta
    // **exatamente** naquele número de amostras. O contrário (velocidade fixa, tempo
    // arredondado) erraria o total em até meia amostra — e o total é o produto aqui.
    const intervalos = Math.max(
      1,
      Math.round((Math.abs(parametros.graus) / parametros.velocidadeGrausPorS) * parametros.taxaHz),
    );
    return {
      intervalos,
      velocidadeEfetivaGrausPorS: parametros.graus / (intervalos * dtS),
    };
  }

  const intervalos = Math.max(1, Math.round(parametros.duracaoS * parametros.taxaHz));
  return {
    intervalos,
    velocidadeEfetivaGrausPorS:
      parametros.padrao === 'rotacao' ? parametros.velocidadeGrausPorS : 0,
  };
}

function descrever(
  parametros: ParametrosDoPadrao,
  total: number,
  duracaoMs: number,
  grausTotais: number,
  velocidadeGrausPorS: number,
): string {
  const comum =
    `${parametros.taxaHz} Hz, ${total} amostras (${(duracaoMs / 1000).toFixed(2)} s), ` +
    `semente ${parametros.semente}`;
  switch (parametros.padrao) {
    case 'rotacao':
      return (
        `rotacao — ${grausTotais.toFixed(3)}° no eixo ${parametros.eixo} a ` +
        `${velocidadeGrausPorS.toFixed(2)} °/s, ${comum}`
      );
    case 'tremor':
      return (
        `tremor — ${parametros.amplitudeGrausPorS.toFixed(2)} °/s a ` +
        `${parametros.frequenciaHz} Hz no eixo ${parametros.eixo}, ${comum}`
      );
    case 'pico':
      return (
        `pico — uma amostra de ${parametros.picoGrausPorS.toFixed(0)} °/s no eixo ` +
        `${parametros.eixo}, sobre bias ${parametros.biasGrausPorS.toFixed(2)} °/s, ${comum}`
      );
    case 'gravado':
      return `gravado — ${total} amostras reproduzidas do arquivo`;
    case 'parado':
    default:
      return (
        `parado — bias ${parametros.biasGrausPorS.toFixed(2)} °/s e ruído ` +
        `${parametros.ruidoGrausPorS.toFixed(2)} °/s, ${comum}`
      );
  }
}

/** Fonte que reproduz uma captura, amostra por amostra, como ela foi gravada. */
function criarFonteGravada(amostras: readonly AmostraDeCaptura[]): FonteDeAmostras {
  let indice = 0;
  let duracaoMs = 0;
  // A partir da segunda: o `dtMs` da primeira amostra mede o intervalo desde uma amostra
  // anterior que não existe nesta reprodução, e ela sai no instante zero do envio.
  for (let posicao = 1; posicao < amostras.length; posicao += 1) {
    duracaoMs += amostras[posicao]?.dtMs ?? 0;
  }

  return {
    padrao: 'gravado',
    total: amostras.length,
    duracaoPrevistaMs: duracaoMs,
    grausTotais: 0,
    descricao: `gravado — ${amostras.length} amostras reproduzidas do arquivo`,

    proxima(destino) {
      const amostra = amostras[indice];
      if (amostra === undefined) return false;
      indice += 1;
      destino.seq = amostra.seq;
      destino.tDispositivoMs = amostra.tDispositivoMs;
      destino.dtMs = amostra.dtMs;
      destino.gx = amostra.gx;
      destino.gy = amostra.gy;
      destino.gz = amostra.gz;
      destino.flags = amostra.flags;
      destino.temAcelerometro = amostra.temAcelerometro;
      destino.ax = amostra.ax;
      destino.ay = amostra.ay;
      destino.az = amostra.az;
      return true;
    },

    reiniciar() {
      indice = 0;
    },
  };
}

/**
 * Cria a fonte de amostras do padrão pedido.
 *
 * A fonte é **determinística**: mesma semente e mesmos parâmetros produzem exatamente a mesma
 * sequência, em qualquer máquina (critério de aceite 4 da ATI-023).
 *
 * @throws {ErroDoSimulador} combinação impossível que só dá para julgar depois de saber quantas
 * amostras a execução tem — hoje, `--indice-do-pico` fora da sequência.
 */
export function criarFonteDeAmostras(parametros: ParametrosDoPadrao): FonteDeAmostras {
  if (parametros.padrao === 'gravado') {
    return criarFonteGravada(parametros.amostrasGravadas ?? []);
  }

  const { intervalos, velocidadeEfetivaGrausPorS } = dimensionar(parametros);
  const total = intervalos + 1;
  const dtMs = 1000 / parametros.taxaHz;
  const duracaoPrevistaMs = intervalos * dtMs;
  const grausTotais =
    parametros.padrao === 'rotacao' ? (velocidadeEfetivaGrausPorS * intervalos * dtMs) / 1000 : 0;

  // Pico fora da sequência é recusa, e não uma execução silenciosamente sem pico: a descrição
  // continuaria anunciando "uma amostra de 2000 °/s" e o teste do pipeline (ATI-008) passaria
  // verde medindo só bias e ruído. Defeito silencioso é o pior desfecho possível numa
  // ferramenta de verificação — mesma linha do `--graus 0` acima.
  if (parametros.indiceDoPico !== undefined && parametros.indiceDoPico >= total) {
    throw new ErroDoSimulador(
      `--indice-do-pico ${parametros.indiceDoPico} está fora da execução: ela tem ${total} ` +
        `amostras (0 a ${total - 1}). Aumente --duracao ou escolha um índice menor.`,
    );
  }
  const indiceDoPico = parametros.indiceDoPico ?? Math.floor(total / 2);

  const gerador: GeradorPseudoaleatorio = criarGerador(parametros.semente);
  let indice = 0;
  let seq = 0;
  let tempoMs = 0;

  /** Componente de bias do eixo, em °/s. */
  function bias(eixo: Eixo): number {
    return parametros.biasGrausPorS * BIAS_RELATIVO[eixo];
  }

  /** Valor do eixo em °/s, antes do ruído. O ruído entra fora, para todo eixo, sempre. */
  function sinal(eixo: Eixo, indiceDaAmostra: number, segundos: number): number {
    switch (parametros.padrao) {
      case 'rotacao':
        return eixo === parametros.eixo ? velocidadeEfetivaGrausPorS : 0;
      case 'tremor':
        // Sem bias de propósito: quem valida bias é o `parado`. Misturar os dois faria um
        // teste de zona morta responder por dois defeitos ao mesmo tempo.
        return eixo === parametros.eixo
          ? parametros.amplitudeGrausPorS *
              Math.sin(2 * Math.PI * parametros.frequenciaHz * segundos)
          : 0;
      case 'pico': {
        const base = bias(eixo);
        if (eixo !== parametros.eixo || indiceDaAmostra !== indiceDoPico) return base;
        return base + parametros.picoGrausPorS;
      }
      case 'parado':
      default:
        return bias(eixo);
    }
  }

  return {
    padrao: parametros.padrao,
    total,
    duracaoPrevistaMs,
    grausTotais,
    descricao: descrever(
      parametros,
      total,
      duracaoPrevistaMs,
      grausTotais,
      velocidadeEfetivaGrausPorS,
    ),

    proxima(destino) {
      if (indice >= total) return false;

      const primeira = indice === 0;
      destino.dtMs = primeira ? 0 : dtMs;
      tempoMs += destino.dtMs;
      const segundos = tempoMs / 1000;

      destino.seq = seq;
      destino.tDispositivoMs = Math.round(TEMPO_INICIAL_DO_APARELHO_MS + tempoMs);
      destino.flags = primeira ? FLAG_PRIMEIRA_APOS_RETOMAR : 0;

      // Os três eixos sorteiam ruído sempre, na ordem x, y, z — inclusive com `--ruido 0`.
      const ruido = parametros.ruidoGrausPorS;
      const grausX = sinal('x', indice, segundos) + ruido * gerador.normal();
      const grausY = sinal('y', indice, segundos) + ruido * gerador.normal();
      const grausZ = sinal('z', indice, segundos) + ruido * gerador.normal();
      destino.gx = grausX * GRAUS_PARA_RADIANOS;
      destino.gy = grausY * GRAUS_PARA_RADIANOS;
      destino.gz = grausZ * GRAUS_PARA_RADIANOS;

      destino.temAcelerometro = parametros.acelerometro;
      if (parametros.acelerometro) {
        destino.ax = RUIDO_DO_ACELEROMETRO_MS2 * gerador.normal();
        destino.ay = RUIDO_DO_ACELEROMETRO_MS2 * gerador.normal();
        destino.az = GRAVIDADE_MS2 + RUIDO_DO_ACELEROMETRO_MS2 * gerador.normal();
      } else {
        destino.ax = 0;
        destino.ay = 0;
        destino.az = 0;
      }

      indice += 1;
      seq = proximoSeq(seq);
      return true;
    },

    reiniciar() {
      gerador.reiniciar();
      indice = 0;
      seq = 0;
      tempoMs = 0;
    },
  };
}

/** Materializa a sequência inteira. Para teste e diagnóstico — nunca no caminho de envio. */
export function coletarAmostras(fonte: FonteDeAmostras): AmostraSimulada[] {
  const destino = criarAmostraSimulada();
  const amostras: AmostraSimulada[] = [];
  while (fonte.proxima(destino)) amostras.push(copiarAmostra(destino));
  return amostras;
}

/**
 * Copia uma amostra decodificada pelo servidor para o formato do simulador.
 *
 * Serve para o teste comparar o que **saiu** do simulador com o que **chegou** ao servidor sem
 * ter de reescrever a lista de campos nos dois lugares.
 */
export function amostraDoPacote(pacote: PacoteDecodificado): AmostraSimulada {
  return {
    seq: pacote.seq,
    tDispositivoMs: pacote.tDispositivoMs,
    dtMs: pacote.dtMs,
    gx: pacote.gx,
    gy: pacote.gy,
    gz: pacote.gz,
    flags: pacote.flags,
    temAcelerometro: pacote.temAcelerometro,
    ax: pacote.ax,
    ay: pacote.ay,
    az: pacote.az,
  };
}
