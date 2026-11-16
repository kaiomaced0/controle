/**
 * Os ajustes do giroscópio: o que a pessoa regula, com faixa declarada e saturação.
 *
 * Os nomes e os padrões são os do bloco `gyro` do perfil (ARQUITETURA.md, seção 4) e as faixas
 * são as do PROTOCOLO.md, seção 3.4 — `sensX` 1–200, `deadzone` 0–10 °/s, `suavizacao` 0–0,9.
 * Regra do protocolo, repetida aqui porque é dela que sai o comportamento: **valor fora da faixa
 * satura, não recusa**. Quem arrasta o controle deslizante até o fim recebe o fim da faixa.
 *
 * Este módulo é **caminho frio**: ele roda no handshake, na troca de perfil e no `config` do app
 * (baixa frequência), e por isso pode alocar à vontade. O que ele entrega é um objeto congelado
 * que o pipeline converte **uma vez** para as unidades internas — a conversão de pixel por grau
 * para pixel por radiano não pode acontecer por amostra.
 */

import {
  ehFiltro,
  ehOrientacao,
  type Filtro,
  type Orientacao,
} from './tipos.js';

/**
 * Ajustes efetivos do giro. Todo campo já resolvido e dentro da faixa — não existe `undefined`
 * aqui dentro, para o pipeline nunca precisar decidir nada por amostra.
 */
export interface AjustesDoGiro {
  /** Giro desligado no perfil: nenhuma amostra vira pixel. */
  readonly ativo: boolean;
  /** Como o aparelho é segurado; decide qual eixo do sensor vira horizontal e vertical. */
  readonly orientacao: Orientacao;
  /** Sensibilidade horizontal, em **pixels por grau** de rotação. */
  readonly sensXPixelsPorGrau: number;
  /** Sensibilidade vertical, em **pixels por grau** de rotação. */
  readonly sensYPixelsPorGrau: number;
  /** Limiar da zona morta, em graus por segundo. 0 desliga a zona morta. */
  readonly zonaMortaGrausPorS: number;
  /**
   * Quanto de suavização, de 0 (nenhuma) a 0,9 (bem lenta), como o perfil declara.
   *
   * **Não** é o `a` da fórmula do ARQUITETURA.md — é o complemento dele. A média exponencial usa
   * `s = a·x + (1−a)·s_anterior`, onde `a = 1 − suavizacao`: com `suavizacao` 0 o `a` é 1 e a
   * saída é a entrada (nenhuma suavização), e quanto maior a `suavizacao`, menor o peso da
   * amostra nova. O teto de 0,9 existe para não haver ajuste que trave o cursor.
   */
  readonly suavizacao: number;
  /**
   * Qual filtro faz a etapa 4 (ATI-033): `exponencial` (a média de coeficiente fixo, regulada por
   * {@link suavizacao}) ou `euro` (o adaptativo de `filtro-adaptativo.ts`, regulado pelos três
   * campos abaixo). Só um dos dois roda; o outro fica parado e zerado.
   */
  readonly filtro: Filtro;
  /**
   * Filtro `euro`: o corte com o aparelho parado ou tremendo, em Hz. É ele que decide quanto do
   * tremor some — e quanto a mira lenta atrasa (constante de tempo de 1/(2π·corte)).
   */
  readonly filtroCorteMinimoHz: number;
  /**
   * Filtro `euro`: quanto o corte sobe por grau por segundo de rapidez, em Hz por °/s. É ele que
   * tira o atraso do gesto rápido. Zero vira um passa-baixa fixo no corte mínimo.
   */
  readonly filtroBeta: number;
  /**
   * Filtro `euro`: o passa-baixa da estimativa de rapidez, em Hz. Baixo demais, o gesto rápido
   * começa com o corte ainda fechado (atraso); alto demais, o tremor abre o corte no ritmo dele.
   */
  readonly filtroCorteDaVelocidadeHz: number;
  /** Inverte o sentido horizontal em cima do padrão da orientação. */
  readonly inverterX: boolean;
  /** Inverte o sentido vertical em cima do padrão da orientação. */
  readonly inverterY: boolean;
  /**
   * Teto de deslocamento de **uma** amostra, em pixels por eixo — a proteção contra pico de
   * sensor. Um giroscópio de celular vai até ~2000 °/s; uma amostra dessas com sensibilidade de
   * fábrica jogaria o cursor para o outro lado da tela num quadro só.
   */
  readonly limitePixelsPorAmostra: number;
  /** Maior `dtMs` aceito. Acima disto a amostra é descartada em vez de integrar um salto. */
  readonly dtMaximoMs: number;
  /**
   * Quanto uma amostra pode estar atrasada, em ms, antes de ser jogada fora.
   *
   * O atraso é medido **em relação ao caminho mais rápido já visto nesta sessão**, e não com o
   * relógio de parede: o carimbo do aparelho e o do PC contam de origens diferentes, então o que
   * dá para saber é a *variação* do atraso. Ver `pipeline.ts`.
   */
  readonly atrasoMaximoMs: number;
  /** Bias medido na calibração (ATI-009), em rad/s, no eixo `gx` do sensor. */
  readonly biasGxRadPorS: number;
  /** Bias medido na calibração (ATI-009), em rad/s, no eixo `gy` do sensor. */
  readonly biasGyRadPorS: number;
  /** Bias medido na calibração (ATI-009), em rad/s, no eixo `gz` do sensor. */
  readonly biasGzRadPorS: number;
}

/** Pedido parcial de ajuste: o que não vier fica como estava. */
export type AjustesParciais = {
  readonly [Campo in keyof AjustesDoGiro]?: AjustesDoGiro[Campo] | undefined;
};

/**
 * Faixas aceitas. As três primeiras são as do PROTOCOLO.md, seção 3.4, letra por letra; as
 * outras nascem aqui e estão documentadas no README do módulo.
 */
export const FAIXAS_DO_GIRO = Object.freeze({
  /** Pixels por grau. O mínimo é 1 porque abaixo disso o giro não move nada de útil. */
  sensibilidade: { minimo: 1, maximo: 200 },
  /** Graus por segundo. Zero é válido: desliga a zona morta. */
  zonaMorta: { minimo: 0, maximo: 10 },
  /** 0 = sem suavização. O teto de 0,9 evita ajuste que trave o cursor. */
  suavizacao: { minimo: 0, maximo: 0.9 },
  /**
   * Hz. Abaixo de 0,1 Hz a constante de tempo passa de 1,6 s e o cursor vira borracha; acima de
   * 10 Hz o corte já não alcança o tremor de mão (5–12 Hz), e o filtro deixa de servir para o que
   * existe (ATI-033).
   */
  filtroCorteMinimo: { minimo: 0.1, maximo: 10 },
  /** Hz por °/s. Zero é válido: passa-baixa fixo. 1 Hz por °/s já abre o corte com a mira lenta. */
  filtroBeta: { minimo: 0, maximo: 1 },
  /** Hz. O teto de 100 Hz passa de qualquer taxa de amostragem: é "rapidez sem filtro". */
  filtroCorteDaVelocidade: { minimo: 0.1, maximo: 100 },
  /** Pixels por amostra. 2000 px é mais que a largura da tela desta bancada. */
  limitePorAmostra: { minimo: 1, maximo: 2000 },
  /** Milissegundos. Teto de 1 s: acima disso não é amostra, é sessão nova. */
  dtMaximo: { minimo: 1, maximo: 1000 },
  /** Milissegundos de atraso tolerado. */
  atrasoMaximo: { minimo: 1, maximo: 1000 },
  /**
   * Bias em rad/s. Um giroscópio parado acusa 0,002–0,02 rad/s (ARQUITETURA.md, seção 3); ±1
   * rad/s é folga de duas ordens de grandeza e, ao mesmo tempo, uma trava contra calibração
   * absurda virar movimento constante do cursor.
   */
  bias: { minimo: -1, maximo: 1 },
});

/**
 * Padrões de fábrica — os mesmos números do perfil `mouse-basico` do ARQUITETURA.md, seção 4.
 *
 * O bias nasce em zero de propósito: sem calibração (ATI-009), descontar um bias inventado seria
 * pior do que não descontar nada.
 */
export const AJUSTES_PADRAO: AjustesDoGiro = Object.freeze({
  ativo: true,
  orientacao: 'retrato',
  sensXPixelsPorGrau: 35,
  sensYPixelsPorGrau: 35,
  zonaMortaGrausPorS: 0.15,
  suavizacao: 0.15,
  filtro: 'euro',
  filtroCorteMinimoHz: 1.5,
  filtroBeta: 0.3,
  filtroCorteDaVelocidadeHz: 3,
  inverterX: false,
  inverterY: false,
  limitePixelsPorAmostra: 120,
  dtMaximoMs: 200,
  atrasoMaximoMs: 50,
  biasGxRadPorS: 0,
  biasGyRadPorS: 0,
  biasGzRadPorS: 0,
});

interface Faixa {
  readonly minimo: number;
  readonly maximo: number;
}

/**
 * Satura dentro da faixa. Valor não finito (`NaN`, infinito) cai no atual — saturar `NaN` para o
 * mínimo daria um ajuste que ninguém pediu, e `JSON.parse('1e999')` devolve `Infinity` sem erro
 * nenhum (PROTOCOLO.md, seção 3).
 */
function saturar(valor: number | undefined, faixa: Faixa, atual: number): number {
  if (valor === undefined || !Number.isFinite(valor)) return atual;
  if (valor < faixa.minimo) return faixa.minimo;
  if (valor > faixa.maximo) return faixa.maximo;
  return valor;
}

function booleano(valor: boolean | undefined, atual: boolean): boolean {
  return typeof valor === 'boolean' ? valor : atual;
}

/**
 * Monta os ajustes efetivos: o que vier em `pedido` vence, o resto fica como em `base`.
 *
 * Nunca lança. Pedido imprestável não derruba a sessão de quem está com o celular na mão: ou
 * satura na faixa, ou fica com o valor que já estava valendo.
 */
export function resolverAjustes(
  pedido: AjustesParciais = {},
  base: AjustesDoGiro = AJUSTES_PADRAO,
): AjustesDoGiro {
  return Object.freeze({
    ativo: booleano(pedido.ativo, base.ativo),
    orientacao: ehOrientacao(pedido.orientacao) ? pedido.orientacao : base.orientacao,
    sensXPixelsPorGrau: saturar(
      pedido.sensXPixelsPorGrau,
      FAIXAS_DO_GIRO.sensibilidade,
      base.sensXPixelsPorGrau,
    ),
    sensYPixelsPorGrau: saturar(
      pedido.sensYPixelsPorGrau,
      FAIXAS_DO_GIRO.sensibilidade,
      base.sensYPixelsPorGrau,
    ),
    zonaMortaGrausPorS: saturar(
      pedido.zonaMortaGrausPorS,
      FAIXAS_DO_GIRO.zonaMorta,
      base.zonaMortaGrausPorS,
    ),
    suavizacao: saturar(pedido.suavizacao, FAIXAS_DO_GIRO.suavizacao, base.suavizacao),
    filtro: ehFiltro(pedido.filtro) ? pedido.filtro : base.filtro,
    filtroCorteMinimoHz: saturar(
      pedido.filtroCorteMinimoHz,
      FAIXAS_DO_GIRO.filtroCorteMinimo,
      base.filtroCorteMinimoHz,
    ),
    filtroBeta: saturar(pedido.filtroBeta, FAIXAS_DO_GIRO.filtroBeta, base.filtroBeta),
    filtroCorteDaVelocidadeHz: saturar(
      pedido.filtroCorteDaVelocidadeHz,
      FAIXAS_DO_GIRO.filtroCorteDaVelocidade,
      base.filtroCorteDaVelocidadeHz,
    ),
    inverterX: booleano(pedido.inverterX, base.inverterX),
    inverterY: booleano(pedido.inverterY, base.inverterY),
    limitePixelsPorAmostra: saturar(
      pedido.limitePixelsPorAmostra,
      FAIXAS_DO_GIRO.limitePorAmostra,
      base.limitePixelsPorAmostra,
    ),
    dtMaximoMs: saturar(pedido.dtMaximoMs, FAIXAS_DO_GIRO.dtMaximo, base.dtMaximoMs),
    atrasoMaximoMs: saturar(
      pedido.atrasoMaximoMs,
      FAIXAS_DO_GIRO.atrasoMaximo,
      base.atrasoMaximoMs,
    ),
    biasGxRadPorS: saturar(pedido.biasGxRadPorS, FAIXAS_DO_GIRO.bias, base.biasGxRadPorS),
    biasGyRadPorS: saturar(pedido.biasGyRadPorS, FAIXAS_DO_GIRO.bias, base.biasGyRadPorS),
    biasGzRadPorS: saturar(pedido.biasGzRadPorS, FAIXAS_DO_GIRO.bias, base.biasGzRadPorS),
  });
}

/** Duas casas decimais, sem zero à direita: 42,67 e 24 (e não 42,67 e 24,00). */
function arredondar(valor: number): number {
  return Math.round(valor * 100) / 100;
}

/**
 * A suavização e o filtro da etapa 4 com os números **dele** (ATI-033). Com o `euro` ligado a
 * `suavizacao` não é usada, e a linha diz isso com todas as letras: mostrá-la sem aviso faria
 * alguém mexer num número que não faz nada.
 */
function resumirFiltro(ajustes: AjustesDoGiro): string {
  if (ajustes.filtro === 'euro') {
    return (
      `suavizacao=${ajustes.suavizacao} (sem efeito com o filtro euro) ` +
      `filtro=euro(corte=${ajustes.filtroCorteMinimoHz} Hz beta=${ajustes.filtroBeta} Hz/(°/s) ` +
      `corteDaVelocidade=${ajustes.filtroCorteDaVelocidadeHz} Hz)`
    );
  }
  return `suavizacao=${ajustes.suavizacao} filtro=exponencial`;
}

/** Uma linha legível com os ajustes efetivos, para o log de partida e para o relatório. */
export function resumirAjustes(ajustes: AjustesDoGiro): string {
  return (
    `ativo=${String(ajustes.ativo)} orientacao=${ajustes.orientacao} ` +
    // Duas casas: 1920/45 dá 42,666666666666664, e esse número no log só atrapalha quem lê.
    `sens=${arredondar(ajustes.sensXPixelsPorGrau)}/${arredondar(ajustes.sensYPixelsPorGrau)} px/grau ` +
    `zonaMorta=${ajustes.zonaMortaGrausPorS} °/s ${resumirFiltro(ajustes)} ` +
    `inverter=${String(ajustes.inverterX)}/${String(ajustes.inverterY)} ` +
    `limite=${ajustes.limitePixelsPorAmostra} px/amostra`
  );
}
