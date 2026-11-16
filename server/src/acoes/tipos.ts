/**
 * Vocabulário do mapeador de ações (ATI-010): o que um controle do celular vira no PC.
 *
 * Até aqui o BOTÃO (`0x02`) e o SCROLL (`0x04`) chegavam ao servidor, entravam nos contadores do
 * transporte e **morriam ali** — o `botaoMouse` do backend só era chamado pelo gesto de teste do
 * `--teste-mouse`. Este módulo é a ponte que faltava: pacote do fio → ação → `BackendDeEntrada`.
 *
 * Três regras que valem para o módulo inteiro:
 *
 * 1. **Nada de clique atômico.** O BOTÃO já traz `pressionado`; o mapeador repassa aperto e
 *    soltura como chamadas separadas. É o que faz arrastar existir (selecionar texto, mover
 *    janela) — a mesma regra 1 de `saida/tipos.ts`, um degrau acima.
 * 2. **Tudo que pressiona sabe soltar.** O destino é sempre alguém com `soltarTudo()`, e o
 *    mapeador tem `reiniciar()` para o fim de sessão (CLAUDE.md, regra 5).
 * 3. **Erro vira número, não exceção.** `NaN` e infinito passam crus pelo fio (PROTOCOLO.md,
 *    seção 4.0, regra 7) e chegam aqui: viram contador, nunca `throw` e nunca acumulador
 *    envenenado.
 */

import type { BackendDeEntrada, BotaoDoMouse } from '../saida/tipos.js';

/* ----------------------------------------------------------------------------------- ações */

/**
 * O que um controle faz quando é tocado.
 *
 * É a forma reduzida do campo `acao` do perfil (ARQUITETURA.md, seção 4): os dois tipos que o
 * perfil **Mouse básico** precisa. `tecla`, `gamepad-botao`, `gamepad-eixo`, `interno` e `macro`
 * entram com o schema de perfil (ATI-016) e o mapeador completo (ATI-018) — este é o ponto onde
 * elas se acrescentam, e o `switch` do mapeador é o outro.
 */
export type AcaoDeControle =
  | {
      readonly tipo: 'mouse';
      readonly botao: BotaoDoMouse;
    }
  | {
      /**
       * Roda o scroll um tanto fixo **a cada aperto** — um botão de passo, não um estado.
       *
       * Scroll é impulso: não existe "roda pressionada". Por isso a ação acontece no aperto e a
       * soltura não faz nada, e por isso ela nunca pode deixar estado preso.
       */
      readonly tipo: 'scroll';
      /** Entalhes por aperto. Positivo rola para **cima** (Win32; ver `saida/tipos.ts`). */
      readonly entalhesVertical: number;
      /** Entalhes por aperto no eixo horizontal. Positivo rola para a **direita**. */
      readonly entalhesHorizontal: number;
    };

/**
 * De `idControle` (o `id` declarado no perfil, byte 4 do BOTÃO) para a ação.
 *
 * `Map` e não objeto: a chave é número, a busca é sem alocação e o "não existe" volta como
 * `undefined` em vez de virar `TypeError` no meio do caminho quente.
 */
export type TabelaDeControles = ReadonlyMap<number, AcaoDeControle>;

/* --------------------------------------------------------------------------------- destino */

/**
 * Para onde as ações vão.
 *
 * É de propósito **menor** que `BackendDeEntrada` — mesma decisão do `DestinoDeMovimento`
 * (`movimento/tipos.ts`): o mapeador só aperta botão e roda a roda, e exigir a interface inteira
 * obrigaria todo dublê a implementar cursor e tecla para nada. Um `BackendDeEntrada` atende este
 * contrato sem adaptador, e é assim que `CONTROLE_MOVIMENTO=sistema` liga o clique no `SendInput`.
 */
export interface DestinoDeAcoes {
  /** Identificação curta para log e telemetria: `windows`, `dubla`, `ensaio`. */
  readonly nome: string;
  /** Aperta (`true`) ou solta (`false`). Nunca há clique atômico — ver a regra 1 acima. */
  botaoMouse(botao: BotaoDoMouse, pressionado: boolean): void;
  /** Roda a roda em **entalhes** (um entalhe = `WHEEL_DELTA`). Aceita fração. */
  scroll(deltaVertical: number, deltaHorizontal: number): void;
  /** Quantos botões este destino tem presos neste instante. */
  pressionados(): number;
  /** Solta tudo que este destino apertou. Idempotente (CLAUDE.md, regra 5). */
  soltarTudo(): void;
}

/** Prova, em tempo de compilação, que o backend de saída serve de destino sem adaptador. */
export type BackendServeDeDestinoDeAcoes = BackendDeEntrada extends DestinoDeAcoes ? true : never;

/* ------------------------------------------------------------------------------ resultados */

/**
 * O que aconteceu com um pacote. É **número**, e não string nem objeto: `processar` está no
 * caminho de entrada e não pode alocar por pacote (CLAUDE.md, regra 2).
 */
export const RESULTADO_DE_ACAO = Object.freeze({
  /** Virou ação e foi para o destino. */
  APLICADA: 0,
  /** Não é BOTÃO nem SCROLL: o mapeador não tem nada a ver com este pacote. */
  NAO_E_ACAO: 1,
  /** BOTÃO com `idControle` que a tabela do perfil não conhece. */
  SEM_MAPEAMENTO: 2,
  /**
   * Chegou, foi entendido e não produziu evento: soltura de um controle de impulso (scroll), ou
   * fração de entalhe que ainda não completou o passo mínimo e ficou guardada.
   */
  SEM_EFEITO: 3,
  /** Número não finito no fio (`NaN`, infinito). Recusado antes de encostar no acumulador. */
  INVALIDA: 4,
} as const);

export type ResultadoDeAcao = (typeof RESULTADO_DE_ACAO)[keyof typeof RESULTADO_DE_ACAO];

/* ------------------------------------------------------------------------------ contadores */

/**
 * Diagnóstico do mapeador. Objeto **mutável reaproveitado**, no mesmo padrão do
 * `ContadoresDeSaida` e do `ContadoresDoCodec`: o caminho de entrada só incrementa campo já
 * alocado.
 *
 * Ler estes números é a única forma honesta de responder "o toque virou clique?" com o celular
 * na mão: no meio de um arrastar ninguém lê log, e uma exceção por evento derrubaria o servidor.
 *
 * A mesma forma serve para as duas contas do mapeador (ATI-028): a **da sessão**
 * (`mapeador.contadores`, zerada em `reiniciar()` depois do resumo) e o **total do processo**
 * (`mapeador.totalDoProcesso()`).
 */
export interface ContadoresDasAcoes {
  /**
   * Apertos de botão de mouse **repassados ao destino**.
   *
   * Repassado não é o mesmo que aceito: o destino ainda pode recusar (aperto redundante, ou
   * `SendInput` barrado por uma janela elevada). Quem conta o que o sistema aceitou é o
   * `ContadoresDeSaida` do backend — ler os dois lado a lado é como se descobre que o toque está
   * chegando e o Windows está recusando.
   */
  botoesApertados: number;
  /** Solturas repassadas ao destino. Em sessão saudável fecha com `botoesApertados`. */
  botoesSoltos: number;
  /** BOTÃO cujo `idControle` não está na tabela do perfil ativo. */
  semMapeamento: number;
  /** Pedidos recusados por número não finito — o fio deixa passar `NaN` e infinito. */
  pedidosInvalidos: number;
  /** Pacotes de scroll saturados no teto de entalhes (um por pacote, não por entalhe). */
  pedidosLimitados: number;
  /** Entalhes verticais que chegaram ao destino (soma com sinal; positivo = para cima). */
  entalhesVerticais: number;
  /** Entalhes horizontais que chegaram ao destino (soma com sinal; positivo = direita). */
  entalhesHorizontais: number;
  /** Chamadas de roda que saíram para o destino (uma por pacote que completou o passo mínimo). */
  giradasDeRoda: number;
  /** Entalhes **inteiros** percorridos — é o que dá a sensação de roda física (a detente). */
  detentes: number;
  /** Hápticos mandados de volta ao aparelho (`click` de botão e `tick` de detente). */
  hapticosEnviados: number;
}

/** Contadores zerados. Objeto novo a cada chamada — nunca no caminho de entrada. */
export function criarContadoresDasAcoes(): ContadoresDasAcoes {
  return {
    botoesApertados: 0,
    botoesSoltos: 0,
    semMapeamento: 0,
    pedidosInvalidos: 0,
    pedidosLimitados: 0,
    entalhesVerticais: 0,
    entalhesHorizontais: 0,
    giradasDeRoda: 0,
    detentes: 0,
    hapticosEnviados: 0,
  };
}

/**
 * Os nomes de todos os campos, tirados do próprio construtor: campo novo entra no zerar e na soma
 * sozinho, em vez de sumir do total do processo sem erro de compilação (ATI-028).
 */
const CAMPOS_DOS_CONTADORES_DAS_ACOES = Object.freeze(
  Object.keys(criarContadoresDasAcoes()) as (keyof ContadoresDasAcoes)[],
);

/** Soma `parcela` em `alvo`, no mesmo objeto. Caminho frio: uma vez por sessão. */
export function somarContadoresDasAcoes(
  alvo: ContadoresDasAcoes,
  parcela: Readonly<ContadoresDasAcoes>,
): void {
  for (const campo of CAMPOS_DOS_CONTADORES_DAS_ACOES) alvo[campo] += parcela[campo];
}

/** Zera no mesmo objeto — quem guardou a referência continua lendo os números novos. */
export function zerarContadoresDasAcoes(alvo: ContadoresDasAcoes): void {
  for (const campo of CAMPOS_DOS_CONTADORES_DAS_ACOES) alvo[campo] = 0;
}

/**
 * Uma linha com o que os contadores dizem — a mesma forma para o resumo da sessão e para o total
 * do processo, que só diferem em **qual** conta é lida. Aloca: nunca por pacote.
 */
export function resumirContadoresDasAcoes(contadores: Readonly<ContadoresDasAcoes>): string {
  return (
    `apertos=${contadores.botoesApertados} solturas=${contadores.botoesSoltos} ` +
    `semMapeamento=${contadores.semMapeamento} ` +
    `entalhes=${contadores.entalhesVerticais.toFixed(2)}/` +
    `${contadores.entalhesHorizontais.toFixed(2)} ` +
    `giradas=${contadores.giradasDeRoda} detentes=${contadores.detentes}`
  );
}
