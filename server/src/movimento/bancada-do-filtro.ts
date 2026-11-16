/**
 * Bancada de medição do filtro da etapa 4 (ATI-033): séries de movimento conhecido, a cadeia de
 * verdade e os números que decidem se o filtro adaptativo fica ligado.
 *
 * O critério da ATI é numérico — "quantos pixels o cursor anda com a pessoa tentando ficar parada"
 * e "quanto atraso o gesto rápido ganhou" — e número só existe com série conhecida. Esta bancada
 * entrega as séries e as réguas; quem afirma é `filtro-adaptativo.teste.ts` (o que trava os
 * critérios) e quem imprime a tabela do relatório é `ferramentas/medir-filtro.mjs`. Os dois usam
 * as **mesmas** séries daqui, para o número do teste e o do relatório serem o mesmo número.
 *
 * Não é caminho quente: aloca à vontade, e nada aqui roda no servidor.
 *
 * Quatro famílias de série, todas determinísticas:
 *
 * | Série | O que imita | Régua |
 * |---|---|---|
 * | `serieDeTremor` | mão tentando ficar parada (o padrão `tremor` do simulador, ATI-023) | caminho percorrido |
 * | `serieDeMiraLenta` | aproximação lenta de um alvo, com o tremor por cima | entrega, maior parada, deslize |
 * | `serieDeGestoRapido` | atravessar a tela (perfil de mínimo *jerk*, o do braço humano) | atraso médio |
 * | `serieDaCaptura` | um trecho de captura real (`CONTROLE_GRAVACAO`) | caminho percorrido |
 */

import type { AmostraDeCaptura } from '../cli/captura.js';
import {
  criarAmostraSimulada,
  criarFonteDeAmostras,
  criarGerador,
  resolverParametros,
  type OpcoesDePadrao,
} from '../cli/simulador/indice.js';
import {
  FLAG_PRIMEIRA_APOS_RETOMAR,
  TIPO_MOVIMENTO,
  criarPacoteDecodificado,
} from '../protocolo/indice.js';
import type { AjustesParciais } from './ajustes.js';
import { criarPipelineDeMovimento } from './pipeline.js';
import { RADIANOS_POR_GRAU, type DestinoDeMovimento } from './tipos.js';

/** Taxa das séries sintéticas: a do PROTOCOLO.md, seção 1. */
export const TAXA_DA_BANCADA_HZ = 100;

/** Sensibilidade das medições: o padrão de fábrica (35 px/grau, `ajustes.ts`). */
export const SENSIBILIDADE_DA_BANCADA = 35;

/**
 * Uma amostra de giroscópio, em rad/s, como chega ao pipeline. A **primeira** de toda série é
 * tratada como "primeira após retomar": ela não integra, como no aparelho de verdade.
 */
export interface AmostraDeBancada {
  readonly dtMs: number;
  readonly gx: number;
  readonly gy: number;
  readonly gz: number;
}

/** Uma série com o que se sabe dela de antemão. */
export interface Serie {
  readonly nome: string;
  readonly amostras: readonly AmostraDeBancada[];
  /** Onde o gesto começa e termina, em ms desde a primeira amostra (0 e o fim, se não há gesto). */
  readonly inicioDoGestoMs: number;
  readonly fimDoGestoMs: number;
  /** Graus girados de propósito no eixo horizontal (0 = "ficar parado"). */
  readonly grausDoGesto: number;
}

/** O que o cursor fez, amostra a amostra. */
export interface Trilha {
  /** Instante de cada amostra, em ms desde a primeira. */
  readonly tempoMs: Float64Array;
  /** Posição acumulada do cursor (pixels inteiros emitidos) depois de cada amostra. */
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Σ (|dx| + |dy|): quantos pixels o cursor **andou**, para qualquer lado. */
  readonly caminhoPx: number;
}

/* ------------------------------------------------------------------------------ percorrer */

/**
 * Passa a série pela cadeia de verdade (`criarPipelineDeMovimento`) e devolve a trilha do cursor.
 *
 * O relógio de chegada acompanha o carimbo do aparelho (atraso zero): o que está em medição é o
 * filtro, e não a guarda de atraso. O destino só anota — nada encosta no cursor.
 */
export function percorrer(serie: Serie, ajustes: AjustesParciais): Trilha {
  const total = serie.amostras.length;
  const tempoMs = new Float64Array(total);
  const x = new Float64Array(total);
  const y = new Float64Array(total);
  let posicaoX = 0;
  let posicaoY = 0;
  let caminhoPx = 0;

  const destino: DestinoDeMovimento = {
    nome: 'bancada',
    moverMouseRelativo(dx, dy) {
      posicaoX += dx;
      posicaoY += dy;
      caminhoPx += Math.abs(dx) + Math.abs(dy);
    },
  };

  let chegadaMs = 0;
  const pipeline = criarPipelineDeMovimento({
    destino,
    ajustes: {
      sensXPixelsPorGrau: SENSIBILIDADE_DA_BANCADA,
      sensYPixelsPorGrau: SENSIBILIDADE_DA_BANCADA,
      ...ajustes,
    },
    relogio: () => chegadaMs,
  });
  const pacote = criarPacoteDecodificado();
  pacote.tipo = TIPO_MOVIMENTO;

  let relogioDoAparelhoMs = 60_000;
  let decorridoMs = 0;
  for (let indice = 0; indice < total; indice += 1) {
    const amostra = serie.amostras[indice];
    if (amostra === undefined) break;
    const primeira = indice === 0;
    if (!primeira) {
      decorridoMs += amostra.dtMs;
      relogioDoAparelhoMs += amostra.dtMs;
    }
    chegadaMs = relogioDoAparelhoMs;
    pacote.seq = indice & 0xffff;
    pacote.flags = primeira ? FLAG_PRIMEIRA_APOS_RETOMAR : 0;
    pacote.tDispositivoMs = relogioDoAparelhoMs;
    pacote.dtMs = primeira ? 0 : amostra.dtMs;
    pacote.gx = amostra.gx;
    pacote.gy = amostra.gy;
    pacote.gz = amostra.gz;
    pipeline.processar(pacote);
    tempoMs[indice] = decorridoMs;
    x[indice] = posicaoX;
    y[indice] = posicaoY;
  }

  return { tempoMs, x, y, caminhoPx };
}

/* --------------------------------------------------------------------------------- séries */

function doSimulador(nome: string, opcoes: OpcoesDePadrao): Serie {
  const fonte = criarFonteDeAmostras(resolverParametros(opcoes));
  const amostra = criarAmostraSimulada();
  const amostras: AmostraDeBancada[] = [];
  while (fonte.proxima(amostra)) {
    amostras.push({ dtMs: amostra.dtMs, gx: amostra.gx, gy: amostra.gy, gz: amostra.gz });
  }
  const fim = fonte.duracaoPrevistaMs;
  return { nome, amostras, inicioDoGestoMs: 0, fimDoGestoMs: fim, grausDoGesto: 0 };
}

/**
 * Mão tentando ficar parada: o padrão `tremor` do simulador (ATI-023) — seno na amplitude e na
 * frequência pedidas no eixo `y` (o horizontal em `retrato`), mais o ruído de sensor de 0,05 °/s
 * nos três eixos. Reproduzível na linha de comando:
 * `npm run simulador -- --padrao tremor --amplitude 2 --frequencia 10`.
 */
export function serieDeTremor(
  amplitudeGrausPorS: number,
  frequenciaHz: number,
  duracaoS = 10,
): Serie {
  return doSimulador(`tremor ${amplitudeGrausPorS} °/s a ${frequenciaHz} Hz`, {
    padrao: 'tremor',
    taxaHz: TAXA_DA_BANCADA_HZ,
    duracaoS,
    eixo: 'y',
    amplitudeGrausPorS,
    frequenciaHz,
  });
}

/** Aparelho apoiado: o padrão `parado` do simulador, com bias zero (o calibrado) e ruído de sensor. */
export function serieApoiada(duracaoS = 60, ruidoGrausPorS = 0.05): Serie {
  return doSimulador(`apoiado ${duracaoS} s`, {
    padrao: 'parado',
    taxaHz: TAXA_DA_BANCADA_HZ,
    duracaoS,
    biasGrausPorS: 0,
    ruidoGrausPorS,
  });
}

export interface PedidoDeMiraLenta {
  /** Velocidade da aproximação, em °/s. */
  readonly velocidadeGrausPorS: number;
  /** Quanto dura a aproximação. */
  readonly duracaoS: number;
  /** Mão parada antes do gesto (o filtro chega ao gesto já com o tremor dentro). */
  readonly antesS?: number;
  /** Mão parada depois do gesto — é onde se mede o deslize. */
  readonly depoisS?: number;
  /** Tremor por cima do gesto o tempo todo, em °/s (0 = sem tremor). */
  readonly tremorGrausPorS?: number;
  readonly tremorHz?: number;
  /** Ruído de sensor nos três eixos, em °/s. */
  readonly ruidoGrausPorS?: number;
  readonly semente?: number;
}

/**
 * Aproximação lenta de um alvo: velocidade constante no horizontal (para a direita), com tremor e
 * ruído por cima, e mão parada antes e depois. É o caso que a zona morta alta estraga: o gesto é
 * lento, da mesma amplitude do tremor.
 */
export function serieDeMiraLenta(pedido: PedidoDeMiraLenta): Serie {
  const antesS = pedido.antesS ?? 1;
  const depoisS = pedido.depoisS ?? 1;
  const tremor = pedido.tremorGrausPorS ?? 0;
  const tremorHz = pedido.tremorHz ?? 10;
  const ruido = pedido.ruidoGrausPorS ?? 0.05;
  const gerador = criarGerador(pedido.semente ?? 33);
  const dtMs = 1000 / TAXA_DA_BANCADA_HZ;
  const inicioMs = antesS * 1000;
  const fimMs = inicioMs + pedido.duracaoS * 1000;
  const totalMs = fimMs + depoisS * 1000;
  const amostras: AmostraDeBancada[] = [];
  for (let tMs = 0; tMs <= totalMs + 1e-9; tMs += dtMs) {
    // A amostra que chega em `t` mede o intervalo que **termina** em `t`: o gesto vale nas amostras
    // de (início, fim]. Assim os graus integrados fecham a conta exata.
    const noGesto = tMs > inicioMs + 1e-9 && tMs <= fimMs + 1e-9;
    const gesto = noGesto ? pedido.velocidadeGrausPorS : 0;
    const oscilacao = tremor * Math.sin(2 * Math.PI * tremorHz * (tMs / 1000));
    // `retrato`: o horizontal é −gy (ver `eixos.ts`), então "para a direita" é gy negativo.
    const grausY = -(gesto + oscilacao) + ruido * gerador.normal();
    const grausX = ruido * gerador.normal();
    const grausZ = ruido * gerador.normal();
    amostras.push({
      dtMs,
      gx: grausX * RADIANOS_POR_GRAU,
      gy: grausY * RADIANOS_POR_GRAU,
      gz: grausZ * RADIANOS_POR_GRAU,
    });
  }
  return {
    nome: `mira lenta ${pedido.velocidadeGrausPorS} °/s por ${pedido.duracaoS} s` +
      (tremor > 0 ? ` com tremor ${tremor} °/s a ${tremorHz} Hz` : ''),
    amostras,
    inicioDoGestoMs: inicioMs,
    fimDoGestoMs: fimMs,
    grausDoGesto: pedido.velocidadeGrausPorS * pedido.duracaoS,
  };
}

/**
 * Gesto rápido de atravessar a tela, com o perfil de **mínimo *jerk*** — o que o braço humano
 * faz num movimento de ponto a ponto (Flash e Hogan, 1985): começa e termina com velocidade zero
 * e passa por um pico de 1,875 × a velocidade média. Cada amostra leva a velocidade **média** do
 * seu intervalo, para o total integrado fechar exato.
 *
 * Sem ruído e sem tremor: o que está em medição é atraso, e atraso se mede contra a mesma série
 * sem filtro.
 */
export function serieDeGestoRapido(graus: number, duracaoMs: number, depoisMs = 500): Serie {
  const dtMs = 1000 / TAXA_DA_BANCADA_HZ;
  const antesMs = 200;
  const fimMs = antesMs + duracaoMs;
  const totalMs = fimMs + depoisMs;
  const posicao = (tMs: number): number => {
    const s = Math.min(Math.max((tMs - antesMs) / duracaoMs, 0), 1);
    return graus * (10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5);
  };
  const amostras: AmostraDeBancada[] = [];
  for (let tMs = 0; tMs <= totalMs + 1e-9; tMs += dtMs) {
    const grausPorS = tMs === 0 ? 0 : ((posicao(tMs) - posicao(tMs - dtMs)) / dtMs) * 1000;
    amostras.push({ dtMs, gx: 0, gy: -grausPorS * RADIANOS_POR_GRAU, gz: 0 });
  }
  return {
    nome: `gesto rápido ${graus}° em ${duracaoMs} ms (pico ${(1.875 * graus * 1000 / duracaoMs).toFixed(0)} °/s)`,
    amostras,
    inicioDoGestoMs: antesMs,
    fimDoGestoMs: fimMs,
    grausDoGesto: graus,
  };
}

/**
 * Um trecho de captura real (`CONTROLE_GRAVACAO`, ATI-023), de `deS` a `ateS` segundos contados
 * do carimbo da primeira amostra do arquivo.
 */
export function serieDaCaptura(
  nome: string,
  amostras: readonly AmostraDeCaptura[],
  deS: number,
  ateS: number,
): Serie {
  const origem = amostras[0]?.tDispositivoMs ?? 0;
  const trecho: AmostraDeBancada[] = [];
  for (const amostra of amostras) {
    const s = (amostra.tDispositivoMs - origem) / 1000;
    if (s < deS || s >= ateS) continue;
    trecho.push({ dtMs: amostra.dtMs, gx: amostra.gx, gy: amostra.gy, gz: amostra.gz });
  }
  const duracaoMs = trecho.slice(1).reduce((soma, amostra) => soma + amostra.dtMs, 0);
  return { nome, amostras: trecho, inicioDoGestoMs: 0, fimDoGestoMs: duracaoMs, grausDoGesto: 0 };
}

/* --------------------------------------------------------------------------------- réguas */

/** Primeiro índice cujo instante é ≥ `tMs`. */
function indiceEm(trilha: Trilha, tMs: number): number {
  for (let indice = 0; indice < trilha.tempoMs.length; indice += 1) {
    if ((trilha.tempoMs[indice] ?? 0) >= tMs - 1e-9) return indice;
  }
  return trilha.tempoMs.length - 1;
}

/**
 * Atraso médio de `medida` em relação a `referencia`, em ms, no eixo horizontal:
 * `Σ (ref − medida) · dt / total da referência`.
 *
 * Para um gesto num sentido só é o atraso de grupo: um passa-baixa fixo de constante de tempo τ
 * dá exatamente τ. A referência é a **mesma série** sem filtro e com a mesma zona morta — assim o
 * número isola o filtro, e não mistura o que a zona morta come.
 */
export function atrasoMedioMs(referencia: Trilha, medida: Trilha): number {
  const total = referencia.x[referencia.x.length - 1] ?? 0;
  if (total === 0) return Number.NaN;
  let area = 0;
  for (let indice = 1; indice < referencia.x.length; indice += 1) {
    const dt = (referencia.tempoMs[indice] ?? 0) - (referencia.tempoMs[indice - 1] ?? 0);
    area += ((referencia.x[indice - 1] ?? 0) - (medida.x[indice - 1] ?? 0)) * dt;
  }
  return area / total;
}

/** Instante, em ms, em que o horizontal chega a `fracao` de `totalPx` (NaN se nunca chega). */
export function instanteDaFracaoMs(trilha: Trilha, fracao: number, totalPx: number): number {
  const alvo = fracao * totalPx;
  for (let indice = 0; indice < trilha.x.length; indice += 1) {
    const posicao = trilha.x[indice] ?? 0;
    if (totalPx >= 0 ? posicao >= alvo : posicao <= alvo) return trilha.tempoMs[indice] ?? 0;
  }
  return Number.NaN;
}

/** O que a mira lenta fez — os números de "o cursor não engasga". */
export interface AvaliacaoDaMira {
  /** Pixels pedidos pelo gesto: graus × sensibilidade. */
  readonly idealPx: number;
  /** Quanto do ideal já tinha saído quando a mão parou. */
  readonly entregueNoFimPct: number;
  /** Quanto do ideal saiu até o fim da série (a mão parada depois do gesto incluída). */
  readonly entregueTotalPct: number;
  /** Do começo do gesto até o primeiro pixel para o lado certo. */
  readonly primeiroPixelMs: number;
  /**
   * Maior intervalo **sem avançar** durante o gesto — sem a posição bater um novo máximo para o
   * lado do gesto —, contado do primeiro avanço até a mão parar. É o "engasgo" medido.
   */
  readonly maiorParadaMs: number;
  /** Intervalo entre pixels se o cursor andasse liso na velocidade pedida. */
  readonly intervaloIdealMs: number;
  /** Pixels que saíram para o lado do gesto **depois** de a mão parar: o cursor escorregando. */
  readonly deslizeAposPararPx: number;
}

export function avaliarMira(serie: Serie, trilha: Trilha, sensibilidade = SENSIBILIDADE_DA_BANCADA): AvaliacaoDaMira {
  const idealPx = serie.grausDoGesto * sensibilidade;
  const inicio = indiceEm(trilha, serie.inicioDoGestoMs);
  const fim = indiceEm(trilha, serie.fimDoGestoMs);
  const ultimo = trilha.x.length - 1;
  const base = trilha.x[inicio] ?? 0;
  const noFim = (trilha.x[fim] ?? 0) - base;
  const noTotal = (trilha.x[ultimo] ?? 0) - base;

  let maximo = base;
  let primeiroAvanco = Number.NaN;
  let ultimoAvanco = Number.NaN;
  let maiorParada = 0;
  for (let indice = inicio + 1; indice <= fim; indice += 1) {
    const posicao = trilha.x[indice] ?? 0;
    const tempo = trilha.tempoMs[indice] ?? 0;
    if (posicao > maximo) {
      if (Number.isNaN(primeiroAvanco)) primeiroAvanco = tempo;
      else maiorParada = Math.max(maiorParada, tempo - ultimoAvanco);
      ultimoAvanco = tempo;
      maximo = posicao;
    }
  }
  // A parada que ainda estava aberta quando a mão parou também conta.
  if (!Number.isNaN(ultimoAvanco)) {
    maiorParada = Math.max(maiorParada, (trilha.tempoMs[fim] ?? 0) - ultimoAvanco);
  }

  let maximoDepois = trilha.x[fim] ?? 0;
  for (let indice = fim + 1; indice <= ultimo; indice += 1) {
    maximoDepois = Math.max(maximoDepois, trilha.x[indice] ?? 0);
  }

  const velocidadePxPorS =
    (idealPx / Math.max(serie.fimDoGestoMs - serie.inicioDoGestoMs, 1)) * 1000;
  return {
    idealPx,
    entregueNoFimPct: (100 * noFim) / idealPx,
    entregueTotalPct: (100 * noTotal) / idealPx,
    primeiroPixelMs: Number.isNaN(primeiroAvanco)
      ? Number.NaN
      : primeiroAvanco - serie.inicioDoGestoMs,
    maiorParadaMs: Number.isNaN(primeiroAvanco) ? Number.POSITIVE_INFINITY : maiorParada,
    intervaloIdealMs: 1000 / velocidadePxPorS,
    deslizeAposPararPx: maximoDepois - (trilha.x[fim] ?? 0),
  };
}

/* --------------------------------------------------------------------- configurações */

/** "Hoje": o padrão de fábrica de antes da ATI-033 — média exponencial e zona morta de 0,35 °/s. */
export const AJUSTES_DE_HOJE: AjustesParciais = Object.freeze({
  filtro: 'exponencial',
  zonaMortaGrausPorS: 0.35,
  suavizacao: 0.15,
});

/** A mesma cadeia sem filtro nenhum — a referência do atraso. */
export function semFiltro(zonaMortaGrausPorS: number): AjustesParciais {
  return { filtro: 'exponencial', suavizacao: 0, zonaMortaGrausPorS };
}
