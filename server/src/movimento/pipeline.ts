/**
 * O pipeline de movimento — a cadeia da seção 3 do ARQUITETURA.md, na ordem em que ela está lá:
 *
 * ```
 * gx,gy,gz (rad/s, cru)
 *   → 1. desconta bias        (calibração: média com o aparelho parado — ATI-009)
 *   → 2. escolhe eixos        (orientação do perfil; espaço local na v1 — `eixos.ts`)
 *   → 3. aplica zona morta    (com transição suave: sem degrau ao cruzar o limiar)
 *   → 4. suaviza              (filtro adaptativo 1€, o padrão — `filtro-adaptativo.ts`, ATI-033 —
 *                              ou média exponencial: s = a·x + (1−a)·s_anterior)
 *   → 5. aplica sensibilidade (pixels por grau, separado em X e Y, com inversão opcional)
 *   → 6. integra pelo dt real (dx = ω · dt, com o dt medido **no aparelho**)
 *   → 7. acumula subpixel     (guarda a fração; sem isso, movimento lento vira zero)
 *   → dx, dy inteiros → destino.moverMouseRelativo()
 * ```
 *
 * Antes da cadeia vêm quatro guardas, e cada uma existe por causa de um defeito conhecido:
 *
 * | Guarda | Defeito que ela evita |
 * |---|---|
 * | `seq` fora de ordem | reproduzir amostra velha em lote, que vira salto de cursor |
 * | primeira após retomar | integrar contra um passado que não existe mais |
 * | `dtMs` imprestável | um `dt` de 3 s multiplicando a velocidade angular |
 * | atraso acima do teto | o engasgo de rede virando movimento acumulado de uma vez |
 *
 * ⚠️ **CAMINHO QUENTE**: `processar` roda uma vez por pacote, 100 vezes por segundo, para sempre.
 * Não existe aqui dentro nenhuma alocação, nenhum log, nenhuma exceção e nenhuma string — só
 * números em campos já criados (regra 2 do CLAUDE.md). Diagnóstico é contador agregado, e é por
 * isso que `ContadoresDoPipeline` tem um campo por motivo de descarte.
 *
 * ## Os três erros clássicos que este arquivo existe para não cometer
 *
 * 1. **Não descontar bias** — giroscópio parado acusa 0,002–0,02 rad/s, e o cursor caminha
 *    sozinho. Etapa 1, mais a zona morta da etapa 3 como segunda tranca.
 * 2. **Integrar pelo relógio do PC** — o jitter da rede vira tremor na mão de quem usa. O `dt`
 *    sai de `pacote.dtMs`, medido no aparelho; o relógio do PC entra **só** na conta de atraso,
 *    que decide descarte e nunca deslocamento.
 * 3. **Truncar a fração a cada amostra** — movimento lento gera 0,4 px por amostra, e sem
 *    acumulador ele vira zero para sempre. Etapa 7.
 *
 * ## Estado guardado é estado que precisa de dono
 *
 * A cadeia carrega memória entre amostras (média exponencial, fração de pixel, ordem de `seq`,
 * régua de atraso), e memória que sobrevive a uma mudança de contexto vira salto de cursor. Os
 * três momentos em que ela é esquecida, e por quê:
 *
 * | Momento | O que é esquecido | Por quê |
 * |---|---|---|
 * | retomada, centralizar, pausa, fim de sessão, reancoragem | tudo (`reiniciar`) | não há passado contra o qual integrar |
 * | religar o giro (`ativo` de `false` para `true`) | tudo | o que estava guardado é de antes da pausa |
 * | trocar orientação ou inversão de eixo | só a média (`trocasDeReferencial`) | o resíduo foi medido em outro referencial e sairia para o lado errado |
 *
 * E um momento em que ela **não** é esquecida, de propósito: mexer em sensibilidade, zona morta,
 * suavização, limite ou bias. Zerar ali engasgaria o cursor a cada passo do controle deslizante.
 */

import { performance } from 'node:perf_hooks';
import {
  FLAG_PRIMEIRA_APOS_RETOMAR,
  TIPO_MOVIMENTO,
  type PacoteDecodificado,
} from '../protocolo/indice.js';
import { compararSeq } from '../transporte/metricas.js';
import { resolverAjustes, type AjustesDoGiro, type AjustesParciais } from './ajustes.js';
import { mapaDeEixos } from './eixos.js';
import { criarFiltroAdaptativo } from './filtro-adaptativo.js';
import {
  criarContadoresDoPipeline,
  somarContadoresDoPipeline,
  zerarContadoresDoPipeline,
  GRAUS_POR_RADIANO,
  RADIANOS_POR_GRAU,
  RESULTADO_DE_MOVIMENTO,
  type ContadoresDoPipeline,
  type DestinoDeMovimento,
  type ResultadoDeMovimento,
} from './tipos.js';

/**
 * Quantos descartes seguidos por atraso até reancorar a referência de tempo.
 *
 * O atraso é medido contra o caminho mais rápido já visto na sessão. Se o caminho **piorar de
 * vez** (o Wi-Fi entrou no lugar do cabo, o celular baixou o clock), essa referência vira uma
 * régua velha e todo pacote passa a ser "atrasado" — o cursor congelaria para sempre. Depois de
 * 25 descartes seguidos (0,25 s a 100 Hz) a régua é refeita com a amostra atual, e o estado da
 * suavização é zerado junto: o que estava guardado ali é de antes do engasgo.
 */
export const DESCARTES_ATE_REANCORAR = 25;

export interface OpcoesDoPipeline {
  /** Para onde vão os pixels. Um `BackendDeEntrada` serve sem adaptador. */
  readonly destino: DestinoDeMovimento;
  /** Ajustes iniciais; o que não vier fica no padrão de fábrica (`AJUSTES_PADRAO`). */
  readonly ajustes?: AjustesParciais | undefined;
  /**
   * Relógio **monotônico** em ms, usado só para medir atraso de chegada. O padrão é
   * `performance.now()`; o teste passa o próprio para não depender de tempo real.
   */
  readonly relogio?: (() => number) | undefined;
}

export interface PipelineDeMovimento {
  /** Ajustes efetivos, congelados. Trocam por inteiro em `ajustar()`. */
  readonly ajustes: AjustesDoGiro;
  /**
   * Contadores **da sessão atual**, vivos; o objeto é sempre o mesmo (não copie esperando cópia).
   *
   * Zerados em `fecharContadoresDaSessao()`, que o fim de sessão chama **depois** de pôr o resumo
   * no log (ATI-028). Antes disso o "resumo da sessão" mostrava o acumulado do processo: a segunda
   * sessão aparecia com `amostras=202` quando tinha recebido 101. Quem quer o total da execução lê
   * `totalDoProcesso()`, que tem o nome do que é.
   */
  readonly contadores: ContadoresDoPipeline;
  /** Quantas vezes `fecharContadoresDaSessao()` fechou uma sessão desde a criação (ou o zerar). */
  readonly sessoesFechadas: number;
  /** Destino ligado a este pipeline. */
  readonly destino: DestinoDeMovimento;
  /** Pixels inteiros emitidos na última amostra (0 quando nada foi emitido). */
  readonly ultimoDx: number;
  readonly ultimoDy: number;
  /** Fração de pixel guardada no acumulador de cada eixo — sempre em (−1, 1). */
  readonly fracaoX: number;
  readonly fracaoY: number;

  /** ⚠️ Caminho quente. Processa um pacote decodificado e devolve o que aconteceu com ele. */
  processar(pacote: PacoteDecodificado): ResultadoDeMovimento;

  /**
   * Troca ajustes (caminho frio: `config` do app, troca de perfil). Devolve os efetivos.
   *
   * Duas trocas mexem no estado guardado, porque invalidam o referencial em que ele foi medido:
   *
   * - **orientação, `inverterX` ou `inverterY`** zeram a média exponencial (`trocasDeReferencial`).
   *   Sem isso, o resíduo do gesto anterior sai depois da troca — para o lado contrário, já que a
   *   inversão é aplicada **depois** da média. Medido na rodada 1: 2439 px de cursor fantasma com
   *   o aparelho parado, no topo das faixas de `ajustes.ts`.
   * - **religar o giro** (`ativo` de `false` para `true`) esquece tudo, como uma retomada: o que
   *   estava guardado é de antes da pausa.
   *
   * Sensibilidade, zona morta, suavização, limite e bias **não** esquecem nada: engasgariam o
   * cursor a cada passo do controle deslizante do app.
   */
  ajustar(pedido: AjustesParciais): AjustesDoGiro;

  /** Atalho de `ajustar` para a calibração de bias (ATI-009), em rad/s. */
  definirBias(gx: number, gy: number, gz: number): AjustesDoGiro;

  /**
   * Zera o estado com memória: suavização, acumulador de subpixel, ordem de `seq` e referência
   * de atraso. É o que **centralizar**, **pausar** e a troca de perfil precisam chamar — sem
   * isso sobra movimento guardado que sai depois do salto do cursor (ATI-009).
   */
  reiniciar(): void;

  /**
   * Fecha a conta da sessão: soma `contadores` no total do processo e zera `contadores` no mesmo
   * objeto. Caminho frio, uma vez por sessão — o caminho quente não paga nada pelo total.
   *
   * ⚠️ É do **fim de sessão**, e não de `reiniciar()`: `centralizar`, retomada e reancoragem
   * também reiniciam o estado, e nenhum deles encerra a sessão de ninguém.
   */
  fecharContadoresDaSessao(): void;

  /**
   * O total **do processo**: as sessões já fechadas mais a atual. Objeto novo a cada chamada
   * (aloca) — nunca no caminho quente.
   */
  totalDoProcesso(): ContadoresDoPipeline;

  /**
   * Zera **tudo** — a sessão atual e o total do processo. É ferramenta de medição (teste,
   * bancada); o fim de sessão usa `fecharContadoresDaSessao()`, que não perde número nenhum.
   */
  zerarContadores(): void;
}

export function criarPipelineDeMovimento(opcoes: OpcoesDoPipeline): PipelineDeMovimento {
  const destino = opcoes.destino;
  const relogio = opcoes.relogio ?? (() => performance.now());
  /** Da sessão atual — o único que o caminho quente toca. */
  const contadores = criarContadoresDoPipeline();
  /**
   * Soma das sessões **já fechadas**. Só é escrito em `fecharContadoresDaSessao()`, uma vez por
   * sessão: manter o total vivo no caminho quente custaria um segundo incremento por campo, a
   * 100 Hz, para um número que só é lido no fim da execução.
   */
  const sessoesAnteriores = criarContadoresDoPipeline();
  let sessoesFechadas = 0;

  let ajustes: AjustesDoGiro = resolverAjustes(opcoes.ajustes);

  /* ---------------------------------------------------------- derivados (caminho frio) */
  // Tudo que dá para calcular uma vez é calculado uma vez. A conversão de pixel por grau para
  // pixel por radiano é o exemplo do porquê: ela é uma multiplicação por 57,2957…, e fazê-la por
  // amostra seria pagar 100 vezes por segundo por um número que não muda.
  let ganhoX = 0;
  let ganhoY = 0;
  let zonaMortaRadPorS = 0;
  let alfa = 1;
  let umMenosAlfa = 0;
  let limitePixels = 0;
  let dtMaximoMs = 0;
  let atrasoMaximoMs = 0;
  let biasGx = 0;
  let biasGy = 0;
  let biasGz = 0;
  let horizontalDeGx = 0;
  let horizontalDeGy = 0;
  let horizontalDeGz = 0;
  let verticalDeGx = 0;
  let verticalDeGy = 0;
  let verticalDeGz = 0;
  let ativo = true;
  /** Etapa 4 pelo filtro adaptativo (ATI-033) em vez da média exponencial. */
  let filtroEuro = false;
  let filtroAplicado = ajustes.filtro;
  /**
   * O filtro adaptativo (ATI-033). Existe sempre, mesmo com a média exponencial valendo: trocar de
   * filtro é caminho frio e não pode alocar nada no meio de uma sessão.
   */
  const filtroAdaptativo = criarFiltroAdaptativo();
  /**
   * Deslocamento desta amostra, em pixels, antes do teto — `[x, y]`. Os dois filtros da etapa 4
   * escrevem aqui e a etapa 6 lê daqui: um `let` atribuído nos dois ramos juntaria dois números
   * quebrados numa variável só, e o motor faz essa junção com caixa no heap (ver o teto da etapa 6).
   */
  const deslocamentoBruto = new Float64Array(2);

  /**
   * Referencial com que o estado guardado na média exponencial foi medido.
   *
   * A média mora **antes** da sensibilidade e depois da escolha de eixos, então ela está sempre no
   * referencial que valia quando foi escrita. Trocar `orientacao` muda qual eixo do sensor alimenta
   * cada direção, e trocar `inverterX`/`inverterY` troca o sinal do ganho — nos dois casos o
   * resíduo guardado sai para o lado errado. Guardar o referencial aplicado é o que permite
   * perceber a troca em `aplicarDerivados()`, que é caminho frio.
   */
  let orientacaoAplicada = ajustes.orientacao;
  let inverterXAplicado = ajustes.inverterX;
  let inverterYAplicado = ajustes.inverterY;

  /**
   * @param partida `true` só na montagem, onde não há estado anterior a invalidar.
   */
  function aplicarDerivados(partida = false): void {
    // Os dois motivos de esquecer o que estava guardado, decididos **antes** de os derivados
    // serem sobrescritos (é o valor antigo que diz se houve troca).
    const trocouReferencial =
      !partida &&
      (ajustes.orientacao !== orientacaoAplicada ||
        ajustes.inverterX !== inverterXAplicado ||
        ajustes.inverterY !== inverterYAplicado);
    const religou = !partida && ajustes.ativo && !ativo;
    const trocouFiltro = !partida && ajustes.filtro !== filtroAplicado;

    const mapa = mapaDeEixos(ajustes.orientacao);
    horizontalDeGx = mapa.horizontalDeGx;
    horizontalDeGy = mapa.horizontalDeGy;
    horizontalDeGz = mapa.horizontalDeGz;
    verticalDeGx = mapa.verticalDeGx;
    verticalDeGy = mapa.verticalDeGy;
    verticalDeGz = mapa.verticalDeGz;

    // Etapa 5 já resolvida: pixels por radiano, com a inversão do perfil embutida no sinal.
    ganhoX = ajustes.sensXPixelsPorGrau * GRAUS_POR_RADIANO * (ajustes.inverterX ? -1 : 1);
    ganhoY = ajustes.sensYPixelsPorGrau * GRAUS_POR_RADIANO * (ajustes.inverterY ? -1 : 1);

    zonaMortaRadPorS = ajustes.zonaMortaGrausPorS * RADIANOS_POR_GRAU;

    // `suavizacao` é quanto se suaviza; `a` da fórmula é o peso da amostra nova. Ver `ajustes.ts`.
    alfa = 1 - ajustes.suavizacao;
    umMenosAlfa = ajustes.suavizacao;

    // O adaptativo é reconfigurado sempre (é caminho frio e não aloca), e **não** esquece o estado
    // ao mudar de número: mesma regra da suavização, o controle deslizante não pode engasgar.
    filtroEuro = ajustes.filtro === 'euro';
    filtroAdaptativo.configurar(
      ajustes.filtroCorteMinimoHz,
      ajustes.filtroBeta,
      ajustes.filtroCorteDaVelocidadeHz,
    );
    filtroAplicado = ajustes.filtro;

    limitePixels = ajustes.limitePixelsPorAmostra;
    dtMaximoMs = ajustes.dtMaximoMs;
    atrasoMaximoMs = ajustes.atrasoMaximoMs;
    biasGx = ajustes.biasGxRadPorS;
    biasGy = ajustes.biasGyRadPorS;
    biasGz = ajustes.biasGzRadPorS;
    ativo = ajustes.ativo;
    orientacaoAplicada = ajustes.orientacao;
    inverterXAplicado = ajustes.inverterX;
    inverterYAplicado = ajustes.inverterY;

    // Religar o giro é retomada: o que estava guardado é de antes da pausa (podem ter passado
    // minutos), e a ordem de `seq` precisa reancorar. Vale o esquecimento inteiro.
    if (religou) {
      esquecerEstado();
      return;
    }
    // Já a troca de orientação ou de inversão invalida **só** a média: a fração de subpixel é
    // menos de um pixel e a régua de atraso não tem referencial nenhum. Zerar mais que isso
    // engasgaria o cursor a cada passo do controle deslizante do app (PROTOCOLO.md, seção 3.4).
    if (trocouReferencial) esquecerSuavizacao();
    // Trocar de filtro zera os dois, sem contar como troca de referencial (o referencial é o
    // mesmo). Sem isso, o que estava guardado no filtro que saiu de cena ficaria preso ali e sairia
    // de uma vez no dia em que ele voltasse. Custa no máximo o resíduo de um gesto — e a troca é de
    // configuração, não de controle deslizante.
    else if (trocouFiltro) zerarFiltros();
  }

  /* -------------------------------------------------------------- estado (caminho quente) */
  /**
   * O estado **fracionário** mora num `Float64Array`, e isso não é preciosismo.
   *
   * Variável de closure é fatia do contexto, que é objeto do heap com campo *tagged*: guardar um
   * número quebrado ali obriga o motor a criar uma caixa (`HeapNumber`) **a cada escrita** — cinco
   * caixas por amostra, 500 por segundo, para sempre. Medido antes da mudança: 13,6 B por amostra.
   * Num `Float64Array` o número é gravado cru, sem caixa nenhuma. É o mesmo motivo pelo qual
   * `transporte/sessao.ts` guarda os carimbos de ping num `Float64Array`.
   *
   * A cadeia lê o estado para variáveis locais no começo e escreve de volta no fim: local não é
   * fatia de contexto (o motor a mantém em registrador), então a conta do meio continua legível e
   * sem caixa. Índices nomeados abaixo.
   */
  const SUAVE_HORIZONTAL = 0;
  const SUAVE_VERTICAL = 1;
  const FRACAO_X = 2;
  const FRACAO_Y = 3;
  const REFERENCIA_DE_ATRASO = 4;
  const estado = new Float64Array(5);
  /** Ordem dos pacotes. */
  let ultimoSeq = 0;
  let temUltimoSeq = false;
  /**
   * `estado[REFERENCIA_DE_ATRASO]` guarda o menor `chegada − carimboDoAparelho` já visto. Os dois
   * relógios contam de origens diferentes (uptime do celular × início do processo), então o valor
   * absoluto não significa nada — o que significa é o quanto ele **piorou** desde o melhor caso.
   */
  let temReferenciaDeAtraso = false;
  let descartesSeguidosPorAtraso = 0;

  let ultimoDx = 0;
  let ultimoDy = 0;

  /** Esquece tudo que tem memória. Não mexe em contador: o histórico da sessão continua. */
  function esquecerEstado(): void {
    estado.fill(0);
    filtroAdaptativo.zerar();
    temUltimoSeq = false;
    temReferenciaDeAtraso = false;
    descartesSeguidosPorAtraso = 0;
    contadores.reinicios += 1;
  }

  /**
   * Esquece **só** a média exponencial — o que a troca de referencial invalida.
   *
   * A fração de subpixel e a régua de atraso ficam: a fração vale menos de um pixel e a régua não
   * tem referencial de eixo nenhum. Zerar as três a cada ajuste faria o cursor engasgar enquanto a
   * pessoa arrasta o controle deslizante de sensibilidade.
   */
  function esquecerSuavizacao(): void {
    zerarFiltros();
    contadores.trocasDeReferencial += 1;
  }

  /**
   * Zera o que os dois filtros da etapa 4 guardam. O pendente do adaptativo (ATI-033) mora no
   * mesmo lugar da cadeia que a média — depois dos eixos, antes da inversão — e por isso sai para o
   * lado errado nos mesmos casos: quem zera um zera o outro.
   */
  function zerarFiltros(): void {
    estado[SUAVE_HORIZONTAL] = 0;
    estado[SUAVE_VERTICAL] = 0;
    filtroAdaptativo.zerar();
  }

  // Só agora: os dois esquecimentos acima mexem em `estado`, que acabou de nascer.
  aplicarDerivados(true);

  /**
   * ⚠️ CAMINHO QUENTE — 100 Hz. Sem alocação, sem log, sem exceção.
   *
   * A ordem das guardas é a ordem do custo: primeiro o que é uma comparação de inteiro, por
   * último o que precisa ler o relógio.
   */
  function processar(pacote: PacoteDecodificado): ResultadoDeMovimento {
    ultimoDx = 0;
    ultimoDy = 0;

    // BOTÃO, EIXO e SCROLL passam por aqui no mesmo gancho do transporte: não são assunto deste
    // módulo e saem antes de qualquer contador, para não poluir a estatística de movimento.
    if (pacote.tipo !== TIPO_MOVIMENTO) return RESULTADO_DE_MOVIMENTO.NAO_E_MOVIMENTO;

    contadores.amostrasRecebidas += 1;

    if (!ativo) {
      contadores.amostrasComGiroDesligado += 1;
      // A ordem continua sendo escriturada com o giro desligado, e isso não é detalhe: o aparelho
      // segue mandando 100 pacotes por segundo com o giro desligado no perfil. Se `ultimoSeq`
      // congelasse aqui, bastariam 32768 pacotes (~5,5 min) para o `seq` passar da meia-volta do
      // u16 e **todo** pacote novo passar a parecer velho para `compararSeq` — o cursor ficaria
      // morto depois de religar, sem caminho de recuperação e com `descartadasPorOrdem` subindo
      // como única pista, que é a pista mais enganosa possível.
      ultimoSeq = pacote.seq;
      temUltimoSeq = true;
      return RESULTADO_DE_MOVIMENTO.DESLIGADO;
    }

    // Guarda 1 — ordem. O transporte já descarta MOVIMENTO fora de ordem (sessao.ts), mas o
    // pipeline não pode depender disso: ele também é alimentado direto por teste, simulador e
    // captura reproduzida, e "nunca reproduzir em lote" é regra da cadeia, não do transporte.
    if (temUltimoSeq && compararSeq(pacote.seq, ultimoSeq) <= 0) {
      contadores.descartadasPorOrdem += 1;
      return RESULTADO_DE_MOVIMENTO.FORA_DE_ORDEM;
    }
    ultimoSeq = pacote.seq;
    temUltimoSeq = true;

    // Guarda 2 — primeira amostra depois de retomar (PROTOCOLO.md, seção 4.1, bit2). Ela não tem
    // amostra anterior contra a qual integrar: o estado é zerado e nada é emitido.
    if ((pacote.flags & FLAG_PRIMEIRA_APOS_RETOMAR) !== 0) {
      esquecerEstado();
      ultimoSeq = pacote.seq;
      temUltimoSeq = true;
      contadores.retomadas += 1;
      return RESULTADO_DE_MOVIMENTO.RETOMADA;
    }

    // Guarda 3 — o `dt` do aparelho. `!(dtMs > 0)` pega de uma vez zero, negativo e `NaN`.
    const dtMs = pacote.dtMs;
    if (!(dtMs > 0) || dtMs > dtMaximoMs) {
      contadores.descartadasPorDt += 1;
      return RESULTADO_DE_MOVIMENTO.DT_INVALIDO;
    }

    // Guarda 4 — atraso de chegada. O relógio do PC entra **só aqui**, e só para decidir
    // descarte: o deslocamento continua saindo do `dtMs` medido no aparelho.
    const chegadaMs = relogio();
    const distanciaMs = chegadaMs - pacote.tDispositivoMs;
    if (!temReferenciaDeAtraso) {
      estado[REFERENCIA_DE_ATRASO] = distanciaMs;
      temReferenciaDeAtraso = true;
    } else {
      const atrasoMs = distanciaMs - (estado[REFERENCIA_DE_ATRASO] ?? 0);
      if (atrasoMs < 0) {
        // Caminho mais rápido do que qualquer um já visto: é a nova régua.
        estado[REFERENCIA_DE_ATRASO] = distanciaMs;
        descartesSeguidosPorAtraso = 0;
      } else if (atrasoMs > atrasoMaximoMs) {
        contadores.descartadasPorAtraso += 1;
        descartesSeguidosPorAtraso += 1;
        if (descartesSeguidosPorAtraso >= DESCARTES_ATE_REANCORAR) {
          contadores.reancoragens += 1;
          // Zera primeiro (a suavização guardada é de antes do engasgo) e só então planta a régua
          // nova e a ordem atual — `esquecerEstado` apaga as duas coisas.
          esquecerEstado();
          estado[REFERENCIA_DE_ATRASO] = distanciaMs;
          temReferenciaDeAtraso = true;
          ultimoSeq = pacote.seq;
          temUltimoSeq = true;
        }
        return RESULTADO_DE_MOVIMENTO.ATRASADA;
      } else {
        descartesSeguidosPorAtraso = 0;
      }
    }
    // A volta do `tDispositivoMs` (u32, ~49,7 dias de uptime do aparelho) **não** cai no ramo de
    // cima: ela faz `distanciaMs` crescer 2³², então o pacote parece atrasadíssimo e o conserto
    // vem pelo caminho da reancoragem — 25 descartes seguidos (0,25 s de cursor parado) e a régua
    // é refeita. Medido, e o número é bom: 0,25 s a cada 49,7 dias.

    /* ----------------------------------------------------------------- 1. desconta o bias */
    const cruGx = pacote.gx - biasGx;
    const cruGy = pacote.gy - biasGy;
    const cruGz = pacote.gz - biasGz;

    /* ------------------------------------------------------------------- 2. escolhe eixos */
    let horizontal = cruGx * horizontalDeGx + cruGy * horizontalDeGy + cruGz * horizontalDeGz;
    let vertical = cruGx * verticalDeGx + cruGy * verticalDeGy + cruGz * verticalDeGz;

    // `f32` passa cru no fio (PROTOCOLO.md, seção 4.0, regra 7): `NaN` e infinito chegam aqui de
    // verdade, e quem decide o que fazer com eles é este módulo. Um `NaN` que entrasse na média
    // exponencial envenenaria o estado **para sempre** — o cursor pararia até a próxima retomada.
    if (!Number.isFinite(horizontal) || !Number.isFinite(vertical)) {
      contadores.descartadasPorLeituraInvalida += 1;
      return RESULTADO_DE_MOVIMENTO.LEITURA_INVALIDA;
    }

    /* ------------------------------------------------- 3. zona morta com transição suave */
    // Corte seco (`< limiar → 0`) cria um degrau: a mão treme perto do limiar e o cursor pula de
    // parado para o valor cheio. Aqui o que sobra acima do limiar é **reescalado**, então a saída
    // cresce de zero a partir do limiar em vez de saltar. A conta é feita sobre a magnitude do
    // vetor, e não eixo a eixo: por eixo, um movimento diagonal lento perderia só uma das
    // componentes e a direção do cursor sairia torta.
    if (zonaMortaRadPorS > 0) {
      const magnitude = Math.sqrt(horizontal * horizontal + vertical * vertical);
      if (magnitude <= zonaMortaRadPorS) {
        horizontal = 0;
        vertical = 0;
        contadores.zeradasPorZonaMorta += 1;
        // Atalho do caso mais comum de todos — aparelho na mesa, onde a zona morta zera **e** a
        // média já escoou até zero (6000 de 6001 amostras na série de 60 s parado). Daqui para
        // baixo a cadeia só produziria zero: entrada zero com média zero mantém a média em zero,
        // o deslocamento em zero e a fração intocada (ela vale menos de um pixel, e `trunc` dela
        // é zero). Sair aqui devolve exatamente o mesmo resultado e os mesmos contadores, e a
        // comparação a mais só é paga na amostra que já foi zerada — nunca na que está movendo.
        //
        // Com o filtro adaptativo (ATI-033) a pergunta é a mesma — "o filtro tem algo guardado?" —
        // e quem responde é ele: nada pendente e rapidez estimada em zero.
        if (
          filtroEuro
            ? filtroAdaptativo.vazio()
            : estado[SUAVE_HORIZONTAL] === 0 && estado[SUAVE_VERTICAL] === 0
        ) {
          contadores.amostrasSemMovimento += 1;
          return RESULTADO_DE_MOVIMENTO.SEM_MOVIMENTO;
        }
      } else {
        const fator = (magnitude - zonaMortaRadPorS) / magnitude;
        horizontal *= fator;
        vertical *= fator;
      }
    }

    /* ------------------------------------------------------------------------ 4. suaviza */
    // A amostra zerada pela zona morta **continua** entrando aqui, de propósito: é assim que o
    // que estava guardado no filtro decai até parar. Sair antes deixaria resíduo preso no estado.
    const dtSegundos = dtMs / 1000;
    if (filtroEuro) {
      // Filtro adaptativo (ATI-033). Ele trabalha na **posição** (é o que conserva o
      // deslocamento com corte variável — ver `filtro-adaptativo.ts`), então devolve o ângulo
      // girado nesta amostra: as etapas 5 e 6 viram uma multiplicação pelo ganho.
      filtroAdaptativo.entrada[0] = horizontal;
      filtroAdaptativo.entrada[1] = vertical;
      filtroAdaptativo.entrada[2] = dtSegundos;
      filtroAdaptativo.filtrar();
      deslocamentoBruto[0] = (filtroAdaptativo.saida[0] ?? 0) * ganhoX;
      deslocamentoBruto[1] = (filtroAdaptativo.saida[1] ?? 0) * ganhoY;
    } else {
      // Média exponencial de coeficiente fixo (ATI-008), conta idêntica à de antes da ATI-033.
      const suaveHorizontal = alfa * horizontal + umMenosAlfa * (estado[SUAVE_HORIZONTAL] ?? 0);
      const suaveVertical = alfa * vertical + umMenosAlfa * (estado[SUAVE_VERTICAL] ?? 0);
      estado[SUAVE_HORIZONTAL] = suaveHorizontal;
      estado[SUAVE_VERTICAL] = suaveVertical;

      /* ------------------------------------------------------------- 5. sensibilidade */
      const pixelsPorSegundoX = suaveHorizontal * ganhoX;
      const pixelsPorSegundoY = suaveVertical * ganhoY;

      /* ----------------------------------------- 6. integra pelo dt medido no aparelho */
      deslocamentoBruto[0] = pixelsPorSegundoX * dtSegundos;
      deslocamentoBruto[1] = pixelsPorSegundoY * dtSegundos;
    }
    const brutoX = deslocamentoBruto[0] ?? 0;
    const brutoY = deslocamentoBruto[1] ?? 0;

    // Proteção contra pico de sensor, ainda dentro da etapa 6: o teto vale para o deslocamento
    // **desta** amostra, antes de a fração entrar no acumulador. Limitar depois do acumulador
    // deixaria o pico guardado e ele sairia nas amostras seguintes, que é o mesmo salto com
    // atraso.
    //
    // `Math.min`/`Math.max` e não `if (x > teto) x = teto`: a versão com atribuição obriga o
    // motor a juntar dois caminhos num valor só, e ele o faz na representação genérica — o que
    // custava uma caixa de número por amostra. Medido: 14,2 B/amostra com `if`, 2,9 B com estas
    // duas linhas. O contador vem da comparação, que é entre números crus e não aloca nada.
    const deslocamentoX = Math.min(Math.max(brutoX, -limitePixels), limitePixels);
    const deslocamentoY = Math.min(Math.max(brutoY, -limitePixels), limitePixels);
    if (deslocamentoX !== brutoX || deslocamentoY !== brutoY) contadores.limitadasPorPico += 1;

    /* ------------------------------------------------------------- 7. acumula subpixel */
    // `SendInput` só aceita inteiro. Movimento lento gera 0,4 px por amostra: truncar a cada
    // amostra faria o cursor **nunca** andar. O inteiro sai, a fração fica.
    //
    // O `| 0` depois do `Math.trunc` não é enfeite: truncar um número entre −1 e 0 devolve **−0**,
    // que não é inteiro pequeno para o motor — guardá-lo custa uma caixa no heap, e é o que
    // acontece em toda amostra parada de movimento lento. O `| 0` devolve zero positivo e mantém
    // o resultado como inteiro de máquina (o valor já vem limitado a `limitePixelsPorAmostra`,
    // muito abaixo do limite de 32 bits). Medido: 2,9 B/amostra sem ele, 0,02 B com ele.
    const somaX = (estado[FRACAO_X] ?? 0) + deslocamentoX;
    const somaY = (estado[FRACAO_Y] ?? 0) + deslocamentoY;
    const pixelsX = Math.trunc(somaX) | 0;
    const pixelsY = Math.trunc(somaY) | 0;
    estado[FRACAO_X] = somaX - pixelsX;
    estado[FRACAO_Y] = somaY - pixelsY;

    ultimoDx = pixelsX;
    ultimoDy = pixelsY;

    if (pixelsX === 0 && pixelsY === 0) {
      contadores.amostrasSemMovimento += 1;
      return RESULTADO_DE_MOVIMENTO.SEM_MOVIMENTO;
    }

    contadores.amostrasAplicadas += 1;
    contadores.pixelsX += pixelsX;
    contadores.pixelsY += pixelsY;
    destino.moverMouseRelativo(pixelsX, pixelsY);
    return RESULTADO_DE_MOVIMENTO.APLICADO;
  }

  return {
    get ajustes() {
      return ajustes;
    },
    contadores,
    destino,
    get ultimoDx() {
      return ultimoDx;
    },
    get ultimoDy() {
      return ultimoDy;
    },
    get fracaoX() {
      return estado[FRACAO_X] ?? 0;
    },
    get fracaoY() {
      return estado[FRACAO_Y] ?? 0;
    },

    processar,

    ajustar(pedido) {
      ajustes = resolverAjustes(pedido, ajustes);
      aplicarDerivados();
      return ajustes;
    },

    definirBias(gx, gy, gz) {
      ajustes = resolverAjustes(
        { biasGxRadPorS: gx, biasGyRadPorS: gy, biasGzRadPorS: gz },
        ajustes,
      );
      aplicarDerivados();
      return ajustes;
    },

    reiniciar: esquecerEstado,

    get sessoesFechadas() {
      return sessoesFechadas;
    },

    fecharContadoresDaSessao() {
      somarContadoresDoPipeline(sessoesAnteriores, contadores);
      zerarContadoresDoPipeline(contadores);
      sessoesFechadas += 1;
    },

    totalDoProcesso() {
      const total = criarContadoresDoPipeline();
      somarContadoresDoPipeline(total, sessoesAnteriores);
      somarContadoresDoPipeline(total, contadores);
      return total;
    },

    zerarContadores() {
      zerarContadoresDoPipeline(contadores);
      zerarContadoresDoPipeline(sessoesAnteriores);
      sessoesFechadas = 0;
    },
  };
}
