/**
 * Teste da cadeia de movimento com **séries sintéticas** (ATI-008).
 *
 * Nada aqui toca no cursor da máquina: o destino é o de ensaio (`ensaio.ts`) ou a dubla da camada
 * de saída (`saida/dubla.ts`). Tem gente trabalhando neste PC — a regra do sprint é essa desde a
 * ATI-007 e ela não muda porque agora existe uma cadeia que produz pixels.
 *
 * O aparelho de mentira daqui é o mais simples possível de propósito: uma função que carimba
 * `seq`, `tDispositivoMs` e `dtMs` e chama `processar`. Séries com forma (rotação, tremor, pico,
 * parado com ruído) são geradas pelo simulador da ATI-023 e vivem em `ponta-a-ponta.teste.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FLAG_PRIMEIRA_APOS_RETOMAR,
  TIPO_BOTAO,
  TIPO_MOVIMENTO,
  criarPacoteDecodificado,
  proximoSeq,
} from '../protocolo/indice.js';
import { criarBackendDubla } from '../saida/dubla.js';
import type { AjustesParciais } from './ajustes.js';
import { criarDestinoDeEnsaio } from './ensaio.js';
import { DESCARTES_ATE_REANCORAR, criarPipelineDeMovimento } from './pipeline.js';
import {
  RADIANOS_POR_GRAU,
  RESULTADO_DE_MOVIMENTO,
  criarContadoresDoPipeline,
  somarContadoresDoPipeline,
  type DestinoDeMovimento,
  type ResultadoDeMovimento,
} from './tipos.js';

/** Uptime de mentira do aparelho, na linha do simulador: nunca começa em zero. */
const TEMPO_INICIAL_DO_APARELHO_MS = 60_000;

interface OpcoesDoAparelho {
  readonly ajustes?: AjustesParciais | undefined;
  readonly destino?: DestinoDeMovimento | undefined;
}

/**
 * Um aparelho de mentira ligado ao pipeline, com relógio de chegada controlado pelo teste.
 *
 * O relógio anda junto com o `dtMs` de cada amostra: é a chegada perfeita, sem atraso nenhum. Quem
 * quiser simular engasgo de rede chama `atrasar(ms)`, que empurra **só** a chegada.
 */
function criarAparelho(opcoes: OpcoesDoAparelho = {}) {
  const destino = opcoes.destino ?? criarDestinoDeEnsaio();
  let chegadaMs = 1000;
  const pipeline = criarPipelineDeMovimento({
    destino,
    ajustes: opcoes.ajustes,
    relogio: () => chegadaMs,
  });
  const pacote = criarPacoteDecodificado();
  let seq = 0;
  let tDispositivoMs = TEMPO_INICIAL_DO_APARELHO_MS;

  function enviar(
    grausPorSX: number,
    grausPorSY: number,
    grausPorSZ: number,
    dtMs = 10,
    flags = 0,
  ): ResultadoDeMovimento {
    pacote.tipo = TIPO_MOVIMENTO;
    pacote.flags = flags;
    pacote.seq = seq;
    seq = proximoSeq(seq);
    if (dtMs > 0 && Number.isFinite(dtMs)) {
      tDispositivoMs += dtMs;
      chegadaMs += dtMs;
    }
    pacote.tDispositivoMs = tDispositivoMs;
    pacote.dtMs = dtMs;
    pacote.gx = grausPorSX * RADIANOS_POR_GRAU;
    pacote.gy = grausPorSY * RADIANOS_POR_GRAU;
    pacote.gz = grausPorSZ * RADIANOS_POR_GRAU;
    return pipeline.processar(pacote);
  }

  return {
    pipeline,
    destino,
    /** Uma amostra, em graus por segundo por eixo. */
    enviar,
    /** `n` amostras iguais. Devolve o último resultado. */
    enviarVarias(
      quantidade: number,
      grausPorSX: number,
      grausPorSY: number,
      grausPorSZ: number,
      dtMs = 10,
    ): ResultadoDeMovimento {
      let ultimo: ResultadoDeMovimento = RESULTADO_DE_MOVIMENTO.SEM_MOVIMENTO;
      for (let indice = 0; indice < quantidade; indice += 1) {
        ultimo = enviar(grausPorSX, grausPorSY, grausPorSZ, dtMs);
      }
      return ultimo;
    },
    /** A amostra que se anuncia como primeira depois de retomar (bit2 de `flags`). */
    retomar(): ResultadoDeMovimento {
      return enviar(0, 0, 0, 0, FLAG_PRIMEIRA_APOS_RETOMAR);
    },
    /** Empurra **só** a chegada: é o engasgo de rede visto do lado do PC. */
    atrasar(ms: number): void {
      chegadaMs += ms;
    },
    /** Repete o `seq` já usado — pacote fora de ordem. */
    enviarComSeq(seqPedido: number, grausPorSY: number, dtMs = 10): ResultadoDeMovimento {
      pacote.tipo = TIPO_MOVIMENTO;
      pacote.flags = 0;
      pacote.seq = seqPedido;
      tDispositivoMs += dtMs;
      chegadaMs += dtMs;
      pacote.tDispositivoMs = tDispositivoMs;
      pacote.dtMs = dtMs;
      pacote.gx = 0;
      pacote.gy = grausPorSY * RADIANOS_POR_GRAU;
      pacote.gz = 0;
      return pipeline.processar(pacote);
    },
    /** Um pacote que não é MOVIMENTO. */
    enviarBotao(): ResultadoDeMovimento {
      pacote.tipo = TIPO_BOTAO;
      return pipeline.processar(pacote);
    },
  };
}

/**
 * Ajuste "de bancada": sem zona morta e sem suavização, para a conta fechar exata. O filtro é o
 * exponencial com `suavizacao` 0 — a única etapa 4 que é a identidade —, porque o padrão de
 * fábrica passou a ser o adaptativo na ATI-033 (que tem os testes dele em `filtro-adaptativo.teste.ts`).
 */
const CRU: AjustesParciais = { zonaMortaGrausPorS: 0, suavizacao: 0, filtro: 'exponencial' };

describe('pipeline de movimento — etapa 1: bias', () => {
  it('sem descontar o bias, o aparelho parado leva o cursor embora sozinho', () => {
    // O defeito nº 1 dos apps ruins, reproduzido de propósito: 0,005 rad/s é o que um giroscópio
    // parado acusa de verdade (ARQUITETURA.md, seção 3).
    const biasGrausPorS = 0.005 * (180 / Math.PI);
    const aparelho = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 35 } });

    aparelho.enviarVarias(6000, 0, biasGrausPorS, 0);

    // 60 s de aparelho parado em cima da mesa: o cursor andou meia tela.
    assert.ok(
      Math.abs(aparelho.pipeline.contadores.pixelsX) > 500,
      `sem bias o cursor derivou ${aparelho.pipeline.contadores.pixelsX} px em 60 s`,
    );
  });

  it('com o bias descontado, os mesmos 60 s não movem nenhum pixel', () => {
    const biasRadPorS = 0.005;
    const biasGrausPorS = biasRadPorS * (180 / Math.PI);
    const aparelho = criarAparelho({
      ajustes: { ...CRU, sensXPixelsPorGrau: 35, biasGyRadPorS: biasRadPorS },
    });

    aparelho.enviarVarias(6000, 0, biasGrausPorS, 0);

    assert.equal(aparelho.pipeline.contadores.pixelsX, 0, 'nenhum pixel em 60 s de mesa');
    assert.equal(aparelho.pipeline.contadores.pixelsY, 0);
    assert.equal(aparelho.pipeline.contadores.amostrasAplicadas, 0, 'nada chegou ao destino');
  });

  it('bias entra nos três eixos, e `definirBias` troca os três de uma vez', () => {
    const aparelho = criarAparelho({ ajustes: CRU });
    aparelho.pipeline.definirBias(0.01, 0.02, 0.03);

    assert.equal(aparelho.pipeline.ajustes.biasGxRadPorS, 0.01);
    assert.equal(aparelho.pipeline.ajustes.biasGyRadPorS, 0.02);
    assert.equal(aparelho.pipeline.ajustes.biasGzRadPorS, 0.03);

    // Amostra idêntica ao bias: sobra zero depois da etapa 1.
    const grau = 180 / Math.PI;
    aparelho.enviarVarias(200, 0.01 * grau, 0.02 * grau, 0.03 * grau);
    assert.equal(aparelho.pipeline.contadores.pixelsX, 0);
    assert.equal(aparelho.pipeline.contadores.pixelsY, 0);
  });
});

describe('pipeline de movimento — etapa 2: escolha de eixos', () => {
  it('em retrato, girar para a esquerda (gy > 0) leva o cursor para a esquerda', () => {
    const aparelho = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 10 } });

    aparelho.enviarVarias(100, 0, 90, 0);

    // 90 °/s por 1 s a 10 px/grau = 900 px, para o lado −x (ver `eixos.ts`).
    assert.equal(aparelho.pipeline.contadores.pixelsX, -900);
    assert.equal(aparelho.pipeline.contadores.pixelsY, 0, 'giro no eixo y não mexe na vertical');
  });

  it('em retrato, levantar o aparelho (gx > 0) leva o cursor para cima', () => {
    const aparelho = criarAparelho({ ajustes: { ...CRU, sensYPixelsPorGrau: 10 } });

    aparelho.enviarVarias(100, 45, 0, 0);

    // Positivo é para baixo no Windows: cursor para cima é dy negativo.
    assert.equal(aparelho.pipeline.contadores.pixelsY, -450);
    assert.equal(aparelho.pipeline.contadores.pixelsX, 0);
  });

  it('o giro em torno do eixo que aponta (gz, o roll) não mexe no cursor', () => {
    const aparelho = criarAparelho({ ajustes: CRU });

    aparelho.enviarVarias(100, 0, 0, 180);

    assert.equal(aparelho.pipeline.contadores.pixelsX, 0);
    assert.equal(aparelho.pipeline.contadores.pixelsY, 0);
  });

  it('em paisagem os papéis dos eixos trocam', () => {
    const aparelho = criarAparelho({
      ajustes: { ...CRU, orientacao: 'paisagem', sensXPixelsPorGrau: 10, sensYPixelsPorGrau: 10 },
    });

    aparelho.enviarVarias(100, 90, 0, 0);
    assert.equal(aparelho.pipeline.contadores.pixelsX, -900, 'gx vira horizontal em paisagem');

    aparelho.pipeline.zerarContadores();
    aparelho.enviarVarias(100, 0, 90, 0);
    assert.equal(aparelho.pipeline.contadores.pixelsY, 900, 'gy vira vertical, com sinal trocado');
  });

  it('inverterX e inverterY trocam o sentido sem mexer no tamanho do passo', () => {
    const normal = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 10 } });
    const invertido = criarAparelho({
      ajustes: { ...CRU, sensXPixelsPorGrau: 10, inverterX: true },
    });

    normal.enviarVarias(100, 0, 90, 0);
    invertido.enviarVarias(100, 0, 90, 0);

    assert.equal(normal.pipeline.contadores.pixelsX, -900);
    assert.equal(invertido.pipeline.contadores.pixelsX, 900);
  });
});

describe('pipeline de movimento — etapa 3: zona morta com transição suave', () => {
  it('abaixo do limiar não sai pixel nenhum, e o contador diz por quê', () => {
    const aparelho = criarAparelho({
      ajustes: { zonaMortaGrausPorS: 0.35, suavizacao: 0, sensXPixelsPorGrau: 100 },
    });

    aparelho.enviarVarias(500, 0, 0.34, 0);

    assert.equal(aparelho.pipeline.contadores.pixelsX, 0);
    assert.equal(aparelho.pipeline.contadores.zeradasPorZonaMorta, 500);
  });

  it('não existe degrau ao cruzar o limiar: a saída sai de zero, não do valor cheio', () => {
    // Corte seco daria, logo acima do limiar, a velocidade **inteira**; com transição suave sobra
    // só o excedente. É a diferença entre o cursor pular e o cursor sair andando devagar quando a
    // mão treme perto do limite.
    const limiar = 0.35;
    const sens = 200; // o teto da faixa: sem sensibilidade alta a diferença não vira pixel inteiro
    const aparelho = criarAparelho({
      ajustes: { zonaMortaGrausPorS: limiar, suavizacao: 0, filtro: 'exponencial', sensXPixelsPorGrau: sens },
    });

    // 1 s logo acima do limiar (2 % acima).
    aparelho.enviarVarias(100, 0, limiar * 1.02, 0);
    const logoAcima = Math.abs(aparelho.pipeline.contadores.pixelsX);

    aparelho.pipeline.zerarContadores();
    aparelho.pipeline.reiniciar();
    // 1 s no dobro do limiar.
    aparelho.enviarVarias(100, 0, limiar * 2, 0);
    const dobroDoLimiar = Math.abs(aparelho.pipeline.contadores.pixelsX);

    // Com corte seco, o primeiro trecho teria produzido ~71 px (a velocidade inteira, 0,357 °/s ×
    // 200 px/grau). Com transição suave ele produz ~1 px — o excedente de 2 % acima do limiar.
    assert.ok(logoAcima <= 3, `logo acima do limiar saíram ${logoAcima} px (corte seco daria ~71)`);
    assert.ok(
      Math.abs(dobroDoLimiar - limiar * sens) <= 1,
      `no dobro do limiar saíram ${dobroDoLimiar} px (esperado ~${limiar * sens})`,
    );
  });

  it('a zona morta age na magnitude, não eixo a eixo: a direção da diagonal se mantém', () => {
    // Zona morta por eixo deformaria o movimento diagonal lento — o cursor sairia torto.
    const aparelho = criarAparelho({
      ajustes: {
        zonaMortaGrausPorS: 1,
        suavizacao: 0,
        filtro: 'exponencial',
        sensXPixelsPorGrau: 100,
        sensYPixelsPorGrau: 100,
      },
    });

    aparelho.enviarVarias(100, 10, 10, 0);

    const { pixelsX, pixelsY } = aparelho.pipeline.contadores;
    assert.equal(Math.abs(pixelsX), Math.abs(pixelsY), 'os dois eixos encolheram igual');
    // Magnitude 14,14 °/s, limiar 1 → fator 0,929: cada eixo vira 9,29 °/s × 100 px/grau × 1 s.
    assert.ok(Math.abs(Math.abs(pixelsX) - 929) < 2, `saíram ${Math.abs(pixelsX)} px`);
  });

  it('a amostra parada com a média já em zero sai pelo atalho, sem mudar nada', () => {
    // O caso mais comum de todos (aparelho na mesa: 6000 de 6001 amostras da série de 60 s) não
    // precisa percorrer média, sensibilidade, integração e acumulador para produzir zero. O que
    // este teste guarda é a **equivalência**: mesmo resultado, mesmos contadores, e a fração de
    // subpixel intocada — o atalho não pode virar um jeito de perder movimento guardado.
    const aparelho = criarAparelho({
      ajustes: { zonaMortaGrausPorS: 1, suavizacao: 0, filtro: 'exponencial', sensXPixelsPorGrau: 10 },
    });

    // Uma amostra logo acima do limiar: deixa fração guardada e a média diferente de zero.
    assert.equal(aparelho.enviar(0, 1.05, 0), RESULTADO_DE_MOVIMENTO.SEM_MOVIMENTO);
    const fracaoGuardada = aparelho.pipeline.fracaoX;
    assert.notEqual(fracaoGuardada, 0);

    // A primeira amostra parada ainda percorre a cadeia (é ela que escoa a média até zero);
    // a segunda já encontra a média zerada e sai no atalho.
    assert.equal(aparelho.enviar(0, 0, 0), RESULTADO_DE_MOVIMENTO.SEM_MOVIMENTO);
    assert.equal(aparelho.enviar(0, 0, 0), RESULTADO_DE_MOVIMENTO.SEM_MOVIMENTO);

    assert.equal(aparelho.pipeline.fracaoX, fracaoGuardada, 'o atalho não come a fração guardada');
    assert.equal(aparelho.pipeline.contadores.zeradasPorZonaMorta, 2);
    assert.equal(aparelho.pipeline.contadores.amostrasSemMovimento, 3);
    assert.equal(aparelho.pipeline.contadores.pixelsX, 0);
  });

  it('zona morta zero desliga a etapa por completo', () => {
    const aparelho = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 100 } });

    aparelho.enviarVarias(100, 0, 0.1, 0);

    assert.equal(aparelho.pipeline.contadores.zeradasPorZonaMorta, 0);
    // 0,1 °/s × 1 s × 100 px/grau = 10 px. Sai 9, e o décimo fica **pendente** no acumulador: a
    // ida e volta grau→radiano→grau deixa o total em 9,99999…, e a etapa 7 emite só o inteiro.
    // Guardar essa fração em vez de arredondar é o que faz o movimento lento não se perder.
    assert.equal(aparelho.pipeline.contadores.pixelsX, -9);
    assert.ok(Math.abs(aparelho.pipeline.fracaoX) > 0.99, 'o pixel que falta está guardado');
  });
});

describe('pipeline de movimento — etapa 4: suavização', () => {
  it('segue a fórmula s = a·x + (1−a)·s_anterior, com a = 1 − suavizacao', () => {
    const suavizacao = 0.5;
    const sens = 100;
    const aparelho = criarAparelho({
      ajustes: { zonaMortaGrausPorS: 0, suavizacao, filtro: 'exponencial', sensXPixelsPorGrau: sens },
    });

    // Degrau de 10 °/s. Com a = 0,5, a saída suavizada vale 5, 7,5, 8,75… °/s.
    // Em pixels por amostra (dt = 10 ms): 5, 7,5, 8,75 → o acumulador entrega 5, 12, 21 px.
    aparelho.enviar(0, 10, 0);
    assert.equal(aparelho.pipeline.contadores.pixelsX, -5);
    aparelho.enviar(0, 10, 0);
    assert.equal(aparelho.pipeline.contadores.pixelsX, -12);
    aparelho.enviar(0, 10, 0);
    assert.equal(aparelho.pipeline.contadores.pixelsX, -21);
  });

  it('suavização não come deslocamento: ela atrasa, e o total continua o mesmo', () => {
    const comum = criarAparelho({
      ajustes: { zonaMortaGrausPorS: 0, suavizacao: 0.8, sensXPixelsPorGrau: 10 },
    });
    const semSuavizacao = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 10 } });

    // Rotação longa o bastante para o transitório do começo virar detalhe.
    comum.enviarVarias(1000, 0, 90, 0);
    semSuavizacao.enviarVarias(1000, 0, 90, 0);

    const diferenca = Math.abs(
      comum.pipeline.contadores.pixelsX - semSuavizacao.pipeline.contadores.pixelsX,
    );
    assert.ok(
      diferenca <= 40,
      `suavizada ${comum.pipeline.contadores.pixelsX} px contra ` +
        `${semSuavizacao.pipeline.contadores.pixelsX} px`,
    );
  });

  it('amostra zerada pela zona morta continua entrando na média — o resíduo escoa', () => {
    const aparelho = criarAparelho({
      ajustes: { zonaMortaGrausPorS: 1, suavizacao: 0.8, sensXPixelsPorGrau: 100 },
    });

    aparelho.enviarVarias(50, 0, 90, 0);
    const durante = aparelho.pipeline.contadores.pixelsX;

    // A mão parou: as amostras seguintes estão dentro da zona morta.
    aparelho.enviarVarias(100, 0, 0, 0);
    const depois = aparelho.pipeline.contadores.pixelsX;

    assert.ok(depois !== durante, 'o que estava guardado na média saiu em vez de ficar preso');
    // E escoou até o fim: mais 100 amostras paradas não movem mais que o último pixel pendente no
    // acumulador de subpixel (a média já está em 10⁻⁷ °/s aqui).
    aparelho.enviarVarias(100, 0, 0, 0);
    assert.ok(
      Math.abs(aparelho.pipeline.contadores.pixelsX - depois) <= 1,
      'a média chegou a zero e ficou',
    );
  });
});

describe('pipeline de movimento — etapas 5 e 6: sensibilidade e integração', () => {
  it('a sensibilidade é em pixels por grau, separada em X e Y', () => {
    const aparelho = criarAparelho({
      ajustes: { ...CRU, sensXPixelsPorGrau: 10, sensYPixelsPorGrau: 40 },
    });

    aparelho.enviarVarias(100, 45, 45, 0);

    assert.equal(aparelho.pipeline.contadores.pixelsX, -450, '45° × 10 px/grau');
    assert.equal(aparelho.pipeline.contadores.pixelsY, -1800, '45° × 40 px/grau');
  });

  it('integra pelo dt do aparelho: dt irregular dá o mesmo total que dt constante', () => {
    const constante = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 10 } });
    const irregular = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 10 } });

    // 200 amostras de 10 ms = 2 s.
    constante.enviarVarias(200, 0, 90, 0);
    // 200 amostras alternando 5 ms e 15 ms = os mesmos 2 s, com o dobro de jitter.
    for (let indice = 0; indice < 200; indice += 1) {
      irregular.enviar(0, 90, 0, indice % 2 === 0 ? 5 : 15);
    }

    assert.equal(constante.pipeline.contadores.pixelsX, -1800);
    assert.equal(
      irregular.pipeline.contadores.pixelsX,
      -1800,
      'o jitter da ponte JS não vira nem tira pixel — o dt vem do aparelho',
    );
  });

  it('dt imprestável é descartado e contado, nunca integrado', () => {
    const aparelho = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 10 } });

    assert.equal(aparelho.enviar(0, 90, 0, 0), RESULTADO_DE_MOVIMENTO.DT_INVALIDO);
    assert.equal(aparelho.enviar(0, 90, 0, -10), RESULTADO_DE_MOVIMENTO.DT_INVALIDO);
    assert.equal(aparelho.enviar(0, 90, 0, Number.NaN), RESULTADO_DE_MOVIMENTO.DT_INVALIDO);
    assert.equal(aparelho.enviar(0, 90, 0, 250), RESULTADO_DE_MOVIMENTO.DT_INVALIDO, 'acima de 200 ms');
    assert.equal(
      aparelho.enviar(0, 90, 0, Number.POSITIVE_INFINITY),
      RESULTADO_DE_MOVIMENTO.DT_INVALIDO,
    );

    assert.equal(aparelho.pipeline.contadores.descartadasPorDt, 5);
    assert.equal(aparelho.pipeline.contadores.pixelsX, 0);
    // E o caminho bom continua funcionando depois.
    assert.equal(aparelho.enviar(0, 90, 0, 10), RESULTADO_DE_MOVIMENTO.APLICADO);
  });

  it('pico de sensor bate no limite por amostra, e o limite é configurável', () => {
    const aparelho = criarAparelho({
      ajustes: { ...CRU, sensXPixelsPorGrau: 10, limitePixelsPorAmostra: 40 },
    });

    // 2000 °/s é o fundo de escala de um giroscópio de celular: 2000 × 0,01 s × 10 px/grau = 200 px.
    const resultado = aparelho.enviar(0, 2000, 0);

    assert.equal(resultado, RESULTADO_DE_MOVIMENTO.APLICADO);
    assert.equal(aparelho.pipeline.contadores.limitadasPorPico, 1);
    assert.equal(aparelho.pipeline.contadores.pixelsX, -40, 'o pico saiu limitado, não inteiro');
  });

  it('o limite não guarda o excedente para soltar depois', () => {
    const aparelho = criarAparelho({
      ajustes: { ...CRU, sensXPixelsPorGrau: 10, limitePixelsPorAmostra: 40 },
    });

    aparelho.enviar(0, 2000, 0);
    const depoisDoPico = aparelho.pipeline.contadores.pixelsX;
    aparelho.enviarVarias(10, 0, 0, 0);

    assert.equal(
      aparelho.pipeline.contadores.pixelsX,
      depoisDoPico,
      'o que foi aparado sumiu na hora — limitar depois do acumulador seria o mesmo salto atrasado',
    );
  });
});

describe('pipeline de movimento — etapa 7: acumulador de subpixel', () => {
  it('movimento muito lento move o cursor (sem acumulador, viraria zero para sempre)', () => {
    const aparelho = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 10 } });

    // 0,5 °/s × 10 px/grau = 5 px/s → 0,05 px por amostra de 10 ms. Truncar por amostra daria 0.
    const primeira = aparelho.enviar(0, 0.5, 0);
    assert.equal(primeira, RESULTADO_DE_MOVIMENTO.SEM_MOVIMENTO, 'uma amostra não fecha um pixel');
    assert.ok(Math.abs(aparelho.pipeline.fracaoX - -0.05) < 1e-9, 'a fração ficou guardada');

    aparelho.enviarVarias(99, 0, 0.5, 0);

    assert.equal(aparelho.pipeline.contadores.pixelsX, -5, '1 s de movimento lento = 5 px');
    assert.equal(aparelho.pipeline.contadores.amostrasAplicadas, 5, 'um pixel a cada 20 amostras');
    assert.equal(aparelho.pipeline.contadores.amostrasSemMovimento, 95);
  });

  it('a fração fica em (−1, 1) e nunca acumula pixel inteiro escondido', () => {
    const aparelho = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 7 } });

    for (let indice = 0; indice < 500; indice += 1) {
      aparelho.enviar(0, 13.7, 0);
      assert.ok(Math.abs(aparelho.pipeline.fracaoX) < 1, `fração ${aparelho.pipeline.fracaoX}`);
    }
  });

  it('reiniciar zera a fração — é o que centralizar e pausar precisam', () => {
    const aparelho = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 10 } });

    aparelho.enviar(0, 0.5, 0);
    assert.notEqual(aparelho.pipeline.fracaoX, 0);

    aparelho.pipeline.reiniciar();

    assert.equal(aparelho.pipeline.fracaoX, 0);
    assert.equal(aparelho.pipeline.fracaoY, 0);
    assert.equal(aparelho.pipeline.contadores.reinicios, 1);
  });
});

describe('pipeline de movimento — guardas de entrada', () => {
  it('pacote que não é MOVIMENTO sai antes de qualquer contador', () => {
    const aparelho = criarAparelho();

    assert.equal(aparelho.enviarBotao(), RESULTADO_DE_MOVIMENTO.NAO_E_MOVIMENTO);
    assert.equal(aparelho.pipeline.contadores.amostrasRecebidas, 0);
  });

  it('giro desligado no ajuste não vira pixel, e o contador separa esse caso', () => {
    const aparelho = criarAparelho({ ajustes: { ...CRU, ativo: false } });

    assert.equal(aparelho.enviar(0, 90, 0), RESULTADO_DE_MOVIMENTO.DESLIGADO);
    assert.equal(aparelho.pipeline.contadores.amostrasComGiroDesligado, 1);
    assert.equal(aparelho.pipeline.contadores.pixelsX, 0);
  });

  it('meia hora de giro desligado não deixa o cursor morto ao religar', () => {
    // O aparelho **não para de mandar** quando o giro é desligado no perfil: são 100 pacotes por
    // segundo do mesmo jeito. Passada a meia-volta do `seq` (32768 pacotes, ~5,5 min), um
    // `ultimoSeq` congelado faria todo pacote novo parecer velho para `compararSeq` — e o cursor
    // ficaria morto por mais 5,5 min depois de religar, com `descartadasPorOrdem` subindo como
    // única pista. Medido na rodada 1: 400 s desligado = 0 px em 1000 amostras, 1000 descartes.
    const aparelho = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 10 } });

    // Com o giro **ligado** primeiro: é o que ancora a ordem. Sem esta parte o defeito nem
    // aparece, porque não haveria `ultimoSeq` velho para congelar.
    aparelho.enviarVarias(10, 0, 90, 0);
    aparelho.pipeline.ajustar({ ativo: false });

    // 40.000 amostras a 10 ms = 400 s de giro desligado, além da meia-volta do u16.
    aparelho.enviarVarias(40_000, 0, 90, 0);
    assert.equal(aparelho.pipeline.contadores.amostrasComGiroDesligado, 40_000);

    aparelho.pipeline.zerarContadores();
    aparelho.pipeline.ajustar({ ativo: true });

    assert.equal(aparelho.enviar(0, 90, 0), RESULTADO_DE_MOVIMENTO.APLICADO, 'religou e andou');
    assert.equal(aparelho.pipeline.contadores.descartadasPorOrdem, 0);
    assert.equal(aparelho.pipeline.contadores.pixelsX, -9, '90 °/s × 10 px/grau × 10 ms');
  });

  it('religar o giro esquece o que estava guardado antes da pausa', () => {
    // Desligar o giro é pausar: o que ficou na média é de antes, e pode ter sido há minutos.
    const aparelho = criarAparelho({
      ajustes: { zonaMortaGrausPorS: 0, suavizacao: 0.9, sensXPixelsPorGrau: 200 },
    });

    aparelho.enviarVarias(60, 0, 90, 0);
    aparelho.pipeline.ajustar({ ativo: false });
    aparelho.enviarVarias(100, 0, 0, 0);
    const antesDeReligar = aparelho.pipeline.contadores.pixelsX;
    const reiniciosAntes = aparelho.pipeline.contadores.reinicios;

    aparelho.pipeline.ajustar({ ativo: true });
    assert.equal(aparelho.pipeline.contadores.reinicios, reiniciosAntes + 1, 'religar é retomada');
    assert.equal(aparelho.pipeline.fracaoX, 0);

    // Aparelho parado depois de religar: nada do gesto anterior pode sair agora.
    aparelho.enviarVarias(60, 0, 0, 0);

    assert.equal(aparelho.pipeline.contadores.pixelsX, antesDeReligar, 'nenhum pixel fantasma');
  });

  it('seq repetido ou anterior é descartado, nunca reproduzido', () => {
    const aparelho = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 10 } });

    aparelho.enviar(0, 90, 0); // seq 0
    aparelho.enviar(0, 90, 0); // seq 1
    const depoisDeDuas = aparelho.pipeline.contadores.pixelsX;

    assert.equal(aparelho.enviarComSeq(1, 90), RESULTADO_DE_MOVIMENTO.FORA_DE_ORDEM, 'repetido');
    assert.equal(aparelho.enviarComSeq(0, 90), RESULTADO_DE_MOVIMENTO.FORA_DE_ORDEM, 'anterior');

    assert.equal(aparelho.pipeline.contadores.descartadasPorOrdem, 2);
    assert.equal(aparelho.pipeline.contadores.pixelsX, depoisDeDuas);
  });

  it('a volta do seq em 65535 não é confundida com pacote velho', () => {
    const aparelho = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 10 } });

    aparelho.enviarComSeq(65_534, 90);
    aparelho.enviarComSeq(65_535, 90);
    const resultado = aparelho.enviarComSeq(0, 90);

    assert.equal(resultado, RESULTADO_DE_MOVIMENTO.APLICADO, 'seq 0 depois de 65535 é o próximo');
    assert.equal(aparelho.pipeline.contadores.descartadasPorOrdem, 0);
  });

  it('leitura não finita do sensor é descartada sem envenenar o estado', () => {
    const aparelho = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 10 } });

    aparelho.enviarVarias(10, 0, 90, 0);
    const antes = aparelho.pipeline.contadores.pixelsX;

    assert.equal(aparelho.enviar(0, Number.NaN, 0), RESULTADO_DE_MOVIMENTO.LEITURA_INVALIDA);
    assert.equal(
      aparelho.enviar(Number.POSITIVE_INFINITY, 0, 0),
      RESULTADO_DE_MOVIMENTO.LEITURA_INVALIDA,
    );
    assert.equal(aparelho.pipeline.contadores.descartadasPorLeituraInvalida, 2);

    // Um NaN dentro da média exponencial deixaria o cursor parado até a próxima retomada.
    aparelho.enviarVarias(10, 0, 90, 0);
    assert.equal(aparelho.pipeline.contadores.pixelsX, antes * 2);
  });

  it('primeira amostra após retomar zera a memória e não integra contra o passado', () => {
    const aparelho = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 10 } });

    aparelho.enviar(0, 0.5, 0); // deixa fração guardada
    assert.notEqual(aparelho.pipeline.fracaoX, 0);

    assert.equal(aparelho.retomar(), RESULTADO_DE_MOVIMENTO.RETOMADA);

    assert.equal(aparelho.pipeline.fracaoX, 0, 'a fração da sessão anterior não escapa');
    assert.equal(aparelho.pipeline.contadores.retomadas, 1);
    assert.equal(aparelho.pipeline.contadores.pixelsX, 0);
  });
});

describe('pipeline de movimento — troca de ajustes e o estado guardado', () => {
  /**
   * Gesto, troca de ajuste no meio dele, e o **aparelho parado** depois. O que sair aí é resíduo
   * guardado saindo no referencial errado — o pulo de cursor que a rodada 1 media em 2439 px.
   */
  function fantasmaDepoisDe(ajustes: AjustesParciais, troca: AjustesParciais): number {
    const aparelho = criarAparelho({ ajustes });
    aparelho.enviarVarias(60, 0, 90, 0);
    const duranteOGesto = aparelho.pipeline.contadores.pixelsX;

    aparelho.pipeline.ajustar(troca);
    aparelho.enviarVarias(60, 0, 0, 0);

    return Math.abs(aparelho.pipeline.contadores.pixelsX - duranteOGesto);
  }

  it('inverter um eixo no meio do gesto não solta o resíduo para o lado contrário', () => {
    // A inversão entra no **ganho**, que é aplicado depois da média: sem zerar a média, o que ela
    // guardou do gesto sai invertido. Medido na rodada 1 (sem o conserto): 12 px com os ajustes de
    // fábrica e 2439 px no topo das faixas de `ajustes.ts` — mais que a largura da tela desta
    // bancada, com o celular imóvel na mão.
    assert.equal(fantasmaDepoisDe({}, { inverterX: true }), 0, 'ajustes de fábrica');
    assert.equal(
      fantasmaDepoisDe(
        { suavizacao: 0.9, sensXPixelsPorGrau: 200, zonaMortaGrausPorS: 0 },
        { inverterX: true },
      ),
      0,
      'topo das faixas: suavização 0,9 e 200 px/grau',
    );
    assert.equal(fantasmaDepoisDe({ suavizacao: 0.9 }, { inverterY: true }), 0, 'e no eixo Y');
  });

  it('trocar a orientação também zera a média — o eixo que a alimentava mudou', () => {
    assert.equal(
      fantasmaDepoisDe({ suavizacao: 0.9, sensXPixelsPorGrau: 200 }, { orientacao: 'paisagem' }),
      0,
    );
  });

  it('a troca conta em `trocasDeReferencial`, e ela é separada de `reinicios`', () => {
    const aparelho = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 10 } });

    aparelho.enviar(0, 0.5, 0); // deixa fração guardada
    const fracao = aparelho.pipeline.fracaoX;
    aparelho.pipeline.ajustar({ inverterX: true });

    assert.equal(aparelho.pipeline.contadores.trocasDeReferencial, 1);
    assert.equal(aparelho.pipeline.contadores.reinicios, 0, 'esquecimento parcial não é reinício');
    assert.equal(aparelho.pipeline.fracaoX, fracao, 'a fração de subpixel não é do referencial');

    // Pedir a mesma inversão de novo não é troca nenhuma.
    aparelho.pipeline.ajustar({ inverterX: true });
    assert.equal(aparelho.pipeline.contadores.trocasDeReferencial, 1);
  });

  it('mexer na sensibilidade NÃO zera a média: o cursor não engasga no controle deslizante', () => {
    // O caso comum do app (ATI-010) é arrastar um controle deslizante — dezenas de `config` por
    // segundo. Se cada um zerasse a média, o cursor daria um tranco a cada passo.
    const aparelho = criarAparelho({
      ajustes: { zonaMortaGrausPorS: 0, suavizacao: 0.8, sensXPixelsPorGrau: 10 },
    });

    aparelho.enviarVarias(200, 0, 90, 0); // média já em regime: ~9 px por amostra
    const emRegime = Math.abs(aparelho.pipeline.ultimoDx);
    assert.ok(emRegime >= 8, `regime de ${emRegime} px por amostra`);

    aparelho.pipeline.ajustar({ zonaMortaGrausPorS: 0.5 });
    aparelho.pipeline.definirBias(0, 0, 0);
    aparelho.enviar(0, 90, 0);

    // Com a média zerada, a amostra seguinte valeria 0,2 × 89,5 × 10 × 0,01 ≈ 1,8 px.
    assert.ok(
      Math.abs(aparelho.pipeline.ultimoDx) >= 5,
      `depois do ajuste saiu ${aparelho.pipeline.ultimoDx} px — a média foi zerada à toa`,
    );
    assert.equal(aparelho.pipeline.contadores.trocasDeReferencial, 0);
    assert.equal(aparelho.pipeline.contadores.reinicios, 0);
  });
});

describe('pipeline de movimento — engasgo de rede', () => {
  it('amostra que chegou tarde demais é jogada fora, e não reproduzida em lote', () => {
    const aparelho = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 10 } });

    aparelho.enviarVarias(10, 0, 90, 0);
    const antesDoEngasgo = aparelho.pipeline.contadores.pixelsX;

    // A rede prendeu os pacotes por 300 ms: eles chegam com 300 ms de atraso relativo.
    aparelho.atrasar(300);
    assert.equal(aparelho.enviar(0, 90, 0), RESULTADO_DE_MOVIMENTO.ATRASADA);
    assert.equal(aparelho.enviar(0, 90, 0), RESULTADO_DE_MOVIMENTO.ATRASADA);

    assert.equal(aparelho.pipeline.contadores.descartadasPorAtraso, 2);
    assert.equal(
      aparelho.pipeline.contadores.pixelsX,
      antesDoEngasgo,
      'nenhum pixel saiu do lote atrasado',
    );
  });

  it('a rajada que alcança o tempo real volta a ser aceita na hora', () => {
    const aparelho = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 10 } });
    aparelho.enviarVarias(10, 0, 90, 0);

    // Engasgo de 100 ms e, em seguida, a rajada: dez amostras chegando de uma vez só. Cada uma
    // vale 10 ms de tempo do aparelho, então o atraso relativo cai 10 ms por amostra.
    aparelho.atrasar(100);
    let descartadas = 0;
    let aplicadas = 0;
    for (let indice = 0; indice < 15; indice += 1) {
      const resultado = aparelho.enviar(0, 90, 0);
      aparelho.atrasar(-10); // a rajada chega toda junta: a chegada não anda com o aparelho
      if (resultado === RESULTADO_DE_MOVIMENTO.ATRASADA) descartadas += 1;
      if (resultado === RESULTADO_DE_MOVIMENTO.APLICADO) aplicadas += 1;
    }

    assert.ok(descartadas >= 4, `descartou ${descartadas} amostras velhas`);
    assert.ok(aplicadas >= 4, `voltou a aplicar ${aplicadas} amostras assim que elas ficaram novas`);
  });

  it('caminho que piorou de vez reancora sozinho, em vez de congelar o cursor', () => {
    const aparelho = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 10 } });
    aparelho.enviarVarias(10, 0, 90, 0);

    // O cabo saiu e entrou o Wi-Fi: 200 ms a mais, para sempre.
    aparelho.atrasar(200);
    for (let indice = 0; indice < DESCARTES_ATE_REANCORAR; indice += 1) {
      assert.equal(aparelho.enviar(0, 90, 0), RESULTADO_DE_MOVIMENTO.ATRASADA);
    }

    assert.equal(aparelho.pipeline.contadores.reancoragens, 1);
    const depoisDaReancoragem = aparelho.enviar(0, 90, 0);
    assert.equal(depoisDaReancoragem, RESULTADO_DE_MOVIMENTO.APLICADO, 'o cursor voltou a andar');
  });
});

describe('pipeline de movimento — contrato com a camada de saída', () => {
  it('fala com o BackendDeEntrada sem adaptador nenhum', () => {
    const dubla = criarBackendDubla({ tela: { largura: 4000, altura: 4000 } });
    const aparelho = criarAparelho({
      destino: dubla,
      ajustes: { ...CRU, sensXPixelsPorGrau: 10 },
    });

    aparelho.enviarVarias(100, 0, 90, 0);

    const somaDosEventos = dubla.eventos.reduce(
      (total, evento) => (evento.tipo === 'mover' ? total + evento.dx : total),
      0,
    );
    assert.equal(somaDosEventos, -900);
    assert.equal(dubla.contadores.eventosEnviados, dubla.eventos.length);
    assert.equal(dubla.contadores.pedidosInvalidos, 0);
    assert.equal(dubla.contadores.pedidosNulos, 0, 'o pipeline nunca pede movimento de zero pixel');
  });

  it('não chama o destino quando o deslocamento inteiro é zero', () => {
    const dubla = criarBackendDubla();
    const aparelho = criarAparelho({
      destino: dubla,
      ajustes: { ...CRU, sensXPixelsPorGrau: 10 },
    });

    aparelho.enviarVarias(19, 0, 0.5, 0);

    assert.equal(dubla.eventos.length, 0, 'chamar o backend para pedir zero é evento à toa a 100 Hz');
  });
});

describe('pipeline de movimento — caminho quente', () => {
  it('não aloca por amostra', () => {
    // A afirmação "zero alocação por pacote" (CLAUDE.md, regra 2) só vale medida. 200 mil amostras
    // alocando uma caixa de número cada deixariam megabytes de rastro, muito acima do limite
    // abaixo — foi assim que a primeira versão deste módulo foi pega guardando estado fracionário
    // em variável de closure (13,6 B/amostra; ver o comentário do `Float64Array` no pipeline).
    //
    // O pacote é preenchido **uma vez** e só o `seq` anda: escrever `gx`/`gy`/`gz` a cada volta
    // mediria a caixa que o próprio arnês cria, e não o pipeline. No servidor de verdade quem
    // escreve esses campos é o decodificador, que já tem a medição dele (ATI-002).
    const amostras = 200_000;
    const destino = criarDestinoDeEnsaio();
    let chegadaMs = 1000;
    const pipeline = criarPipelineDeMovimento({
      destino,
      ajustes: { sensXPixelsPorGrau: 35 },
      relogio: () => chegadaMs,
    });
    const pacote = criarPacoteDecodificado();
    pacote.tipo = TIPO_MOVIMENTO;
    pacote.tDispositivoMs = 60_000;
    pacote.dtMs = 10;
    pacote.gx = 0.7 * RADIANOS_POR_GRAU;
    pacote.gy = 1.3 * RADIANOS_POR_GRAU;
    pacote.gz = 0.2 * RADIANOS_POR_GRAU;
    chegadaMs = pacote.tDispositivoMs;

    function rodar(voltas: number): void {
      for (let indice = 0; indice < voltas; indice += 1) {
        pacote.seq = proximoSeq(pacote.seq);
        pipeline.processar(pacote);
      }
    }

    // Aquece: enquanto o motor não compila a função de verdade, **toda** conta com número
    // quebrado passa por uma caixa no heap — medir antes disso mediria o aquecimento, não o
    // código. 200 mil voltas é folga com sobra para a compilação acontecer.
    rodar(200_000);

    // `heapUsed` é medida ruidosa: uma coleta caindo entre as duas leituras deixa o crescimento
    // **negativo**, e uma asserção de "cresceu pouco" passaria por acidente — inclusive com
    // alguém alocando de novo. Duas defesas: forçar a coleta nas duas pontas quando o processo
    // foi levantado com `--expose-gc` (é como o relatório mede), e, quando não foi, repetir a
    // medição e ficar com a **mediana** — uma coleta estraga uma rodada, não a mediana de cinco.
    const coletar = (globalThis as { gc?: () => void }).gc;
    const rodadas = 5;
    const porAmostra: number[] = [];
    for (let rodada = 0; rodada < rodadas; rodada += 1) {
      coletar?.();
      const antes = process.memoryUsage().heapUsed;
      rodar(amostras);
      coletar?.();
      const depois = process.memoryUsage().heapUsed;
      porAmostra.push((depois - antes) / amostras);
    }

    assert.equal(pipeline.contadores.amostrasRecebidas, amostras * rodadas + 200_000);
    assert.equal(pipeline.contadores.descartadasPorOrdem, 0, 'a volta do seq não descartou nada');

    const ordenadas = [...porAmostra].sort((esquerda, direita) => esquerda - direita);
    const mediana = ordenadas[Math.floor(rodadas / 2)] ?? Number.NaN;
    assert.ok(
      mediana < 1,
      `mediana de ${mediana.toFixed(3)} B/amostra em ${String(rodadas)} rodadas de ` +
        `${String(amostras)} amostras (${porAmostra.map((valor) => valor.toFixed(3)).join(', ')})` +
        ' — alguém voltou a alocar no caminho quente',
    );
  });
});

describe('pipeline de movimento — conta da sessão e total do processo (ATI-028)', () => {
  it('fechar a sessão zera a conta dela e guarda o número no total do processo', () => {
    const aparelho = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 10 } });
    const contadoresDaSessao = aparelho.pipeline.contadores;

    // 90 °/s × 10 px/grau × 10 ms = 9 px por amostra, para a esquerda.
    aparelho.enviarVarias(100, 0, 90, 0);
    assert.equal(aparelho.pipeline.contadores.pixelsX, -900);

    aparelho.pipeline.fecharContadoresDaSessao();

    assert.deepEqual({ ...aparelho.pipeline.contadores }, criarContadoresDoPipeline());
    assert.equal(
      aparelho.pipeline.contadores,
      contadoresDaSessao,
      'o objeto é o mesmo: quem guardou a referência lê os números novos',
    );
    assert.equal(aparelho.pipeline.sessoesFechadas, 1);
    assert.equal(aparelho.pipeline.totalDoProcesso().pixelsX, -900);

    // A sessão seguinte relata só o que foi dela; o total soma as duas.
    aparelho.enviarVarias(40, 0, 90, 0);
    assert.equal(aparelho.pipeline.contadores.amostrasRecebidas, 40);
    assert.equal(aparelho.pipeline.contadores.pixelsX, -360);
    const total = aparelho.pipeline.totalDoProcesso();
    assert.equal(total.amostrasRecebidas, 140, 'a sessão aberta também entra no total');
    assert.equal(total.pixelsX, -1260);
  });

  it('o total devolve objeto novo: mexer nele não mexe em conta nenhuma', () => {
    const aparelho = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 10 } });
    aparelho.enviarVarias(10, 0, 90, 0);

    const total = aparelho.pipeline.totalDoProcesso();
    total.pixelsX = 12345;

    assert.equal(aparelho.pipeline.contadores.pixelsX, -90);
    assert.equal(aparelho.pipeline.totalDoProcesso().pixelsX, -90);
  });

  it('a soma passa por todos os campos — inclusive os que o resumo do log não mostra', () => {
    // Cada campo com um valor diferente: um campo esquecido na soma sairia com o valor errado, e
    // não com zero por coincidência.
    const parcela = criarContadoresDoPipeline();
    const alvo = criarContadoresDoPipeline();
    const campos = Object.keys(parcela) as (keyof typeof parcela)[];
    campos.forEach((campo, indice) => {
      parcela[campo] = indice + 1;
      alvo[campo] = 100 * (indice + 1);
    });

    somarContadoresDoPipeline(alvo, parcela);

    for (const [indice, campo] of campos.entries()) {
      assert.equal(alvo[campo], 101 * (indice + 1), `campo ${campo}`);
    }
    assert.equal(campos.length, 16, 'campo novo nos contadores: confira se ele é por sessão');
  });

  it('zerarContadores zera a sessão e o total — é ferramenta de medição, não fim de sessão', () => {
    const aparelho = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 10 } });
    aparelho.enviarVarias(10, 0, 90, 0);
    aparelho.pipeline.fecharContadoresDaSessao();
    aparelho.enviarVarias(10, 0, 90, 0);

    aparelho.pipeline.zerarContadores();

    assert.deepEqual({ ...aparelho.pipeline.contadores }, criarContadoresDoPipeline());
    assert.deepEqual(aparelho.pipeline.totalDoProcesso(), criarContadoresDoPipeline());
    assert.equal(aparelho.pipeline.sessoesFechadas, 0);
  });

  it('reiniciar o estado (centralizar, retomada) NÃO fecha a conta da sessão', () => {
    // `reiniciar()` acontece no meio da sessão por vários motivos; só o fim de sessão fecha conta.
    const aparelho = criarAparelho({ ajustes: { ...CRU, sensXPixelsPorGrau: 10 } });
    aparelho.enviarVarias(10, 0, 90, 0);

    aparelho.pipeline.reiniciar();
    aparelho.enviarVarias(10, 0, 90, 0);

    assert.equal(aparelho.pipeline.contadores.amostrasRecebidas, 20);
    assert.equal(aparelho.pipeline.contadores.reinicios, 1);
    assert.equal(aparelho.pipeline.sessoesFechadas, 0);
  });
});
