/**
 * Teste dos ajustes do giro: padrões de fábrica, saturação e mescla parcial.
 *
 * O que se prova aqui é a regra do PROTOCOLO.md, seção 3.4: valor fora da faixa **satura**, não
 * recusa — e valor imprestável (`NaN`, infinito, tipo errado) não apaga o que estava valendo.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AJUSTES_PADRAO,
  FAIXAS_DO_GIRO,
  resolverAjustes,
  resumirAjustes,
} from './ajustes.js';

describe('resolverAjustes', () => {
  it('sem pedido nenhum, entrega os padrões do perfil mouse-basico', () => {
    const ajustes = resolverAjustes();

    assert.equal(ajustes.ativo, true);
    assert.equal(ajustes.orientacao, 'retrato');
    assert.equal(ajustes.sensXPixelsPorGrau, 35);
    assert.equal(ajustes.sensYPixelsPorGrau, 35);
    // ATI-033: o filtro adaptativo é o padrão, e a zona morta desceu de 0,35 para 0,15 °/s — o
    // ruído do sensor, e não mais o tremor (os números que sustentam isso estão no relatório).
    assert.equal(ajustes.filtro, 'euro');
    assert.equal(ajustes.filtroCorteMinimoHz, 1.5);
    assert.equal(ajustes.filtroBeta, 0.3);
    assert.equal(ajustes.filtroCorteDaVelocidadeHz, 3);
    assert.equal(ajustes.zonaMortaGrausPorS, 0.15);
    assert.equal(ajustes.suavizacao, 0.15, 'continua lá para quem voltar ao filtro exponencial');
    assert.equal(ajustes.inverterX, false);
    assert.equal(ajustes.inverterY, false);
    assert.equal(ajustes.biasGxRadPorS, 0, 'sem calibração, bias inventado seria pior que nenhum');
  });

  it('o objeto entregue é congelado — ninguém muda ajuste por baixo do pipeline', () => {
    assert.ok(Object.isFrozen(resolverAjustes()));
    assert.ok(Object.isFrozen(AJUSTES_PADRAO));
  });

  it('satura nas duas pontas de cada faixa, em vez de recusar', () => {
    const alto = resolverAjustes({
      sensXPixelsPorGrau: 5000,
      zonaMortaGrausPorS: 90,
      suavizacao: 1,
      limitePixelsPorAmostra: 99_999,
      biasGxRadPorS: 40,
    });
    assert.equal(alto.sensXPixelsPorGrau, FAIXAS_DO_GIRO.sensibilidade.maximo);
    assert.equal(alto.zonaMortaGrausPorS, FAIXAS_DO_GIRO.zonaMorta.maximo);
    assert.equal(alto.suavizacao, FAIXAS_DO_GIRO.suavizacao.maximo, 'nunca 1: travaria o cursor');
    assert.equal(alto.limitePixelsPorAmostra, FAIXAS_DO_GIRO.limitePorAmostra.maximo);
    assert.equal(alto.biasGxRadPorS, FAIXAS_DO_GIRO.bias.maximo);

    const baixo = resolverAjustes({
      sensXPixelsPorGrau: 0,
      zonaMortaGrausPorS: -3,
      suavizacao: -1,
      biasGyRadPorS: -40,
    });
    assert.equal(baixo.sensXPixelsPorGrau, FAIXAS_DO_GIRO.sensibilidade.minimo);
    assert.equal(baixo.zonaMortaGrausPorS, 0);
    assert.equal(baixo.suavizacao, 0);
    assert.equal(baixo.biasGyRadPorS, FAIXAS_DO_GIRO.bias.minimo);
  });

  it('número não finito não vira zero nem mínimo: fica o que estava valendo', () => {
    // `JSON.parse('1e999')` devolve `Infinity` sem erro nenhum (PROTOCOLO.md, seção 3): saturar
    // isso para o mínimo mudaria um ajuste que ninguém pediu.
    const base = resolverAjustes({ sensXPixelsPorGrau: 42 });
    const depois = resolverAjustes(
      { sensXPixelsPorGrau: Number.NaN, sensYPixelsPorGrau: Number.POSITIVE_INFINITY },
      base,
    );

    assert.equal(depois.sensXPixelsPorGrau, 42);
    assert.equal(depois.sensYPixelsPorGrau, base.sensYPixelsPorGrau);
  });

  it('pedido parcial mescla sobre a base: o que não veio não se perde', () => {
    const base = resolverAjustes({ sensXPixelsPorGrau: 20, inverterY: true, orientacao: 'paisagem' });
    const depois = resolverAjustes({ zonaMortaGrausPorS: 1.5 }, base);

    assert.equal(depois.zonaMortaGrausPorS, 1.5);
    assert.equal(depois.sensXPixelsPorGrau, 20);
    assert.equal(depois.inverterY, true);
    assert.equal(depois.orientacao, 'paisagem');
  });

  it('orientação desconhecida fica na anterior', () => {
    const base = resolverAjustes({ orientacao: 'paisagem' });
    const depois = resolverAjustes(
      { orientacao: 'diagonal' as unknown as 'retrato' },
      base,
    );

    assert.equal(depois.orientacao, 'paisagem');
  });

  it('resumirAjustes cabe numa linha de log e traz a unidade junto', () => {
    const linha = resumirAjustes(resolverAjustes());

    assert.match(linha, /sens=35\/35 px\/grau/);
    assert.match(linha, /zonaMorta=0\.15 °\/s/);
    assert.match(linha, /filtro=euro\(corte=1\.5 Hz beta=0\.3 Hz\/\(°\/s\) corteDaVelocidade=3 Hz\)/);
    assert.match(linha, /limite=120 px\/amostra/);
  });

  it('resumirAjustes diz que a suavização não vale nada com o filtro euro, e vale com o exponencial', () => {
    // A suavização continua sendo lida da configuração com o euro ligado; a linha de partida
    // precisa dizer que ela não faz nada, senão alguém fica mexendo num número morto.
    assert.match(resumirAjustes(resolverAjustes()), /suavizacao=0\.15 \(sem efeito com o filtro euro\)/);
    const exponencial = resumirAjustes(resolverAjustes({ filtro: 'exponencial', suavizacao: 0.4 }));
    assert.match(exponencial, /zonaMorta=0\.15 °\/s suavizacao=0\.4 filtro=exponencial/);
    assert.doesNotMatch(exponencial, /corte=/);
  });

  it('filtro desconhecido fica no anterior, e os números do euro saturam na faixa', () => {
    const base = resolverAjustes({ filtro: 'exponencial' });
    assert.equal(resolverAjustes({ filtro: 'kalman' as unknown as 'euro' }, base).filtro, 'exponencial');

    const alto = resolverAjustes({
      filtroCorteMinimoHz: 500,
      filtroBeta: 9,
      filtroCorteDaVelocidadeHz: 1e6,
    });
    assert.equal(alto.filtroCorteMinimoHz, FAIXAS_DO_GIRO.filtroCorteMinimo.maximo);
    assert.equal(alto.filtroBeta, FAIXAS_DO_GIRO.filtroBeta.maximo);
    assert.equal(alto.filtroCorteDaVelocidadeHz, FAIXAS_DO_GIRO.filtroCorteDaVelocidade.maximo);

    const baixo = resolverAjustes({
      filtroCorteMinimoHz: 0,
      filtroBeta: -1,
      filtroCorteDaVelocidadeHz: 0,
    });
    assert.equal(baixo.filtroCorteMinimoHz, FAIXAS_DO_GIRO.filtroCorteMinimo.minimo, 'corte zero travaria o cursor');
    assert.equal(baixo.filtroBeta, 0);
    assert.equal(baixo.filtroCorteDaVelocidadeHz, FAIXAS_DO_GIRO.filtroCorteDaVelocidade.minimo);

    const imprestavel = resolverAjustes({ filtroCorteMinimoHz: Number.NaN, filtroBeta: Infinity });
    assert.equal(imprestavel.filtroCorteMinimoHz, AJUSTES_PADRAO.filtroCorteMinimoHz);
    assert.equal(imprestavel.filtroBeta, AJUSTES_PADRAO.filtroBeta);
  });
});
