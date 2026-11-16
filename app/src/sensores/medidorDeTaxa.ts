/**
 * Acumulador de estatísticas de amostragem em janela fixa.
 *
 * Roda no caminho quente (uma chamada por amostra, 100 vezes por segundo): só soma números em
 * campos já alocados — nada de array, objeto ou log por amostra. O único objeto criado é o resumo,
 * uma vez por janela.
 *
 * Duas medidas diferentes, de propósito:
 * - `dt*` vem do carimbo de tempo do sensor no lado nativo: mede a cadência do *sensor*.
 * - `taxaHz` e `intervaloJsMaximoMs` usam o relógio do JS: medem o que a *ponte* de fato entrega.
 *
 * Quando as duas divergem, a culpa é da ponte — que é exatamente a decisão que a ATI-003 precisa.
 */

export type ResumoMedicao = {
  /** Amostras recebidas na janela. */
  readonly amostras: number;
  /**
   * Quantos intervalos carimbados entraram no `dt*` (a primeira amostra do ciclo não tem anterior).
   * É o peso da janela quando várias são combinadas num acumulado (`acumuladoDaMedicao.ts`).
   */
  readonly intervalos: number;
  /** Duração real da janela, medida no relógio monotônico do JS. */
  readonly janelaMs: number;
  /** Amostras por segundo vistas pelo JS na janela. */
  readonly taxaHz: number;
  /** Média do intervalo entre amostras carimbado pelo sensor. */
  readonly dtMedioMs: number;
  /** Desvio padrão (populacional) do mesmo intervalo — o jitter do sensor. */
  readonly dtDesvioMs: number;
  /** Maior intervalo carimbado pelo sensor na janela. */
  readonly dtMaximoMs: number;
  /** Maior intervalo entre duas chegadas consecutivas no JS — o jitter da ponte. */
  readonly intervaloJsMaximoMs: number;
};

const RESUMO_VAZIO: ResumoMedicao = {
  amostras: 0,
  intervalos: 0,
  janelaMs: 0,
  taxaHz: 0,
  dtMedioMs: 0,
  dtDesvioMs: 0,
  dtMaximoMs: 0,
  intervaloJsMaximoMs: 0,
};

export class MedidorDeTaxa {
  private inicioJanelaMs = 0;
  private amostras = 0;
  private intervalos = 0;
  private somaDt = 0;
  private somaDtAoQuadrado = 0;
  private maiorDt = 0;
  private maiorIntervaloJs = 0;
  private ultimaChegadaMs = 0;
  private temChegadaAnterior = false;

  /** Zera tudo e abre uma janela nova. Use ao (re)começar a medir. */
  reiniciar(agoraMs: number): void {
    this.zerarJanela(agoraMs);
    this.ultimaChegadaMs = 0;
    this.temChegadaAnterior = false;
  }

  /**
   * @param dtMs intervalo carimbado pelo sensor; 0 significa "primeira amostra, sem anterior".
   * @param chegadaMs instante da chegada no JS, pelo relógio monotônico.
   */
  registrar(dtMs: number, chegadaMs: number): void {
    if (this.temChegadaAnterior) {
      const intervaloJs = chegadaMs - this.ultimaChegadaMs;
      if (intervaloJs > this.maiorIntervaloJs) {
        this.maiorIntervaloJs = intervaloJs;
      }
    }
    this.ultimaChegadaMs = chegadaMs;
    this.temChegadaAnterior = true;
    this.amostras += 1;

    if (dtMs > 0) {
      this.intervalos += 1;
      this.somaDt += dtMs;
      this.somaDtAoQuadrado += dtMs * dtMs;
      if (dtMs > this.maiorDt) {
        this.maiorDt = dtMs;
      }
    }
  }

  /** Fecha a janela corrente, devolve o resumo e abre a janela seguinte em `agoraMs`. */
  fechar(agoraMs: number): ResumoMedicao {
    const janelaMs = agoraMs - this.inicioJanelaMs;
    if (this.amostras === 0) {
      this.zerarJanela(agoraMs);
      return janelaMs > 0 ? {...RESUMO_VAZIO, janelaMs} : RESUMO_VAZIO;
    }

    const media = this.intervalos > 0 ? this.somaDt / this.intervalos : 0;
    // Variância pela forma E[x²] − E[x]²; o max(0) apara o resíduo negativo do ponto flutuante.
    const variancia =
      this.intervalos > 0
        ? Math.max(0, this.somaDtAoQuadrado / this.intervalos - media * media)
        : 0;

    const resumo: ResumoMedicao = {
      amostras: this.amostras,
      intervalos: this.intervalos,
      janelaMs,
      taxaHz: janelaMs > 0 ? (this.amostras * 1000) / janelaMs : 0,
      dtMedioMs: media,
      dtDesvioMs: Math.sqrt(variancia),
      dtMaximoMs: this.maiorDt,
      intervaloJsMaximoMs: this.maiorIntervaloJs,
    };

    this.zerarJanela(agoraMs);
    return resumo;
  }

  private zerarJanela(agoraMs: number): void {
    this.inicioJanelaMs = agoraMs;
    this.amostras = 0;
    this.intervalos = 0;
    this.somaDt = 0;
    this.somaDtAoQuadrado = 0;
    this.maiorDt = 0;
    this.maiorIntervaloJs = 0;
  }
}
