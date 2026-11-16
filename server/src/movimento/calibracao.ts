/**
 * Calibração de bias — o **sincronizar** da ATI-009 (PROTOCOLO.md, seção 3.5).
 *
 * Entre `calibrar-inicio` e `calibrar-fim` o aparelho fica parado e este módulo guarda o que o
 * giroscópio acusa. No fim, a média dessas leituras **é** o bias: o valor que o sensor reporta
 * quando ninguém o está girando. Descontá-lo é a etapa 1 do pipeline, e sem ela o cursor caminha
 * sozinho — a causa nº 1 de "esse app é ruim" (ARQUITETURA.md, seção 3).
 *
 * ## Três recusas, e o porquê de cada uma
 *
 * | Recusa | O que evita |
 * |---|---|
 * | menos de {@link MINIMO_DE_AMOSTRAS} amostras | um toque rápido no botão virar "calibração" feita com 3 leituras |
 * | dispersão acima do limite | calibrar com o aparelho balançando na mão, gravando o gesto como se fosse bias |
 * | média grande demais para ser bias | calibrar **durante** uma rotação: a média sai enorme e viraria movimento constante ao contrário |
 *
 * As duas últimas parecem a mesma coisa e não são. Uma rotação constante de 90 °/s tem dispersão
 * **zero** — todas as amostras são iguais —, então só a dispersão a aceitaria em silêncio. Já um
 * aparelho sacudido em torno do lugar tem média perto de zero e dispersão enorme, e só o segundo
 * teste o pegaria. Uma calibração ruim é pior que nenhuma: ela vira movimento constante do cursor,
 * e a pessoa não tem como saber de onde veio.
 *
 * ## Média com descarte dos extremos
 *
 * A média é **aparada**: as amostras de cada eixo são ordenadas e {@link PROPORCAO_DESCARTADA} de
 * cada ponta sai da conta. Uma batida na mesa, um passo de alguém ao lado ou o próprio toque do
 * dedo que soltou o botão produzem um punhado de amostras muito fora do resto, e a média simples
 * carrega essas amostras para dentro do bias. A **dispersão**, ao contrário, é medida sobre a série
 * **inteira**: ela existe justamente para perceber o que a aparagem esconderia.
 *
 * ⚠️ `registrar` é **caminho quente** (100 Hz): escreve num `Float64Array` alocado uma vez, sem
 * alocação, sem log e sem exceção. Todo o resto — ordenar, somar, montar mensagem — acontece em
 * `finalizar`, que roda uma vez por calibração.
 */

import { TIPO_MOVIMENTO, type PacoteDecodificado } from '../protocolo/indice.js';
import { GRAUS_POR_RADIANO, RADIANOS_POR_GRAU } from './tipos.js';

/**
 * Mínimo de amostras para uma calibração valer. A 100 Hz são 0,6 s de aparelho parado.
 *
 * Abaixo disso a média é ruído: com 10 amostras, o desvio da própria média ainda é da ordem do
 * bias que se quer medir, e o resultado seria um número com cara de medição e valor de sorteio.
 */
export const MINIMO_DE_AMOSTRAS = 60;

/** Alvo declarado na ATI-009: 120 amostras (~1,2 s a 100 Hz) é onde a média fica estável. */
export const ALVO_DE_AMOSTRAS = 120;

/**
 * Teto de amostras guardadas — 6 s a 100 Hz.
 *
 * A coleta é aberta pelo aparelho e fechada pelo aparelho; um `calibrar-fim` que nunca chega (app
 * fechado, cabo arrancado) não pode fazer a memória crescer para sempre. Passando daqui, a amostra
 * é contada em `excedentes` e descartada: 6 s de aparelho parado já dizem tudo o que há para dizer.
 */
export const CAPACIDADE_DE_AMOSTRAS = 600;

/** Quanto de **cada ponta** sai da média aparada (10 % embaixo, 10 % em cima). */
export const PROPORCAO_DESCARTADA = 0.1;

/**
 * Os dois limites de recusa, em graus por segundo — a unidade em que se pensa.
 *
 * - `dispersaoMaximaGrausPorS`: desvio padrão de um eixo na série inteira. Aparelho na mesa fica
 *   na casa de 0,05 °/s; parado na mão, com o tremor de quem segura, na casa de 0,3 °/s. 2 °/s é
 *   folga larga para o segundo caso e ainda assim uma ordem de grandeza abaixo de "mexeu".
 * - `moduloMaximoGrausPorS`: módulo do vetor de bias medido. Um giroscópio de celular parado acusa
 *   0,1 a 1 °/s (ARQUITETURA.md, seção 3); 15 °/s é generoso com um sensor ruim e recusa de longe
 *   os 90 °/s de um giro de verdade.
 */
export const LIMITES_DA_CALIBRACAO = Object.freeze({
  dispersaoMaximaGrausPorS: 2,
  moduloMaximoGrausPorS: 15,
});

/** Maior `dtMs` que entra na duração declarada da coleta; acima disso é engasgo, não intervalo. */
const DT_MAXIMO_MS = 1000;

/** Bias medido, em rad/s, nos eixos do sensor. */
export interface LeituraDeBias {
  readonly gx: number;
  readonly gy: number;
  readonly gz: number;
}

/** Diagnóstico da calibração. Objeto mutável reaproveitado, como o resto do módulo. */
export interface ContadoresDaCalibracao {
  /** Quantas coletas começaram (`calibrar-inicio`). */
  iniciadas: number;
  /** Quantas terminaram com bias válido. */
  concluidas: number;
  /** Recusadas por não juntar o mínimo de amostras. */
  recusadasPorAmostras: number;
  /** Recusadas porque o aparelho se mexeu durante a coleta (dispersão). */
  recusadasPorMovimento: number;
  /** Recusadas porque a média é grande demais para ser bias (giro em curso). */
  recusadasPorModulo: number;
  /** `calibrar-fim` sem `calibrar-inicio` antes. */
  recusadasSemInicio: number;
  /** Coletas abandonadas (fim de sessão, novo `calibrar-inicio` por cima). */
  canceladas: number;
  /** Amostras que chegaram com a memória cheia (ver {@link CAPACIDADE_DE_AMOSTRAS}). */
  excedentes: number;
  /** Amostras recusadas por leitura não finita (`NaN`, infinito — o fio deixa passar). */
  naoFinitas: number;
}

export function criarContadoresDaCalibracao(): ContadoresDaCalibracao {
  return {
    iniciadas: 0,
    concluidas: 0,
    recusadasPorAmostras: 0,
    recusadasPorMovimento: 0,
    recusadasPorModulo: 0,
    recusadasSemInicio: 0,
    canceladas: 0,
    excedentes: 0,
    naoFinitas: 0,
  };
}

/** Por que uma calibração foi recusada — código de máquina ao lado do texto de gente. */
export const MOTIVO_DA_RECUSA = Object.freeze({
  SEM_INICIO: 'sem-inicio',
  POUCAS_AMOSTRAS: 'poucas-amostras',
  APARELHO_SE_MOVEU: 'aparelho-se-moveu',
  NAO_E_BIAS: 'nao-e-bias',
} as const);

export type MotivoDaRecusa = (typeof MOTIVO_DA_RECUSA)[keyof typeof MOTIVO_DA_RECUSA];

export type ResultadoDaCalibracao =
  | {
      readonly ok: true;
      readonly bias: LeituraDeBias;
      /** Amostras coletadas. */
      readonly amostras: number;
      /** Amostras que a aparagem tirou da média (soma das duas pontas). */
      readonly descartadas: number;
      /** Maior desvio padrão entre os três eixos, em °/s — o número que decidiu a aceitação. */
      readonly dispersaoGrausPorS: number;
      /** Duração da coleta pelo relógio **do aparelho** (soma dos `dtMs`). */
      readonly duracaoMs: number;
    }
  | {
      readonly ok: false;
      readonly motivo: MotivoDaRecusa;
      /** Texto para pessoa ler; é ele que vai no `motivo` do `cmd-erro` (PROTOCOLO.md, 3.5). */
      readonly mensagem: string;
      readonly amostras: number;
    };

export interface CalibracaoDeBias {
  /** Se há coleta em curso agora. */
  readonly coletando: boolean;
  /** Quantas amostras já entraram na coleta em curso. */
  readonly amostras: number;
  readonly contadores: ContadoresDaCalibracao;

  /** Abre a coleta. Chamar com uma coleta em curso recomeça do zero (e conta o cancelamento). */
  iniciar(): void;
  /** ⚠️ Caminho quente. Guarda a leitura crua de um MOVIMENTO; ignora tudo o mais. */
  registrar(pacote: PacoteDecodificado): void;
  /** Fecha a coleta e devolve o bias ou a recusa. Sempre encerra o estado de coleta. */
  finalizar(): ResultadoDaCalibracao;
  /** Abandona a coleta sem resultado (fim de sessão, pausa). Idempotente. */
  cancelar(): void;
}

/** Desvio padrão (populacional) de um trecho, em rad/s. */
function desvioPadrao(valores: Float64Array, quantidade: number): number {
  if (quantidade <= 1) return 0;
  let soma = 0;
  for (let indice = 0; indice < quantidade; indice += 1) soma += valores[indice] ?? 0;
  const media = soma / quantidade;
  let somaDosQuadrados = 0;
  for (let indice = 0; indice < quantidade; indice += 1) {
    const diferenca = (valores[indice] ?? 0) - media;
    somaDosQuadrados += diferenca * diferenca;
  }
  return Math.sqrt(somaDosQuadrados / quantidade);
}

/**
 * Média com as pontas descartadas.
 *
 * ⚠️ **Ordena o trecho no lugar** — o chamador já mediu a dispersão sobre a série original antes
 * de chegar aqui, e depois disto a ordem das amostras não serve mais para nada.
 */
function mediaAparada(valores: Float64Array, quantidade: number, aparar: number): number {
  const trecho = valores.subarray(0, quantidade);
  trecho.sort();
  const primeiro = aparar;
  const ultimo = quantidade - aparar;
  let soma = 0;
  for (let indice = primeiro; indice < ultimo; indice += 1) soma += trecho[indice] ?? 0;
  return soma / (ultimo - primeiro);
}

export interface OpcoesDaCalibracao {
  /** Teto de amostras guardadas. O padrão é {@link CAPACIDADE_DE_AMOSTRAS}. */
  readonly capacidade?: number | undefined;
  /** Mínimo de amostras aceito. O padrão é {@link MINIMO_DE_AMOSTRAS}. */
  readonly minimoDeAmostras?: number | undefined;
  /** Limites de recusa, em °/s. O padrão é {@link LIMITES_DA_CALIBRACAO}. */
  readonly dispersaoMaximaGrausPorS?: number | undefined;
  readonly moduloMaximoGrausPorS?: number | undefined;
}

export function criarCalibracaoDeBias(opcoes: OpcoesDaCalibracao = {}): CalibracaoDeBias {
  const capacidade = Math.max(1, Math.trunc(opcoes.capacidade ?? CAPACIDADE_DE_AMOSTRAS));
  const minimoDeAmostras = Math.max(2, Math.trunc(opcoes.minimoDeAmostras ?? MINIMO_DE_AMOSTRAS));
  const dispersaoMaximaRadPorS =
    (opcoes.dispersaoMaximaGrausPorS ?? LIMITES_DA_CALIBRACAO.dispersaoMaximaGrausPorS) *
    RADIANOS_POR_GRAU;
  const moduloMaximoRadPorS =
    (opcoes.moduloMaximoGrausPorS ?? LIMITES_DA_CALIBRACAO.moduloMaximoGrausPorS) *
    RADIANOS_POR_GRAU;

  const contadores = criarContadoresDaCalibracao();

  // Três buffers alocados **uma vez**, na montagem: guardar amostra não pode alocar (regra 2 do
  // CLAUDE.md). São 600 números por eixo, 14 KB no total — memória parada, não por pacote.
  const amostrasGx = new Float64Array(capacidade);
  const amostrasGy = new Float64Array(capacidade);
  const amostrasGz = new Float64Array(capacidade);

  let coletando = false;
  let usadas = 0;
  let duracaoMs = 0;

  function iniciar(): void {
    if (coletando) contadores.canceladas += 1;
    coletando = true;
    usadas = 0;
    duracaoMs = 0;
    contadores.iniciadas += 1;
  }

  /** ⚠️ CAMINHO QUENTE — 100 Hz. Sem alocação, sem log, sem exceção. */
  function registrar(pacote: PacoteDecodificado): void {
    if (!coletando) return;
    if (pacote.tipo !== TIPO_MOVIMENTO) return;

    const gx = pacote.gx;
    const gy = pacote.gy;
    const gz = pacote.gz;
    // `f32` passa cru no fio (PROTOCOLO.md, seção 4.0, regra 7): um `NaN` aqui envenenaria a
    // média e o desvio de uma vez, e o bias resultante desligaria o cursor até a próxima retomada.
    if (!Number.isFinite(gx) || !Number.isFinite(gy) || !Number.isFinite(gz)) {
      contadores.naoFinitas += 1;
      return;
    }

    if (usadas >= capacidade) {
      contadores.excedentes += 1;
      return;
    }

    amostrasGx[usadas] = gx;
    amostrasGy[usadas] = gy;
    amostrasGz[usadas] = gz;
    usadas += 1;

    // Duração pelo relógio do aparelho, como o resto do pipeline: o relógio do PC embute o jitter
    // da rede e não é o tempo em que a mão ficou parada.
    const dtMs = pacote.dtMs;
    if (dtMs > 0 && dtMs <= DT_MAXIMO_MS) duracaoMs += dtMs;
  }

  function finalizar(): ResultadoDaCalibracao {
    if (!coletando) {
      contadores.recusadasSemInicio += 1;
      return {
        ok: false,
        motivo: MOTIVO_DA_RECUSA.SEM_INICIO,
        mensagem: 'não há calibração em curso: mande calibrar-inicio antes de calibrar-fim.',
        amostras: 0,
      };
    }

    coletando = false;
    const quantidade = usadas;

    if (quantidade < minimoDeAmostras) {
      contadores.recusadasPorAmostras += 1;
      return {
        ok: false,
        motivo: MOTIVO_DA_RECUSA.POUCAS_AMOSTRAS,
        mensagem:
          `coletei ${quantidade} amostras e preciso de pelo menos ${minimoDeAmostras}. ` +
          'Segure o aparelho parado por cerca de um segundo antes de terminar.',
        amostras: quantidade,
      };
    }

    // Dispersão sobre a série **inteira** e antes da aparagem: é ela que percebe o que a aparagem
    // esconderia (ver o cabeçalho do arquivo).
    const dispersaoGx = desvioPadrao(amostrasGx, quantidade);
    const dispersaoGy = desvioPadrao(amostrasGy, quantidade);
    const dispersaoGz = desvioPadrao(amostrasGz, quantidade);
    const dispersao = Math.max(dispersaoGx, dispersaoGy, dispersaoGz);

    if (dispersao > dispersaoMaximaRadPorS) {
      contadores.recusadasPorMovimento += 1;
      return {
        ok: false,
        motivo: MOTIVO_DA_RECUSA.APARELHO_SE_MOVEU,
        mensagem:
          `o aparelho se moveu durante a coleta (variação de ` +
          `${(dispersao * GRAUS_POR_RADIANO).toFixed(2)} °/s, o limite é ` +
          `${(dispersaoMaximaRadPorS * GRAUS_POR_RADIANO).toFixed(2)} °/s). ` +
          'Apoie o aparelho e tente de novo.',
        amostras: quantidade,
      };
    }

    const aparar = Math.floor(quantidade * PROPORCAO_DESCARTADA);
    const gx = mediaAparada(amostrasGx, quantidade, aparar);
    const gy = mediaAparada(amostrasGy, quantidade, aparar);
    const gz = mediaAparada(amostrasGz, quantidade, aparar);

    const modulo = Math.sqrt(gx * gx + gy * gy + gz * gz);
    if (modulo > moduloMaximoRadPorS) {
      contadores.recusadasPorModulo += 1;
      return {
        ok: false,
        motivo: MOTIVO_DA_RECUSA.NAO_E_BIAS,
        mensagem:
          `a leitura média (${(modulo * GRAUS_POR_RADIANO).toFixed(1)} °/s) é grande demais para ` +
          `ser bias: o aparelho estava girando, não parado. ` +
          `O limite é ${(moduloMaximoRadPorS * GRAUS_POR_RADIANO).toFixed(1)} °/s.`,
        amostras: quantidade,
      };
    }

    contadores.concluidas += 1;
    return {
      ok: true,
      bias: { gx, gy, gz },
      amostras: quantidade,
      descartadas: aparar * 2,
      dispersaoGrausPorS: dispersao * GRAUS_POR_RADIANO,
      duracaoMs,
    };
  }

  function cancelar(): void {
    if (!coletando) return;
    coletando = false;
    usadas = 0;
    duracaoMs = 0;
    contadores.canceladas += 1;
  }

  return {
    get coletando() {
      return coletando;
    },
    get amostras() {
      return usadas;
    },
    contadores,
    iniciar,
    registrar,
    finalizar,
    cancelar,
  };
}
