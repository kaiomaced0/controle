/**
 * Medidas de qualidade de uma sessão de transporte (PROTOCOLO.md, seção 7).
 *
 * Este módulo é a resposta à pergunta "o canal está bom?" em número: taxa realmente medida,
 * estabilidade do `dt` do sensor, latência do canal e quantidade de pacote perdido ou fora de
 * ordem. A ATI-006 (telemetria ao vivo) consome daqui — por isso a leitura é uma função só,
 * `instantaneo()`, que devolve tudo de uma vez, com os nomes **da tabela da seção 7**.
 *
 * ⚠️ CAMINHO QUENTE nas funções `registrar*`: elas rodam uma vez por pacote, 100 vezes por
 * segundo. Só somam números em campos já alocados — nada de array, objeto, string ou log
 * (regra 2 do CLAUDE.md). A única alocação do módulo é o objeto de `instantaneo()`, que roda na
 * frequência da interface (~10 Hz), não na do sensor.
 *
 * Relógio: quem chama passa `agoraMs` de um relógio **monotônico** (`performance.now()` no
 * servidor). Relógio de parede voltaria no ajuste de horário e produziria taxa negativa.
 */

import type { ContadoresDoCodec } from '../protocolo/indice.js';

/** Janela de apuração de `taxaHzMedida` e das estatísticas de `dt` (PROTOCOLO.md, seção 7). */
export const JANELA_DE_MEDICAO_MS = 1000;

/**
 * Quantas amostras de RTT ficam guardadas para o cálculo dos percentis.
 *
 * Com ping a cada 1 s, 128 amostras são os últimos ~2 minutos de canal — janela suficiente para
 * o p95 significar alguma coisa e pequena o bastante para a ordenação da leitura ser irrelevante.
 */
export const CAPACIDADE_DE_RTT = 128;

/** Medidas de uma sessão num instante. Objeto novo por leitura — nunca chamado por pacote. */
export interface MedidasDaSessao {
  /* --- fluxo (vêm dos contadores do codec, que já conta por sessão) --- */
  readonly pacotesRecebidos: number;
  readonly bytesRecebidos: number;
  /** `descartadosPorTamanho + descartadosPorTipo`, como manda a seção 7. */
  readonly descartados: number;
  readonly descartadosPorTamanho: number;
  readonly descartadosPorTipo: number;
  readonly comBytesExtras: number;
  /**
   * Quantas `DataView` o decodificador precisou criar.
   *
   * Nasceu como "prova do zero alocação por pacote" (PROTOCOLO.md, seção 7) e **hoje não prova
   * isso no caminho do `ws`**: cada quadro chega num `Buffer` com `ArrayBuffer` próprio, então a
   * vista é refeita quase toda vez (medido: 385 vistas para 385 pacotes). Continua sendo a
   * medida honesta do reaproveitamento — só que o número atual diz que ele não acontece. Ver
   * `README.md` do módulo.
   */
  readonly visoesCriadas: number;
  /**
   * Pacotes binários bem-formados que chegaram no sentido errado (RUMBLE/HÁPTICO vindos do app).
   *
   * Ficam de fora de `descartados` de propósito: `descartados` é `porTamanho + porTipo` (seção 7)
   * e fala de **formato**. Este aqui é defeito de direção, e sem contador próprio o pacote sumia
   * depois de já ter entrado em `pacotesRecebidos` e `bytesRecebidos`.
   */
  readonly pacotesNoSentidoErrado: number;

  /* --- ordem --- */
  /** Pacotes cujo `seq` era anterior ao último recebido (PROTOCOLO.md, seção 4.1). */
  readonly foraDeOrdem: number;
  /**
   * Quantos desses foram efetivamente jogados fora.
   *
   * Não é o mesmo número que `foraDeOrdem`: MOVIMENTO atrasado é descartado (reproduzir gera
   * salto de cursor), mas BOTÃO/EIXO/SCROLL atrasado é entregue mesmo assim — descartar uma
   * soltura de botão é exatamente como se prende um botão (regra 5 do CLAUDE.md).
   */
  readonly descartadosForaDeOrdem: number;

  /* --- janela de 1 s --- */
  /** Pacotes por segundo na última janela fechada. 0 antes da primeira janela. */
  readonly taxaHzMedida: number;
  /** Média do `dtMs` carimbado pelo aparelho na última janela. */
  readonly dtMsMedio: number;
  /** Desvio padrão populacional do mesmo `dtMs` — o jitter da ponte JS do celular. */
  readonly dtMsDesvio: number;

  /* --- latência --- */
  readonly rttMsP50: number;
  readonly rttMsP95: number;
  /** Último RTT medido; útil para ver a latência "agora" sem esperar a estatística. */
  readonly rttMsUltimo: number;
  /** Quantas amostras entraram no cálculo dos percentis (no máximo `CAPACIDADE_DE_RTT`). */
  readonly amostrasDeRtt: number;
  /** Total de RTTs medidos desde o início da sessão, sem o limite do anel. */
  readonly pongsRecebidos: number;
  /**
   * `pong` bem-formado que foi ignorado por não bater com nenhum `ping` enviado.
   *
   * Sem este contador, um cliente que ecoe `tServidorMs` errado inflaria o RTT sem deixar rastro
   * — a estatística mentiria e ninguém saberia por quê.
   */
  readonly pongsRecusados: number;

  /** Tempo de vida da sessão até esta leitura. */
  readonly duracaoMs: number;
}

export interface MedidorDaSessao {
  /** ⚠️ Caminho quente. Um pacote aceito. */
  registrarPacote(agoraMs: number): void;
  /** ⚠️ Caminho quente. `dtMs` do MOVIMENTO; valor não positivo é ignorado (primeira amostra). */
  registrarDt(dtMs: number): void;
  /** ⚠️ Caminho quente. Pacote com `seq` anterior ao último; `descartado` diz se foi jogado fora. */
  registrarForaDeOrdem(descartado: boolean): void;
  /** ⚠️ Caminho quente. Pacote binário do servidor (RUMBLE/HÁPTICO) que chegou do app. */
  registrarSentidoErrado(): void;
  /** Uma vez por pong (1 Hz), fora do caminho quente. */
  registrarRtt(rttMs: number): void;
  /** Um `pong` que não casou com nenhum `ping` enviado; entra só no contador. */
  registrarPongRecusado(): void;
  /** Leitura completa. Fecha a janela vencida, se houver. Aloca um objeto — não chame por pacote. */
  instantaneo(agoraMs: number): MedidasDaSessao;
}

/**
 * Percentil pelo método *nearest-rank* sobre uma amostra **já ordenada**.
 *
 * Sem interpolação de propósito: o valor devolvido é um RTT que de fato aconteceu, e não uma
 * média entre dois. Para diagnóstico de canal isso é mais fácil de conferir contra o log.
 */
function percentil(ordenada: Float64Array, quantidade: number, fracao: number): number {
  if (quantidade <= 0) return 0;
  const posicao = Math.ceil(fracao * quantidade) - 1;
  const indice = posicao < 0 ? 0 : posicao >= quantidade ? quantidade - 1 : posicao;
  return ordenada[indice] ?? 0;
}

/**
 * Cria o medidor de uma sessão.
 *
 * @param contadores contadores do codec **daquela sessão** (o decodificador é um por sessão)
 * @param inicioMs   instante monotônico de abertura, usado por `duracaoMs`
 */
export function criarMedidorDaSessao(
  contadores: ContadoresDoCodec,
  inicioMs: number,
): MedidorDaSessao {
  // Janela corrente: só contadores primitivos, zerados a cada fechamento.
  let inicioDaJanelaMs = inicioMs;
  let pacotesNaJanela = 0;
  let amostrasDeDt = 0;
  let somaDeDt = 0;
  let somaDeDtAoQuadrado = 0;

  // Resultado da última janela fechada — é o que a leitura mostra.
  let taxaHzMedida = 0;
  let dtMsMedio = 0;
  let dtMsDesvio = 0;

  let foraDeOrdem = 0;
  let descartadosForaDeOrdem = 0;
  let pacotesNoSentidoErrado = 0;
  let pongsRecusados = 0;

  // Anel de RTT + buffer de ordenação, os dois alocados uma vez.
  const amostrasDeRtt = new Float64Array(CAPACIDADE_DE_RTT);
  const ordenacao = new Float64Array(CAPACIDADE_DE_RTT);
  let quantidadeDeRtt = 0;
  let proximoRtt = 0;
  let rttMsUltimo = 0;
  let pongsRecebidos = 0;

  /**
   * Fecha a janela quando ela venceu.
   *
   * O denominador é o tempo **decorrido de verdade**, não o `JANELA_DE_MEDICAO_MS` nominal: se o
   * fluxo parou por 10 s, a taxa honesta é "os poucos pacotes divididos por 10 s", e não a taxa
   * congelada da última janela cheia. Uma passada só, sem laço — silêncio longo não pode custar
   * mil iterações na leitura.
   */
  function fecharJanelaVencida(agoraMs: number): void {
    const decorridoMs = agoraMs - inicioDaJanelaMs;
    if (decorridoMs < JANELA_DE_MEDICAO_MS) return;

    taxaHzMedida = decorridoMs > 0 ? (pacotesNaJanela * 1000) / decorridoMs : 0;

    if (amostrasDeDt > 0) {
      const media = somaDeDt / amostrasDeDt;
      // Variância por E[x²] − E[x]²; o max(0) apara o resíduo negativo do ponto flutuante.
      const variancia = Math.max(0, somaDeDtAoQuadrado / amostrasDeDt - media * media);
      dtMsMedio = media;
      dtMsDesvio = Math.sqrt(variancia);
    } else {
      dtMsMedio = 0;
      dtMsDesvio = 0;
    }

    inicioDaJanelaMs = agoraMs;
    pacotesNaJanela = 0;
    amostrasDeDt = 0;
    somaDeDt = 0;
    somaDeDtAoQuadrado = 0;
  }

  return {
    registrarPacote(agoraMs) {
      fecharJanelaVencida(agoraMs);
      pacotesNaJanela += 1;
    },

    registrarDt(dtMs) {
      // `dtMs` 0 é a primeira amostra do ciclo (não há intervalo anterior); negativo e NaN só
      // apareceriam por defeito, e nenhum dos dois pode entrar na média.
      if (!(dtMs > 0)) return;
      amostrasDeDt += 1;
      somaDeDt += dtMs;
      somaDeDtAoQuadrado += dtMs * dtMs;
    },

    registrarForaDeOrdem(descartado) {
      foraDeOrdem += 1;
      if (descartado) descartadosForaDeOrdem += 1;
    },

    registrarSentidoErrado() {
      pacotesNoSentidoErrado += 1;
    },

    registrarPongRecusado() {
      pongsRecusados += 1;
    },

    registrarRtt(rttMs) {
      if (!Number.isFinite(rttMs) || rttMs < 0) return;
      rttMsUltimo = rttMs;
      pongsRecebidos += 1;
      amostrasDeRtt[proximoRtt] = rttMs;
      proximoRtt = (proximoRtt + 1) % CAPACIDADE_DE_RTT;
      if (quantidadeDeRtt < CAPACIDADE_DE_RTT) quantidadeDeRtt += 1;
    },

    instantaneo(agoraMs) {
      fecharJanelaVencida(agoraMs);

      // A cópia e a ordenação acontecem na frequência da interface (~10 Hz), nunca por pacote.
      ordenacao.set(amostrasDeRtt.subarray(0, quantidadeDeRtt));
      const janelaDeRtt = ordenacao.subarray(0, quantidadeDeRtt);
      janelaDeRtt.sort();

      return {
        pacotesRecebidos: contadores.pacotesRecebidos,
        bytesRecebidos: contadores.bytesRecebidos,
        descartados: contadores.descartadosPorTamanho + contadores.descartadosPorTipo,
        descartadosPorTamanho: contadores.descartadosPorTamanho,
        descartadosPorTipo: contadores.descartadosPorTipo,
        comBytesExtras: contadores.comBytesExtras,
        visoesCriadas: contadores.visoesCriadas,
        pacotesNoSentidoErrado,
        foraDeOrdem,
        descartadosForaDeOrdem,
        taxaHzMedida,
        dtMsMedio,
        dtMsDesvio,
        rttMsP50: percentil(janelaDeRtt, quantidadeDeRtt, 0.5),
        rttMsP95: percentil(janelaDeRtt, quantidadeDeRtt, 0.95),
        rttMsUltimo,
        amostrasDeRtt: quantidadeDeRtt,
        pongsRecebidos,
        pongsRecusados,
        duracaoMs: agoraMs - inicioMs,
      };
    },
  };
}

/**
 * Comparação de `seq` com a volta do u16 (RFC 1982, *serial number arithmetic*).
 *
 * Comparar `seq` cru quebra exatamente uma vez a cada 65536 pacotes — a 100 Hz, a cada ~11
 * minutos: o pacote 0 pareceria "anterior" ao 65535 e o fluxo inteiro viraria fora de ordem.
 * A diferença circular resolve isso: metade do espaço para a frente é futuro, metade é passado.
 *
 * @returns positivo se `seq` é posterior a `ultimo`, negativo se anterior, 0 se é o mesmo.
 */
export function compararSeq(seq: number, ultimo: number): number {
  const diferenca = (seq - ultimo) & 0xffff;
  if (diferenca === 0) return 0;
  return diferenca < 0x8000 ? 1 : -1;
}
