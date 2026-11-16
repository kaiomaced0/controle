/**
 * Como o movimento do mouse sai para o sistema — a escolha da ATI-026.
 *
 * ## O problema
 *
 * O Windows aplica a **aceleração de ponteiro** ("Aumentar a precisão do ponteiro") sobre todo
 * movimento **relativo**, inclusive o injetado por `SendInput`. Medido na bancada do projeto
 * (velocidade 11/20, 96 DPI): 40 eventos de +1 px andam ~24 px e um evento de −40 px anda ~59 px. O gesto lento encolhe e o rápido estica —
 * exatamente o contrário do que a mira precisa — e o px/grau do perfil deixa de significar o que
 * promete. A velocidade do ponteiro (o controle de 1 a 20) também multiplica o relativo, com ou sem
 * aceleração: fora do 10, o mesmo perfil anda diferente em dois PCs.
 *
 * ## As três saídas
 *
 * - **`absoluto`** — o servidor lê onde o cursor está (`GetCursorPos`), soma o deslocamento pedido
 *   e posiciona com `SendInput` em coordenada normalizada sobre a área de trabalho virtual inteira.
 *   Coordenada absoluta **não passa pela curva**: o pixel pedido é o pixel que sai, com qualquer
 *   configuração de ponteiro. Como parte da posição atual a cada evento, convive com o mouse físico.
 * - **`relativo`** — o `SendInput` relativo de sempre. **Não pode sumir**: jogo lê *raw input*, que
 *   entrega o deslocamento cru, antes da aceleração — para jogo, o relativo já é o certo, e o
 *   absoluto quebraria a câmera.
 * - **`auto`** (padrão) — absoluto quando o relativo não sai 1:1 nesta máquina (aceleração ligada,
 *   ou velocidade do ponteiro fora do 10); relativo quando sai.
 *
 * Existe ainda o **`compensado`**: relativo com a curva inversa do Windows aplicada antes de mandar
 * (a estratégia que a spec da ATI-026 descreve). Ele só é aceito pela bancada
 * (`ferramentas/provar-aceleracao.mjs`), não pela configuração — o relatório da ATI-026 traz a
 * medição que decidiu isso.
 *
 * **O servidor nunca altera a configuração de mouse do sistema.** Ele lê, avisa e escolhe a saída.
 */

/** O que a configuração aceita em `CONTROLE_SAIDA_MOUSE`. */
export const MODOS_DE_SAIDA_DO_MOUSE = ['auto', 'absoluto', 'relativo'] as const;
export type ModoDeSaidaDoMouse = (typeof MODOS_DE_SAIDA_DO_MOUSE)[number];

/** O que o backend aceita: os modos da configuração e o `compensado`, só de bancada. */
export type PedidoDeSaidaDoMouse = ModoDeSaidaDoMouse | 'compensado';

/** A saída que de fato está valendo, depois de o `auto` ser resolvido. */
export type SaidaEfetivaDoMouse = 'absoluto' | 'relativo' | 'compensado';

/** A aceleração de ponteiro do Windows, como o sistema respondeu na partida. */
export type EstadoDaAceleracao = 'ligada' | 'desligada' | 'desconhecida';

export function ehModoDeSaidaDoMouse(valor: unknown): valor is ModoDeSaidaDoMouse {
  return typeof valor === 'string' && (MODOS_DE_SAIDA_DO_MOUSE as readonly string[]).includes(valor);
}

/**
 * O que o backend diz sobre a própria saída de mouse. Lido na partida (log) e pelo painel — nunca
 * no caminho quente. A configuração de ponteiro é lida **uma vez**, na criação do backend: quem
 * mudar a opção do Windows com o servidor de pé precisa reiniciá-lo para o aviso acompanhar.
 */
export interface DescricaoDaSaidaDoMouse {
  readonly pedido: PedidoDeSaidaDoMouse;
  readonly efetivo: SaidaEfetivaDoMouse;
  readonly aceleracao: EstadoDaAceleracao;
  /** Velocidade do ponteiro, de 1 a 20 (10 é o neutro). `undefined` quando não deu para ler. */
  readonly velocidade: number | undefined;
  /**
   * Se o movimento relativo sai 1:1 nesta máquina — aceleração desligada **e** velocidade 10.
   * `undefined` quando a configuração não pôde ser lida.
   */
  readonly relativoSaiFiel: boolean | undefined;
  /** Por que esta saída — vai inteiro para o log de partida. */
  readonly motivo: string;
}

/**
 * O caminho exato para desligar a aceleração, como o Windows 11 em português o mostra (com o nome em
 * inglês junto, para quem usa o sistema em inglês). O servidor **diz** o caminho; quem desliga é a
 * pessoa — mexer no ajuste de mouse de alguém sem pedir é fora de escopo em qualquer circunstância.
 */
export const COMO_DESLIGAR_A_ACELERACAO =
  'Configurações > Bluetooth e dispositivos > Mouse > Configurações adicionais do mouse > ' +
  'aba "Opções de ponteiro" > desmarque "Aumentar a precisão do ponteiro" ' +
  '(em inglês: "Enhance pointer precision")';

/**
 * A linha de aviso do log de partida, ou `undefined` quando não há o que avisar (o relativo sai
 * 1:1). Uma função só para o `npm run dev` e o `npm run telemetria` dizerem a mesma coisa.
 */
export function avisoDaSaidaDoMouse(descricao: DescricaoDaSaidaDoMouse): string | undefined {
  if (descricao.relativoSaiFiel === true) return undefined;

  let problema: string;
  if (descricao.aceleracao === 'ligada') {
    // Os números são da bancada do projeto, e o texto diz isso: em outro PC (outra velocidade,
    // outra escala) a distorção tem outro tamanho, e o aviso não pode afirmar uma medição que ali
    // não foi feita. Ficam porque dão a ordem de grandeza do efeito.
    problema =
      'a aceleração de ponteiro do Windows está LIGADA: no movimento relativo, gesto lento encolhe ' +
      'e gesto rápido estica (na bancada do projeto, com velocidade 11/20 e 96 DPI, 40 × 1 px ' +
      'andaram ~24 px e 1 × 40 px andou ~59 px; aqui o tamanho depende da velocidade e da escala)';
  } else if (descricao.aceleracao === 'desconhecida') {
    problema = 'não consegui ler a configuração de ponteiro do Windows';
  } else {
    problema =
      `a velocidade do ponteiro do Windows está em ${String(descricao.velocidade)}/20, e não em 10: ` +
      'o movimento relativo sai multiplicado';
  }

  let consequencia: string;
  switch (descricao.efetivo) {
    case 'absoluto':
      consequencia = 'saída do mouse ABSOLUTA — não passa pela curva, o pixel pedido é o que sai';
      break;
    case 'compensado':
      consequencia = 'saída do mouse COMPENSADA (bancada) — curva inversa aplicada antes de mandar';
      break;
    case 'relativo':
      consequencia =
        'saída do mouse RELATIVA, como foi pedido — o cursor da área de trabalho anda distorcido ' +
        '(para jogo que lê raw input não importa; para a área de trabalho use CONTROLE_SAIDA_MOUSE=auto)';
      break;
  }

  const desligar =
    descricao.aceleracao === 'ligada' ? ` Para desligar no Windows: ${COMO_DESLIGAR_A_ACELERACAO}.` : '';
  return `${problema}; ${consequencia}. O servidor não altera a configuração do sistema.${desligar}`;
}

/**
 * Uma linha curta para o painel de telemetria — cabe nas 66 colunas de conteúdo do quadro. O estado
 * da aceleração vem primeiro porque é o aviso, e terminal estreito corta pelo fim.
 */
export function resumirSaidaDoMouse(descricao: DescricaoDaSaidaDoMouse): string {
  const aceleracao =
    descricao.aceleracao === 'ligada'
      ? 'aceleração LIGADA'
      : descricao.aceleracao === 'desligada'
        ? 'aceleração desligada'
        : 'aceleração ilegível';
  const velocidade =
    descricao.velocidade === undefined ? '' : ` · vel. ${String(descricao.velocidade)}/20`;
  const efeito =
    descricao.efetivo === 'absoluto'
      ? 'sem curva'
      : descricao.efetivo === 'compensado'
        ? 'inversa'
        : descricao.relativoSaiFiel === false
          ? 'DISTORCE'
          : '1:1';
  return `${aceleracao}${velocidade} · saída ${descricao.efetivo} (${efeito})`;
}
