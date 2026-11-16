/**
 * Filtro adaptativo do tremor (ATI-033): a peça sozinha, a peça dentro da cadeia, e os critérios
 * de aceite com número.
 *
 * Os critérios usam as séries de `bancada-do-filtro.ts` — as mesmas que
 * `ferramentas/medir-filtro.mjs` imprime para o relatório. O que se compara é sempre "hoje" (a cadeia
 * de antes desta atividade: média exponencial de 0,15 e zona morta de 0,35 °/s) contra o padrão de
 * fábrica novo (filtro `euro` e zona morta de 0,15 °/s).
 *
 * ⚠️ O tremor aqui é **sintético** (o padrão `tremor` do simulador). O critério com captura de mão
 * humana parada depende de uma gravação que ainda não existe — o relatório da ATI diz o que a única
 * captura real disponível mostrou.
 *
 * Nada aqui toca no cursor: os destinos só anotam.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { carregarConfiguracao, VARIAVEIS_DE_AMBIENTE } from '../config.js';
import { ajustesDaConfiguracao } from '../principal.js';
import {
  FLAG_PRIMEIRA_APOS_RETOMAR,
  TIPO_MOVIMENTO,
  criarPacoteDecodificado,
  proximoSeq,
} from '../protocolo/indice.js';
import { AJUSTES_PADRAO, resolverAjustes, type AjustesParciais } from './ajustes.js';
import {
  AJUSTES_DE_HOJE,
  atrasoMedioMs,
  avaliarMira,
  percorrer,
  semFiltro,
  serieApoiada,
  serieDeGestoRapido,
  serieDeMiraLenta,
  serieDeTremor,
} from './bancada-do-filtro.js';
import { criarDestinoDeEnsaio } from './ensaio.js';
import { criarFiltroAdaptativo, type FiltroAdaptativo } from './filtro-adaptativo.js';
import { criarPipelineDeMovimento } from './pipeline.js';
import { GRAUS_POR_RADIANO, RADIANOS_POR_GRAU } from './tipos.js';

/* ------------------------------------------------------------------------- o filtro sozinho */

/** Passa uma amostra (em °/s) e devolve o que saiu, em graus. */
function passar(filtro: FiltroAdaptativo, hGrausPorS: number, vGrausPorS: number, dtS = 0.01): [number, number] {
  filtro.entrada[0] = hGrausPorS * RADIANOS_POR_GRAU;
  filtro.entrada[1] = vGrausPorS * RADIANOS_POR_GRAU;
  filtro.entrada[2] = dtS;
  filtro.filtrar();
  return [(filtro.saida[0] ?? 0) * GRAUS_POR_RADIANO, (filtro.saida[1] ?? 0) * GRAUS_POR_RADIANO];
}

function filtroDeFabrica(): FiltroAdaptativo {
  const filtro = criarFiltroAdaptativo();
  filtro.configurar(
    AJUSTES_PADRAO.filtroCorteMinimoHz,
    AJUSTES_PADRAO.filtroBeta,
    AJUSTES_PADRAO.filtroCorteDaVelocidadeHz,
  );
  return filtro;
}

describe('filtro adaptativo — a peça sozinha', () => {
  it('conserva o deslocamento: todo grau girado sai, só que no tempo do filtro', () => {
    // É a razão de o filtro trabalhar na posição (ver o cabeçalho de `filtro-adaptativo.ts`): com
    // o corte subindo e descendo no meio do gesto, filtrar a velocidade perderia graus.
    const filtro = filtroDeFabrica();
    let entrou = 0;
    let saiu = 0;
    for (let indice = 0; indice < 300; indice += 1) {
      // Gesto com aceleração e freada, mais um tremor por cima: o corte varia o tempo todo.
      const grausPorS = 120 * Math.sin((Math.PI * indice) / 300) + 3 * Math.sin(indice * 0.63);
      entrou += grausPorS * 0.01;
      saiu += passar(filtro, grausPorS, 0)[0];
    }
    for (let indice = 0; indice < 1000; indice += 1) saiu += passar(filtro, 0, 0)[0];

    assert.ok(Math.abs(saiu - entrou) < 1e-6, `entrou ${entrou}°, saiu ${saiu}°`);
    assert.equal(filtro.vazio(), true, 'parado tempo bastante, nada fica guardado');
  });

  it('velocidade constante sai inteira depois da subida: o filtro atrasa, não come', () => {
    const filtro = filtroDeFabrica();
    let ultimo = 0;
    for (let indice = 0; indice < 400; indice += 1) ultimo = passar(filtro, 2, 0)[0];
    assert.ok(Math.abs(ultimo - 2 * 0.01) < 1e-9, `por amostra saiu ${ultimo}° de 0,02°`);
  });

  it('tremor de 10 Hz sai atenuado; gesto rápido sai quase inteiro na mesma amostra', () => {
    const tremor = filtroDeFabrica();
    let maxima = Number.NEGATIVE_INFINITY;
    let minima = Number.POSITIVE_INFINITY;
    let posicao = 0;
    for (let indice = 0; indice < 300; indice += 1) {
      posicao += passar(tremor, 3 * Math.sin(2 * Math.PI * 10 * indice * 0.01), 0)[0];
      if (indice > 100) {
        maxima = Math.max(maxima, posicao);
        minima = Math.min(minima, posicao);
      }
    }
    // Sem filtro, 3 °/s a 10 Hz oscilam ±0,048° (3 / 2π·10) — o cursor sacode ±1,7 px a 35 px/grau.
    // A conta é sobre a oscilação (pico a pico), e não sobre a posição: integrar o seno a partir do
    // zero deixa um deslocamento constante de 0,048°, que não é tremor.
    const amplitude = (maxima - minima) / 2;
    assert.ok(amplitude < 0.048 * 0.2, `o tremor ainda oscila ±${amplitude.toFixed(4)}°`);

    const rapido = filtroDeFabrica();
    let fracao = 0;
    for (let indice = 0; indice < 10; indice += 1) fracao = passar(rapido, 200, 0)[0] / (200 * 0.01);
    assert.ok(fracao > 0.9, `com 200 °/s, em 100 ms já sai ${(fracao * 100).toFixed(0)} % por amostra`);
  });

  it('um corte só para os dois eixos: a diagonal sai reta, amostra a amostra', () => {
    const filtro = filtroDeFabrica();
    for (let indice = 0; indice < 50; indice += 1) {
      const [h, v] = passar(filtro, 30 + indice, 10 + indice / 3);
      assert.ok(Math.abs(h - 3 * v) < 1e-12, `amostra ${indice}: ${h} contra ${v}`);
    }
  });

  it('o dt de cada amostra entra na conta: 60 Hz e 100 Hz dão o mesmo total', () => {
    const cem = filtroDeFabrica();
    const sessenta = filtroDeFabrica();
    let totalCem = 0;
    let totalSessenta = 0;
    for (let indice = 0; indice < 100; indice += 1) totalCem += passar(cem, 15, 0, 0.01)[0];
    for (let indice = 0; indice < 60; indice += 1) totalSessenta += passar(sessenta, 15, 0, 1 / 60)[0];
    for (let indice = 0; indice < 2000; indice += 1) {
      totalCem += passar(cem, 0, 0, 0.01)[0];
      totalSessenta += passar(sessenta, 0, 0, 1 / 60)[0];
    }
    assert.ok(Math.abs(totalCem - 15) < 1e-6, `100 Hz: ${totalCem}`);
    assert.ok(Math.abs(totalSessenta - 15) < 1e-6, `60 Hz: ${totalSessenta}`);
  });

  it('zerar esquece o pendente e a rapidez; reconfigurar não esquece nada', () => {
    const filtro = filtroDeFabrica();
    passar(filtro, 50, 0);
    assert.equal(filtro.vazio(), false);

    // Mexer nos números é o controle deslizante: o que estava pendente continua lá.
    filtro.configurar(4, 0.1, 10);
    assert.equal(filtro.vazio(), false);

    filtro.zerar();
    assert.equal(filtro.vazio(), true);
    assert.deepEqual([...passar(filtro, 0, 0)], [0, 0]);
  });
});

/* ---------------------------------------------------------------------- dentro da cadeia */

/** Pipeline com chegada perfeita e destino de ensaio; `enviar` em °/s no horizontal de `retrato`. */
function montar(ajustes: AjustesParciais) {
  const destino = criarDestinoDeEnsaio();
  let chegadaMs = 60_000;
  const pipeline = criarPipelineDeMovimento({ destino, ajustes, relogio: () => chegadaMs });
  const pacote = criarPacoteDecodificado();
  pacote.tipo = TIPO_MOVIMENTO;
  pacote.tDispositivoMs = chegadaMs;
  pacote.flags = FLAG_PRIMEIRA_APOS_RETOMAR;
  pipeline.processar(pacote);
  pacote.flags = 0;
  return {
    pipeline,
    destino,
    /** `quantas` amostras de 10 ms girando para a direita a `grausPorS`. */
    enviar(grausPorS: number, quantas = 1): void {
      for (let indice = 0; indice < quantas; indice += 1) {
        pacote.seq = proximoSeq(pacote.seq);
        pacote.tDispositivoMs += 10;
        chegadaMs = pacote.tDispositivoMs;
        pacote.dtMs = 10;
        // `retrato`: o horizontal é −gy (ver `eixos.ts`), então "para a direita" é gy negativo.
        pacote.gy = -grausPorS * RADIANOS_POR_GRAU;
        pipeline.processar(pacote);
      }
    },
  };
}

/** Pixels que a cadeia entregou: os inteiros que saíram mais a fração guardada no acumulador. */
function entregue(aparelho: ReturnType<typeof montar>): number {
  return aparelho.pipeline.contadores.pixelsX + aparelho.pipeline.fracaoX;
}

describe('filtro adaptativo — dentro da cadeia', () => {
  it('90° viram o número exato de pixels, só que no tempo do filtro', () => {
    const aparelho = montar({ filtro: 'euro', zonaMortaGrausPorS: 0, sensXPixelsPorGrau: 10 });
    aparelho.enviar(90, 100);
    const logoDepois = aparelho.pipeline.contadores.pixelsX;
    aparelho.enviar(0, 300);

    assert.ok(logoDepois < 900, 'ao fim do giro ainda havia pendente — é o atraso do filtro');
    // Inteiros emitidos mais a fração no acumulador: a conta em ponto flutuante pode fechar em
    // 899,9999994 px, e o último pixel sai no próximo movimento — o que se afirma é que nada sumiu.
    assert.ok(Math.abs(entregue(aparelho) - 900) < 1e-5, `entregou ${entregue(aparelho)} px de 900`);
  });

  it('parado, o filtro esvazia e a amostra zerada pela zona morta volta a sair pelo atalho', () => {
    const aparelho = montar({ filtro: 'euro', sensXPixelsPorGrau: 35 });
    aparelho.enviar(5, 50);
    aparelho.enviar(0, 600);
    const semMovimento = aparelho.pipeline.contadores.amostrasSemMovimento;
    const pixels = aparelho.pipeline.contadores.pixelsX;

    aparelho.enviar(0, 100);

    assert.equal(aparelho.pipeline.contadores.amostrasSemMovimento, semMovimento + 100);
    assert.equal(aparelho.pipeline.contadores.pixelsX, pixels, 'nada saiu depois de esvaziar');
  });

  it('trocar a orientação zera o pendente: o resíduo não sai para o lado errado', () => {
    const aparelho = montar({ filtro: 'euro', zonaMortaGrausPorS: 0, sensXPixelsPorGrau: 35 });
    aparelho.enviar(60, 20);
    const trocasAntes = aparelho.pipeline.contadores.trocasDeReferencial;
    const pixelsAntes = aparelho.pipeline.contadores.pixelsX;

    aparelho.pipeline.ajustar({ orientacao: 'paisagem' });
    aparelho.enviar(0, 200);

    assert.equal(aparelho.pipeline.contadores.trocasDeReferencial, trocasAntes + 1);
    assert.equal(aparelho.pipeline.contadores.pixelsX, pixelsAntes, 'o pendente não saiu depois da troca');
    assert.equal(aparelho.pipeline.contadores.pixelsY, 0);
  });

  it('trocar de filtro zera os dois, sem contar como troca de referencial', () => {
    const aparelho = montar({ filtro: 'euro', zonaMortaGrausPorS: 0, sensXPixelsPorGrau: 35 });
    aparelho.enviar(60, 20);
    const pixelsAntes = aparelho.pipeline.contadores.pixelsX;

    aparelho.pipeline.ajustar({ filtro: 'exponencial' });
    aparelho.enviar(0, 50);
    assert.equal(aparelho.pipeline.contadores.pixelsX, pixelsAntes, 'o pendente do euro não vazou');

    aparelho.pipeline.ajustar({ filtro: 'euro' });
    aparelho.enviar(0, 50);
    assert.equal(aparelho.pipeline.contadores.pixelsX, pixelsAntes, 'nem quando o euro voltou');
    assert.equal(aparelho.pipeline.contadores.trocasDeReferencial, 0);
  });

  it('mexer no corte ou no beta não esquece o pendente: o giro sai inteiro', () => {
    const aparelho = montar({ filtro: 'euro', zonaMortaGrausPorS: 0, sensXPixelsPorGrau: 10 });
    aparelho.enviar(90, 50);
    aparelho.pipeline.ajustar({ filtroCorteMinimoHz: 0.5, filtroBeta: 0 });
    aparelho.enviar(90, 50);
    aparelho.pipeline.ajustar({ filtroCorteMinimoHz: 3 });
    aparelho.enviar(0, 600);

    assert.ok(Math.abs(entregue(aparelho) - 900) < 1e-5, `entregou ${entregue(aparelho)} px de 900`);
  });

  it('reiniciar (centralizar, pausa, fim de sessão) esquece o pendente', () => {
    const aparelho = montar({ filtro: 'euro', zonaMortaGrausPorS: 0, sensXPixelsPorGrau: 35 });
    aparelho.enviar(60, 20);
    const pixelsAntes = aparelho.pipeline.contadores.pixelsX;

    aparelho.pipeline.reiniciar();
    aparelho.enviar(0, 200);

    assert.equal(aparelho.pipeline.contadores.pixelsX, pixelsAntes);
  });

  it('leitura não finita é barrada antes do filtro e não o envenena', () => {
    const aparelho = montar({ filtro: 'euro', zonaMortaGrausPorS: 0, sensXPixelsPorGrau: 10 });
    aparelho.enviar(Number.NaN, 1);
    assert.equal(aparelho.pipeline.contadores.descartadasPorLeituraInvalida, 1);
    aparelho.enviar(10, 100);
    aparelho.enviar(0, 300);
    assert.ok(Math.abs(entregue(aparelho) - 100) < 1e-5, `entregou ${entregue(aparelho)} px de 100`);
  });

  it('não aloca por amostra (sem coleta forçada: a coleta nas pontas esconderia lixo de vida curta)', () => {
    const destino = criarDestinoDeEnsaio();
    let chegadaMs = 60_000;
    const pipeline = criarPipelineDeMovimento({
      destino,
      ajustes: { filtro: 'euro', sensXPixelsPorGrau: 35 },
      relogio: () => chegadaMs,
    });
    const pacote = criarPacoteDecodificado();
    pacote.tipo = TIPO_MOVIMENTO;
    pacote.tDispositivoMs = 60_000;
    pacote.dtMs = 10;
    pacote.gx = 0.7 * RADIANOS_POR_GRAU;
    pacote.gy = 1.3 * RADIANOS_POR_GRAU;
    chegadaMs = pacote.tDispositivoMs;
    const rodar = (voltas: number): void => {
      for (let indice = 0; indice < voltas; indice += 1) {
        pacote.seq = proximoSeq(pacote.seq);
        pipeline.processar(pacote);
      }
    };

    rodar(200_000);
    const porAmostra: number[] = [];
    for (let rodada = 0; rodada < 7; rodada += 1) {
      const antes = process.memoryUsage().heapUsed;
      rodar(200_000);
      porAmostra.push((process.memoryUsage().heapUsed - antes) / 200_000);
    }

    // A primeira versão passava a amostra como argumento (`filtrar(h, v, dt)`) e media 6,8 B por
    // amostra exatamente aqui — e 0,000 com `gc()` forçado nas pontas, que é por que ele não é usado.
    const mediana = [...porAmostra].sort((a, b) => a - b)[3] ?? Number.NaN;
    assert.ok(
      mediana < 1,
      `mediana de ${mediana.toFixed(3)} B/amostra (${porAmostra.map((valor) => valor.toFixed(2)).join(', ')})`,
    );
  });
});

/* ------------------------------------------------------------------- critérios de aceite */

const PADRAO_NOVO: AjustesParciais = {};

describe('ATI-033 — critérios de aceite contra a cadeia de antes', () => {
  it('ligável e desligável: o padrão é o euro, e o exponencial continua lá', () => {
    assert.equal(resolverAjustes().filtro, 'euro');
    const desligado = percorrer(serieDeTremor(3, 10), { filtro: 'exponencial', zonaMortaGrausPorS: 0.35 });
    const deHoje = percorrer(serieDeTremor(3, 10), AJUSTES_DE_HOJE);
    assert.equal(desligado.caminhoPx, deHoje.caminhoPx, 'desligar devolve a cadeia de antes, igualzinha');
  });

  it('mão "parada" com tremor de 8 a 12 Hz (simulador): o cursor anda ≥ 80 % menos', () => {
    let hoje = 0;
    let novo = 0;
    for (const amplitude of [0.5, 1, 2, 3]) {
      for (const frequencia of [8, 10, 12]) {
        const serie = serieDeTremor(amplitude, frequencia);
        const antes = percorrer(serie, AJUSTES_DE_HOJE).caminhoPx;
        const depois = percorrer(serie, PADRAO_NOVO).caminhoPx;
        hoje += antes;
        novo += depois;
        if (antes > 0) {
          assert.ok(depois <= antes * 0.2, `${serie.nome}: ${antes} px → ${depois} px`);
        }
      }
    }
    // Medido: 1342 px → 9 px (99,3 %). Abaixo de 2 °/s os dois dão zero (a zona morta e o acumulador).
    assert.ok(novo <= hoje * 0.2, `no total, ${hoje} px → ${novo} px`);
  });

  it('mira lenta não engasga: entrega mais que hoje, sem parada maior, com o deslize medido', () => {
    const casos = [
      ...[0.5, 1, 2].map((velocidade) =>
        serieDeMiraLenta({ velocidadeGrausPorS: velocidade, duracaoS: 3, tremorGrausPorS: 1.5, tremorHz: 10 }),
      ),
      ...[0.5, 1].map((velocidade) => serieDeMiraLenta({ velocidadeGrausPorS: velocidade, duracaoS: 3 })),
    ];
    for (const serie of casos) {
      const hoje = avaliarMira(serie, percorrer(serie, AJUSTES_DE_HOJE));
      const novo = avaliarMira(serie, percorrer(serie, PADRAO_NOVO));
      const rotulo = `${serie.nome}: hoje ${JSON.stringify(hoje)} · novo ${JSON.stringify(novo)}`;

      assert.ok(novo.entregueNoFimPct >= hoje.entregueNoFimPct, rotulo);
      assert.ok(novo.entregueNoFimPct >= 65, rotulo);
      assert.ok(novo.maiorParadaMs <= hoje.maiorParadaMs + 10, rotulo);
      // O preço do filtro: o pendente sai depois de a mão parar. Medido: até 5 px a 2 °/s.
      assert.ok(novo.deslizeAposPararPx <= 6, rotulo);
    }
    // O caso que a zona morta de 0,35 estragava: 0,5 °/s sem tremor saía a 29 %.
    const lenta = serieDeMiraLenta({ velocidadeGrausPorS: 0.5, duracaoS: 3 });
    const hoje = avaliarMira(lenta, percorrer(lenta, AJUSTES_DE_HOJE));
    const novo = avaliarMira(lenta, percorrer(lenta, PADRAO_NOVO));
    assert.ok(novo.entregueNoFimPct >= 2 * hoje.entregueNoFimPct, `${hoje.entregueNoFimPct} → ${novo.entregueNoFimPct}`);
  });

  it('gesto rápido: o filtro acrescenta menos de 15 ms de atraso, e não come pixel', () => {
    const zona = AJUSTES_PADRAO.zonaMortaGrausPorS;
    for (const serie of [
      serieDeGestoRapido(30, 200),
      serieDeGestoRapido(45, 300),
      serieDeGestoRapido(90, 500),
      serieDeGestoRapido(20, 400),
    ]) {
      const referencia = percorrer(serie, semFiltro(zona));
      const novo = percorrer(serie, PADRAO_NOVO);
      const atraso = atrasoMedioMs(referencia, novo);
      // Medido: 3,0 a 9,2 ms (o pior é o gesto mais lento, 20° em 400 ms, pico de 94 °/s).
      assert.ok(atraso < 15, `${serie.nome}: ${atraso.toFixed(1)} ms`);
      const total = referencia.x[referencia.x.length - 1] ?? 0;
      const totalNovo = novo.x[novo.x.length - 1] ?? 0;
      assert.ok(Math.abs(totalNovo - total) <= 1, `${serie.nome}: ${totalNovo} de ${total} px`);
    }
  });

  it('aparelho apoiado: a zona morta nova (0,15 °/s) continua dando zero pixel em 60 s', () => {
    // Ruído de sensor de 0,05 e 0,08 °/s. O S20 apoiado, medido pelo navegador, ficou entre 0,035 e
    // 0,06 °/s por eixo (relatório da ATI-033); a 0,1 °/s já sai 1 px por minuto.
    for (const ruido of [0.05, 0.08]) {
      assert.equal(percorrer(serieApoiada(60, ruido), PADRAO_NOVO).caminhoPx, 0, `ruído ${ruido} °/s`);
    }
  });
});

describe('ATI-033 — as chaves da configuração chegam ao pipeline', () => {
  it('CONTROLE_FILTRO, CONTROLE_FILTRO_CORTE_MINIMO e CONTROLE_FILTRO_BETA', () => {
    const configuracao = carregarConfiguracao({
      caminhoDoArquivo: null,
      ambiente: {
        [VARIAVEIS_DE_AMBIENTE.filtro]: 'exponencial',
        [VARIAVEIS_DE_AMBIENTE.filtroCorteMinimo]: '2.5',
        [VARIAVEIS_DE_AMBIENTE.filtroBeta]: '0',
      },
    });
    const ajustes = resolverAjustes(ajustesDaConfiguracao(configuracao).ajustes);

    assert.equal(ajustes.filtro, 'exponencial');
    assert.equal(ajustes.filtroCorteMinimoHz, 2.5);
    assert.equal(ajustes.filtroBeta, 0, 'zero é pedido de verdade, e não o sentinela');
    assert.equal(ajustes.filtroCorteDaVelocidadeHz, AJUSTES_PADRAO.filtroCorteDaVelocidadeHz);
  });

  it('sem nada pedido, vale o padrão de fábrica', () => {
    const configuracao = carregarConfiguracao({ caminhoDoArquivo: null, ambiente: {} });
    const ajustes = resolverAjustes(ajustesDaConfiguracao(configuracao).ajustes);

    assert.equal(ajustes.filtro, AJUSTES_PADRAO.filtro);
    assert.equal(ajustes.filtroCorteMinimoHz, AJUSTES_PADRAO.filtroCorteMinimoHz);
    assert.equal(ajustes.filtroBeta, AJUSTES_PADRAO.filtroBeta);
    assert.equal(ajustes.zonaMortaGrausPorS, 0.15);
  });
});
