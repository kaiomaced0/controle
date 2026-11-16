/**
 * Recalibração automática do bias — o que mantém o cursor parado **depois de uma hora**.
 *
 * O bias de um giroscópio MEMS não é constante: ele anda com a temperatura do aparelho. A pessoa
 * calibra com o celular frio, joga vinte minutos, o aparelho esquenta e o bias sai do lugar — o
 * cursor volta a caminhar sozinho e a única saída seria calibrar de novo, no meio do uso. É essa a
 * diferença entre um controle que funciona bem no primeiro minuto e um que continua bom depois de
 * uma hora (ATI-009, seção "Notas").
 *
 * ## A regra, em quatro linhas
 *
 * 1. Enquanto a leitura ficar **perto da estimativa atual**, o aparelho está parado.
 * 2. Depois de {@link ESPERA_ATE_AJUSTAR_MS} parado sem interrupção, a estimativa passa a seguir a
 *    leitura por média exponencial **lenta** ({@link CONSTANTE_DE_TEMPO_MS}).
 * 3. Qualquer amostra fora do limiar zera o cronômetro: enquanto a pessoa está mirando, ninguém
 *    mexe no bias.
 * 4. E se a estimativa estiver **longe da leitura de verdade**, uma leitura sustentada que passe
 *    pelos três portões do replantio replanta a estimativa — ver "O impasse" abaixo.
 *
 * **Lento é o ponto.** Um salto no bias é indistinguível de um empurrão no cursor; a média
 * exponencial com constante de tempo de dezenas de segundos corrige a deriva térmica (que leva
 * minutos) sem produzir movimento perceptível. O peso de cada amostra é `dt / constante`, e não um
 * número fixo: assim o mesmo ajuste vale a 60 Hz no navegador e a 100 Hz no app nativo.
 *
 * ## O impasse que o replantio resolve (rodada 2 da ATI-009)
 *
 * As regras 1 a 3 sozinhas se mordem: "parado" é medido pela distância até a estimativa, e a
 * estimativa só anda **dentro** da janela, que só abre depois de 3 s de "parado". Uma estimativa
 * plantada a mais de um limiar da leitura real fecha o laço — toda amostra interrompe, o cronômetro
 * volta a zero para sempre, a janela nunca abre e o mecanismo morre calado. Dois caminhos comuns
 * levavam a isso:
 *
 * - o aparelho esquentou **entre** sessões e voltou com o bias guardado defasado (que é justamente
 *   a deriva térmica que esta peça existe para corrigir);
 * - sem bias guardado, a primeira amostra da sessão era a semente — e a primeira amostra logo
 *   depois de tocar em "ligar" carrega o toque do dedo.
 *
 * A saída é não deixar a estimativa ser a única testemunha. Quando a leitura está longe dela, as
 * amostras passam a ser comparadas **umas com as outras**: uma leitura que se sustenta coerente
 * consigo mesma é a melhor estimativa que existe naquele momento, e passa a ser a estimativa.
 *
 * ## O portão do replantio (rodada 3 da ATI-009)
 *
 * Aqui mora o risco desta peça inteira, e por isso o portão é o trecho mais defendido do arquivo:
 * **um gesto lento e constante não pode virar bias.** Se virar, o cursor congela no meio do gesto
 * e sai andando sozinho assim que a mão para — o oposto exato do que a ATI-009 promete.
 *
 * A diferença entre este caminho e o `calibrar-fim` é que lá **uma pessoa afirma** que o aparelho
 * está parado (ela apoiou o aparelho e mandou calibrar); aqui não existe afirmação nenhuma. Sem
 * testemunha humana, os números precisam ser mais duros — e nenhum deles pode ser importado de lá.
 * São três portões, e a leitura precisa passar pelos três:
 *
 * 1. **Coerência, medida pelo ruído do sensor** ({@link COERENCIA_DA_SUSTENTADA_GRAUS_POR_S}). A
 *    pergunta é "esta série é ruído em torno de um patamar?", e ruído de giroscópio parado é da
 *    ordem de 0,05–0,1 °/s. Qualquer amostra que se afaste mais que isso da média da sequência
 *    recomeça a contagem: mão segurando aparelho enquanto mira treme muito mais.
 * 2. **Teto de módulo próprio** ({@link MODULO_MAXIMO_DO_REPLANTIO_GRAUS_POR_S}). Bias de
 *    giroscópio de celular vive em fração de °/s; acima do teto a leitura simplesmente não é
 *    candidata a bias, por mais coerente que seja. Quem tem sensor pior que isso ainda pode
 *    calibrar na mão — lá existe a pessoa afirmando que o aparelho está parado.
 * 3. **Prova de ângulo** ({@link ANGULO_DE_PROVA_GRAUS}), cobrada só acima da faixa em que a
 *    leitura ainda é bias plausível ({@link MODULO_DE_BIAS_PLAUSIVEL_GRAUS_POR_S}). Uma leitura de
 *    módulo `M` sustentada por `T` afirma que o aparelho girou `M × T` graus a taxa constante.
 *    Bias não gira nada — ele se sustenta para sempre —, então quanto maior o módulo, mais tempo é
 *    exigido, porque mais absurda fica a rotação equivalente. Na prática: 3 °/s precisam de 20 s
 *    seguidos (60° de giro a taxa constante, dentro do ruído do sensor); 0,4 °/s passam com o
 *    tempo base, porque nessa faixa a leitura é indistinguível de bias — e o estrago também é.
 *
 * O replantio **não** mexe no bias: ele só recoloca a estimativa perto da realidade e zera o
 * cronômetro. Dali até a primeira aplicação ainda são 3 s de leitura dentro do limiar da estimativa
 * recém-plantada — o que é **continuidade da mesma leitura**, e não uma segunda prova de aparelho
 * parado: uma rotação constante também é contínua. Quem separa bias de gesto são os três portões
 * acima; os 3 s existem para que nenhuma correção chegue ao cursor de supetão.
 *
 * ## O aviso de bias alto (ATI-029)
 *
 * O portão 3 tem um preço, e ele é pago por quem tem sensor ruim: com bias real de 2 °/s e o
 * aparelho parado, a prova de ângulo cobra 60° ÷ 2 °/s = 30 s de leitura sustentada antes do
 * replantio, e o cursor anda sozinho esse tempo todo. O `sincronizar` manual resolve na hora — mas
 * só para quem sabe que o problema é o sensor. Sem explicação na tela, a conclusão é "o programa
 * está quebrado".
 *
 * Por isso a leitura que os portões **seguram** vira aviso: uma leitura sustentada (coerente e com
 * o tempo base cumprido) acima da faixa de bias plausível acende o aviso, com o módulo medido. São
 * os mesmos dois ramos em que os portões 2 e 3 já decidem — o aviso só olha para a decisão, não
 * muda nenhuma. Acima do teto do `calibrar-fim` (15 °/s) não há aviso: ali a leitura é giro, e o
 * próprio `sincronizar` a recusaria, então mandar a pessoa sincronizar seria instrução que não
 * resolve.
 *
 * O aviso **apaga** quando o problema deixa de existir para o cursor:
 *
 * - na primeira aplicação de bias depois dele — a estimativa passou a cobrir a leitura (o bias
 *   voltou à faixa, ou a prova de ângulo replantou e os 3 s de continuidade passaram), e o cursor
 *   parou de andar sozinho;
 * - em `semear` (o `sincronizar` concluído, ou o bias guardado do aparelho que conectou);
 * - em `esquecer` (fim de sessão).
 *
 * O aparelho **se mexendo** não apaga: movimento não diz nada sobre o bias, e o aviso que some
 * quando a pessoa pega o celular para tocar em "sincronizar" sumiria justamente na hora de ser lido.
 *
 * Acender e apagar não são caminho quente: acender acontece uma vez por sequência sustentada (no
 * máximo uma vez a cada {@link TEMPO_DE_LEITURA_SUSTENTADA_MS}), apagar só junto de uma aplicação
 * ou de um comando. É a mesma natureza do `aoReplantar`.
 *
 * ## Por que a estimativa é do sinal **cru**
 *
 * Este módulo não desconta bias nenhum antes de olhar: com o aparelho parado, a média lenta da
 * leitura crua **é** o bias, e o que decide "parado" é a distância entre a leitura e essa média —
 * que independe de qual bias o pipeline está aplicando agora. É o que permite testá-lo sozinho,
 * sem pipeline, e o que evita o laço em que o bias aplicado influencia a decisão de mexer no bias.
 *
 * ⚠️ `observar` é **caminho quente** (100 Hz): estado em `Float64Array`, zero alocação, zero log.
 * Quem aloca é `aplicar`, e por isso ele é chamado a cada {@link INTERVALO_DE_APLICACAO_MS} — duas
 * vezes por segundo, no máximo — e nunca por amostra. `aoReplantar` tem a mesma natureza: ele só
 * pode acontecer depois de 2 s de leitura sustentada, ou seja, no máximo uma vez a cada 2 s.
 */

import { TIPO_MOVIMENTO, type PacoteDecodificado } from '../protocolo/indice.js';
import { LIMITES_DA_CALIBRACAO } from './calibracao.js';
import { GRAUS_POR_RADIANO, RADIANOS_POR_GRAU } from './tipos.js';

/**
 * Distância entre a leitura e a estimativa que ainda conta como "parado", em °/s.
 *
 * Acima da zona morta de fábrica (0,35 °/s) de propósito: a zona morta decide o que **não vira
 * movimento**; aqui decide-se o que **não é gesto**. Um aparelho apoiado na mesa fica muito abaixo
 * de 1,5 °/s; um aparelho na mão parada, com tremor, também. Qualquer intenção de mirar passa
 * disso em uma amostra.
 */
export const LIMIAR_DE_PARADO_GRAUS_POR_S = 1.5;

/** Tempo parado, sem interrupção, antes de o ajuste começar (ATI-009: "mais de 3 s"). */
export const ESPERA_ATE_AJUSTAR_MS = 3000;

/**
 * Tempo **base** de uma leitura sustentada: o mínimo, que vale para toda leitura.
 *
 * 2 s bastam para a faixa em que a leitura é bias plausível; acima dela quem manda é a prova de
 * ângulo, que cobra mais tempo quanto maior for o módulo. É também o mesmo tempo que a página de
 * diagnóstico pede para a coleta da calibração manual — o "segure parado" que a pessoa já conhece.
 */
export const TEMPO_DE_LEITURA_SUSTENTADA_MS = 2000;

/**
 * Portão 1 — quanto uma amostra pode se afastar da média da própria sequência, em °/s.
 *
 * Este número mede **ruído de sensor**, não gesto, e por isso ele foi medido no único sensor de
 * verdade que este projeto tem gravado: os 60 s de aparelho parado de `parado-60s.captura`
 * (ATI-023) têm desvio padrão de 0,050 °/s por eixo e **maior desvio da média de 0,209 °/s** em
 * 6001 amostras. 0,4 °/s é o dobro do pior caso medido — e a `medir-calibracao.mjs` replica essa
 * captura pelo módulo para provar que a sequência atravessa os 60 s sem quebrar nenhuma vez.
 *
 * Não é o {@link LIMIAR_DE_PARADO_GRAUS_POR_S}, e a diferença é o conserto da rodada 3: 1,5 °/s
 * responde "isto é gesto?" contra um bias já conhecido; aqui a pergunta é "esta série é ruído em
 * torno de um patamar?", e respondê-la com o limiar de gesto não separava aparelho parado de
 * aparelho girando devagar.
 */
export const COERENCIA_DA_SUSTENTADA_GRAUS_POR_S = 0.4;

/**
 * Portão 2 — teto de módulo, em °/s, para uma leitura sustentada poder virar estimativa.
 *
 * É **próprio do caminho automático** e bem abaixo dos 15 °/s do `calibrar-fim` de propósito: lá
 * uma pessoa afirma que o aparelho está parado (apoiou e mandou calibrar), aqui não existe
 * afirmação nenhuma. Um giroscópio de celular parado acusa 0,1 a 1 °/s (ARQUITETURA.md, seção 3);
 * 5 °/s é generoso com um sensor ruim e, ainda assim, recusa de longe a mira lenta que a rodada 2
 * deixava passar (a 35 px/grau de fábrica, 5 °/s já são 175 px/s de cursor).
 *
 * Sensor pior que isto não fica sem saída: a calibração manual continua aceitando até 15 °/s,
 * porque lá existe a testemunha que aqui não existe.
 */
export const MODULO_MAXIMO_DO_REPLANTIO_GRAUS_POR_S = 5;

/**
 * Portão 3 — até onde uma leitura ainda é **bias plausível**, em °/s, e o tempo base basta.
 *
 * Acima daqui a leitura precisa da prova de ângulo. Um giroscópio de celular parado acusa 0,1 a
 * 1 °/s (ARQUITETURA.md, seção 3); 1,5 °/s cobre um sensor ruim com margem. Nessa faixa a leitura
 * é indistinguível de bias por qualquer critério — e o estrago de errar também é pequeno: 1,5 °/s
 * mal passam da zona morta de fábrica (0,35 °/s) e valem ~52 px/s de cursor, corrigidos pelo
 * próprio mecanismo poucos segundos depois.
 *
 * O número coincide com {@link LIMIAR_DE_PARADO_GRAUS_POR_S} por acaso, não por construção: um é
 * "isto ainda pode ser bias?", o outro é "isto é gesto?".
 */
export const MODULO_DE_BIAS_PLAUSIVEL_GRAUS_POR_S = 1.5;

/**
 * Portão 3 — o ângulo que a rotação equivalente precisa acumular antes de a leitura virar bias.
 *
 * Uma leitura de módulo `M` sustentada por `T` afirma que o aparelho girou `M × T` graus **a taxa
 * constante, dentro do ruído do sensor**. Bias não gira nada: ele pode se sustentar para sempre.
 * Exigir 60° é exigir que a explicação alternativa (rotação de verdade) já tivesse acabado — 60°
 * a taxa perfeitamente constante é um terço da faixa útil do punho, e ninguém mira assim.
 *
 * O tempo exigido sai da conta `T ≥ ângulo / M`: 20 s a 3 °/s, 15 s a 4 °/s, 12 s no teto de
 * 5 °/s. Abaixo de {@link MODULO_DE_BIAS_PLAUSIVEL_GRAUS_POR_S} a prova não é cobrada, senão a
 * primeira estimativa de um aparelho com bias de 0,4 °/s levaria dois minutos e meio para nascer.
 */
export const ANGULO_DE_PROVA_GRAUS = 60;

/**
 * Constante de tempo do ajuste: em ~20 s parado a estimativa cobre 63 % da diferença.
 *
 * A deriva térmica de um giroscópio de celular acontece em minutos; 20 s é rápido o bastante para
 * acompanhá-la e lento o bastante para que a correção nunca apareça como movimento.
 */
export const CONSTANTE_DE_TEMPO_MS = 20_000;

/** De quanto em quanto tempo parado a estimativa é entregue a quem aplica (o pipeline). */
export const INTERVALO_DE_APLICACAO_MS = 500;

/** Maior `dtMs` que conta como intervalo; acima disso é engasgo e não mede tempo parado. */
const DT_MAXIMO_MS = 1000;

/**
 * O nome do comando que resolve o bias alto, **como a pessoa o vê**: é o botão da página
 * `/diagnostico` e o nome que a ARQUITETURA.md (seção 3.2) dá ao par `calibrar-inicio`/`calibrar-fim`.
 * O nome do fio não serve aqui — ninguém com o celular na mão sabe o que é `calibrar-fim`.
 */
export const COMANDO_QUE_RESOLVE_BIAS_ALTO = 'sincronizar';

/**
 * A linha do aviso de bias alto (ATI-029), **uma só** para o painel e para a página: as duas telas
 * dizerem a mesma coisa com palavras diferentes faria quem olha as duas desconfiar de uma.
 *
 * Vírgula decimal porque é texto para pessoa ler, em PT-BR. Não é caminho quente: sai uma vez por
 * acendimento do aviso e uma vez por quadro do painel.
 */
export function textoDoAvisoDeBiasAlto(grausPorS: number): string {
  const valor = Number.isFinite(grausPorS) ? grausPorS.toFixed(1).replace('.', ',') : '?';
  return `bias alto detectado (${valor} °/s) — use ${COMANDO_QUE_RESOLVE_BIAS_ALTO}`;
}

/** Diagnóstico do ajuste automático. Objeto mutável reaproveitado. */
export interface ContadoresDaRecalibracao {
  /** Amostras que passaram pelo módulo com ele ligado. */
  amostrasObservadas: number;
  /** Amostras que interromperam a contagem por estarem fora do limiar (o aparelho se mexeu). */
  interrupcoes: number;
  /** Quantas vezes a contagem chegou aos 3 s e o ajuste começou a valer. */
  janelasDeAjuste: number;
  /** Quantas vezes o bias ajustado foi entregue a quem aplica. */
  aplicacoes: number;
  /**
   * Quantas vezes a estimativa foi plantada a partir de uma leitura sustentada.
   *
   * É o contador do impasse: uma sessão inteira com `interrupcoes` subindo, `janelasDeAjuste` em
   * zero e `replantios` em zero é uma recalibração que não está recalibrando nada.
   */
  replantios: number;
  /** Leituras sustentadas recusadas por módulo grande demais para ser bias (giro constante). */
  replantiosRecusados: number;
  /**
   * Sequências que fecharam o tempo base e ficaram esperando a prova de ângulo (portão 3).
   *
   * Uma por sequência, e não uma por amostra. É o contador que distingue "o gesto foi barrado no
   * portão certo" de "o aparelho nunca conseguiu sustentar leitura nenhuma".
   */
  replantiosAdiados: number;
  /**
   * Quantas vezes o aviso de bias alto **acendeu** (ATI-029) — a passagem de apagado para aceso,
   * e não cada confirmação de um aviso que já estava na tela.
   */
  avisosDeBiasAlto: number;
  /** Amostras ignoradas por `dtMs` imprestável (não dá para medir tempo parado com elas). */
  semDt: number;
  /** Amostras ignoradas por leitura não finita. */
  naoFinitas: number;
}

export function criarContadoresDaRecalibracao(): ContadoresDaRecalibracao {
  return {
    amostrasObservadas: 0,
    interrupcoes: 0,
    janelasDeAjuste: 0,
    aplicacoes: 0,
    replantios: 0,
    replantiosRecusados: 0,
    replantiosAdiados: 0,
    avisosDeBiasAlto: 0,
    semDt: 0,
    naoFinitas: 0,
  };
}

export interface AjusteAutomaticoDeBias {
  /** Se o ajuste está ligado (configuração `recalibracao`). Desligado, `observar` sai na hora. */
  readonly ativo: boolean;
  readonly contadores: ContadoresDaRecalibracao;
  /** Há quanto tempo o aparelho está parado, em ms do relógio do próprio aparelho. */
  readonly paradoMs: number;
  /** Há quanto tempo a leitura atual se sustenta coerente consigo mesma, em ms. */
  readonly sustentadaMs: number;
  /** Se já existe estimativa (leitura sustentada, ou `semear`). */
  readonly temEstimativa: boolean;
  /**
   * Módulo, em °/s, da leitura sustentada que acendeu o aviso de bias alto (ATI-029); `undefined`
   * com o aviso apagado. Calcula na leitura — é para o painel, não para o caminho quente.
   */
  readonly biasAltoGrausPorS: number | undefined;
  /** Estimativa atual do bias, em rad/s. Aloca — não chame por amostra. */
  estimativa(): { readonly gx: number; readonly gy: number; readonly gz: number };

  /** ⚠️ Caminho quente. Uma amostra crua. */
  observar(pacote: PacoteDecodificado): void;
  /**
   * Planta a estimativa com um bias conhecido — a calibração manual que acabou de sair, ou o bias
   * guardado do aparelho que acabou de conectar. Sem isto, o módulo levaria os primeiros segundos
   * da sessão para descobrir sozinho onde a leitura está.
   */
  semear(gx: number, gy: number, gz: number): void;
  /** Zera o cronômetro de parado sem mexer na estimativa (retomada, pausa). */
  reiniciar(): void;
  /** Esquece tudo, inclusive a estimativa (fim de sessão: o próximo aparelho é outro sensor). */
  esquecer(): void;
}

export interface OpcoesDaRecalibracao {
  /** `false` desliga o módulo inteiro (configuração `recalibracao`). O padrão é ligado. */
  readonly ativo?: boolean | undefined;
  /**
   * Onde a estimativa é entregue — na produção, `pipeline.definirBias`.
   *
   * Chamado no máximo a cada {@link INTERVALO_DE_APLICACAO_MS} de aparelho parado, nunca por
   * amostra: `definirBias` monta um objeto de ajustes congelado, e isso é alocação.
   */
  readonly aplicar?: ((gx: number, gy: number, gz: number) => void) | undefined;
  /**
   * Avisado quando a estimativa é replantada a partir de uma leitura sustentada — na produção, uma
   * linha de log. Acontece no máximo uma vez a cada {@link TEMPO_DE_LEITURA_SUSTENTADA_MS}, e é o
   * que torna visível a saída de um impasse que antes era silenciosa.
   *
   * `tinhaEstimativa` separa os dois casos: `false` é a primeira estimativa da sessão (aparelho sem
   * bias guardado), `true` é a estimativa antiga que não servia mais.
   */
  readonly aoReplantar?:
    | ((gx: number, gy: number, gz: number, tinhaEstimativa: boolean) => void)
    | undefined;
  /**
   * Avisado quando o aviso de bias alto muda (ATI-029) — na produção, o quadro `aviso` para o
   * aparelho e uma linha de log. `grausPorS` é o módulo da leitura sustentada; `undefined` quer
   * dizer "apagou".
   *
   * Chamado ao acender, a cada sequência sustentada nova que **confirma** um aviso aceso (o número
   * pode ter mudado) e ao apagar. Nunca por amostra: acender exige o tempo base de leitura
   * sustentada, então acontece no máximo uma vez a cada {@link TEMPO_DE_LEITURA_SUSTENTADA_MS}.
   */
  readonly aoMudarAvisoDeBiasAlto?: ((grausPorS: number | undefined) => void) | undefined;
  readonly limiarGrausPorS?: number | undefined;
  readonly esperaAteAjustarMs?: number | undefined;
  readonly tempoDeLeituraSustentadaMs?: number | undefined;
  /** Portão 1 do replantio. O padrão é {@link COERENCIA_DA_SUSTENTADA_GRAUS_POR_S}. */
  readonly coerenciaDaSustentadaGrausPorS?: number | undefined;
  /** Portão 2 do replantio. O padrão é {@link MODULO_MAXIMO_DO_REPLANTIO_GRAUS_POR_S}. */
  readonly moduloMaximoDoReplantioGrausPorS?: number | undefined;
  /** Portão 3 do replantio. O padrão é {@link MODULO_DE_BIAS_PLAUSIVEL_GRAUS_POR_S}. */
  readonly moduloDeBiasPlausivelGrausPorS?: number | undefined;
  /** Portão 3 do replantio. O padrão é {@link ANGULO_DE_PROVA_GRAUS}. */
  readonly anguloDeProvaGraus?: number | undefined;
  readonly constanteDeTempoMs?: number | undefined;
  readonly intervaloDeAplicacaoMs?: number | undefined;
}

export function criarAjusteAutomaticoDeBias(
  opcoes: OpcoesDaRecalibracao = {},
): AjusteAutomaticoDeBias {
  const ativo = opcoes.ativo ?? true;
  const aplicar = opcoes.aplicar;
  const aoReplantar = opcoes.aoReplantar;
  const aoMudarAvisoDeBiasAlto = opcoes.aoMudarAvisoDeBiasAlto;
  const limiarRadPorS = (opcoes.limiarGrausPorS ?? LIMIAR_DE_PARADO_GRAUS_POR_S) * RADIANOS_POR_GRAU;
  const esperaAteAjustarMs = opcoes.esperaAteAjustarMs ?? ESPERA_ATE_AJUSTAR_MS;
  const tempoSustentadoMs =
    opcoes.tempoDeLeituraSustentadaMs ?? TEMPO_DE_LEITURA_SUSTENTADA_MS;
  const coerenciaRadPorS =
    (opcoes.coerenciaDaSustentadaGrausPorS ?? COERENCIA_DA_SUSTENTADA_GRAUS_POR_S) *
    RADIANOS_POR_GRAU;
  const moduloMaximoRadPorS =
    (opcoes.moduloMaximoDoReplantioGrausPorS ?? MODULO_MAXIMO_DO_REPLANTIO_GRAUS_POR_S) *
    RADIANOS_POR_GRAU;
  const biasPlausivelRadPorS =
    (opcoes.moduloDeBiasPlausivelGrausPorS ?? MODULO_DE_BIAS_PLAUSIVEL_GRAUS_POR_S) *
    RADIANOS_POR_GRAU;
  const anguloDeProvaRad = (opcoes.anguloDeProvaGraus ?? ANGULO_DE_PROVA_GRAUS) * RADIANOS_POR_GRAU;
  // Comparar quadrados poupa uma raiz por amostra no caminho quente: o módulo só aparece na conta
  // ao quadrado, e o ângulo equivalente é `módulo × segundos`, que também é comparável ao quadrado.
  const moduloMaximoQuadrado = moduloMaximoRadPorS * moduloMaximoRadPorS;
  const biasPlausivelQuadrado = biasPlausivelRadPorS * biasPlausivelRadPorS;
  const anguloDeProvaQuadrado = anguloDeProvaRad * anguloDeProvaRad;
  // Teto do aviso de bias alto: o do `calibrar-fim`. Acima dele o `sincronizar` recusaria a
  // leitura, e o aviso estaria mandando fazer o que não resolve (ver o topo do arquivo).
  const tetoDoAvisoRadPorS = LIMITES_DA_CALIBRACAO.moduloMaximoGrausPorS * RADIANOS_POR_GRAU;
  const tetoDoAvisoQuadrado = tetoDoAvisoRadPorS * tetoDoAvisoRadPorS;
  const constanteDeTempoMs = Math.max(1, opcoes.constanteDeTempoMs ?? CONSTANTE_DE_TEMPO_MS);
  const intervaloDeAplicacaoMs = opcoes.intervaloDeAplicacaoMs ?? INTERVALO_DE_APLICACAO_MS;

  const contadores = criarContadoresDaRecalibracao();

  // Mesmo motivo de `pipeline.ts`: número quebrado em variável de closure vira caixa no heap a
  // cada escrita, e aqui há cinco escritas por amostra parada.
  const GX = 0;
  const GY = 1;
  const GZ = 2;
  const PARADO_MS = 3;
  const DESDE_APLICACAO_MS = 4;
  // A leitura sustentada — a testemunha independente da estimativa (ver "O impasse", no topo).
  const SUSTENTADA_GX = 5;
  const SUSTENTADA_GY = 6;
  const SUSTENTADA_GZ = 7;
  const SUSTENTADA_MS = 8;
  const SUSTENTADA_N = 9;
  // 1 depois que esta sequência já foi contada como adiada pela prova de ângulo (contador de
  // sequência, não de amostra).
  const SUSTENTADA_ADIADA = 10;
  // O módulo **ao quadrado** (rad/s) da leitura que acendeu o aviso de bias alto; 0 = apagado.
  // Ao quadrado pelo mesmo motivo dos portões: a raiz só é tirada quando alguém lê o número.
  const BIAS_ALTO_QUADRADO = 11;
  const estado = new Float64Array(12);
  let temEstimativa = false;
  let dentroDaJanela = false;

  /** Apaga a sequência coerente em curso: a estimativa voltou a servir, ou acabou de mudar. */
  function esquecerSustentada(): void {
    estado[SUSTENTADA_MS] = 0;
    estado[SUSTENTADA_N] = 0;
    estado[SUSTENTADA_ADIADA] = 0;
  }

  /**
   * Acende o aviso de bias alto — ou o confirma com o número da sequência nova (ATI-029).
   *
   * Chamada só dos dois ramos em que um portão **segura** uma leitura sustentada, e uma vez por
   * sequência: nunca por amostra. Não decide nada sobre o replantio; só registra a decisão que o
   * portão já tomou.
   */
  function acenderAvisoDeBiasAlto(moduloQuadrado: number): void {
    if (moduloQuadrado > tetoDoAvisoQuadrado) return;
    if ((estado[BIAS_ALTO_QUADRADO] ?? 0) === 0) contadores.avisosDeBiasAlto += 1;
    estado[BIAS_ALTO_QUADRADO] = moduloQuadrado;
    aoMudarAvisoDeBiasAlto?.(Math.sqrt(moduloQuadrado) * GRAUS_POR_RADIANO);
  }

  /** Apaga o aviso, se ele estiver aceso. Junto de uma aplicação ou de um comando, nunca por amostra. */
  function apagarAvisoDeBiasAlto(): void {
    if ((estado[BIAS_ALTO_QUADRADO] ?? 0) === 0) return;
    estado[BIAS_ALTO_QUADRADO] = 0;
    aoMudarAvisoDeBiasAlto?.(undefined);
  }

  /**
   * ⚠️ CAMINHO QUENTE — 100 Hz. Sem alocação, sem log, sem exceção.
   *
   * Só é chamada quando a estimativa não serve (não existe, ou a leitura está longe dela). Enquanto
   * o aparelho estiver parado de verdade, este caminho nem é tocado.
   */
  function acompanharSustentada(gx: number, gy: number, gz: number, dtMs: number): void {
    let amostras = estado[SUSTENTADA_N] ?? 0;
    if (amostras > 0) {
      const mediaGx = estado[SUSTENTADA_GX] ?? 0;
      const mediaGy = estado[SUSTENTADA_GY] ?? 0;
      const mediaGz = estado[SUSTENTADA_GZ] ?? 0;
      const desvioGx = gx < mediaGx ? mediaGx - gx : gx - mediaGx;
      const desvioGy = gy < mediaGy ? mediaGy - gy : gy - mediaGy;
      const desvioGz = gz < mediaGz ? mediaGz - gz : gz - mediaGz;
      // Portão 1: a banda é o **ruído do sensor**, e não o limiar de gesto. Ver o topo do arquivo.
      if (
        desvioGx > coerenciaRadPorS ||
        desvioGy > coerenciaRadPorS ||
        desvioGz > coerenciaRadPorS
      ) {
        amostras = 0;
      }
    }

    if (amostras === 0) {
      // A leitura mudou: a sequência recomeça **nesta** amostra, e não do zero absoluto.
      estado[SUSTENTADA_GX] = gx;
      estado[SUSTENTADA_GY] = gy;
      estado[SUSTENTADA_GZ] = gz;
      estado[SUSTENTADA_MS] = 0;
      estado[SUSTENTADA_N] = 1;
      estado[SUSTENTADA_ADIADA] = 0;
      return;
    }

    amostras += 1;
    estado[SUSTENTADA_N] = amostras;
    // Média corrida (sem guardar as amostras): `m += (x - m) / n`.
    const peso = 1 / amostras;
    const mediaGx = (estado[SUSTENTADA_GX] ?? 0) + peso * (gx - (estado[SUSTENTADA_GX] ?? 0));
    const mediaGy = (estado[SUSTENTADA_GY] ?? 0) + peso * (gy - (estado[SUSTENTADA_GY] ?? 0));
    const mediaGz = (estado[SUSTENTADA_GZ] ?? 0) + peso * (gz - (estado[SUSTENTADA_GZ] ?? 0));
    estado[SUSTENTADA_GX] = mediaGx;
    estado[SUSTENTADA_GY] = mediaGy;
    estado[SUSTENTADA_GZ] = mediaGz;

    const sustentadaMs = (estado[SUSTENTADA_MS] ?? 0) + dtMs;
    estado[SUSTENTADA_MS] = sustentadaMs;
    if (sustentadaMs < tempoSustentadoMs) return;

    // Portão 2: rotação constante é coerente consigo mesma, e sem teto de módulo segurar o
    // aparelho girando plantaria o giro como bias. O teto é o do caminho automático (5 °/s), que
    // não tem a pessoa afirmando "está parado" que o `calibrar-fim` tem.
    const moduloQuadrado = mediaGx * mediaGx + mediaGy * mediaGy + mediaGz * mediaGz;
    if (moduloQuadrado > moduloMaximoQuadrado) {
      contadores.replantiosRecusados += 1;
      // ATI-029: a recusa continua igual; o aviso só conta para a pessoa que a leitura existe. É a
      // faixa em que o automático nunca resolve — sem o `sincronizar`, o cursor anda para sempre.
      acenderAvisoDeBiasAlto(moduloQuadrado);
      esquecerSustentada();
      return;
    }

    // Portão 3: acima da faixa de bias plausível, a leitura ainda precisa provar que a rotação
    // equivalente (módulo × tempo) já passou de {@link ANGULO_DE_PROVA_GRAUS}. É o que separa
    // "bias de giroscópio parado" de "gesto lento e constante", que passa pelos dois primeiros.
    if (moduloQuadrado > biasPlausivelQuadrado) {
      const segundos = sustentadaMs / 1000;
      if (moduloQuadrado * segundos * segundos < anguloDeProvaQuadrado) {
        if ((estado[SUSTENTADA_ADIADA] ?? 0) === 0) {
          estado[SUSTENTADA_ADIADA] = 1;
          contadores.replantiosAdiados += 1;
          // ATI-029: a espera da prova de ângulo é o tempo em que o cursor anda sozinho (30 s com
          // 2 °/s). O adiamento continua igual; o aviso diz à pessoa o que resolve na hora.
          acenderAvisoDeBiasAlto(moduloQuadrado);
        }
        return;
      }
    }

    const tinhaEstimativa = temEstimativa;
    estado[GX] = mediaGx;
    estado[GY] = mediaGy;
    estado[GZ] = mediaGz;
    // O replantio **não** mexe no bias: ele só recoloca a estimativa perto da realidade. Daqui até
    // a primeira aplicação ainda são 3 s de leitura dentro do limiar da estimativa recém-plantada
    // — continuidade da mesma leitura, para nenhuma correção chegar ao cursor de supetão. A prova
    // de que isto é bias, e não gesto, já foi dada pelos três portões acima.
    estado[PARADO_MS] = 0;
    estado[DESDE_APLICACAO_MS] = 0;
    esquecerSustentada();
    temEstimativa = true;
    dentroDaJanela = false;
    contadores.replantios += 1;
    aoReplantar?.(mediaGx, mediaGy, mediaGz, tinhaEstimativa);
  }

  /** ⚠️ CAMINHO QUENTE — 100 Hz. Sem alocação, sem log, sem exceção. */
  function observar(pacote: PacoteDecodificado): void {
    if (!ativo) return;
    if (pacote.tipo !== TIPO_MOVIMENTO) return;

    const gx = pacote.gx;
    const gy = pacote.gy;
    const gz = pacote.gz;
    if (!Number.isFinite(gx) || !Number.isFinite(gy) || !Number.isFinite(gz)) {
      contadores.naoFinitas += 1;
      return;
    }

    contadores.amostrasObservadas += 1;

    // O tempo é medido pelo `dtMs` do **aparelho**, como todo o resto da cadeia: o relógio do PC
    // embutiria o jitter da rede numa conta que decide mexer no bias. Sem `dt` não dá para medir
    // nem tempo parado nem leitura sustentada, e a amostra não serve para nada aqui.
    const dtMs = pacote.dtMs;
    if (!(dtMs > 0) || dtMs > DT_MAXIMO_MS) {
      contadores.semDt += 1;
      return;
    }

    if (temEstimativa) {
      const estimadoGx = estado[GX] ?? 0;
      const estimadoGy = estado[GY] ?? 0;
      const estimadoGz = estado[GZ] ?? 0;
      const desvioGx = gx < estimadoGx ? estimadoGx - gx : gx - estimadoGx;
      const desvioGy = gy < estimadoGy ? estimadoGy - gy : gy - estimadoGy;
      const desvioGz = gz < estimadoGz ? estimadoGz - gz : gz - estimadoGz;

      if (desvioGx <= limiarRadPorS && desvioGy <= limiarRadPorS && desvioGz <= limiarRadPorS) {
        // A estimativa serve: a testemunha independente não é mais necessária.
        if ((estado[SUSTENTADA_N] ?? 0) !== 0) esquecerSustentada();

        const paradoMs = (estado[PARADO_MS] ?? 0) + dtMs;
        estado[PARADO_MS] = paradoMs;
        if (paradoMs < esperaAteAjustarMs) {
          dentroDaJanela = false;
          return;
        }
        if (!dentroDaJanela) {
          dentroDaJanela = true;
          contadores.janelasDeAjuste += 1;
        }

        // Peso proporcional ao intervalo: a constante de tempo em segundos vale igual em qualquer
        // taxa de amostragem. O teto de 1 é a trava contra um `dt` maior que a própria constante.
        const alfa = Math.min(dtMs / constanteDeTempoMs, 1);
        estado[GX] = estimadoGx + alfa * (gx - estimadoGx);
        estado[GY] = estimadoGy + alfa * (gy - estimadoGy);
        estado[GZ] = estimadoGz + alfa * (gz - estimadoGz);

        const desdeAplicacaoMs = (estado[DESDE_APLICACAO_MS] ?? 0) + dtMs;
        if (desdeAplicacaoMs < intervaloDeAplicacaoMs) {
          estado[DESDE_APLICACAO_MS] = desdeAplicacaoMs;
          return;
        }
        estado[DESDE_APLICACAO_MS] = 0;
        contadores.aplicacoes += 1;
        aplicar?.(estado[GX] ?? 0, estado[GY] ?? 0, estado[GZ] ?? 0);
        // ATI-029: o bias descontado passou a cobrir a leitura — o cursor parou de andar sozinho,
        // e "use sincronizar" deixou de ser verdade. Aqui, e não no replantio: replantar só
        // recoloca a estimativa, e o cursor continua andando até esta primeira aplicação.
        apagarAvisoDeBiasAlto();
        return;
      }

      contadores.interrupcoes += 1;
      estado[PARADO_MS] = 0;
      estado[DESDE_APLICACAO_MS] = 0;
      dentroDaJanela = false;
    }

    // Sem estimativa, ou com uma que não corresponde à leitura: quem decide passa a ser a própria
    // sequência de leituras. É a saída do impasse descrito no topo do arquivo.
    acompanharSustentada(gx, gy, gz, dtMs);
  }

  return {
    ativo,
    contadores,
    get paradoMs() {
      return estado[PARADO_MS] ?? 0;
    },
    get sustentadaMs() {
      return estado[SUSTENTADA_MS] ?? 0;
    },
    get temEstimativa() {
      return temEstimativa;
    },
    get biasAltoGrausPorS() {
      const quadrado = estado[BIAS_ALTO_QUADRADO] ?? 0;
      return quadrado === 0 ? undefined : Math.sqrt(quadrado) * GRAUS_POR_RADIANO;
    },
    estimativa() {
      return { gx: estado[GX] ?? 0, gy: estado[GY] ?? 0, gz: estado[GZ] ?? 0 };
    },

    observar,

    semear(gx, gy, gz) {
      if (!Number.isFinite(gx) || !Number.isFinite(gy) || !Number.isFinite(gz)) return;
      estado[GX] = gx;
      estado[GY] = gy;
      estado[GZ] = gz;
      estado[PARADO_MS] = 0;
      estado[DESDE_APLICACAO_MS] = 0;
      esquecerSustentada();
      temEstimativa = true;
      dentroDaJanela = false;
      // O bias conhecido passa a ser descontado agora: é o `sincronizar` que o aviso pedia.
      apagarAvisoDeBiasAlto();
    },

    reiniciar() {
      estado[PARADO_MS] = 0;
      estado[DESDE_APLICACAO_MS] = 0;
      esquecerSustentada();
      dentroDaJanela = false;
    },

    esquecer() {
      // Antes do `fill`: quem ouve o aviso precisa saber que ele apagou (o aparelho que vem é
      // outro sensor, e o aviso era do anterior).
      apagarAvisoDeBiasAlto();
      estado.fill(0);
      temEstimativa = false;
      dentroDaJanela = false;
    },
  };
}
