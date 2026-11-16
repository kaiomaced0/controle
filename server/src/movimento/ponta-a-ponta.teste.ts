/**
 * O pipeline contra o **simulador de aparelho** (ATI-023) — os critérios de aceite da ATI-008.
 *
 * O simulador entrega o que celular nenhum entrega: **movimento conhecido**. Quando a execução
 * declara 90° no eixo y, o deslocamento esperado do cursor vira conta, e a conta vira asserção.
 * É por isso que os números daqui podem ir para o relatório como medição, e não como impressão.
 *
 * Dois caminhos, de propósito:
 *
 * - **Fora da rede** (`alimentarComFonte`): a série do simulador entra direto no pipeline, com o
 *   relógio de chegada controlado. É o que permite rodar 60 s de aparelho parado em milissegundos
 *   e afirmar "zero pixel" sem depender do relógio da máquina.
 * - **Pela rede** (`executarBancada`): servidor de verdade, WebSocket de verdade, codec de
 *   verdade, e o destino é a **dubla** da camada de saída. É o caminho do celular na mesa, menos
 *   o celular.
 *
 * Nada aqui toca no cursor: o destino é sempre a dubla (`saida/dubla.ts`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  criarAmostraSimulada,
  criarFonteDeAmostras,
  executarBancada,
  resolverParametros,
  type AmostraSimulada,
  type FonteDeAmostras,
  type OpcoesDePadrao,
} from '../cli/simulador/indice.js';
import { TIPO_MOVIMENTO, criarPacoteDecodificado } from '../protocolo/indice.js';
import { criarBackendDubla, type BackendDubla } from '../saida/dubla.js';
import type { AjustesParciais } from './ajustes.js';
import { criarCalibracaoDeBias } from './calibracao.js';
import { criarPipelineDeMovimento, type PipelineDeMovimento } from './pipeline.js';

/** Tela grande para o cursor virtual da dubla não bater na borda no meio de uma medição. */
const TELA_DE_BANCADA = { largura: 8000, altura: 8000 } as const;

/** Soma dos `dx`/`dy` que a dubla recebeu — o que o pipeline **pediu**, evento a evento. */
function somarEventos(dubla: BackendDubla): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  for (const evento of dubla.eventos) {
    if (evento.tipo !== 'mover') continue;
    dx += evento.dx;
    dy += evento.dy;
  }
  return { dx, dy };
}

/** Pipeline com dubla e relógio de chegada preso ao carimbo do aparelho (chegada perfeita). */
function montarFora(ajustes: AjustesParciais): {
  pipeline: PipelineDeMovimento;
  dubla: BackendDubla;
  alimentar: (fonte: FonteDeAmostras) => void;
} {
  const dubla = criarBackendDubla({ tela: TELA_DE_BANCADA });
  let chegadaMs = 0;
  const pipeline = criarPipelineDeMovimento({
    destino: dubla,
    ajustes,
    // A chegada acompanha o carimbo do aparelho: atraso relativo constante e igual a zero. Sem
    // isso, uma série de 60 s "chegaria" toda no mesmo instante e a guarda de atraso descartaria
    // o que este teste quer medir.
    relogio: () => chegadaMs,
  });
  const pacote = criarPacoteDecodificado();

  return {
    pipeline,
    dubla,
    alimentar(fonte) {
      const amostra = criarAmostraSimulada();
      while (fonte.proxima(amostra)) {
        chegadaMs = amostra.tDispositivoMs;
        pacote.tipo = TIPO_MOVIMENTO;
        pacote.flags = amostra.flags;
        pacote.seq = amostra.seq;
        pacote.tDispositivoMs = amostra.tDispositivoMs;
        pacote.dtMs = amostra.dtMs;
        pacote.gx = amostra.gx;
        pacote.gy = amostra.gy;
        pacote.gz = amostra.gz;
        pipeline.processar(pacote);
      }
    },
  };
}

function fonteDe(opcoes: OpcoesDePadrao): FonteDeAmostras {
  return criarFonteDeAmostras(resolverParametros(opcoes));
}

/**
 * A calibração de bias **de verdade** (ATI-009) rodando sobre a série do simulador.
 *
 * Até a ATI-009 esta função era uma média escrita à mão aqui dentro, com o comentário de que era
 * "o que a calibração vai fazer". Agora ela existe: é o mesmo `criarCalibracaoDeBias` que o
 * `calibrar-fim` usa, alimentado pacote a pacote. O critério "60 s parado = zero pixel" continua
 * sendo sobre **bias descontado**, e agora sobre o bias que o produto realmente mede.
 */
function calibrarBias(
  fonte: FonteDeAmostras,
  quantidade: number,
): { gx: number; gy: number; gz: number } {
  const calibracao = criarCalibracaoDeBias();
  const amostra: AmostraSimulada = criarAmostraSimulada();
  const pacote = criarPacoteDecodificado();
  calibracao.iniciar();
  let usadas = 0;
  while (usadas < quantidade && fonte.proxima(amostra)) {
    // A primeira amostra vem com `dtMs` 0 (ela se anuncia como primeira após retomar).
    if (!(amostra.dtMs > 0)) continue;
    pacote.tipo = TIPO_MOVIMENTO;
    pacote.dtMs = amostra.dtMs;
    pacote.gx = amostra.gx;
    pacote.gy = amostra.gy;
    pacote.gz = amostra.gz;
    calibracao.registrar(pacote);
    usadas += 1;
  }
  const resultado = calibracao.finalizar();
  fonte.reiniciar();
  assert.equal(resultado.ok, true, resultado.ok ? '' : resultado.mensagem);
  return resultado.ok ? resultado.bias : { gx: 0, gy: 0, gz: 0 };
}

describe('pipeline × simulador — aparelho parado', () => {
  it('60 s parado em cima da mesa, com bias calibrado: ZERO pixel', () => {
    // Bias de 2 °/s: exagerado de propósito. Com o bias de fábrica do simulador (0,29 °/s) a zona
    // morta sozinha já engoliria tudo, e o teste passaria verde sem provar nada sobre a etapa 1.
    const pedido: OpcoesDePadrao = {
      padrao: 'parado',
      taxaHz: 100,
      duracaoS: 60,
      biasGrausPorS: 2,
    };

    const bias = calibrarBias(fonteDe(pedido), 120);
    const { pipeline, dubla, alimentar } = montarFora({
      sensXPixelsPorGrau: 35,
      sensYPixelsPorGrau: 35,
      biasGxRadPorS: bias.gx,
      biasGyRadPorS: bias.gy,
      biasGzRadPorS: bias.gz,
    });

    alimentar(fonteDe(pedido));

    assert.equal(pipeline.contadores.amostrasRecebidas, 6001);
    assert.equal(pipeline.contadores.pixelsX, 0, 'o cursor não andou nenhum pixel em 60 s');
    assert.equal(pipeline.contadores.pixelsY, 0);
    assert.equal(dubla.eventos.length, 0, 'nem uma chamada chegou ao backend');
    assert.equal(dubla.lerPosicaoDoMouse()?.x, TELA_DE_BANCADA.largura / 2);
  });

  it('sem calibrar, os mesmos 60 s levam o cursor embora — é o defeito nº 1 dos apps ruins', () => {
    const pedido: OpcoesDePadrao = {
      padrao: 'parado',
      taxaHz: 100,
      duracaoS: 60,
      biasGrausPorS: 2,
    };
    const { pipeline, alimentar } = montarFora({
      sensXPixelsPorGrau: 35,
      sensYPixelsPorGrau: 35,
    });

    alimentar(fonteDe(pedido));

    const percorrido = Math.hypot(pipeline.contadores.pixelsX, pipeline.contadores.pixelsY);
    assert.ok(percorrido > 1000, `sem bias o cursor derivou ${percorrido.toFixed(0)} px em 60 s`);
  });

  it('bias calibrado e zona morta desligada: sobra só o erro da média, e ele é pequeno', () => {
    // Serve para separar as duas trancas. Descontar o bias leva o erro para a casa do ruído
    // residual da própria calibração (~0,005 °/s); é a zona morta que faz esse resto virar zero.
    const pedido: OpcoesDePadrao = {
      padrao: 'parado',
      taxaHz: 100,
      duracaoS: 60,
      biasGrausPorS: 2,
    };
    const bias = calibrarBias(fonteDe(pedido), 120);
    const { pipeline, alimentar } = montarFora({
      sensXPixelsPorGrau: 35,
      sensYPixelsPorGrau: 35,
      zonaMortaGrausPorS: 0,
      biasGxRadPorS: bias.gx,
      biasGyRadPorS: bias.gy,
      biasGzRadPorS: bias.gz,
    });

    alimentar(fonteDe(pedido));

    const percorrido = Math.hypot(pipeline.contadores.pixelsX, pipeline.contadores.pixelsY);
    assert.ok(percorrido < 60, `sem zona morta sobraram ${percorrido.toFixed(0)} px em 60 s`);
  });
});

describe('pipeline × simulador — tremor e pico', () => {
  it('tremor de mão abaixo do limiar não move nada', () => {
    // A cadeia de antes da ATI-033 (média exponencial e zona morta de 0,35 °/s), escrita por
    // extenso: este teste é sobre a zona morta segurando sozinha. Com o padrão novo (filtro
    // adaptativo e zona morta de 0,15) quem segura é o filtro — ver `filtro-adaptativo.teste.ts`.
    const { pipeline, alimentar } = montarFora({
      sensXPixelsPorGrau: 35,
      sensYPixelsPorGrau: 35,
      filtro: 'exponencial',
      zonaMortaGrausPorS: 0.35,
    });

    // 0,3 °/s a 8 Hz por 10 s — a amplitude de fábrica do simulador, logo abaixo da zona morta.
    alimentar(fonteDe({ padrao: 'tremor', taxaHz: 100, duracaoS: 10, amplitudeGrausPorS: 0.3 }));

    assert.equal(pipeline.contadores.pixelsX, 0);
    assert.equal(pipeline.contadores.pixelsY, 0);
    // 953 das 1000 amostras foram zeradas de vez pela zona morta; nas outras 47 o ruído do sensor
    // levou o pico do tremor acima do limiar, e o que passou foi tão pouco que não fechou um pixel.
    // As duas coisas juntas são o ponto: tremor de mão não pode virar movimento de cursor.
    assert.ok(pipeline.contadores.zeradasPorZonaMorta > 900, 'a zona morta é quem segurou');
  });

  it('pico isolado de 2000 °/s vira um passo limitado, não um salto de tela', () => {
    const { pipeline, dubla, alimentar } = montarFora({
      sensXPixelsPorGrau: 35,
      sensYPixelsPorGrau: 35,
    });

    alimentar(
      fonteDe({
        padrao: 'pico',
        taxaHz: 100,
        duracaoS: 2,
        eixo: 'y',
        picoGrausPorS: 2000,
        indiceDoPico: 100,
      }),
    );

    assert.equal(pipeline.contadores.limitadasPorPico >= 1, true, 'o limite entrou em ação');
    // Sem o limite, uma amostra de 2000 °/s com 35 px/grau valeria 595 px de uma vez.
    const maiorPasso = dubla.eventos.reduce(
      (maior, evento) => (evento.tipo === 'mover' ? Math.max(maior, Math.abs(evento.dx)) : maior),
      0,
    );
    assert.ok(maiorPasso <= 120, `o maior passo de uma amostra foi ${maiorPasso} px`);
  });
});

describe('pipeline × simulador — rotação conhecida', () => {
  it('90° no eixo y viram o número exato de pixels (sem zona morta e sem suavização)', () => {
    const sens = 10;
    const { pipeline, dubla, alimentar } = montarFora({
      sensXPixelsPorGrau: sens,
      zonaMortaGrausPorS: 0,
      suavizacao: 0,
      filtro: 'exponencial',
    });

    alimentar(fonteDe({ padrao: 'rotacao', graus: 90, eixo: 'y', taxaHz: 100 }));

    const esperado = -90 * sens; // gy positivo leva o cursor para a esquerda (ver `eixos.ts`)
    const obtido = somarEventos(dubla).dx;
    const erro = Math.abs((obtido - esperado) / esperado);

    assert.equal(pipeline.contadores.pixelsX, obtido, 'contador e backend contam a mesma coisa');
    assert.ok(erro < 0.005, `esperado ${esperado} px, obtido ${obtido} px (erro ${(erro * 100).toFixed(2)} %)`);
    assert.equal(somarEventos(dubla).dy, 0, 'o eixo que ninguém girou não moveu o cursor');
  });

  it('rotação muito lenta (2 °/s) acaba movendo o cursor', () => {
    const sens = 10;
    const { pipeline, alimentar } = montarFora({
      sensXPixelsPorGrau: sens,
      zonaMortaGrausPorS: 0,
      suavizacao: 0,
      filtro: 'exponencial',
    });

    // 2° a 2 °/s = 1 s: cada amostra vale 0,2 px, e truncar por amostra daria zero para sempre.
    alimentar(
      fonteDe({
        padrao: 'rotacao',
        graus: 2,
        velocidadeGrausPorS: 2,
        eixo: 'y',
        taxaHz: 100,
      }),
    );

    assert.equal(pipeline.contadores.pixelsX, -20, '2° × 10 px/grau');
    assert.ok(
      pipeline.contadores.amostrasSemMovimento > 70,
      'a maioria das amostras sozinha não fechava um pixel',
    );
  });
});

describe('pipeline × bancada — servidor, socket e dubla de verdade', () => {
  it('90° no eixo y pela rede: o deslocamento previsto aparece na dubla', async () => {
    const sens = 10;
    const zonaMorta = 0.35;
    const dubla = criarBackendDubla({ tela: TELA_DE_BANCADA });
    const pipeline = criarPipelineDeMovimento({
      destino: dubla,
      ajustes: { sensXPixelsPorGrau: sens, zonaMortaGrausPorS: zonaMorta },
    });

    const resultado = await executarBancada({
      padrao: { padrao: 'rotacao', graus: 90, eixo: 'y', taxaHz: 100 },
      aoReceberPacote: (pacote) => {
        pipeline.processar(pacote);
      },
    });

    assert.equal(resultado.resumo.desfecho, 'completo', resultado.resumo.motivo);
    assert.equal(resultado.medidas?.pacotesRecebidos, 101);
    assert.equal(pipeline.contadores.amostrasRecebidas, 101);
    assert.equal(pipeline.contadores.retomadas, 1, 'a primeira amostra se anuncia e não integra');
    assert.equal(pipeline.contadores.descartadasPorOrdem, 0);
    assert.equal(pipeline.contadores.descartadasPorLeituraInvalida, 0);

    // Previsão em papel: a rotação dura 1 s, a zona morta come 0,35 °/s desse tempo, e o que
    // sobra vira pixel na sensibilidade escolhida. A suavização não muda o total — ela atrasa —,
    // mas deixa pendente o que ainda estava na média quando a execução acabou.
    const esperado = -(90 - zonaMorta * 1) * sens;
    const obtido = somarEventos(dubla).dx;
    const erro = Math.abs((obtido - esperado) / esperado);

    assert.ok(
      erro < 0.05,
      `esperado ${esperado.toFixed(1)} px, obtido ${obtido} px (erro ${(erro * 100).toFixed(2)} %)`,
    );
    assert.equal(dubla.contadores.pedidosInvalidos, 0);
    assert.equal(dubla.pressionados(), 0, 'movimento não prende botão nenhum');
  });

  it('o aparelho parado pela rede também não move nada', async () => {
    // Com o bias calibrado, como no produto (ATI-009). Até a ATI-033 este teste rodava sem
    // calibrar e passava porque a zona morta de fábrica (0,35 °/s) era maior que o bias do
    // simulador (0,29 °/s); a de hoje (0,15) existe para o ruído do sensor, não para bias — quem
    // desconta bias é a etapa 1. O padrão novo continua dando zero aqui, e é isso que se afirma.
    const pedido: OpcoesDePadrao = { padrao: 'parado', taxaHz: 200, duracaoS: 1, biasGrausPorS: 0.29 };
    const bias = calibrarBias(fonteDe(pedido), 120);
    const dubla = criarBackendDubla({ tela: TELA_DE_BANCADA });
    const pipeline = criarPipelineDeMovimento({
      destino: dubla,
      ajustes: { biasGxRadPorS: bias.gx, biasGyRadPorS: bias.gy, biasGzRadPorS: bias.gz },
    });

    const resultado = await executarBancada({
      padrao: pedido,
      aoReceberPacote: (pacote) => {
        pipeline.processar(pacote);
      },
    });

    assert.equal(resultado.resumo.desfecho, 'completo', resultado.resumo.motivo);
    assert.equal(pipeline.contadores.pixelsX, 0);
    assert.equal(pipeline.contadores.pixelsY, 0);
    assert.equal(dubla.eventos.length, 0);
  });
});
