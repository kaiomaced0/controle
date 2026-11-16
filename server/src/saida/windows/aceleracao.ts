/**
 * A aceleração de ponteiro do Windows: o que o sistema informa, o modelo da curva e a escolha da
 * saída do mouse (ATI-026).
 *
 * Três peças, todas sem tocar no sistema (quem lê o Windows é `api.ts`; aqui só há conta):
 *
 * 1. **`ParametrosDoPonteiro`** — o que `SystemParametersInfo` (`SPI_GETMOUSE`,
 *    `SPI_GETMOUSESPEED`) e o registro (`SmoothMouseXCurve`/`YCurve`) respondem.
 * 2. **O modelo da curva** (`criarModeloDaAceleracao`) e o **compensador** que o inverte — a
 *    estratégia (a) da ATI-026: mandar o deslocamento já deformado ao contrário, para a curva
 *    devolvê-lo como foi pedido.
 * 3. **`resolverSaidaDoMouse`** — o `auto` virando `absoluto` ou `relativo`.
 *
 * ## O modelo, e o que nele é medido e não documentado
 *
 * O formato é o conhecido do Windows 7 em diante: a cada evento, a magnitude do movimento é
 * `max(|dx|, |dy|) + min(|dx|, |dy|) / 2`; ela vira a velocidade de entrada da curva
 * (`SmoothMouseXCurve`); a curva dá a de saída (`SmoothMouseYCurve`), interpolada em linha reta
 * entre os cinco pontos; o resultado é escalado pela DPI do sistema e pela velocidade do ponteiro
 * (`velocidade / 10` com a aceleração ligada); e o Windows guarda a fração de pixel entre eventos.
 *
 * As **duas escalas** — quanto um mickey vale no eixo X da curva e quanto uma unidade do eixo Y vale
 * em pixel — a Microsoft não publica. As de `CONSTANTES_MEDIDAS` saíram da bancada desta máquina
 * (`ferramentas/provar-aceleracao.mjs`, relatório da ATI-026).
 *
 * ## Por que o compensador é só de bancada
 *
 * Medido: com o modelo ajustado ao ganho em regime (erro de 0,006), a curva inversa ainda erra a
 * tabela da spec por 1 a 15 px. O ganho de um evento depende **dos eventos anteriores**, não só da
 * magnitude dele — e o histórico inclui o mouse físico, que o servidor não vê. Somado a duas
 * constantes ajustadas num PC (outra DPI, outra versão do Windows, outra máquina: outro número), é
 * exatamente a margem que a spec manda não aceitar. A saída que fecha é a absoluta.
 */

import type {
  DescricaoDaSaidaDoMouse,
  EstadoDaAceleracao,
  PedidoDeSaidaDoMouse,
  SaidaEfetivaDoMouse,
} from '../saida-do-mouse.js';

/** O que o Windows informa sobre o ponteiro. Lido uma vez, na criação do backend. */
export interface ParametrosDoPonteiro {
  /** Terceiro inteiro do `SPI_GETMOUSE`: 0 = aceleração desligada; 1 ou 2 = ligada. */
  readonly aceleracao: number;
  /** Os dois limiares do `SPI_GETMOUSE` (só valiam até o Windows 2000; vão para o log). */
  readonly limiar1: number;
  readonly limiar2: number;
  /** `SPI_GETMOUSESPEED`: 1 a 20, 10 é o neutro. */
  readonly velocidade: number;
  /** `SmoothMouseXCurve` em unidades da curva; `undefined` quando o registro não respondeu. */
  readonly curvaX: readonly number[] | undefined;
  readonly curvaY: readonly number[] | undefined;
  /** DPI do sistema (96 = escala de 100 %). */
  readonly dpi: number;
}

/** Velocidade neutra do ponteiro: o multiplicador é 1 com ou sem aceleração. */
export const VELOCIDADE_NEUTRA = 10;

/** DPI de referência das constantes do modelo (escala de 100 %). */
export const DPI_DE_REFERENCIA = 96;

/**
 * Multiplicador do relativo com a aceleração **desligada**, por posição do controle de velocidade
 * (1 a 20). Não é linear: abaixo do 10 cai em oitavos, acima sobe de 0,25 em 0,25.
 */
export const MULTIPLICADORES_SEM_ACELERACAO: readonly number[] = Object.freeze([
  1 / 32, 1 / 16, 1 / 8, 2 / 8, 3 / 8, 4 / 8, 5 / 8, 6 / 8, 7 / 8, 1,
  1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5,
]);

/** Se o sistema está com "Aumentar a precisão do ponteiro" ligado. */
export function aceleracaoEstaLigada(parametros: ParametrosDoPonteiro): boolean {
  return parametros.aceleracao !== 0;
}

/** Velocidade válida (1 a 20). Fora disso o Windows não produz, e o modelo não inventa. */
function velocidadeValida(velocidade: number): boolean {
  return Number.isInteger(velocidade) && velocidade >= 1 && velocidade <= 20;
}

/**
 * Quanto o controle de velocidade multiplica o relativo: `velocidade / 10` com a aceleração
 * ligada, a tabela {@link MULTIPLICADORES_SEM_ACELERACAO} com ela desligada.
 */
export function multiplicadorDaVelocidade(velocidade: number, comAceleracao: boolean): number {
  if (!velocidadeValida(velocidade)) return 1;
  if (comAceleracao) return velocidade / VELOCIDADE_NEUTRA;
  return MULTIPLICADORES_SEM_ACELERACAO[velocidade - 1] ?? 1;
}

/** Se o relativo sai 1:1: aceleração desligada e velocidade no neutro. */
export function relativoSaiFiel(parametros: ParametrosDoPonteiro): boolean {
  return !aceleracaoEstaLigada(parametros) && parametros.velocidade === VELOCIDADE_NEUTRA;
}

/**
 * Lê os cinco pontos de uma curva do registro.
 *
 * Cada ponto ocupa 8 bytes; o valor é 16.16 em ponto fixo (1,0 = `0x10000`). Fora do formato
 * (tamanho diferente de 40 bytes) é `undefined`, e quem chama trata como "curva desconhecida".
 */
export function interpretarCurva(bytes: Buffer, tamanho: number): number[] | undefined {
  if (tamanho !== 40 || bytes.length < 40) return undefined;
  const pontos: number[] = [];
  for (let deslocamento = 0; deslocamento < 40; deslocamento += 8) {
    const baixo = bytes.readUInt32LE(deslocamento);
    const alto = bytes.readInt32LE(deslocamento + 4);
    pontos.push((alto * 2 ** 32 + baixo) / 65_536);
  }
  return pontos;
}

/**
 * Se as duas curvas têm o formato que o modelo sabe inverter: cinco pontos, começando em (0, 0), com
 * X e Y **crescentes**. Curva achatada (tudo zero, como certos "consertos" de jogo deixam) ou fora de
 * ordem não tem inversa — e aí o compensador não é oferecido.
 */
export function curvaInversivel(
  curvaX: readonly number[] | undefined,
  curvaY: readonly number[] | undefined,
): boolean {
  if (curvaX === undefined || curvaY === undefined) return false;
  if (curvaX.length !== 5 || curvaY.length !== 5) return false;
  if (curvaX[0] !== 0 || curvaY[0] !== 0) return false;
  for (let i = 1; i < 5; i += 1) {
    const xAtual = curvaX[i] ?? Number.NaN;
    const xAnterior = curvaX[i - 1] ?? Number.NaN;
    const yAtual = curvaY[i] ?? Number.NaN;
    const yAnterior = curvaY[i - 1] ?? Number.NaN;
    if (!(xAtual > xAnterior) || !(yAtual > yAnterior)) return false;
  }
  return true;
}

/**
 * Magnitude que o Windows usa para escolher o ganho: `max + min/2`, uma aproximação barata da
 * norma euclidiana. ⚠️ Caminho quente (compensador): só aritmética.
 */
export function magnitudeDoWindows(dx: number, dy: number): number {
  const ax = dx < 0 ? -dx : dx;
  const ay = dy < 0 ? -dy : dy;
  return ax > ay ? ax + ay / 2 : ay + ax / 2;
}

/** As duas escalas do modelo que a Microsoft não publica — ver o cabeçalho do arquivo. */
export interface ConstantesDoModelo {
  /** Unidades do eixo X da curva por mickey de magnitude. */
  readonly entradaPorMickey: number;
  /** Pixels por unidade do eixo Y da curva, a 96 DPI e com velocidade 10. */
  readonly saidaA96Dpi: number;
}

/**
 * As escalas desta máquina (Windows 11, 96 DPI, curva de fábrica, velocidade 11), ajustadas por
 * mínimos quadrados ao ganho **em regime** medido pela bancada da ATI-026 em 15 magnitudes, de 1 a
 * 40 mickeys por evento (n eventos iguais seguidos). Erro RMS do ganho: 0,006.
 *
 * A entrada saiu 0,2849 ≈ 1/3,51 — o "mickeys ÷ 3,5" que a comunidade descreve para o eixo X da
 * curva. O ajuste em regime é bom; o compensador construído sobre ele **não** fecha a tabela da spec
 * (+37 a +39 e −25 a −30, contra ±2 pedidos), porque o Windows não usa a magnitude do evento sozinha:
 * o −40 isolado depois de quarenta +1 sai com ganho 1,48, o de uma magnitude ~16 em regime — a
 * velocidade que escolhe o ganho carrega o histórico dos eventos anteriores. Ver o relatório.
 */
export const CONSTANTES_MEDIDAS: ConstantesDoModelo = Object.freeze({
  entradaPorMickey: 0.28491,
  saidaA96Dpi: 0.79678,
});

/** O modelo da curva: quantos pixels (reais) o Windows produz para um evento. */
export interface ModeloDaAceleracao {
  /** `true` com a aceleração ligada (curva); `false` é o multiplicador constante da velocidade. */
  readonly comCurva: boolean;
  /** ⚠️ Caminho quente. Pixels por mickey para um evento desta magnitude. */
  ganho(magnitude: number): number;
  /**
   * ⚠️ Caminho quente. A inversa: a magnitude de entrada (em mickeys, fracionária) que faz o
   * Windows produzir `saida` pixels de magnitude.
   */
  entradaParaSaida(saida: number): number;
}

/**
 * Monta o modelo a partir do que o sistema informou. `undefined` quando a aceleração está ligada e a
 * curva não é inversível (ou não foi lida): sem curva conhecida, não há o que inverter.
 */
export function criarModeloDaAceleracao(
  parametros: ParametrosDoPonteiro,
  constantes: ConstantesDoModelo = CONSTANTES_MEDIDAS,
): ModeloDaAceleracao | undefined {
  const comAceleracao = aceleracaoEstaLigada(parametros);
  const multiplicador = multiplicadorDaVelocidade(parametros.velocidade, comAceleracao);

  if (!comAceleracao) {
    // Sem curva, o Windows só multiplica: a inversa é a divisão, e com velocidade 10 é a identidade —
    // é o que garante que o compensador não estraga o caso bom.
    return {
      comCurva: false,
      ganho: () => multiplicador,
      entradaParaSaida: (saida) => saida / multiplicador,
    };
  }

  const { curvaX, curvaY } = parametros;
  if (!curvaInversivel(curvaX, curvaY) || curvaX === undefined || curvaY === undefined) {
    return undefined;
  }
  if (!(constantes.entradaPorMickey > 0) || !(constantes.saidaA96Dpi > 0)) return undefined;

  // Cópias em `Float64Array`: o caminho quente lê por índice, sem `?? NaN` a cada acesso.
  const xs = Float64Array.from(curvaX);
  const ys = Float64Array.from(curvaY);
  const ultimo = xs.length - 1;
  const entrada = constantes.entradaPorMickey;
  const dpi = parametros.dpi > 0 ? parametros.dpi : DPI_DE_REFERENCIA;
  const escala = constantes.saidaA96Dpi * (dpi / DPI_DE_REFERENCIA) * multiplicador;
  const inclinacaoInicial = (ys[1] ?? 0) / (xs[1] ?? 1);

  /** A curva: velocidade de entrada → de saída, em linha reta entre os pontos (e depois do último). */
  function curva(x: number): number {
    if (x <= 0) return 0;
    let i = 1;
    while (i < ultimo && x > (xs[i] ?? 0)) i += 1;
    const x0 = xs[i - 1] ?? 0;
    const x1 = xs[i] ?? 0;
    const y0 = ys[i - 1] ?? 0;
    const y1 = ys[i] ?? 0;
    return y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
  }

  /** A inversa da curva, pelo mesmo trecho — existe porque X e Y são crescentes. */
  function curvaInversa(y: number): number {
    if (y <= 0) return 0;
    let i = 1;
    while (i < ultimo && y > (ys[i] ?? 0)) i += 1;
    const x0 = xs[i - 1] ?? 0;
    const x1 = xs[i] ?? 0;
    const y0 = ys[i - 1] ?? 0;
    const y1 = ys[i] ?? 0;
    return x0 + ((y - y0) * (x1 - x0)) / (y1 - y0);
  }

  return {
    comCurva: true,
    ganho(magnitude) {
      if (magnitude <= 0) return inclinacaoInicial * entrada * escala;
      return (curva(magnitude * entrada) * escala) / magnitude;
    },
    entradaParaSaida(saida) {
      return curvaInversa(saida / escala) / entrada;
    },
  };
}

/** Índices de {@link CompensadorDaAceleracao.mickeys}. */
export const MICKEY_X = 0;
export const MICKEY_Y = 1;

/** O compensador da estratégia (a): recebe o pixel pedido, decide o mickey a mandar. */
export interface CompensadorDaAceleracao {
  /**
   * Os mickeys que o último `compensar` decidiu mandar, em `[MICKEY_X, MICKEY_Y]`. **Reaproveitado**
   * entre chamadas — leia logo depois de compensar.
   *
   * `Int32Array`, e não um objeto `{ x, y }`: o campo de objeto que um dia guardou `-0` (o
   * `Math.round` de um número entre −0,5 e 0) vira campo de ponto flutuante no V8, e cada leitura
   * dele passa a alocar um número no heap — ~7 B por evento, medido. Elemento de `Int32Array` é
   * sempre inteiro e lido sem alocar.
   */
  readonly mickeys: Int32Array;
  /**
   * ⚠️ Caminho quente. Soma o pedido ao alvo e escreve em {@link mickeys} o que leva a previsão do
   * modelo até ele. Devolve `false` (e mickeys zerados) quando o que falta é menor que meio passo —
   * o resto fica para o próximo.
   */
  compensar(dx: number, dy: number): boolean;
  /** Esquece o alvo e a previsão (fração pendente). */
  reiniciar(): void;
}

/** Maior e menor `LONG`: o mickey vai para o `SendInput` como inteiro de 32 bits. */
const MAIOR_MICKEY = 2_147_483_647;
const MENOR_MICKEY = -2_147_483_648;

function limitarMickey(valor: number): number {
  return valor > MAIOR_MICKEY ? MAIOR_MICKEY : valor < MENOR_MICKEY ? MENOR_MICKEY : valor;
}

/**
 * Cria o compensador.
 *
 * Ele guarda duas posições num referencial próprio: o **alvo** (a soma do que foi pedido) e a
 * **previsão** (a soma do que o modelo diz que o Windows andou, fração inclusa — a mesma fração que
 * o Windows guarda). A cada pedido, manda o mickey inteiro cuja saída prevista leva a previsão mais
 * perto do alvo. O que o arredondamento deixa para trás não se perde: fica na diferença entre os dois
 * e entra no pedido seguinte.
 *
 * Com o modelo certo, o erro fica abaixo de um passo do mickey; com o modelo errado, cresce com a
 * distância — e é isso que a bancada mede.
 */
export function criarCompensadorDaAceleracao(modelo: ModeloDaAceleracao): CompensadorDaAceleracao {
  const mickeys = new Int32Array(2);
  // O estado mora num `Float64Array`, e não em `let` da closure: o V8 guarda número fracionário de
  // variável capturada como objeto no heap, e cada escrita aloca um novo — 16 B por evento, medido
  // pelo teste de alocação do backend. Escrever num typed array não aloca.
  const estado = new Float64Array(4);
  const ALVO_X = 0;
  const ALVO_Y = 1;
  const PREVISTO_X = 2;
  const PREVISTO_Y = 3;
  // Abaixo de meio pixel de saída de um mickey, mandar um mickey afasta mais do que aproxima.
  const meioPasso = modelo.ganho(1) / 2;

  return {
    mickeys,

    compensar(dx, dy) {
      let alvoX = (estado[ALVO_X] ?? 0) + dx;
      let alvoY = (estado[ALVO_Y] ?? 0) + dy;
      let previstoX = estado[PREVISTO_X] ?? 0;
      let previstoY = estado[PREVISTO_Y] ?? 0;
      const faltaX = alvoX - previstoX;
      const faltaY = alvoY - previstoY;
      const falta = magnitudeDoWindows(faltaX, faltaY);

      let mx = 0;
      let my = 0;
      if (falta >= meioPasso) {
        // A magnitude é homogênea: mandar `(faltaX, faltaY) × k` dá saída de magnitude `h(k·falta)`.
        // Então basta achar a magnitude de entrada certa e escalar o vetor por ela.
        const fator = modelo.entradaParaSaida(falta) / falta;
        mx = Math.round(faltaX * fator);
        my = Math.round(faltaY * fator);
        if (mx === 0 && my === 0) {
          // O arredondamento zerou o vetor, mas a falta já vale meio passo: um mickey no eixo maior.
          if ((faltaX < 0 ? -faltaX : faltaX) >= (faltaY < 0 ? -faltaY : faltaY)) {
            mx = faltaX < 0 ? -1 : 1;
          } else {
            my = faltaY < 0 ? -1 : 1;
          }
        }
        const ganho = modelo.ganho(magnitudeDoWindows(mx, my));
        previstoX += mx * ganho;
        previstoY += my * ganho;
      }

      // Rebase: os dois referenciais andam juntos pela parte inteira do alvo, para nenhum número
      // crescer sem limite numa sessão longa (e a fração continuar exata).
      const baseX = Math.trunc(alvoX);
      const baseY = Math.trunc(alvoY);
      alvoX -= baseX;
      previstoX -= baseX;
      alvoY -= baseY;
      previstoY -= baseY;
      estado[ALVO_X] = alvoX;
      estado[ALVO_Y] = alvoY;
      estado[PREVISTO_X] = previstoX;
      estado[PREVISTO_Y] = previstoY;

      mickeys[MICKEY_X] = limitarMickey(mx);
      mickeys[MICKEY_Y] = limitarMickey(my);
      return mx !== 0 || my !== 0;
    },

    reiniciar() {
      estado.fill(0);
      mickeys.fill(0);
    },
  };
}

/** A saída escolhida, com o motivo para o log. */
export interface SaidaResolvida {
  readonly efetivo: SaidaEfetivaDoMouse;
  readonly motivo: string;
}

/**
 * Decide a saída do mouse a partir do pedido e do que o sistema informou.
 *
 * - `relativo` e `absoluto` são pedidos explícitos e valem como vieram;
 * - `auto` vira `absoluto` quando o relativo **não** sai 1:1 (aceleração ligada, ou velocidade fora
 *   do 10) e quando a configuração não pôde ser lida (o absoluto acerta com qualquer configuração);
 *   vira `relativo` quando o relativo sai 1:1 — aí não há o que corrigir, e o relativo é o que serve
 *   também a jogo;
 * - `compensado` (bancada) precisa do modelo; sem ele, cai para o absoluto, dizendo por quê.
 */
export function resolverSaidaDoMouse(
  pedido: PedidoDeSaidaDoMouse,
  parametros: ParametrosDoPonteiro | undefined,
  modelo: ModeloDaAceleracao | undefined,
): SaidaResolvida {
  // O motivo diz a chave, e não a variável de ambiente: o pedido pode ter vindo do
  // `controle.config.json`, e a origem exata já está na linha de configuração efetiva da partida.
  switch (pedido) {
    case 'relativo':
      return { efetivo: 'relativo', motivo: 'pedido explícito (saidaMouse=relativo)' };
    case 'absoluto':
      return { efetivo: 'absoluto', motivo: 'pedido explícito (saidaMouse=absoluto)' };
    case 'compensado':
      if (modelo === undefined) {
        return {
          efetivo: 'absoluto',
          motivo: 'compensado pedido, mas a curva do Windows não pôde ser lida ou invertida',
        };
      }
      return { efetivo: 'compensado', motivo: 'pedido de bancada (curva inversa)' };
    case 'auto':
      if (parametros === undefined) {
        return {
          efetivo: 'absoluto',
          motivo: 'auto: configuração de ponteiro ilegível — o absoluto acerta com qualquer uma',
        };
      }
      if (aceleracaoEstaLigada(parametros)) {
        return { efetivo: 'absoluto', motivo: 'auto: aceleração de ponteiro ligada' };
      }
      if (parametros.velocidade !== VELOCIDADE_NEUTRA) {
        return {
          efetivo: 'absoluto',
          motivo: `auto: velocidade do ponteiro ${String(parametros.velocidade)}/20 multiplica o relativo`,
        };
      }
      return { efetivo: 'relativo', motivo: 'auto: aceleração desligada e velocidade 10 — o relativo sai 1:1' };
  }
}

/** O estado da aceleração, em palavra. */
export function estadoDaAceleracao(parametros: ParametrosDoPonteiro | undefined): EstadoDaAceleracao {
  if (parametros === undefined) return 'desconhecida';
  return aceleracaoEstaLigada(parametros) ? 'ligada' : 'desligada';
}

/** A descrição completa que o backend expõe (log de partida e painel). */
export function descreverSaidaDoMouse(
  pedido: PedidoDeSaidaDoMouse,
  parametros: ParametrosDoPonteiro | undefined,
  resolvida: SaidaResolvida,
): DescricaoDaSaidaDoMouse {
  return {
    pedido,
    efetivo: resolvida.efetivo,
    aceleracao: estadoDaAceleracao(parametros),
    velocidade: parametros?.velocidade,
    relativoSaiFiel: parametros === undefined ? undefined : relativoSaiFiel(parametros),
    motivo: resolvida.motivo,
  };
}
