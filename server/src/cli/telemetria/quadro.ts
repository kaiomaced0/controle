/**
 * O quadro da telemetria — as linhas de texto que o painel escreve a cada atualização.
 *
 * Só transformação de número em texto: nada aqui abre socket, lê relógio ou escreve na tela.
 * É de propósito, e é o que permite testar o que a pessoa vê sem subir servidor nenhum.
 *
 * Quatro regras que o painel depende:
 *
 * 1. **A quantidade de linhas é fixa** (`LINHAS_DO_QUADRO`), sempre, com sessão ou sem sessão.
 *    O painel reposiciona o cursor contando linhas; um quadro que encolhe desalinharia todos os
 *    seguintes. Campo sem valor vira `—`, nunca uma linha a menos.
 * 2. **Nenhuma linha passa da largura de trabalho** (`estado.largura`) — nem em **colunas de
 *    exibição**, nem em **pontos de código**. Linha mais comprida que o terminal quebra sozinha
 *    (*auto-wrap*), e cada quebra vira uma linha **visual** que o painel não conta ao subir o
 *    cursor: o quadro seguinte desce, e em poucos segundos a tela rola — exatamente o que o
 *    critério 4 da ATI-006 proíbe. São duas contas porque são dois terminais: o que compõe marca
 *    combinante gasta uma célula por coluna, o que não compõe gasta uma célula por ponto de
 *    código. Quem não couber é cortado com `…`.
 * 3. **Nenhuma linha termina com espaço**: quem apaga o resto da linha é o `\x1b[K` do painel.
 * 4. **Nenhuma linha carrega caractere de controle nem escape de terminal.** Parte do texto do
 *    quadro vem do fio (o nome do aparelho, no `hello`), e quem escolhe esse texto é o outro lado
 *    da conexão. Um `\n` ali criaria uma linha visual a mais — a mesma rolagem da regra 2, por
 *    outro caminho — e um `\x1b[2J` iria inteiro para o terminal, apagando a tela que o painel
 *    promete não piscar. Ver `sanitizarTextoDoFio`.
 *
 * As medidas exibidas são as da tabela do PROTOCOLO.md, seção 7, com os mesmos nomes.
 *
 * ## O que a montagem põe no quadro (ATI-027)
 *
 * Desde a ATI-027 a telemetria monta o servidor inteiro, pelas mesmas regras do `npm run dev`
 * (`montagem.ts`), e o quadro mostra o que a cadeia está fazendo com o giroscópio — não só o que
 * chega pelo fio:
 *
 * - a **primeira linha** diz para onde o movimento vai: `MOUSE REAL`, `ENSAIO` ou `MOVIMENTO
 *   DESLIGADO`. Quem olha o painel precisa saber, sem procurar, se o cursor parado é defeito ou é
 *   o ensaio fazendo o que deve — era exatamente essa a dúvida que o painel antigo não respondia;
 * - os **pixels** que a cadeia mandou ao destino (em ensaio, os que teriam saído), os cliques e
 *   entalhes da sessão, o **bias** em uso e de onde ele veio, a **recalibração** automática
 *   trabalhando e os **ajustes efetivos** do giro;
 * - o **ponteiro** (ATI-026): se a aceleração de ponteiro do Windows está ligada e por qual saída o
 *   movimento vai — absoluto (não passa pela curva) ou relativo (distorce, se ela estiver ligada);
 * - o **aviso de bias alto** (ATI-029), na frente da linha `recalib.`, com o mesmo texto que a
 *   página `/diagnostico` recebe no quadro `aviso`.
 */

import type { DestinoDoCursor, InstantaneoDaMontagem, OrigemDoBias } from '../../montagem.js';
import { resumirSaidaDoMouse } from '../../saida/saida-do-mouse.js';
import type { EnderecoDoTransporte, InstantaneoDaSessao } from '../../transporte/indice.js';

/**
 * Largura de referência — e **máxima** — do painel.
 *
 * 78 e não 80 porque escrever na última coluna já quebra a linha em parte dos terminais (o
 * conhost do Windows quebra na hora; o xterm adia a quebra). Um terminal mais largo que isto não
 * estica o quadro: 78 colunas é a medida em que as linhas foram desenhadas para caber. Terminal
 * mais estreito manda, e aí o corte é por `truncarNaLargura` (ver `larguraDeTrabalho`).
 */
export const LARGURA_DO_PAINEL = 78;

/** Coluna onde começa o conteúdo de cada linha rotulada. */
export const LARGURA_DO_ROTULO = 12;

/** Células de cada lado do centro da barra. A barra inteira tem `2 * MEIA_BARRA + 1`. */
export const MEIA_BARRA = 12;

/**
 * Fundo de escala da barra, em °/s.
 *
 * 200 °/s é a faixa em que a mão realmente trabalha ao mirar: com 12 células por lado, uma
 * rotação de 90 °/s acende 5 células (dá para ver), e o tranco de um giro rápido satura em vez
 * de exigir uma barra do tamanho do terminal. O número exato continua ao lado da barra — ela é
 * para a leitura de relance, não para a medida.
 */
export const ESCALA_DA_BARRA_GRAUS_POR_S = 200;

/** O fio leva rad/s (PROTOCOLO.md, seção 1); a pessoa lê melhor em °/s. */
export const RAD_PARA_GRAU = 180 / Math.PI;

/** Quantas linhas o quadro sempre tem. O painel conta com este número para subir o cursor. */
export const LINHAS_DO_QUADRO = 21;

/**
 * Como a primeira linha nomeia o destino do movimento (ATI-027). Vem **antes** do nome do modo, e
 * é a última coisa a ser cortada num terminal estreito: é a resposta para "por que o cursor não
 * anda?" e para a surpresa contrária, o cursor andando sem ninguém ter pedido.
 */
export const DESTINO_NO_TITULO: Readonly<Record<DestinoDoCursor, string>> = Object.freeze({
  real: 'MOUSE REAL (o cursor SE MEXE)',
  ensaio: 'ENSAIO (o cursor não se mexe)',
  desligado: 'MOVIMENTO DESLIGADO (sem cursor)',
});

/** Marca do corte. Uma coluna, para a conta de largura ser a conta de colunas. */
export const MARCA_DE_CORTE = '…';

/**
 * Quantas colunas o nome do aparelho pode ocupar na linha `sessão`.
 *
 * O nome vem do `hello` (PROTOCOLO.md, seção 3.1) e o servidor aceita qualquer string, de
 * qualquer tamanho. Sem um teto **próprio**, um nome comprido empurraria o resto da linha
 * (transporte e duração) para fora do corte de largura: a linha continuaria cabendo, mas as
 * informações do servidor é que sumiriam — e quem escolhe o nome é o outro lado do fio.
 * 24 colunas cabem "Samsung Galaxy S23 Ultra" inteiro.
 */
export const LIMITE_DO_NOME_DO_APARELHO = 24;

/** Texto que o outro lado mandou e que não sobrou nada legível depois da higienização. */
export const NOME_ILEGIVEL = '(sem nome legível)';

/**
 * Sequência de escape de terminal, para ser **removida** antes de o texto chegar à tela.
 *
 * Cobre os três formatos que aparecem na prática:
 * - CSI (`ESC [ … letra`) — é o `\x1b[2J` que limpa a tela, o `\x1b[10B` que desce o cursor e
 *   toda a coloração;
 * - OSC (`ESC ] … BEL` ou `… ESC \`) — título de janela e hyperlink;
 * - a forma curta (`ESC` + intermediários + um byte final), onde moram `ESC c` (reset),
 *   `ESC 7` (salva cursor) e a troca de conjunto de caracteres.
 *
 * A forma curta come **o byte seguinte ao `ESC`**, e é assim mesmo: o terminal faz o mesmo, e
 * deixar aquele byte na tela mostraria um caractere que o terminal nunca desenharia. O `?` do fim
 * cobre o `ESC` na última posição do texto, que não tem byte seguinte para levar. Não é caminho
 * quente: roda por campo de texto exibido, ~10 vezes por segundo.
 */
/* eslint-disable no-control-regex --
   O ESC e o BEL são justamente o que esta expressão existe para caçar. */
const ESCAPE_DE_TERMINAL =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]?|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[ -/]*[0-~])?/g;
/* eslint-enable no-control-regex */

/**
 * Caractere que o terminal não desenha como um símbolo comum, e que por isso mexe no layout ou
 * some da tela sem sumir do texto:
 *
 * - `\p{Cc}` — os controles C0 e C1, onde moram `\n`, `\r`, `\t`, `\b` e o `ESC` que sobrou;
 * - `\p{Cf}` — os "formato": junção de largura zero, marcas de direção (que podem inverter a
 *   ordem visual da linha inteira) e o BOM;
 * - `\p{Cs}` — metade de par substituto solta, que vira `�` ou lixo dependendo do terminal;
 * - `\p{Co}` — uso privado, cuja largura ninguém sabe;
 * - `\p{Zl}`/`\p{Zp}` — separador de linha e de parágrafo, que são quebra de linha por outro nome;
 * - `U+FE00`–`U+FE0F` — seletores de variação, que trocam a largura do símbolo anterior sem
 *   aparecer na contagem (ver `larguraDeExibicao`).
 */
const INVISIVEIS = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\u{FE00}-\u{FE0F}]/gu;

/** Marca combinante: desenha em cima do caractere anterior, sem ocupar coluna própria. */
const COMBINANTE = /^[\p{Mn}\p{Me}]$/u;

/**
 * Faixas que o terminal desenha com **duas** colunas.
 *
 * É uma aproximação declarada, não a tabela completa do Unicode: cobre os blocos CJK e Hangul
 * (largura dupla desde sempre) e os blocos de emoji mais usados. Fora daqui, cada ponto de código
 * vale uma coluna. A aproximação é segura porque o texto do próprio painel é ASCII mais `·`,
 * `±`, `°`, `—` e `…` — todos de uma coluna — e o único texto de fora é o nome do aparelho, que
 * já tem teto próprio (`LIMITE_DO_NOME_DO_APARELHO`).
 */
const FAIXAS_DE_DUAS_COLUNAS: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Jamo Hangul
  [0x231a, 0x231b], // ⌚⌛
  [0x23e9, 0x23ec],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653], // signos
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e], // radicais CJK e pontuação
  [0x3041, 0x33ff], // kana, bopomofo, compatibilidade
  [0x3400, 0x4dbf], // ideogramas, extensão A
  [0x4e00, 0x9fff], // ideogramas unificados
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3], // sílabas Hangul
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60], // formas de largura dupla
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], // símbolos, transporte, emoticons
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd], // ideogramas, planos suplementares
];

/** Colunas de um ponto de código: 0 (marca combinante), 2 (faixa dupla) ou 1 (o resto). */
function colunasDoPonto(ponto: string): number {
  if (COMBINANTE.test(ponto)) return 0;
  const codigo = ponto.codePointAt(0) ?? 0;
  for (const [inicio, fim] of FAIXAS_DE_DUAS_COLUNAS) {
    if (codigo < inicio) break;
    if (codigo <= fim) return 2;
  }
  return 1;
}

/**
 * Quantas colunas do terminal o texto ocupa.
 *
 * Não é o mesmo que contar caracteres: emoji e ideograma ocupam duas colunas, e acento
 * combinante não ocupa nenhuma. Contar errado é o mesmo que não contar — a linha passa da
 * largura, o terminal quebra sozinho e o painel volta a rolar (regra 2 do topo do arquivo).
 */
export function larguraDeExibicao(texto: string): number {
  let colunas = 0;
  for (const ponto of texto) colunas += colunasDoPonto(ponto);
  return colunas;
}

/**
 * Higieniza texto de origem externa — hoje, o nome do aparelho que chega no `hello`.
 *
 * Ordem importa: primeiro sai a **sequência** de escape inteira (senão o `ESC` sumiria e o
 * `[2J` ficaria escrito na tela como texto), depois saem os caracteres invisíveis que sobraram,
 * e só então o texto é medido e cortado — cortar antes daria uma conta de largura sobre bytes
 * que nunca chegariam ao terminal.
 *
 * O corte tem **dois** tetos, e vale o que estourar primeiro: colunas de exibição (o que o
 * terminal desenha) e pontos de código (o tamanho do texto), os dois **no mesmo número**.
 *
 * O segundo teto existe porque marca combinante custa 0 coluna: sem ele, `'Z' + U+0301 × 5000`
 * passava inteiro por um teto de 24 colunas (sugestão 3 da revisão da rodada 3). Terminal que
 * compõe a marca na célula anterior desenha uma coluna; terminal que **não** compõe (o console
 * legado do Windows, e este projeto é Windows primeiro) desenha uma célula por marca, a linha
 * estoura a largura e o painel volta a rolar.
 *
 * Por que o mesmo número, e não o dobro que a revisão sugeriu: o dobro foi medido na rodada 4 e
 * **não** fechava. Com teto de 2×, a linha `sessão` chegou a 76 pontos de código e o emulador que
 * não compõe a marca contou 15 quebras por largura e 15 linhas de deriva a 80 colunas — a rolagem
 * continuava lá, só menor. Com o teto igual, a mesma bancada deu 0 e 0. O que se paga é pouco:
 * nome com acento decomposto gasta um ponto a mais por acento e só perde caractere se estiver
 * exatamente no limite; emoji não paga nada (1 ponto por 2 colunas).
 *
 * @param limiteDeColunas teto próprio deste campo. Vale em colunas e em pontos de código.
 */
export function sanitizarTextoDoFio(texto: string, limiteDeColunas: number): string {
  const limpo = texto.replace(ESCAPE_DE_TERMINAL, '').replace(INVISIVEIS, '');
  return truncarNaLargura(limpo, limiteDeColunas, limiteDeColunas);
}

/**
 * Última leitura dos eixos, em rad/s crus.
 *
 * Mutável e reaproveitado de propósito: quem escreve aqui é o caminho quente (uma vez por
 * pacote, 100 vezes por segundo), e criar um objeto por amostra é justamente o que a regra 2
 * do CLAUDE.md proíbe.
 */
export interface LeituraDosEixos {
  gx: number;
  gy: number;
  gz: number;
}

export interface EstadoDoQuadro {
  /** Endereço em que o transporte está ouvindo; `undefined` antes de a porta abrir. */
  readonly endereco: EnderecoDoTransporte | undefined;
  /** Conexões abertas, incluindo as que ainda não mandaram `hello`. */
  readonly conexoesAbertas: number;
  /** Sessão com handshake concluído, quando existe. */
  readonly sessao: InstantaneoDaSessao | undefined;
  readonly eixos: Readonly<LeituraDosEixos>;
  /** CPU deste processo na última janela de 1 s, em por cento. */
  readonly cpuPorCento: number;
  /** CPU média deste processo desde a partida — a leitura que vale para o critério de aceite. */
  readonly cpuMediaPorCento: number;
  /** Período de atualização do painel, em ms — vira a taxa mostrada no cabeçalho. */
  readonly intervaloDoQuadroMs: number;
  /** Colunas disponíveis. Nenhuma linha do quadro passa daqui (regra 2 do topo do arquivo). */
  readonly largura: number;
  /** O que a montagem está fazendo com o giroscópio (ATI-027) — `servidor.instantaneo()`. */
  readonly montagem: InstantaneoDaMontagem;
}

/**
 * Quantas colunas o quadro pode ocupar num terminal de `colunas` colunas.
 *
 * Uma a menos que o terminal, porque escrever **na** última coluna já é quebra de linha em parte
 * dos terminais; e nunca mais que `LARGURA_DO_PAINEL`, porque esticar o quadro num monitor largo
 * só afastaria o número do rótulo.
 *
 * Dois casos que **não** são a mesma coisa (sugestão 3 da revisão da rodada 2):
 * - **sem informação** (`undefined`/`NaN`, que é a saída encanada para arquivo): vale a largura
 *   de referência, porque não há terminal para estourar;
 * - **largura absurda** (`<= 1`, que só acontece se `process.stdout.columns` vier errado): vale
 *   1 coluna. Escolher 78 justamente aqui seria escolher a largura que com certeza não cabe — e
 *   linha que não cabe é a rolagem que o critério 4 proíbe. Ilegível é ruim; rolando é pior.
 */
export function larguraDeTrabalho(colunas: number | undefined): number {
  if (colunas === undefined || !Number.isFinite(colunas)) return LARGURA_DO_PAINEL;
  const inteiro = Math.floor(colunas);
  if (inteiro <= 1) return 1;
  return Math.min(LARGURA_DO_PAINEL, inteiro - 1);
}

/**
 * Corta o texto na largura, marcando o corte.
 *
 * A conta é em **colunas de exibição** (`larguraDeExibicao`), não em pontos de código: contar
 * pontos deixava um nome de aparelho com dez emoji ocupar 77 colunas achando que ocupava 67, e a
 * linha voltava a quebrar sozinha. O corte anda de ponto de código em ponto de código, nunca no
 * meio de um par substituto, e reserva a coluna da marca. Não é caminho quente — roda 20 vezes
 * por quadro, ~10 vezes por segundo.
 *
 * @param limiteDePontos teto opcional em **pontos de código**, para texto que cresce sem ocupar
 *   coluna (marca combinante). Vale o teto que estourar primeiro. Quem passa por aqui é
 *   `sanitizarTextoDoFio`; o texto do próprio painel não precisa dele.
 */
export function truncarNaLargura(
  texto: string,
  largura: number,
  limiteDePontos: number = Number.POSITIVE_INFINITY,
): string {
  if (largura <= 0) return '';

  let colunasDoTexto = 0;
  let pontosDoTexto = 0;
  for (const ponto of texto) {
    colunasDoTexto += colunasDoPonto(ponto);
    pontosDoTexto += 1;
  }
  if (colunasDoTexto <= largura && pontosDoTexto <= limiteDePontos) return texto;

  // A marca de corte gasta uma coluna e um ponto de código; os dois tetos abrem espaço para ela.
  const tetoDeColunas = largura - 1;
  const tetoDePontos = limiteDePontos - 1;
  let colunas = 0;
  let pontos = 0;
  let cortado = '';
  for (const ponto of texto) {
    const custo = colunasDoPonto(ponto);
    if (colunas + custo > tetoDeColunas || pontos + 1 > tetoDePontos) break;
    colunas += custo;
    pontos += 1;
    cortado += ponto;
  }
  return `${cortado}${MARCA_DE_CORTE}`;
}

/** Número para pessoa ler. Não finito (NaN, ±Infinity) vira `—`, nunca "NaN". */
export function formatarNumero(valor: number, casas: number): string {
  if (!Number.isFinite(valor)) return '—';
  return valor.toFixed(casas);
}

/** Número com sinal sempre visível — o que importa num eixo é para que lado ele foi. */
export function formatarComSinal(valor: number, casas: number): string {
  if (!Number.isFinite(valor)) return '—';
  const texto = valor.toFixed(casas);
  return valor >= 0 && !texto.startsWith('-') ? `+${texto}` : texto;
}

/**
 * Barra horizontal centrada no zero.
 *
 * `|` é o zero; o preenchimento cresce para a direita quando o valor é positivo e para a
 * esquerda quando é negativo. Valor que passa do fundo de escala acende a célula da ponta com
 * `>` ou `<` — sem isso, "saturado" e "no limite" ficariam idênticos na tela.
 */
export function formatarBarra(
  valorGrausPorS: number,
  escala: number = ESCALA_DA_BARRA_GRAUS_POR_S,
  meia: number = MEIA_BARRA,
): string {
  const vazio = '.'.repeat(meia);
  if (!Number.isFinite(valorGrausPorS) || escala <= 0 || meia <= 0) {
    return `[${vazio}|${vazio}]`;
  }

  const fracao = Math.abs(valorGrausPorS) / escala;
  const saturou = fracao >= 1;
  const celulas = Math.min(meia, Math.round(Math.min(1, fracao) * meia));
  if (celulas === 0) return `[${vazio}|${vazio}]`;

  const cheio = '#'.repeat(celulas - 1);
  const sobra = '.'.repeat(meia - celulas);
  if (valorGrausPorS >= 0) {
    const ponta = saturou ? '>' : '#';
    return `[${vazio}|${cheio}${ponta}${sobra}]`;
  }
  const ponta = saturou ? '<' : '#';
  return `[${sobra}${ponta}${cheio}|${vazio}]`;
}

/**
 * Linha rotulada: rótulo à esquerda, conteúdo alinhado numa coluna só.
 *
 * Toda linha do quadro passa por `sanitizarTextoDoFio` — inclusive as que hoje só têm texto do
 * próprio painel. É de propósito: no dia em que outro campo vindo do fio entrar aqui (modelo,
 * versão do SO), a regra 4 do topo do arquivo vale sem ninguém precisar lembrar dela.
 */
function linha(rotulo: string, conteudo: string, largura: number): string {
  return sanitizarTextoDoFio(`${rotulo.padEnd(LARGURA_DO_ROTULO)}${conteudo}`, largura);
}

/** Linha de um eixo: valor cru no fio, valor em °/s e a barra. */
function linhaDoEixo(nome: string, valorRadS: number, largura: number): string {
  const grausPorS = valorRadS * RAD_PARA_GRAU;
  const cru = `${formatarComSinal(valorRadS, 4)} rad/s`.padEnd(16);
  const graus = `${formatarComSinal(grausPorS, 1)} °/s`.padStart(11);
  return sanitizarTextoDoFio(
    `${nome.padEnd(LARGURA_DO_ROTULO)}${cru}${graus}  ${formatarBarra(grausPorS)}`,
    largura,
  );
}

/**
 * Cabeçalho: **para onde o movimento vai**, o nome do modo, a taxa do próprio painel e como sair.
 *
 * O destino vem primeiro (ATI-027): é a pergunta que quem olha o painel faz antes de qualquer
 * outra, e a resposta não pode depender de procurar. Num terminal estreito o corte come da direita
 * para a esquerda — a dica de saída some antes do nome do modo, e o nome do modo antes do destino.
 *
 * A taxa do painel mora aqui, e não na linha `servidor`, porque ela é propriedade da tela e não
 * do canal — e porque, junto do endereço e da CPU, aquela linha passava das 78 colunas e o
 * terminal a quebrava (era a rolagem do apontamento 1 da revisão da rodada 1).
 */
function linhaDoTitulo(destino: DestinoDoCursor, intervaloDoQuadroMs: number, largura: number): string {
  const painelHz = intervaloDoQuadroMs > 0 ? formatarNumero(1000 / intervaloDoQuadroMs, 1) : '—';
  const titulo = `${DESTINO_NO_TITULO[destino]} · telemetria · painel ${painelHz} Hz`;
  const dica = 'Ctrl+C encerra';
  const espaco = largura - larguraDeExibicao(titulo) - larguraDeExibicao(dica);
  // Terminal estreito perde a dica antes de perder o nome do modo: quem já está com o painel na
  // tela sabe sair; quem não sabe o que está vendo, não.
  if (espaco < 1) return sanitizarTextoDoFio(titulo, largura);
  return `${titulo}${' '.repeat(espaco)}${dica}`;
}

/** Par `x/y` com sinal, sem casas — pixels são inteiros. */
function formatarParDePixels(x: number, y: number): string {
  return `${formatarComSinal(x, 0)}/${formatarComSinal(y, 0)}`;
}

/** `1 clique`, `2 cliques`: singular e plural, que o número na tela é lido por gente. */
function contar(quantidade: number, singular: string, plural: string): string {
  return `${quantidade} ${quantidade === 1 ? singular : plural}`;
}

/** Dois dígitos, para hora e data. */
function doisDigitos(valor: number): string {
  return String(valor).padStart(2, '0');
}

/**
 * Hora local `HH:MM:SS` de um instante do relógio de parede. Instante desconhecido vira `—`.
 *
 * Não lê relógio nenhum: o instante vem pronto da montagem, e a conversão é só de formato.
 */
export function formatarHora(instanteMs: number): string {
  if (!Number.isFinite(instanteMs)) return '—';
  const data = new Date(instanteMs);
  return (
    `${doisDigitos(data.getHours())}:${doisDigitos(data.getMinutes())}:` +
    `${doisDigitos(data.getSeconds())}`
  );
}

/** Data e hora locais `DD/MM HH:MM` — para bias guardado, que costuma ser de outro dia. */
export function formatarDataEHora(instanteMs: number): string {
  if (!Number.isFinite(instanteMs)) return '—';
  const data = new Date(instanteMs);
  return (
    `${doisDigitos(data.getDate())}/${doisDigitos(data.getMonth() + 1)} ` +
    `${doisDigitos(data.getHours())}:${doisDigitos(data.getMinutes())}`
  );
}

/** Sem pipeline não há cadeia, bias nem recalibração: a linha diz isso em vez de mostrar zero. */
const SEM_PIPELINE = '— · movimento desligado (CONTROLE_MOVIMENTO=desligado)';

/**
 * Pixels que a cadeia mandou ao destino: da sessão (zera quando o aparelho desconecta) e da
 * execução inteira. Em ensaio, os que **teriam** saído — é o número que prova o pipeline
 * funcionando sem tocar no cursor (ATI-027).
 */
function descreverPixels(montagem: InstantaneoDaMontagem): string {
  const pixels = montagem.pixels;
  if (pixels === undefined) return SEM_PIPELINE;
  // Em real, "pedidos" e não "andados": na saída relativa com a aceleração de ponteiro do Windows
  // ligada, o que o cursor anda não é o que foi pedido; na absoluta (ATI-026) é, menos o que a borda
  // da tela comer. A linha `ponteiro` diz qual das duas está valendo.
  const quem = montagem.cursor === 'real' ? 'pedidos ao cursor' : 'teriam saído';
  return (
    `sessão ${formatarParDePixels(pixels.sessaoX, pixels.sessaoY)} · ` +
    `execução ${formatarParDePixels(pixels.execucaoX, pixels.execucaoY)} px (${quem})`
  );
}

/** Cliques e entalhes da sessão, e quantos botões estão presos agora (regra 5 do CLAUDE.md). */
function descreverAcoes(montagem: InstantaneoDaMontagem): string {
  const acoes = montagem.acoes;
  const destino = montagem.cursor === 'real' ? 'de verdade' : 'ensaio';
  return (
    `sessão ${contar(acoes.cliquesNaSessao, 'clique', 'cliques')} · ` +
    `entalhes ${formatarComSinal(acoes.entalhesVerticaisNaSessao, 2)}/` +
    `${formatarComSinal(acoes.entalhesHorizontaisNaSessao, 2)} · presos ${acoes.presos} (${destino})`
  );
}

/** De onde veio o bias em uso — o "quando foi calibrado" da ATI-027. */
function descreverOrigemDoBias(origem: OrigemDoBias, desdeMs: number): string {
  switch (origem) {
    case 'calibracao':
      return `calibrado às ${formatarHora(desdeMs)}`;
    case 'guardado':
      return `guardado, de ${formatarDataEHora(desdeMs)}`;
    case 'nenhuma':
      // Partiu de zero; o que a recalibração ajustou desde então aparece na linha dela.
      return 'sem calibração guardada';
  }
}

/** O bias que o pipeline está descontando agora, por eixo do sensor, em °/s. */
function descreverBias(montagem: InstantaneoDaMontagem): string {
  const ajustes = montagem.ajustes;
  if (ajustes === undefined) return SEM_PIPELINE;
  const emGraus = (radPorS: number): string => formatarComSinal(radPorS * RAD_PARA_GRAU, 3);
  return (
    `gx/gy/gz ${emGraus(ajustes.biasGxRadPorS)}/${emGraus(ajustes.biasGyRadPorS)}/` +
    `${emGraus(ajustes.biasGzRadPorS)} °/s · ` +
    descreverOrigemDoBias(montagem.bias.origem, montagem.bias.desdeMs)
  );
}

/**
 * A recalibração automática trabalhando: quantas vezes ela entregou bias ao pipeline, e há quanto
 * tempo o aparelho está parado — aos 3 s parado o ajuste começa (ATI-009), e é aqui que se vê.
 *
 * O aviso de bias alto (ATI-029) vem **na frente** da linha, pelo mesmo motivo do `giro DESLIGADO`
 * dos ajustes: é a última coisa que um terminal estreito corta, e é a resposta para "por que o
 * cursor está andando sozinho?". Ele ocupa a linha da recalibração, e não uma linha própria,
 * porque a contagem de linhas do quadro é fixa e o aviso existe só às vezes — uma linha nova
 * mostraria `—` quase sempre. O que ele empurra para o corte (ajustes e tempo parado) é o que
 * menos importa enquanto o cursor anda sozinho: parado, com o aviso aceso, fica em 0 s.
 */
function descreverRecalibracao(montagem: InstantaneoDaMontagem): string {
  if (montagem.ajustes === undefined) return SEM_PIPELINE;
  const recalibracao = montagem.recalibracao;
  if (!recalibracao.ligada) return 'desligada (CONTROLE_RECALIBRACAO=desligada)';
  const aviso = recalibracao.avisoDeBiasAlto === undefined ? '' : `${recalibracao.avisoDeBiasAlto} · `;
  return (
    aviso +
    `ligada · ${contar(recalibracao.aplicacoesNaSessao, 'ajuste', 'ajustes')} na sessão, ` +
    `${recalibracao.aplicacoesNaExecucao} na execução · ` +
    `parado ${formatarNumero(recalibracao.paradoMs / 1000, 1)} s`
  );
}

/** Os ajustes **efetivos** do giro — os que o pipeline está usando, já resolvidos e saturados. */
function descreverAjustes(montagem: InstantaneoDaMontagem): string {
  const ajustes = montagem.ajustes;
  if (ajustes === undefined) return SEM_PIPELINE;
  // Giro desligado no perfil: a cadeia recebe e descarta tudo. Sem esta marca, o painel mostraria
  // eixos mexendo e pixels parados — o mesmo enigma que a ATI-027 existe para acabar. Vem na
  // frente para ser a última coisa que um terminal estreito corta.
  let texto = ajustes.ativo ? '' : 'giro DESLIGADO · ';
  texto +=
    `${ajustes.orientacao} · ` +
    `${formatarNumero(ajustes.sensXPixelsPorGrau, 2)}/${formatarNumero(ajustes.sensYPixelsPorGrau, 2)} px/grau · ` +
    `zona morta ${formatarNumero(ajustes.zonaMortaGrausPorS, 2)} °/s`;
  if (ajustes.inverterX || ajustes.inverterY) {
    texto += ` · inverte ${ajustes.inverterX ? 'X' : ''}${ajustes.inverterY ? 'Y' : ''}`;
  }
  return texto;
}

/**
 * A aceleração de ponteiro do Windows e a saída do mouse (ATI-026). Sem backend do Windows não há o
 * que dizer, e a linha diz isso em vez de sumir — a contagem de linhas é fixa.
 */
function descreverPonteiro(montagem: InstantaneoDaMontagem): string {
  const ponteiro = montagem.ponteiro;
  if (ponteiro === undefined) return '— · sem leitura do ponteiro do Windows';
  return resumirSaidaDoMouse(ponteiro);
}

/**
 * O nome do aparelho, como pode ser mostrado.
 *
 * É o **único** texto do quadro escolhido pelo outro lado da conexão (`hello`, PROTOCOLO.md,
 * seção 3.1): o servidor aceita qualquer string ali, e o painel escrevia essa string na tela como
 * ela veio. Um `\n` no nome criava uma linha visual a mais e o quadro seguinte errava o alvo por
 * uma linha, para sempre; um `\x1b[2J` limpava a tela do usuário. Os dois foram medidos na
 * revisão da rodada 2 desta ATI (deriva de 5 linhas em 5 quadros; `ESC[2J` cinco vezes na saída).
 */
function descreverAparelho(sessao: InstantaneoDaSessao): string {
  const bruto = sessao.aparelho?.nome;
  if (bruto === undefined) return '—';
  const limpo = sanitizarTextoDoFio(bruto, LIMITE_DO_NOME_DO_APARELHO);
  // Nome que era só caractere de controle não vira campo vazio: quem estiver depurando precisa
  // saber que veio um nome e que ele foi recusado, e não que o aparelho não mandou nome.
  return limpo === '' ? NOME_ILEGIVEL : limpo;
}

function descreverSessao(sessao: InstantaneoDaSessao | undefined): string {
  if (sessao === undefined) return '— · nenhum aparelho pareado ainda';
  const aparelho = descreverAparelho(sessao);
  const duracao = `${formatarNumero(sessao.medidas.duracaoMs / 1000, 1)} s`;
  return `${sessao.id} · ${sessao.estado} · ${aparelho} · ${sessao.transporte} · ${duracao}`;
}

function descreverServidor(estado: EstadoDoQuadro): string {
  const endereco =
    estado.endereco === undefined
      ? 'porta ainda não aberta'
      : `ws://${estado.endereco.host}:${estado.endereco.porta}`;
  const conexoes = estado.conexoesAbertas === 1 ? '1 conexão' : `${estado.conexoesAbertas} conexões`;
  // A média vem junto porque a janela de 1 s lê 0,0 % quase sempre no Windows (ver `cpu.ts`).
  const cpu =
    `CPU ${formatarNumero(estado.cpuPorCento, 1)} % ` +
    `(média ${formatarNumero(estado.cpuMediaPorCento, 2)} %)`;
  return `${endereco} · ${conexoes} · ${cpu}`;
}

/**
 * Monta o quadro inteiro.
 *
 * Sempre `LINHAS_DO_QUADRO` linhas, na mesma ordem, nenhuma passando de `estado.largura` — ver as
 * regras do topo do arquivo.
 */
export function montarQuadro(estado: EstadoDoQuadro): readonly string[] {
  const largura = Number.isFinite(estado.largura) ? Math.max(0, Math.floor(estado.largura)) : 0;
  const regua = '-'.repeat(largura);
  const medidas = estado.sessao?.medidas;

  const taxa = medidas === undefined ? '—' : `${formatarNumero(medidas.taxaHzMedida, 1)} Hz`;
  const dt =
    medidas === undefined
      ? '—'
      : `${formatarNumero(medidas.dtMsMedio, 2)} ± ${formatarNumero(medidas.dtMsDesvio, 2)} ms`;

  const rtt =
    medidas === undefined
      ? '—'
      : `p50 ${formatarNumero(medidas.rttMsP50, 2)} ms · p95 ${formatarNumero(medidas.rttMsP95, 2)} ms · ` +
        `último ${formatarNumero(medidas.rttMsUltimo, 2)} ms · ${medidas.amostrasDeRtt} amostras`;

  const pacotes =
    medidas === undefined
      ? '—'
      : `${medidas.pacotesRecebidos} recebidos · ${medidas.bytesRecebidos} bytes · ` +
        `fora de ordem ${medidas.foraDeOrdem} (${medidas.descartadosForaDeOrdem} descartados)`;

  const descartes =
    medidas === undefined
      ? '—'
      : `${medidas.descartados} no total · tamanho ${medidas.descartadosPorTamanho} · ` +
        `tipo ${medidas.descartadosPorTipo} · sentido errado ${medidas.pacotesNoSentidoErrado}`;

  // `visoesCriadas` está na tabela do PROTOCOLO.md, seção 7, como métrica exposta neste modo — é
  // o contador que mostra se o decodificador reaproveita a `DataView` no caminho quente. Hoje ele
  // cresce junto com os pacotes por causa da biblioteca `ws`; ver `transporte/README.md`.
  const diagnostico =
    medidas === undefined
      ? '—'
      : `bytes extras ${medidas.comBytesExtras} · pong recusado ${medidas.pongsRecusados} · ` +
        `visões criadas ${medidas.visoesCriadas}`;

  const montagem = estado.montagem;

  return [
    linhaDoTitulo(montagem.cursor, estado.intervaloDoQuadroMs, largura),
    regua,
    linha('servidor', descreverServidor(estado), largura),
    linha('sessão', descreverSessao(estado.sessao), largura),
    regua,
    linhaDoEixo('gx', estado.eixos.gx, largura),
    linhaDoEixo('gy', estado.eixos.gy, largura),
    linhaDoEixo('gz', estado.eixos.gz, largura),
    regua,
    // O que a cadeia fez com os eixos de cima (ATI-027): entrada em cima, saída aqui embaixo.
    linha('pixels', descreverPixels(montagem), largura),
    linha('ações', descreverAcoes(montagem), largura),
    linha('bias', descreverBias(montagem), largura),
    linha('recalib.', descreverRecalibracao(montagem), largura),
    linha('ajustes', descreverAjustes(montagem), largura),
    linha('ponteiro', descreverPonteiro(montagem), largura),
    regua,
    linha('taxa', `${taxa}  ·  dt ${dt}`, largura),
    linha('RTT', rtt, largura),
    linha('pacotes', pacotes, largura),
    linha('descartes', descartes, largura),
    linha('diagnóstico', diagnostico, largura),
  ];
}
