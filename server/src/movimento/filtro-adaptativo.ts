/**
 * Filtro adaptativo do tremor (ATI-033) — o "1€" (*One Euro*, Casiez, Roussel e Vogel, CHI 2012),
 * adaptado a um sensor que mede **velocidade** em vez de posição.
 *
 * ## O problema que a zona morta não resolve
 *
 * A zona morta corta por **amplitude**, e tremor e mira fina têm a mesma amplitude: os dois são
 * movimento lento. O que os separa é a **frequência** — tremor é oscilação de 5 a 12 Hz em torno de
 * um ponto, mira fina é deslocamento sustentado numa direção. Um passa-baixa separa os dois; um
 * passa-baixa **fixo** paga com atraso no gesto rápido, que é onde atraso se sente. O 1€ resolve o
 * par jitter × atraso mexendo no corte pela rapidez do movimento:
 *
 * ```
 * corte (Hz) = corteMinimo + beta · rapidez (°/s)
 * ```
 *
 * Parado ou tremendo, o corte fica no mínimo e o tremor some; atravessando a tela, o corte sobe e o
 * atraso desaparece. São dois números com significado físico, e é por isso que ele foi escolhido.
 *
 * ## Três diferenças para o 1€ do artigo, e o porquê de cada uma
 *
 * 1. **A rapidez vem do sensor, não de derivada.** O artigo deriva a posição para saber a
 *    velocidade, e a derivada de sinal ruidoso é tão ruim que precisa de filtro próprio. Aqui o
 *    giroscópio **mede** a velocidade; a rapidez é o módulo dela, passado por um passa-baixa de
 *    `corteDaVelocidade` só para o próprio tremor não abrir o corte no ritmo dele.
 * 2. **O filtro trabalha na posição, guardando só o que falta sair.** A entrada é velocidade, mas
 *    filtrar a velocidade com corte variável **não conserva deslocamento**: quando o corte sobe no
 *    começo do gesto e desce no fim, a área da velocidade filtrada deixa de bater com a da original
 *    (∫ω − ∫ω̂ = −∫τ′·ω̂ dt) e o cursor termina num lugar diferente do que o pulso mandou. Filtrando
 *    a posição — que é o 1€ do artigo —, o estado parado da saída é a própria entrada, e todo grau
 *    girado sai, só que no tempo do filtro. A posição absoluta não é guardada (ela cresce sem
 *    limite numa sessão longa): guarda-se o **pendente**, `θ − θ̂`, que é a mesma conta reescrita:
 *
 *    ```
 *    pendente += ω·dt          (o que o pulso girou nesta amostra entra na fila)
 *    saída     = α · pendente  (o filtro deixa sair uma fração)
 *    pendente -= saída
 *    ```
 * 3. **Um corte só para os dois eixos**, calculado sobre o módulo do vetor. O artigo filtra cada
 *    dimensão por conta própria; aqui isso entortaria a diagonal — o eixo mais rápido teria corte
 *    mais alto, sairia antes, e a reta viraria curva. É o mesmo motivo de a zona morta olhar o vetor.
 *
 * O `α` sai do `dt` **de cada amostra** (medido no aparelho), e não de uma taxa fixa:
 * `α = r / (1 + r)` com `r = 2π·corte·dt`. É a forma exata do passa-baixa de primeira ordem
 * discretizado, e ela continua certa quando o aparelho entrega 60 Hz em vez de 100.
 *
 * ⚠️ **CAMINHO QUENTE**: `filtrar` roda a cada amostra que passa da zona morta. Estado num
 * `Float64Array` e saída em outro (número quebrado em variável de closure custa uma caixa no heap
 * por escrita — ver `pipeline.ts`), nenhuma alocação, nenhum log.
 */

import { GRAUS_POR_RADIANO } from './tipos.js';

/**
 * Abaixo disto o estado vira zero exato.
 *
 * O pendente decai geometricamente e, sem piso, levaria ~11 mil amostras (quase 2 min) para chegar
 * a zero em ponto flutuante — passando por números subnormais, que são lentos em muita CPU. Mais
 * importante: enquanto o estado não é zero, o atalho do aparelho parado (`pipeline.ts`) não pode ser
 * tomado. 1e-9 rad é 1,1e-5 px no teto da sensibilidade (200 px/grau): jogar isso fora uma vez por
 * repouso não aparece em medição nenhuma.
 */
const PISO_DO_ESTADO = 1e-9;

const DOIS_PI = 2 * Math.PI;

export interface FiltroAdaptativo {
  /**
   * O que saiu na última chamada de `filtrar`: deslocamento **angular**, em radianos, desta
   * amostra — `[horizontal, vertical]`. O mesmo objeto sempre; quem precisa guardar, copia.
   */
  readonly saida: Float64Array;

  /**
   * Caminho frio. Troca os parâmetros **sem** esquecer o estado: mexer num controle deslizante não
   * pode engasgar o cursor (mesma regra da suavização no `pipeline.ts`).
   *
   * @param corteMinimoHz corte com o aparelho parado ou tremendo.
   * @param betaHzPorGrauPorS quanto o corte sobe por °/s de rapidez.
   * @param corteDaVelocidadeHz passa-baixa da estimativa de rapidez.
   */
  configurar(corteMinimoHz: number, betaHzPorGrauPorS: number, corteDaVelocidadeHz: number): void;

  /**
   * Onde quem chama escreve a amostra antes de `filtrar()`: `[horizontal, vertical, dt]`, a
   * velocidade em rad/s e o `dt` em segundos (> 0, já validado). É buffer, e não argumento, de
   * propósito: número quebrado passado como argumento a uma função que o motor não embutiu vira
   * caixa no heap. Medido dentro do pipeline: 6,8 B/amostra com `filtrar(h, v, dt)`, ~0 com o buffer.
   */
  readonly entrada: Float64Array;

  /** ⚠️ Caminho quente. Filtra a amostra que está em `entrada` e escreve o resultado em `saida`. */
  filtrar(): void;

  /** Esquece o que estava pendente e a rapidez estimada. */
  zerar(): void;

  /**
   * `true` quando não há nada guardado — entrada zero produziria saída zero e estado intocado.
   * É a condição do atalho do aparelho parado no pipeline.
   */
  vazio(): boolean;
}

export function criarFiltroAdaptativo(): FiltroAdaptativo {
  const PENDENTE_HORIZONTAL = 0;
  const PENDENTE_VERTICAL = 1;
  const VELOCIDADE_HORIZONTAL = 2;
  const VELOCIDADE_VERTICAL = 3;
  const estado = new Float64Array(4);
  const entrada = new Float64Array(3);
  const saida = new Float64Array(2);

  // Derivados, resolvidos em `configurar` (caminho frio). Lidos por amostra, nunca escritos.
  let doisPiCorteMinimo = 0;
  /** 2π·beta, já convertido de "Hz por °/s" para "Hz por rad/s": a rapidez é medida em rad/s. */
  let doisPiBetaPorRadPorS = 0;
  let doisPiCorteDaVelocidade = 0;

  function configurar(
    corteMinimoHz: number,
    betaHzPorGrauPorS: number,
    corteDaVelocidadeHz: number,
  ): void {
    doisPiCorteMinimo = DOIS_PI * corteMinimoHz;
    doisPiBetaPorRadPorS = DOIS_PI * betaHzPorGrauPorS * GRAUS_POR_RADIANO;
    doisPiCorteDaVelocidade = DOIS_PI * corteDaVelocidadeHz;
  }

  function filtrar(): void {
    const horizontal = entrada[0] ?? 0;
    const vertical = entrada[1] ?? 0;
    const dtSegundos = entrada[2] ?? 0;

    // Rapidez: passa-baixa do vetor velocidade, e só depois o módulo. Na ordem contrária (módulo
    // primeiro) o tremor, que tem média zero como vetor, viraria uma rapidez de média positiva e
    // abriria o corte justamente quando ele precisa ficar fechado.
    const rVelocidade = doisPiCorteDaVelocidade * dtSegundos;
    const alfaVelocidade = rVelocidade / (1 + rVelocidade);
    const velocidadeAntesH = estado[VELOCIDADE_HORIZONTAL] ?? 0;
    const velocidadeAntesV = estado[VELOCIDADE_VERTICAL] ?? 0;
    const velocidadeH = velocidadeAntesH + alfaVelocidade * (horizontal - velocidadeAntesH);
    const velocidadeV = velocidadeAntesV + alfaVelocidade * (vertical - velocidadeAntesV);
    const rapidez = Math.sqrt(velocidadeH * velocidadeH + velocidadeV * velocidadeV);

    // O corte da amostra, e o α exato do passa-baixa de primeira ordem para o `dt` dela.
    const r = (doisPiCorteMinimo + doisPiBetaPorRadPorS * rapidez) * dtSegundos;
    const alfa = r / (1 + r);

    const pendenteH = (estado[PENDENTE_HORIZONTAL] ?? 0) + horizontal * dtSegundos;
    const pendenteV = (estado[PENDENTE_VERTICAL] ?? 0) + vertical * dtSegundos;
    const saidaH = alfa * pendenteH;
    const saidaV = alfa * pendenteV;
    saida[0] = saidaH;
    saida[1] = saidaV;

    // Escrita direto no `Float64Array` nos dois ramos: um `let` reatribuído dentro do `if`
    // obrigaria o motor a juntar dois valores quebrados numa variável só, que é a caixa que o
    // `pipeline.ts` mediu (14,2 B/amostra com `if`).
    const restoH = pendenteH - saidaH;
    const restoV = pendenteV - saidaV;
    if (Math.abs(restoH) < PISO_DO_ESTADO) estado[PENDENTE_HORIZONTAL] = 0;
    else estado[PENDENTE_HORIZONTAL] = restoH;
    if (Math.abs(restoV) < PISO_DO_ESTADO) estado[PENDENTE_VERTICAL] = 0;
    else estado[PENDENTE_VERTICAL] = restoV;
    if (Math.abs(velocidadeH) < PISO_DO_ESTADO) estado[VELOCIDADE_HORIZONTAL] = 0;
    else estado[VELOCIDADE_HORIZONTAL] = velocidadeH;
    if (Math.abs(velocidadeV) < PISO_DO_ESTADO) estado[VELOCIDADE_VERTICAL] = 0;
    else estado[VELOCIDADE_VERTICAL] = velocidadeV;
  }

  return {
    entrada,
    saida,
    configurar,
    filtrar,
    zerar() {
      estado.fill(0);
      entrada.fill(0);
      saida.fill(0);
    },
    vazio() {
      return (
        estado[PENDENTE_HORIZONTAL] === 0 &&
        estado[PENDENTE_VERTICAL] === 0 &&
        estado[VELOCIDADE_HORIZONTAL] === 0 &&
        estado[VELOCIDADE_VERTICAL] === 0
      );
    },
  };
}
