/**
 * Acumulado da medição, janela a janela, desde que a medição (re)começou.
 *
 * Existe por causa do parecer r5 da ATI-003 (importante 3): a tela mostra só a janela corrente, e
 * quem lê a tela de fora (o roteiro de medição, um print, uma pessoa) enxerga uma janela em cada
 * tantas. A regra que decide onde mora o envio é "nenhuma janela abaixo de 90 Hz" — contada só
 * sobre as janelas vistas, ela puxa o resultado para aprovar. Aqui cada janela fechada entra, sem
 * exceção, e o número sai junto do **de quantas janelas** ele veio.
 *
 * Fora do caminho quente: recebe o resumo que o `MedidorDeTaxa` já monta uma vez por janela e só
 * soma números em campos já alocados. Nada por amostra.
 */

import type {ResumoMedicao} from './medidorDeTaxa';

/**
 * Abaixo disto a janela conta como queda de taxa. É o limiar de ARQUITETURA.md §2.1 ("abaixo de
 * ~90 Hz estáveis, o envio migra para o nativo"), aplicado janela a janela.
 */
export const LIMIAR_TAXA_HZ = 90;

/**
 * Acima disto o maior intervalo entre chegadas no JS conta como pico da ponte: a 100 Hz são três
 * amostras chegando juntas. Regra combinada na resposta ao parecer r4 da ATI-003 (item 2 b/c).
 */
export const LIMIAR_PONTE_MS = 30;

export type ResumoAcumulado = {
  /** Taxa pedida ao sensor quando o acumulado foi zerado: o número só vale para ela. */
  readonly taxaAlvoHz: number;
  /** Janelas que entraram na conta. É o "de quantas" de todo número abaixo. */
  readonly janelasContadas: number;
  /**
   * Janelas descartadas porque começaram antes de a primeira amostra chegar: medem o tempo de
   * partida do sensor, não a taxa sustentada. Aparecem na tela para nada sumir em silêncio.
   */
  readonly janelasDePartida: number;
  /** Janelas contadas com taxa (JS) abaixo de `LIMIAR_TAXA_HZ`. */
  readonly janelasAbaixoDoLimiarDeTaxa: number;
  /** Janelas contadas com maior atraso na ponte acima de `LIMIAR_PONTE_MS`. */
  readonly janelasComPonteAcimaDoLimiar: number;
  /** Menor taxa (JS) entre as janelas contadas; `null` sem janela contada. */
  readonly piorTaxaHz: number | null;
  /** Amostras sobre tempo, somando todas as janelas contadas; `null` sem janela contada. */
  readonly taxaMediaHz: number | null;
  /** Média do dt carimbado pelo sensor sobre todos os intervalos das janelas contadas. */
  readonly dtMedioMs: number | null;
  /** Desvio padrão (populacional) do mesmo dt, combinado exatamente a partir das janelas. */
  readonly dtDesvioMs: number | null;
  /** Maior dt carimbado pelo sensor em qualquer janela contada. */
  readonly maiorDtMs: number | null;
  /** Maior intervalo entre chegadas no JS em qualquer janela contada. */
  readonly maiorAtrasoNaPonteMs: number | null;
};

export class AcumuladoDaMedicao {
  private taxaAlvoHz = 0;
  private amostraJaChegou = false;
  private janelasContadas = 0;
  private janelasDePartida = 0;
  private janelasAbaixoDoLimiarDeTaxa = 0;
  private janelasComPonteAcimaDoLimiar = 0;
  private piorTaxaHz = Number.POSITIVE_INFINITY;
  private amostras = 0;
  private duracaoMs = 0;
  private intervalos = 0;
  private somaDt = 0;
  private somaDtAoQuadrado = 0;
  private maiorDtMs = 0;
  private maiorAtrasoNaPonteMs = 0;

  /** Começa do zero. Chamar a cada (re)início da medição e a cada troca de taxa. */
  zerar(taxaAlvoHz: number): void {
    this.taxaAlvoHz = taxaAlvoHz;
    this.amostraJaChegou = false;
    this.janelasContadas = 0;
    this.janelasDePartida = 0;
    this.janelasAbaixoDoLimiarDeTaxa = 0;
    this.janelasComPonteAcimaDoLimiar = 0;
    this.piorTaxaHz = Number.POSITIVE_INFINITY;
    this.amostras = 0;
    this.duracaoMs = 0;
    this.intervalos = 0;
    this.somaDt = 0;
    this.somaDtAoQuadrado = 0;
    this.maiorDtMs = 0;
    this.maiorAtrasoNaPonteMs = 0;
  }

  /** Soma uma janela fechada. Uma chamada por janela, nunca por amostra. */
  somar(janela: ResumoMedicao): void {
    if (!this.amostraJaChegou) {
      // A janela começou antes de qualquer amostra: o que ela mede é o tempo de partida do
      // sensor. Uma janela vazia depois disso, ao contrário, é queda de verdade e conta.
      this.janelasDePartida += 1;
      this.amostraJaChegou = janela.amostras > 0;
      return;
    }

    this.janelasContadas += 1;
    if (janela.taxaHz < LIMIAR_TAXA_HZ) {
      this.janelasAbaixoDoLimiarDeTaxa += 1;
    }
    if (janela.intervaloJsMaximoMs > LIMIAR_PONTE_MS) {
      this.janelasComPonteAcimaDoLimiar += 1;
    }
    if (janela.taxaHz < this.piorTaxaHz) {
      this.piorTaxaHz = janela.taxaHz;
    }
    if (janela.dtMaximoMs > this.maiorDtMs) {
      this.maiorDtMs = janela.dtMaximoMs;
    }
    if (janela.intervaloJsMaximoMs > this.maiorAtrasoNaPonteMs) {
      this.maiorAtrasoNaPonteMs = janela.intervaloJsMaximoMs;
    }
    this.amostras += janela.amostras;
    this.duracaoMs += janela.janelaMs;

    // Média e desvio de cada janela são populacionais e pesados pelo número de intervalos dela:
    // reconstruir Σdt e Σdt² dá o resultado exato, como se as amostras estivessem numa janela só.
    const n = janela.intervalos;
    this.intervalos += n;
    this.somaDt += n * janela.dtMedioMs;
    this.somaDtAoQuadrado +=
      n * (janela.dtDesvioMs * janela.dtDesvioMs + janela.dtMedioMs * janela.dtMedioMs);
  }

  /** Foto do acumulado, para a tela e para a captura. Uma por janela. */
  resumir(): ResumoAcumulado {
    const temJanela = this.janelasContadas > 0;
    const temIntervalo = this.intervalos > 0;
    const dtMedio = temIntervalo ? this.somaDt / this.intervalos : null;
    const variancia =
      dtMedio === null
        ? null
        : // O max(0) apara o resíduo negativo do ponto flutuante, como no MedidorDeTaxa.
          Math.max(0, this.somaDtAoQuadrado / this.intervalos - dtMedio * dtMedio);

    return {
      taxaAlvoHz: this.taxaAlvoHz,
      janelasContadas: this.janelasContadas,
      janelasDePartida: this.janelasDePartida,
      janelasAbaixoDoLimiarDeTaxa: this.janelasAbaixoDoLimiarDeTaxa,
      janelasComPonteAcimaDoLimiar: this.janelasComPonteAcimaDoLimiar,
      piorTaxaHz: temJanela ? this.piorTaxaHz : null,
      taxaMediaHz:
        temJanela && this.duracaoMs > 0
          ? (this.amostras * 1000) / this.duracaoMs
          : null,
      dtMedioMs: dtMedio,
      dtDesvioMs: variancia === null ? null : Math.sqrt(variancia),
      maiorDtMs: temJanela ? this.maiorDtMs : null,
      maiorAtrasoNaPonteMs: temJanela ? this.maiorAtrasoNaPonteMs : null,
    };
  }
}
