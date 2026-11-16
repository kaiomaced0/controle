/**
 * As formas do pipeline de movimento: ajustes, destino, contadores e códigos de resultado
 * (docs/ARQUITETURA.md, seção 3).
 *
 * Este arquivo é só vocabulário — a cadeia mora em `pipeline.ts`. A separação existe porque o
 * vocabulário é o que o resto do servidor importa (a configuração, o transporte, o teste), e ele
 * não pode arrastar junto o caminho quente.
 *
 * Três decisões que valem para o módulo inteiro:
 *
 * 1. **A unidade que a pessoa ajusta é pixel por grau.** Grau é a unidade em que se pensa
 *    ("virar 90° atravessa a tela"); radiano é a unidade do fio (PROTOCOLO.md, seção 1). A
 *    conversão acontece **uma vez**, quando o ajuste é resolvido, e nunca por amostra.
 * 2. **Erro vira número, não exceção.** Mesma regra da camada de saída: a 100 Hz não há quem
 *    trate exceção. Amostra imprestável entra em `ContadoresDoPipeline` e o processamento
 *    devolve um código — ver `RESULTADO_DE_MOVIMENTO`.
 * 3. **Valor fora da faixa satura, não recusa** (PROTOCOLO.md, seção 3.4). Quem arrasta um
 *    controle deslizante até o fim recebe o fim da faixa, não uma mensagem de erro.
 */

import type { BackendDeEntrada } from '../saida/tipos.js';

/* ------------------------------------------------------------------------------- conversões */

/** Um radiano em graus. O ajuste fala em graus; o giroscópio, em radianos. */
export const GRAUS_POR_RADIANO = 180 / Math.PI;
/** Um grau em radianos. */
export const RADIANOS_POR_GRAU = Math.PI / 180;

/* ------------------------------------------------------------------------------ orientação */

/**
 * Como o aparelho é segurado (ARQUITETURA.md, seção 3.1 — espaço **local** da v1).
 *
 * O sistema de coordenadas do giroscópio é preso ao aparelho, não à tela: é a orientação
 * declarada no perfil que diz qual eixo do sensor vira horizontal e qual vira vertical. O espaço
 * de **mundo** (projeção pelo vetor gravidade) é a v2 e está fora do escopo da ATI-008.
 */
export const ORIENTACOES = ['retrato', 'paisagem', 'apontador', 'apontador-torcao'] as const;
export type Orientacao = (typeof ORIENTACOES)[number];

export function ehOrientacao(valor: unknown): valor is Orientacao {
  return typeof valor === 'string' && (ORIENTACOES as readonly string[]).includes(valor);
}

/* ---------------------------------------------------------------------------------- filtro */

/**
 * O filtro da etapa 4 (ATI-033).
 *
 * - `exponencial` — a média de coeficiente fixo da ATI-008, regulada por `suavizacao`;
 * - `euro` — o filtro adaptativo (1€, `filtro-adaptativo.ts`): filtra muito quando o movimento é
 *   lento e pouco quando é rápido. Com ele, `suavizacao` não é usada.
 */
export const FILTROS = ['exponencial', 'euro'] as const;
export type Filtro = (typeof FILTROS)[number];

export function ehFiltro(valor: unknown): valor is Filtro {
  return typeof valor === 'string' && (FILTROS as readonly string[]).includes(valor);
}

/* --------------------------------------------------------------------------------- destino */

/**
 * Para onde o pipeline manda os pixels.
 *
 * É de propósito **menor** que `BackendDeEntrada`: o pipeline só sabe mover o cursor de forma
 * relativa, e pedir a interface inteira aqui obrigaria todo dublê de teste a implementar botão,
 * tecla e scroll para nada. Um `BackendDeEntrada` atende este contrato sem adaptador nenhum
 * (`saida/tipos.ts`), e é assim que o modo `sistema` liga a cadeia no `SendInput` de verdade.
 */
export interface DestinoDeMovimento {
  /** Identificação curta para log e telemetria: `windows`, `dubla`, `ensaio`. */
  readonly nome: string;
  /** ⚠️ Caminho quente. Movimento relativo em pixels **inteiros**. */
  moverMouseRelativo(dx: number, dy: number): void;
}

/** Prova, em tempo de compilação, que o backend de saída serve de destino sem adaptador. */
export type BackendServeDeDestino = BackendDeEntrada extends DestinoDeMovimento ? true : never;

/* ------------------------------------------------------------------------------- resultados */

/**
 * O que aconteceu com uma amostra. É **número**, e não string nem objeto: `processar` roda a
 * 100 Hz e não pode alocar (regra 2 do CLAUDE.md).
 */
export const RESULTADO_DE_MOVIMENTO = Object.freeze({
  /** Virou pixel inteiro e foi para o destino. */
  APLICADO: 0,
  /** Amostra válida que não completou um pixel — a fração ficou guardada no acumulador. */
  SEM_MOVIMENTO: 1,
  /** Não é MOVIMENTO (BOTÃO, EIXO, SCROLL): o pipeline não tem nada a ver com este pacote. */
  NAO_E_MOVIMENTO: 2,
  /** O giroscópio está desligado no ajuste (`ativo: false`). */
  DESLIGADO: 3,
  /** `seq` igual ou anterior ao último aceito — nunca reproduzido em lote. */
  FORA_DE_ORDEM: 4,
  /** Primeira amostra depois de retomar: reinicia o estado e **não** integra contra o passado. */
  RETOMADA: 5,
  /** `dtMs` ausente, zero, negativo, não finito ou absurdo. */
  DT_INVALIDO: 6,
  /** Chegou tarde demais (engasgo de rede): reproduzir geraria salto de cursor. */
  ATRASADA: 7,
  /** `gx`/`gy`/`gz` com `NaN` ou infinito — o fio deixa passar (PROTOCOLO.md, seção 4.0). */
  LEITURA_INVALIDA: 8,
} as const);

export type ResultadoDeMovimento =
  (typeof RESULTADO_DE_MOVIMENTO)[keyof typeof RESULTADO_DE_MOVIMENTO];

/* ------------------------------------------------------------------------------ contadores */

/**
 * Diagnóstico do pipeline. Objeto **mutável reaproveitado**, mesmo padrão do `ContadoresDoCodec`
 * e do `ContadoresDeSaida`: o caminho quente só soma em campo já alocado.
 *
 * É por estes números que se responde "por que o cursor não andou?" sem uma linha de log por
 * pacote — que é a única resposta possível a 100 Hz (regra 7 do CLAUDE.md).
 *
 * A mesma forma serve para as duas contas que o pipeline mantém (ATI-028): a **da sessão**
 * (`pipeline.contadores`, zerada a cada fim de sessão) e o **total do processo**
 * (`pipeline.totalDoProcesso()`). As duas nunca dividem objeto.
 */
export interface ContadoresDoPipeline {
  /** Pacotes MOVIMENTO que entraram na cadeia, aceitos ou não. */
  amostrasRecebidas: number;
  /** Amostras que viraram pelo menos um pixel e foram para o destino. */
  amostrasAplicadas: number;
  /** Amostras válidas cujo deslocamento inteiro deu zero (a fração ficou no acumulador). */
  amostrasSemMovimento: number;
  /** Amostras ignoradas por o giro estar desligado no ajuste. */
  amostrasComGiroDesligado: number;
  /** Descartadas por `seq` fora de ordem. */
  descartadasPorOrdem: number;
  /** Descartadas por `dtMs` imprestável (ausente, zero, negativo ou acima do teto). */
  descartadasPorDt: number;
  /** Descartadas por chegarem velhas demais — o engasgo de rede que viraria salto. */
  descartadasPorAtraso: number;
  /** Descartadas por leitura não finita vinda do sensor (`NaN`, infinito). */
  descartadasPorLeituraInvalida: number;
  /** Amostras que a zona morta zerou por completo (mão parada, tremor abaixo do limiar). */
  zeradasPorZonaMorta: number;
  /** Amostras cujo deslocamento bateu no limite por amostra (pico de sensor). */
  limitadasPorPico: number;
  /** Amostras marcadas como primeira após retomar. */
  retomadas: number;
  /** Quantas vezes o estado foi zerado (retomada, centralizar, pausa, reancoragem, religar o giro). */
  reinicios: number;
  /**
   * Quantas vezes a troca de ajustes invalidou a média exponencial — orientação ou inversão de
   * eixo, que mudam o referencial em que o estado guardado foi medido.
   *
   * Separado de `reinicios` porque é esquecimento **parcial** (só a média; a fração de subpixel e
   * a régua de atraso ficam), e porque é o número que explica um cursor que "deu um pulinho" logo
   * depois de alguém mexer no perfil.
   */
  trocasDeReferencial: number;
  /** Quantas vezes a referência de atraso foi reancorada por descarte prolongado. */
  reancoragens: number;
  /** Soma dos pixels **inteiros** emitidos no eixo horizontal (positivo = direita). */
  pixelsX: number;
  /** Soma dos pixels **inteiros** emitidos no eixo vertical (positivo = **para baixo**). */
  pixelsY: number;
}

/** Contadores zerados. Objeto novo a cada chamada — nunca no caminho quente. */
export function criarContadoresDoPipeline(): ContadoresDoPipeline {
  return {
    amostrasRecebidas: 0,
    amostrasAplicadas: 0,
    amostrasSemMovimento: 0,
    amostrasComGiroDesligado: 0,
    descartadasPorOrdem: 0,
    descartadasPorDt: 0,
    descartadasPorAtraso: 0,
    descartadasPorLeituraInvalida: 0,
    zeradasPorZonaMorta: 0,
    limitadasPorPico: 0,
    retomadas: 0,
    reinicios: 0,
    trocasDeReferencial: 0,
    reancoragens: 0,
    pixelsX: 0,
    pixelsY: 0,
  };
}

/**
 * Os nomes de todos os campos, tirados do próprio construtor.
 *
 * É o que `somarContadoresDoPipeline` percorre, e sai daqui de propósito: campo novo em
 * `criarContadoresDoPipeline` entra na soma sozinho. Uma terceira lista escrita à mão (além da
 * criação e do zerar) seria o lugar em que um contador novo some do total do processo sem erro
 * nenhum de compilação.
 */
const CAMPOS_DOS_CONTADORES_DO_PIPELINE = Object.freeze(
  Object.keys(criarContadoresDoPipeline()) as (keyof ContadoresDoPipeline)[],
);

/**
 * Soma `parcela` em `alvo`, campo a campo, **no mesmo objeto**. Caminho frio: é o fechamento de
 * uma sessão entrando no total do processo (ATI-028), uma vez por sessão.
 */
export function somarContadoresDoPipeline(
  alvo: ContadoresDoPipeline,
  parcela: Readonly<ContadoresDoPipeline>,
): void {
  for (const campo of CAMPOS_DOS_CONTADORES_DO_PIPELINE) alvo[campo] += parcela[campo];
}

/**
 * Zera os contadores **no mesmo objeto** — quem guardou a referência continua lendo os números
 * novos. Trocar o objeto deixaria a telemetria presa no antigo para sempre.
 */
export function zerarContadoresDoPipeline(alvo: ContadoresDoPipeline): void {
  alvo.amostrasRecebidas = 0;
  alvo.amostrasAplicadas = 0;
  alvo.amostrasSemMovimento = 0;
  alvo.amostrasComGiroDesligado = 0;
  alvo.descartadasPorOrdem = 0;
  alvo.descartadasPorDt = 0;
  alvo.descartadasPorAtraso = 0;
  alvo.descartadasPorLeituraInvalida = 0;
  alvo.zeradasPorZonaMorta = 0;
  alvo.limitadasPorPico = 0;
  alvo.retomadas = 0;
  alvo.reinicios = 0;
  alvo.trocasDeReferencial = 0;
  alvo.reancoragens = 0;
  alvo.pixelsX = 0;
  alvo.pixelsY = 0;
}
