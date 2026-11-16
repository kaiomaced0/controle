/**
 * A recalibração automática de bias (ATI-009) — o que segura o cursor depois de uma hora.
 *
 * Três lados do comportamento estão aqui: ela **corrige** a deriva térmica sem que ninguém peça,
 * ela **não mexe em nada** enquanto a pessoa está usando o controle, e ela **sai sozinha** do
 * impasse em que a estimativa nasce longe da leitura de verdade (rodada 2: sem essa saída, o
 * mecanismo se desligava calado e não voltava mais na mesma sessão).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TIPO_BOTAO,
  TIPO_MOVIMENTO,
  criarPacoteDecodificado,
  proximoSeq,
} from '../protocolo/indice.js';
import { criarBackendDubla } from '../saida/dubla.js';
import { LIMITES_DA_CALIBRACAO } from './calibracao.js';
import { criarPipelineDeMovimento } from './pipeline.js';
import {
  ANGULO_DE_PROVA_GRAUS,
  CONSTANTE_DE_TEMPO_MS,
  ESPERA_ATE_AJUSTAR_MS,
  MODULO_DE_BIAS_PLAUSIVEL_GRAUS_POR_S,
  MODULO_MAXIMO_DO_REPLANTIO_GRAUS_POR_S,
  TEMPO_DE_LEITURA_SUSTENTADA_MS,
  criarAjusteAutomaticoDeBias,
  type AjusteAutomaticoDeBias,
} from './recalibracao.js';
import { GRAUS_POR_RADIANO, RADIANOS_POR_GRAU } from './tipos.js';

/** Cada aplicação recebida por quem "é o pipeline" nestes testes. */
interface Aplicacao {
  readonly gx: number;
  readonly gy: number;
  readonly gz: number;
}

/** Cada replantio da estimativa, como o log da produção o veria. */
interface Replantio extends Aplicacao {
  readonly tinhaEstimativa: boolean;
}

/**
 * Quantas amostras de 10 ms uma leitura de `moduloGrausPorS` precisa para replantar a estimativa.
 *
 * Duas coisas entram na conta:
 *
 * - o **tempo base** (2 s), que vale para toda leitura. São 201 amostras e não 200: a primeira
 *   **abre** a sequência (é ela quem diz contra o que as próximas serão comparadas) e o cronômetro
 *   só passa a somar `dtMs` a partir da segunda;
 * - a **prova de ângulo** (portão 3), cobrada acima da faixa de bias plausível: a leitura precisa
 *   se sustentar até que `módulo × tempo` passe de {@link ANGULO_DE_PROVA_GRAUS}.
 */
function amostrasAteReplantar(moduloGrausPorS: number): number {
  const provaDeAnguloMs =
    moduloGrausPorS > MODULO_DE_BIAS_PLAUSIVEL_GRAUS_POR_S
      ? (1000 * ANGULO_DE_PROVA_GRAUS) / moduloGrausPorS
      : 0;
  return Math.max(TEMPO_DE_LEITURA_SUSTENTADA_MS, provaDeAnguloMs) / 10 + 1;
}

/** Tela grande: o cursor virtual da dubla não pode bater na borda no meio de uma medição. */
const TELA_DE_BANCADA = { largura: 8000, altura: 8000 } as const;

/**
 * Bancada com o **pipeline de verdade** e a dubla da camada de saída.
 *
 * O portão do replantio não se prova com contador: ele se prova em pixel. Aqui o ajuste automático
 * fala com o `definirBias` do pipeline de verdade, com os ajustes de fábrica (35 px/grau, zona
 * morta de 0,35 °/s), e o destino é a dubla — **nada aqui encosta no cursor desta máquina**.
 *
 * O aparelho parte de calibrado: bias 0 no pipeline e estimativa semeada em 0, como quem acabou de
 * mandar `sincronizar`.
 */
function montarBancadaDeCursor(): {
  recalibracao: AjusteAutomaticoDeBias;
  /** `tremorGrausPorS` é determinístico de propósito: teste que sorteia número não é teste. */
  alimentar: (grausPorS: number, quantasAmostras: number, tremorGrausPorS?: number) => void;
  /** Pixels percorridos desde a última chamada de {@link marcarPixels}. */
  pixelsDesdeAMarca: () => number;
  marcarPixels: () => void;
  biasAplicadoGrausPorS: () => number;
} {
  const dubla = criarBackendDubla({ tela: TELA_DE_BANCADA });
  let chegadaMs = 0;
  const pipeline = criarPipelineDeMovimento({
    destino: dubla,
    // A chegada acompanha o carimbo do aparelho: atraso relativo zero, senão a guarda de atraso
    // descartaria uma série que "chega" toda no mesmo instante.
    relogio: () => chegadaMs,
  });
  const recalibracao = criarAjusteAutomaticoDeBias({
    aplicar: (gx, gy, gz) => {
      pipeline.definirBias(gx, gy, gz);
    },
  });
  recalibracao.semear(0, 0, 0);

  const pacote = criarPacoteDecodificado();
  let tDispositivoMs = 60_000;
  let seq = 0;
  let passo = 0;
  let marcaX = 0;
  let marcaY = 0;

  return {
    recalibracao,

    alimentar(grausPorS, quantasAmostras, tremorGrausPorS = 0) {
      for (let indice = 0; indice < quantasAmostras; indice += 1) {
        // Seno em vez de sorteio: o tremor precisa ser o mesmo em toda execução para o número do
        // relatório poder ser refeito. O passo (1,7 rad) não é múltiplo de π, então a série não se
        // repete dentro de uma medição.
        const tremor = tremorGrausPorS === 0 ? 0 : tremorGrausPorS * Math.sin(passo * 1.7);
        tDispositivoMs += 10;
        chegadaMs = tDispositivoMs;
        pacote.tipo = TIPO_MOVIMENTO;
        pacote.flags = 0;
        pacote.seq = seq;
        pacote.tDispositivoMs = tDispositivoMs;
        pacote.dtMs = 10;
        pacote.gx = (grausPorS + tremor) * RADIANOS_POR_GRAU;
        pacote.gy = 0;
        pacote.gz = 0;
        recalibracao.observar(pacote);
        pipeline.processar(pacote);
        seq = proximoSeq(seq);
        passo += 1;
      }
    },

    pixelsDesdeAMarca() {
      return Math.hypot(
        pipeline.contadores.pixelsX - marcaX,
        pipeline.contadores.pixelsY - marcaY,
      );
    },

    marcarPixels() {
      marcaX = pipeline.contadores.pixelsX;
      marcaY = pipeline.contadores.pixelsY;
    },

    biasAplicadoGrausPorS() {
      const ajustes = pipeline.ajustes;
      return (
        Math.hypot(ajustes.biasGxRadPorS, ajustes.biasGyRadPorS, ajustes.biasGzRadPorS) *
        GRAUS_POR_RADIANO
      );
    },
  };
}

function montar(opcoes: Parameters<typeof criarAjusteAutomaticoDeBias>[0] = {}): {
  ajuste: AjusteAutomaticoDeBias;
  aplicacoes: Aplicacao[];
  replantios: Replantio[];
  alimentar: (gx: number, quantasAmostras: number, dtMs?: number) => void;
} {
  const aplicacoes: Aplicacao[] = [];
  const replantios: Replantio[] = [];
  const ajuste = criarAjusteAutomaticoDeBias({
    aplicar: (gx, gy, gz) => {
      aplicacoes.push({ gx, gy, gz });
    },
    aoReplantar: (gx, gy, gz, tinhaEstimativa) => {
      replantios.push({ gx, gy, gz, tinhaEstimativa });
    },
    ...opcoes,
  });
  const pacote = criarPacoteDecodificado();

  return {
    ajuste,
    aplicacoes,
    replantios,
    alimentar(gx, quantasAmostras, dtMs = 10) {
      pacote.tipo = TIPO_MOVIMENTO;
      pacote.dtMs = dtMs;
      pacote.gx = gx;
      pacote.gy = 0;
      pacote.gz = 0;
      for (let indice = 0; indice < quantasAmostras; indice += 1) ajuste.observar(pacote);
    },
  };
}

describe('recalibração automática — quando ela NÃO mexe', () => {
  it('desligada, sai na primeira linha e não olha amostra nenhuma', () => {
    const { ajuste, aplicacoes, alimentar } = montar({ ativo: false });

    alimentar(0.005, 2000);

    assert.equal(ajuste.ativo, false);
    assert.equal(ajuste.contadores.amostrasObservadas, 0);
    assert.equal(ajuste.temEstimativa, false);
    assert.equal(aplicacoes.length, 0);
  });

  it('antes dos 3 s parados não aplica nada', () => {
    const { ajuste, aplicacoes, alimentar } = montar();
    ajuste.semear(0.005, 0, 0);

    // 2,9 s a 100 Hz: quase lá, e "quase" não vale.
    alimentar(0.005, 290);

    assert.ok(ajuste.paradoMs < ESPERA_ATE_AJUSTAR_MS, `parado há ${ajuste.paradoMs} ms`);
    assert.equal(ajuste.contadores.janelasDeAjuste, 0);
    assert.equal(aplicacoes.length, 0);
  });

  it('uma amostra acima do limiar zera o cronômetro — ninguém mexe no bias durante a mira', () => {
    const { ajuste, aplicacoes, alimentar } = montar();
    ajuste.semear(0.005, 0, 0);

    alimentar(0.005, 290);
    // Um gesto de 30 °/s: é o que a mão faz o tempo todo enquanto se usa o controle.
    alimentar(30 * RADIANOS_POR_GRAU, 1);
    // Mais 2,9 s parados depois do gesto: de novo não chega aos 3 s seguidos.
    alimentar(0.005, 290);

    assert.equal(ajuste.contadores.interrupcoes, 1);
    assert.equal(ajuste.contadores.janelasDeAjuste, 0);
    assert.equal(ajuste.contadores.replantios, 0, 'uma amostra isolada não replanta nada');
    assert.equal(aplicacoes.length, 0);
  });

  it('ignora o que não é MOVIMENTO, a leitura não finita e o dtMs imprestável', () => {
    const { ajuste, alimentar } = montar();
    const pacote = criarPacoteDecodificado();
    ajuste.semear(0.005, 0, 0);

    alimentar(0.005, 400);
    const observadasAntes = ajuste.contadores.amostrasObservadas;

    pacote.tipo = TIPO_BOTAO;
    ajuste.observar(pacote);
    assert.equal(ajuste.contadores.amostrasObservadas, observadasAntes, 'BOTÃO não é amostra');

    pacote.tipo = TIPO_MOVIMENTO;
    pacote.dtMs = 10;
    pacote.gx = Number.NaN;
    pacote.gy = 0;
    pacote.gz = 0;
    ajuste.observar(pacote);
    assert.equal(ajuste.contadores.naoFinitas, 1);

    // `dtMs` zero não mede tempo parado nenhum: a amostra passa, mas não move o cronômetro.
    const paradoAntes = ajuste.paradoMs;
    alimentar(0.005, 1, 0);
    assert.equal(ajuste.contadores.semDt, 1);
    assert.equal(ajuste.paradoMs, paradoAntes);
  });

  it('leitura que muda a cada amostra nunca se sustenta: mão na mira não replanta', () => {
    const { ajuste, aplicacoes, replantios } = montar();
    ajuste.semear(0.005, 0, 0);
    const pacote = criarPacoteDecodificado();
    pacote.tipo = TIPO_MOVIMENTO;
    pacote.dtMs = 10;
    pacote.gy = 0;
    pacote.gz = 0;

    // 30 s de gesto de verdade: velocidade angular pulando de −20 a +20 °/s, como a mão faz.
    for (let indice = 0; indice < 3000; indice += 1) {
      pacote.gx = (indice % 2 === 0 ? 20 : -20) * RADIANOS_POR_GRAU;
      ajuste.observar(pacote);
    }

    assert.equal(replantios.length, 0, 'gesto não vira estimativa por sustentação');
    assert.equal(ajuste.contadores.janelasDeAjuste, 0);
    assert.equal(aplicacoes.length, 0);
    assert.equal(ajuste.estimativa().gx, 0.005, 'a estimativa continua a que a calibração plantou');
  });

  it('rotação constante não vira bias: coerente consigo mesma, mas grande demais', () => {
    // O buraco que o teto de módulo tapa: 90 °/s constantes **são** uma leitura sustentada
    // perfeita. Sem o teto, segurar o aparelho girando por 2 s plantaria o giro como bias — o
    // mesmo estrago que o `calibrar-fim` recusa com "o aparelho estava girando, não parado".
    const { ajuste, aplicacoes, replantios, alimentar } = montar();

    alimentar(90 * RADIANOS_POR_GRAU, 1000); // 10 s girando

    assert.equal(ajuste.temEstimativa, false, 'nada foi plantado');
    assert.equal(replantios.length, 0);
    assert.equal(aplicacoes.length, 0);
    assert.ok(
      ajuste.contadores.replantiosRecusados > 0,
      'a recusa por módulo precisa deixar rastro no contador',
    );
  });
});

describe('recalibração automática — quando ela mexe', () => {
  it('depois de 3 s parados, aplica a cada 500 ms', () => {
    const { ajuste, aplicacoes, alimentar } = montar();
    ajuste.semear(0.005, 0, 0);

    // 3 s para abrir a janela + 2 s de aplicação (4 janelas de 500 ms).
    alimentar(0.005, 300 + 200);

    assert.equal(ajuste.contadores.janelasDeAjuste, 1);
    assert.equal(aplicacoes.length, 4, 'uma aplicação a cada 500 ms de aparelho parado');
    assert.equal(ajuste.contadores.aplicacoes, 4);
  });

  it('segue a deriva térmica devagar: em uma constante de tempo cobre ~63 % do degrau', () => {
    // O aparelho esquenta e o bias sai de 0,005 para 0,020 rad/s (0,86 °/s de diferença: bem
    // abaixo do limiar de "mexeu", que é o que faz esse caso ser deriva e não gesto).
    const inicial = 0.005;
    const novo = 0.02;
    const { ajuste, alimentar } = montar();
    ajuste.semear(inicial, 0, 0);

    alimentar(inicial, 300); // 3 s parado: a janela abre
    alimentar(novo, CONSTANTE_DE_TEMPO_MS / 10); // uma constante de tempo a 100 Hz

    const alcancado = (ajuste.estimativa().gx - inicial) / (novo - inicial);
    assert.ok(
      alcancado > 0.6 && alcancado < 0.66,
      `depois de uma constante de tempo a estimativa cobriu ${(alcancado * 100).toFixed(1)} % do degrau`,
    );
  });

  it('nenhuma aplicação isolada dá um salto — é isso que a torna imperceptível', () => {
    const inicial = 0.005;
    const novo = 0.02;
    const { ajuste, aplicacoes, alimentar } = montar();
    ajuste.semear(inicial, 0, 0);

    alimentar(inicial, 300);
    alimentar(novo, 2000); // 20 s parados

    assert.ok(aplicacoes.length >= 40, `esperava dezenas de aplicações, vieram ${aplicacoes.length}`);
    let anterior = inicial;
    let maiorPasso = 0;
    for (const aplicacao of aplicacoes) {
      maiorPasso = Math.max(maiorPasso, Math.abs(aplicacao.gx - anterior));
      anterior = aplicacao.gx;
    }
    // 500 ms de uma constante de tempo de 20 s valem 2,5 % da diferença que falta — com o degrau
    // inteiro de 0,015 rad/s, o maior passo possível é ~0,0004 rad/s (0,02 °/s).
    assert.ok(maiorPasso < 0.0005, `o maior passo de uma aplicação foi ${maiorPasso} rad/s`);
  });

  it('semear planta o bias conhecido e recomeça a contagem', () => {
    const { ajuste, aplicacoes, alimentar } = montar();
    ajuste.semear(0.005, 0, 0);

    alimentar(0.005, 400); // passa dos 3 s e aplica
    const aplicadasAntes = aplicacoes.length;
    assert.ok(aplicadasAntes > 0);

    ajuste.semear(0.001, 0.002, 0.003);

    assert.deepEqual(ajuste.estimativa(), { gx: 0.001, gy: 0.002, gz: 0.003 });
    assert.equal(ajuste.paradoMs, 0, 'quem acabou de calibrar não recebe ajuste no instante seguinte');
    alimentar(0.001, 290);
    assert.equal(aplicacoes.length, aplicadasAntes, 'a contagem recomeçou do zero');
  });

  it('esquecer apaga a estimativa: o próximo aparelho é outro sensor', () => {
    const { ajuste, alimentar } = montar();
    ajuste.semear(0.005, 0, 0);

    alimentar(0.005, 400);
    ajuste.esquecer();

    assert.equal(ajuste.temEstimativa, false);
    assert.equal(ajuste.paradoMs, 0);
    assert.equal(ajuste.sustentadaMs, 0);
    assert.deepEqual(ajuste.estimativa(), { gx: 0, gy: 0, gz: 0 });
  });
});

describe('recalibração automática — a saída do impasse (rodada 2)', () => {
  it('caso A: bias guardado defasado pela deriva térmica entre sessões não trava o mecanismo', () => {
    // A sessão de ontem guardou 0,5 °/s; o aparelho esquentou e hoje ele acusa 3,0 °/s parado. A
    // diferença (2,5 °/s) passa do limiar, então **toda** amostra interrompe: sem o replantio, o
    // módulo ficaria assim para o resto da sessão, com 0 aplicações e o cursor caminhando sozinho.
    // É exatamente a deriva térmica que a seção "Notas" da ATI-009 dá como razão de ele existir.
    const guardado = 0.5 * RADIANOS_POR_GRAU;
    const real = 3 * RADIANOS_POR_GRAU;
    const { ajuste, aplicacoes, replantios, alimentar } = montar();
    ajuste.semear(guardado, 0, 0);

    alimentar(real, 60_000); // 10 min a 100 Hz

    assert.equal(replantios.length, 1, 'uma vez só: depois de replantar, a estimativa serve');
    assert.equal(replantios[0]?.tinhaEstimativa, true);
    assert.ok(ajuste.contadores.janelasDeAjuste > 0, 'a janela de ajuste abriu');
    assert.ok(aplicacoes.length > 0, `esperava aplicações, vieram ${aplicacoes.length}`);
    assert.ok(
      Math.abs(ajuste.estimativa().gx * GRAUS_POR_RADIANO - 3) < 0.01,
      `a estimativa foi para a leitura de verdade: ${(ajuste.estimativa().gx * GRAUS_POR_RADIANO).toFixed(4)} °/s`,
    );
    // As interrupções param no instante do replantio: de 60 000 amostras, só as da sequência que
    // replantou. São 2001 e não 201 porque 3 °/s passam da faixa de bias plausível e precisam da
    // prova de ângulo (60° a 3 °/s são 20 s) — o portão que a rodada 3 acrescentou.
    assert.equal(
      ajuste.contadores.interrupcoes,
      amostrasAteReplantar(3),
      'as interrupções param no instante do replantio',
    );
  });

  it('caso C: o pico da primeira amostra não vira semente, e o parado seguinte manda', () => {
    // Aparelho sem bias guardado (`aoAbrirSessao` chama `esquecer`): a primeira amostra chega logo
    // depois do toque do dedo em "ligar" e traz 40 °/s. Ela não pode virar a estimativa da sessão.
    const { ajuste, aplicacoes, replantios, alimentar } = montar();

    alimentar(40 * RADIANOS_POR_GRAU, 1);
    assert.equal(ajuste.temEstimativa, false, 'uma amostra isolada não é estimativa de nada');

    alimentar(0.4 * RADIANOS_POR_GRAU, 60_000); // 10 min parado de verdade

    assert.equal(replantios.length, 1);
    assert.equal(replantios[0]?.tinhaEstimativa, false, 'foi a primeira estimativa da sessão');
    assert.ok(aplicacoes.length > 0, `esperava aplicações, vieram ${aplicacoes.length}`);
    assert.ok(
      Math.abs(ajuste.estimativa().gx * GRAUS_POR_RADIANO - 0.4) < 0.01,
      `a estimativa é a leitura parada, não o pico: ${(ajuste.estimativa().gx * GRAUS_POR_RADIANO).toFixed(4)} °/s`,
    );
  });

  it('o replantio não mexe no bias na hora: ainda são 3 s de leitura parada antes da 1ª aplicação', () => {
    const { ajuste, aplicacoes, replantios, alimentar } = montar();
    ajuste.semear(0.5 * RADIANOS_POR_GRAU, 0, 0);

    // Leitura sustentada até passar pelos três portões: replanta.
    alimentar(3 * RADIANOS_POR_GRAU, amostrasAteReplantar(3));
    assert.equal(replantios.length, 1);
    assert.equal(aplicacoes.length, 0, 'replantar não é aplicar');
    assert.equal(ajuste.paradoMs, 0, 'o cronômetro de parado recomeça do replantio');

    // Mais 2,9 s: ainda não chegou aos 3 s.
    alimentar(3 * RADIANOS_POR_GRAU, 290);
    assert.equal(aplicacoes.length, 0);

    alimentar(3 * RADIANOS_POR_GRAU, 60);
    assert.ok(aplicacoes.length > 0, 'passados os 3 s, o ajuste começa');
  });

  it('a leitura sustentada precisa dos 2 s inteiros, e interrupção no meio recomeça a contagem', () => {
    // 1 °/s cabe na faixa de bias plausível: quem manda aqui é só o tempo base, que é o que este
    // teste mede. A estimativa é semeada longe (3 °/s) para o caminho da sustentada ser o ativo.
    const { ajuste, replantios, alimentar } = montar();
    ajuste.semear(3 * RADIANOS_POR_GRAU, 0, 0);

    alimentar(1 * RADIANOS_POR_GRAU, 150); // 1,5 s: falta meio segundo
    assert.equal(replantios.length, 0);
    assert.ok(ajuste.sustentadaMs > 0);

    // Uma leitura de outro tamanho no meio recomeça a sequência do zero.
    alimentar(-2 * RADIANOS_POR_GRAU, 1);
    assert.equal(ajuste.sustentadaMs, 0, 'a sequência recomeça nesta amostra');

    alimentar(1 * RADIANOS_POR_GRAU, 150);
    assert.equal(replantios.length, 0, '1,5 s de novo ainda não são 2 s');

    alimentar(1 * RADIANOS_POR_GRAU, 60);
    assert.equal(replantios.length, 1);
  });

  it('o teto do replantio automático é próprio, e mais duro que o da calibração manual', () => {
    // A rodada 2 importava os 15 °/s do `calibrar-fim`. Aquele número foi calibrado para um
    // caminho em que **uma pessoa afirma** que o aparelho está parado; o caminho automático não
    // tem essa testemunha, e por isso o teto daqui é próprio e menor. A invariante é a relação,
    // não o número — trocar um dos dois não pode fazer os dois se igualarem em silêncio.
    assert.ok(
      MODULO_MAXIMO_DO_REPLANTIO_GRAUS_POR_S < LIMITES_DA_CALIBRACAO.moduloMaximoGrausPorS,
      `teto automático ${MODULO_MAXIMO_DO_REPLANTIO_GRAUS_POR_S} °/s contra manual ` +
        `${LIMITES_DA_CALIBRACAO.moduloMaximoGrausPorS} °/s`,
    );

    // Logo abaixo do teto replanta (com a prova de ângulo cumprida); logo acima, não.
    const abaixoGrausPorS = MODULO_MAXIMO_DO_REPLANTIO_GRAUS_POR_S - 0.1;
    const abaixo = montar();
    abaixo.alimentar(abaixoGrausPorS * RADIANOS_POR_GRAU, amostrasAteReplantar(abaixoGrausPorS));
    assert.equal(abaixo.ajuste.contadores.replantios, 1);

    const acima = montar();
    acima.alimentar((MODULO_MAXIMO_DO_REPLANTIO_GRAUS_POR_S + 0.1) * RADIANOS_POR_GRAU, 300);
    assert.equal(acima.ajuste.contadores.replantios, 0);
    assert.equal(acima.ajuste.contadores.replantiosRecusados, 1);
  });
});

describe('recalibração automática — o portão do replantio (rodada 3)', () => {
  // O defeito que esta suíte existe para não deixar voltar: na rodada 2, um gesto lento e
  // constante passava pelos dois portões de então (coerência medida pelo limiar de gesto, teto de
  // módulo importado do `calibrar-fim`) e virava bias. Medido pelo revisor: 10 °/s segurados por
  // 6 s congelavam o cursor no meio do gesto e o faziam voltar 1851 px sozinho, com o aparelho já
  // parado. É a violação do critério de aceite "após sincronizar, o aparelho parado não move o
  // cursor" — e a pior classe de defeito deste projeto.
  for (const grausPorS of [3, 5, 10, 14]) {
    it(`gesto constante de ${grausPorS} °/s segurado por 6 s não vira bias`, () => {
      const bancada = montarBancadaDeCursor();

      bancada.alimentar(grausPorS, 600); // 6 s de gesto perfeitamente constante (o pior caso)

      assert.equal(bancada.recalibracao.contadores.replantios, 0, 'gesto não replanta');
      assert.equal(bancada.biasAplicadoGrausPorS(), 0, 'nenhum bias chegou ao pipeline');
      assert.ok(
        bancada.pixelsDesdeAMarca() > 100,
        `o gesto precisa ter movido o cursor de verdade, e moveu ${bancada.pixelsDesdeAMarca()} px`,
      );

      // A mão para. Meio segundo para a média exponencial do pipeline soltar o rabo do gesto
      // (0,15 de suavização derruba 10 °/s abaixo da zona morta em duas amostras) — esse resíduo é
      // do gesto e não do bias, e medi-lo aqui responderia pela ATI-008, não por esta.
      bancada.alimentar(0, 50);
      bancada.marcarPixels();
      bancada.alimentar(0, 1000); // 10 s parado

      assert.equal(bancada.pixelsDesdeAMarca(), 0, 'com o aparelho parado o cursor não anda');
      assert.equal(bancada.biasAplicadoGrausPorS(), 0);
    });
  }

  it('o mesmo gesto com tremor de mão nem chega ao fim do tempo base', () => {
    // Um gesto de verdade tem tremor. A banda de coerência é dimensionada pelo ruído do sensor
    // (0,4 °/s), e não pelo limiar de gesto (1,5 °/s) — foi essa troca que fechou o portão 1.
    const bancada = montarBancadaDeCursor();

    bancada.alimentar(10, 1000, 1); // 10 s de gesto de 10 °/s com tremor de ±1 °/s

    assert.equal(bancada.recalibracao.contadores.replantios, 0);
    assert.ok(
      bancada.recalibracao.sustentadaMs < TEMPO_DE_LEITURA_SUSTENTADA_MS,
      `a sequência nunca fecha o tempo base: parou em ${bancada.recalibracao.sustentadaMs} ms`,
    );
  });

  it('cada portão barra a sua faixa, e o contador diz qual foi', () => {
    // Acima do teto de módulo: portão 2, com recusa registrada.
    const rapido = montar();
    rapido.alimentar(10 * RADIANOS_POR_GRAU, 1000);
    assert.equal(rapido.ajuste.contadores.replantios, 0);
    assert.ok(rapido.ajuste.contadores.replantiosRecusados > 0, 'recusado pelo teto de módulo');
    assert.equal(rapido.ajuste.contadores.replantiosAdiados, 0);

    // Abaixo do teto e acima da faixa de bias plausível: portão 3, adiado enquanto a prova de
    // ângulo não fecha. Uma vez por sequência, e não uma por amostra.
    const lento = montar();
    lento.alimentar(3 * RADIANOS_POR_GRAU, 600);
    assert.equal(lento.ajuste.contadores.replantios, 0);
    assert.equal(lento.ajuste.contadores.replantiosRecusados, 0);
    assert.equal(lento.ajuste.contadores.replantiosAdiados, 1);
  });

  it('o portão tem tamanho declarado: 60° de giro a taxa constante ainda passam', () => {
    // Este teste fixa o preço da escolha, e não uma virtude. A prova de ângulo diz "quanto maior o
    // módulo, mais tempo": 3 °/s precisam de 20 s seguidos, dentro do ruído do sensor, para virar
    // bias — 60° de rotação a taxa perfeitamente constante. Mão nenhuma mira assim, mas quem
    // mexer nestes números precisa ver o limite se mexer junto.
    const { ajuste, replantios, alimentar } = montar();

    alimentar(3 * RADIANOS_POR_GRAU, amostrasAteReplantar(3) - 1);
    assert.equal(replantios.length, 0, 'uma amostra antes do ângulo de prova, ainda não');

    alimentar(3 * RADIANOS_POR_GRAU, 1);
    assert.equal(replantios.length, 1);
    assert.equal(ajuste.contadores.replantiosAdiados, 1, 'a sequência ficou adiada até fechar');
  });

  it('aparelho parado com a estimativa defasada continua sendo curado — em pixel', () => {
    // O contrapeso: o portão não pode ser tão duro a ponto de trazer o impasse de volta. Aparelho
    // **parado** cuja leitura real (2,5 °/s) ficou longe da estimativa (0) — o caso A do parecer da
    // rodada 1, agora medido no cursor.
    const bancada = montarBancadaDeCursor();

    bancada.alimentar(2.5, amostrasAteReplantar(2.5));
    assert.equal(bancada.recalibracao.contadores.replantios, 1, 'a estimativa foi replantada');

    // Passados os 3 s de leitura parada, o bias chega ao pipeline e o cursor sossega.
    bancada.alimentar(2.5, 400);
    bancada.marcarPixels();
    bancada.alimentar(2.5, 3000); // 30 s de aparelho parado, já com o bias novo

    assert.equal(bancada.pixelsDesdeAMarca(), 0, 'o cursor parou de caminhar sozinho');
    assert.ok(
      Math.abs(bancada.biasAplicadoGrausPorS() - 2.5) < 0.01,
      `o bias aplicado é a leitura de verdade: ${bancada.biasAplicadoGrausPorS().toFixed(4)} °/s`,
    );
  });
});

describe('recalibração automática — o aviso de bias alto (ATI-029)', () => {
  /**
   * Um ajuste com o aviso escutado, como a produção escuta (o atendente de comandos): cada chamada
   * vira um item da lista — o módulo em °/s ao acender ou confirmar, `undefined` ao apagar.
   */
  function montarComAviso(
    opcoes: Parameters<typeof criarAjusteAutomaticoDeBias>[0] = {},
  ): ReturnType<typeof montar> & { avisos: (number | undefined)[] } {
    const avisos: (number | undefined)[] = [];
    const bancada = montar({
      aoMudarAvisoDeBiasAlto: (grausPorS) => {
        avisos.push(grausPorS);
      },
      ...opcoes,
    });
    return { ...bancada, avisos };
  }

  /** Amostras de 10 ms até uma leitura sustentada cumprir o tempo base (a 1ª só abre a sequência). */
  const TEMPO_BASE_EM_AMOSTRAS = TEMPO_DE_LEITURA_SUSTENTADA_MS / 10 + 1;

  it('bias de 2 °/s com o aparelho parado acende o aviso no fim do tempo base, com o módulo medido', () => {
    const { ajuste, avisos, alimentar } = montarComAviso();
    ajuste.semear(0, 0, 0); // calibrado antes, e o sensor saiu do lugar

    alimentar(2 * RADIANOS_POR_GRAU, TEMPO_BASE_EM_AMOSTRAS - 1);
    assert.deepEqual(avisos, [], 'antes do tempo base a leitura ainda não se sustentou');
    assert.equal(ajuste.biasAltoGrausPorS, undefined);

    alimentar(2 * RADIANOS_POR_GRAU, 1);
    assert.equal(avisos.length, 1);
    assert.ok(Math.abs((avisos[0] ?? 0) - 2) < 1e-9, `o aviso diz ${avisos[0]} °/s`);
    assert.ok(Math.abs((ajuste.biasAltoGrausPorS ?? 0) - 2) < 1e-9);
    assert.equal(ajuste.contadores.avisosDeBiasAlto, 1);
    // O portão decidiu exatamente o que decidia antes: adiou, e não replantou.
    assert.equal(ajuste.contadores.replantiosAdiados, 1);
    assert.equal(ajuste.contadores.replantios, 0);
  });

  it('fica aceso enquanto a prova de ângulo espera, e apaga quando o bias chega ao pipeline', () => {
    const { ajuste, avisos, aplicacoes, alimentar } = montarComAviso();
    ajuste.semear(0, 0, 0);

    alimentar(2 * RADIANOS_POR_GRAU, amostrasAteReplantar(2));
    assert.equal(ajuste.contadores.replantios, 1, '30 s depois, a prova de ângulo replantou');
    // Replantar só recoloca a estimativa: o cursor continua andando até a primeira aplicação, e o
    // aviso que sumisse aqui sumiria com o problema ainda na tela.
    assert.equal(aplicacoes.length, 0);
    assert.ok(ajuste.biasAltoGrausPorS !== undefined, 'o replantio sozinho não apaga o aviso');

    alimentar(2 * RADIANOS_POR_GRAU, 400); // os 3 s de continuidade e a primeira aplicação
    assert.ok(aplicacoes.length >= 1, 'o bias novo chegou ao pipeline');
    assert.equal(ajuste.biasAltoGrausPorS, undefined, 'e o aviso apagou junto');
    assert.deepEqual(avisos.slice(1), [undefined], 'um "apagou", e nada mais');
  });

  it('some quando o bias volta à faixa plausível', () => {
    const { ajuste, avisos, aplicacoes, alimentar } = montarComAviso();
    ajuste.semear(0, 0, 0);
    alimentar(2 * RADIANOS_POR_GRAU, TEMPO_BASE_EM_AMOSTRAS);
    assert.ok(ajuste.biasAltoGrausPorS !== undefined);

    // O sensor esfriou: 0,3 °/s, perto da estimativa (0). 3 s parado abrem a janela, e a primeira
    // aplicação, 500 ms depois, é quando o aviso deixa de ser verdade.
    alimentar(0.3 * RADIANOS_POR_GRAU, 300);
    assert.ok(ajuste.biasAltoGrausPorS !== undefined, 'antes da primeira aplicação, ainda aceso');
    alimentar(0.3 * RADIANOS_POR_GRAU, 100);

    assert.ok(aplicacoes.length >= 1);
    assert.equal(ajuste.biasAltoGrausPorS, undefined);
    assert.equal(avisos[avisos.length - 1], undefined);
    assert.equal(ajuste.contadores.avisosDeBiasAlto, 1);
  });

  it('sincronizar apaga na hora: semear é o bias medido passando a ser descontado', () => {
    const { ajuste, avisos, alimentar } = montarComAviso();
    ajuste.semear(0, 0, 0);
    alimentar(2 * RADIANOS_POR_GRAU, TEMPO_BASE_EM_AMOSTRAS);

    ajuste.semear(2 * RADIANOS_POR_GRAU, 0, 0);

    assert.equal(ajuste.biasAltoGrausPorS, undefined);
    assert.deepEqual(avisos.slice(1), [undefined]);
  });

  it('o aparelho se mexendo não apaga — é quando a pessoa pega o celular para sincronizar', () => {
    const { ajuste, avisos, alimentar } = montarComAviso();
    ajuste.semear(0, 0, 0);
    alimentar(2 * RADIANOS_POR_GRAU, TEMPO_BASE_EM_AMOSTRAS);

    for (let volta = 0; volta < 50; volta += 1) {
      alimentar(30 * RADIANOS_POR_GRAU, 10);
      alimentar(-30 * RADIANOS_POR_GRAU, 10);
    }

    assert.ok(ajuste.biasAltoGrausPorS !== undefined, 'movimento não diz nada sobre o bias');
    assert.equal(avisos.length, 1);
  });

  it('acima do teto do replantio (5 °/s) também avisa: é a faixa em que o automático nunca resolve', () => {
    const { ajuste, avisos, alimentar } = montarComAviso();
    ajuste.semear(0, 0, 0);

    alimentar(7 * RADIANOS_POR_GRAU, 1000); // 10 s: uma recusa a cada sequência de 2 s

    assert.ok(ajuste.contadores.replantiosRecusados >= 4, 'o portão 2 recusou, como sempre');
    assert.equal(ajuste.contadores.replantios, 0);
    assert.ok(Math.abs((ajuste.biasAltoGrausPorS ?? 0) - 7) < 1e-9);
    // Cada recusa confirma o aviso (o número pode ter mudado), mas ele acendeu uma vez só.
    assert.equal(ajuste.contadores.avisosDeBiasAlto, 1);
    assert.equal(avisos.length, ajuste.contadores.replantiosRecusados);
  });

  it('acima do teto do calibrar-fim não avisa: ali é giro, e o sincronizar seria recusado', () => {
    const acima = LIMITES_DA_CALIBRACAO.moduloMaximoGrausPorS + 5;
    const { ajuste, avisos, alimentar } = montarComAviso();
    ajuste.semear(0, 0, 0);

    alimentar(acima * RADIANOS_POR_GRAU, 1000);

    assert.ok(ajuste.contadores.replantiosRecusados > 0);
    assert.deepEqual(avisos, []);
    assert.equal(ajuste.biasAltoGrausPorS, undefined);
  });

  it('dentro da faixa plausível não avisa: a leitura vira estimativa no tempo base', () => {
    const { ajuste, avisos, alimentar } = montarComAviso();

    // Sem estimativa (aparelho sem bias guardado): a leitura sustentada de 1,4 °/s replanta.
    alimentar(1.4 * RADIANOS_POR_GRAU, TEMPO_BASE_EM_AMOSTRAS);

    assert.equal(ajuste.contadores.replantios, 1);
    assert.deepEqual(avisos, []);
  });

  it('esquecer (fim de sessão) apaga; desligada, nunca avisa', () => {
    const ligada = montarComAviso();
    ligada.ajuste.semear(0, 0, 0);
    ligada.alimentar(2 * RADIANOS_POR_GRAU, TEMPO_BASE_EM_AMOSTRAS);
    ligada.ajuste.esquecer();
    assert.equal(ligada.ajuste.biasAltoGrausPorS, undefined);
    assert.deepEqual(ligada.avisos.slice(1), [undefined], 'quem ouve fica sabendo que apagou');

    const desligada = montarComAviso({ ativo: false });
    desligada.alimentar(2 * RADIANOS_POR_GRAU, 1000);
    assert.deepEqual(desligada.avisos, []);
  });

  it('o aviso só olha: os portões decidem igual com e sem quem o escute', () => {
    // Critério de aceite da ATI-029: "nenhum dos três portões foi alterado". As mesmas séries, com
    // e sem o ouvinte, precisam terminar com os mesmos contadores de decisão — inclusive o gesto
    // constante do bloqueante da rodada 2.
    const series: readonly (readonly [number, number])[] = [
      [3, 600],
      [5, 600],
      [10, 600],
      [14, 600],
      [2, 4000],
      [7, 1000],
      [20, 1000],
      [1.2, 1000],
    ];
    const decisao = (ajuste: AjusteAutomaticoDeBias): readonly number[] => [
      ajuste.contadores.replantios,
      ajuste.contadores.replantiosRecusados,
      ajuste.contadores.replantiosAdiados,
      ajuste.contadores.aplicacoes,
      ajuste.contadores.interrupcoes,
    ];
    for (const [grausPorS, amostras] of series) {
      const semOuvinte = montar();
      const comOuvinte = montarComAviso();
      for (const { ajuste, alimentar } of [semOuvinte, comOuvinte]) {
        ajuste.semear(0, 0, 0);
        alimentar(grausPorS * RADIANOS_POR_GRAU, amostras);
        alimentar(0, 600);
      }
      assert.deepEqual(decisao(comOuvinte.ajuste), decisao(semOuvinte.ajuste), `${grausPorS} °/s`);
      assert.deepEqual(comOuvinte.aplicacoes, semOuvinte.aplicacoes, `${grausPorS} °/s`);
    }
  });

  it('em pixel: o aviso fica aceso o tempo em que o cursor anda sozinho, e apaga quando ele para', () => {
    // O caso da ATI-029 no cursor (35 px/grau de fábrica, destino de ensaio): bias de 2 °/s num
    // eixo, aparelho parado, nenhum sincronizar. Sem o aviso, é meio minuto de cursor andando sem
    // explicação nenhuma na tela.
    const bancada = montarBancadaDeCursor();

    bancada.alimentar(2, TEMPO_BASE_EM_AMOSTRAS);
    assert.ok(bancada.recalibracao.biasAltoGrausPorS !== undefined, 'aceso em 2 s');

    bancada.marcarPixels();
    let amostrasComAviso = 0;
    while (bancada.recalibracao.biasAltoGrausPorS !== undefined && amostrasComAviso < 6000) {
      bancada.alimentar(2, 10);
      amostrasComAviso += 10;
    }
    const pixelsComAviso = bancada.pixelsDesdeAMarca();
    assert.equal(bancada.recalibracao.biasAltoGrausPorS, undefined, 'o aviso apagou');
    assert.ok(
      pixelsComAviso > 1000,
      `com o aviso aceso o cursor andou ${pixelsComAviso.toFixed(0)} px em ` +
        `${(amostrasComAviso / 100).toFixed(1)} s — é o que o aviso explica`,
    );

    // Meio segundo para o filtro do pipeline soltar o resto, e depois: parado é parado.
    bancada.alimentar(2, 50);
    bancada.marcarPixels();
    bancada.alimentar(2, 1000);
    assert.equal(bancada.pixelsDesdeAMarca(), 0, 'com o aviso apagado, o cursor não anda mais');
  });
});
