/**
 * O acumulado é o número que decide o critério 4 da ATI-003. Aqui se prova que ele conta toda
 * janela (e diz de quantas), que a janela de partida fica de fora mas à vista, e que média e desvio
 * do dt combinados saem iguais aos de uma janela só com todas as amostras.
 *
 * @format
 */

import {
  AcumuladoDaMedicao,
  LIMIAR_PONTE_MS,
  LIMIAR_TAXA_HZ,
} from '../src/sensores/acumuladoDaMedicao';
import {MedidorDeTaxa, type ResumoMedicao} from '../src/sensores/medidorDeTaxa';

function janela(parcial: Partial<ResumoMedicao>): ResumoMedicao {
  return {
    amostras: 100,
    intervalos: 100,
    janelaMs: 1000,
    taxaHz: 100,
    dtMedioMs: 10,
    dtDesvioMs: 0,
    dtMaximoMs: 10,
    intervaloJsMaximoMs: 12,
    ...parcial,
  };
}

describe('AcumuladoDaMedicao', () => {
  it('sem janela fechada, não inventa número', () => {
    const acumulado = new AcumuladoDaMedicao();
    acumulado.zerar(100);

    expect(acumulado.resumir()).toEqual({
      taxaAlvoHz: 100,
      janelasContadas: 0,
      janelasDePartida: 0,
      janelasAbaixoDoLimiarDeTaxa: 0,
      janelasComPonteAcimaDoLimiar: 0,
      piorTaxaHz: null,
      taxaMediaHz: null,
      dtMedioMs: null,
      dtDesvioMs: null,
      maiorDtMs: null,
      maiorAtrasoNaPonteMs: null,
    });
  });

  it('descarta as janelas que começaram antes da primeira amostra, e diz quantas', () => {
    const acumulado = new AcumuladoDaMedicao();
    acumulado.zerar(100);

    // Sensor demorou: uma janela vazia, depois a janela em que a primeira amostra chegou.
    acumulado.somar(janela({amostras: 0, intervalos: 0, taxaHz: 0}));
    acumulado.somar(janela({amostras: 60, intervalos: 59, taxaHz: 60}));
    // A partir daqui, toda janela conta — inclusive a vazia, que é queda de verdade.
    acumulado.somar(janela({}));
    acumulado.somar(janela({amostras: 0, intervalos: 0, taxaHz: 0}));

    const resumo = acumulado.resumir();
    expect(resumo.janelasDePartida).toBe(2);
    expect(resumo.janelasContadas).toBe(2);
    expect(resumo.janelasAbaixoDoLimiarDeTaxa).toBe(1);
    expect(resumo.piorTaxaHz).toBe(0);
  });

  it('conta janela por janela abaixo do limiar de taxa e acima do limiar de ponte', () => {
    const acumulado = new AcumuladoDaMedicao();
    acumulado.zerar(100);
    acumulado.somar(janela({})); // partida

    acumulado.somar(janela({taxaHz: LIMIAR_TAXA_HZ})); // no limiar: não conta como queda
    acumulado.somar(janela({taxaHz: LIMIAR_TAXA_HZ - 0.1}));
    acumulado.somar(janela({taxaHz: 99, intervaloJsMaximoMs: LIMIAR_PONTE_MS})); // no limiar: não conta
    acumulado.somar(janela({taxaHz: 101, intervaloJsMaximoMs: LIMIAR_PONTE_MS + 0.01}));
    acumulado.somar(janela({taxaHz: 100, intervaloJsMaximoMs: 58.63, dtMaximoMs: 10.4}));

    const resumo = acumulado.resumir();
    expect(resumo.janelasContadas).toBe(5);
    expect(resumo.janelasAbaixoDoLimiarDeTaxa).toBe(1);
    expect(resumo.janelasComPonteAcimaDoLimiar).toBe(2);
    expect(resumo.piorTaxaHz).toBeCloseTo(LIMIAR_TAXA_HZ - 0.1, 6);
    expect(resumo.maiorAtrasoNaPonteMs).toBe(58.63);
    expect(resumo.maiorDtMs).toBe(10.4);
  });

  it('a taxa média é amostras sobre tempo, não média das taxas', () => {
    const acumulado = new AcumuladoDaMedicao();
    acumulado.zerar(100);
    acumulado.somar(janela({})); // partida

    // Uma janela curta e rápida e uma longa e lenta: a média das taxas daria 100 Hz.
    acumulado.somar(janela({amostras: 60, janelaMs: 500, taxaHz: 120}));
    acumulado.somar(janela({amostras: 120, janelaMs: 1500, taxaHz: 80}));

    expect(acumulado.resumir().taxaMediaHz).toBeCloseTo(90, 6);
  });

  it('média e desvio do dt combinados batem com uma janela só com todas as amostras', () => {
    // Duas janelas medidas pelo próprio MedidorDeTaxa: a primeira só com dt 8, a segunda com 12.
    const medidor = new MedidorDeTaxa();
    const acumulado = new AcumuladoDaMedicao();
    const tudoJunto = new MedidorDeTaxa();
    medidor.reiniciar(0);
    tudoJunto.reiniciar(0);
    acumulado.zerar(100);
    acumulado.somar(janela({})); // partida

    // A primeira amostra do ciclo chega com dt 0: a primeira janela tem 4 amostras e só 3
    // intervalos. Pesar por amostras, e não por intervalos, erraria a média aqui.
    const dts = [0, 8, 8, 8, 12, 12, 12, 12, 9];
    let t = 0;
    dts.slice(0, 4).forEach(dt => {
      t += dt;
      medidor.registrar(dt, t);
      tudoJunto.registrar(dt, t);
    });
    const primeira = medidor.fechar(t);
    expect([primeira.amostras, primeira.intervalos]).toEqual([4, 3]);
    acumulado.somar(primeira);
    dts.slice(4).forEach(dt => {
      t += dt;
      medidor.registrar(dt, t);
      tudoJunto.registrar(dt, t);
    });
    acumulado.somar(medidor.fechar(t));
    const referencia = tudoJunto.fechar(t);

    const resumo = acumulado.resumir();
    expect(resumo.dtMedioMs).toBeCloseTo(referencia.dtMedioMs, 9);
    expect(resumo.dtDesvioMs).toBeCloseTo(referencia.dtDesvioMs, 9);
    expect(resumo.maiorDtMs).toBe(12);
  });

  it('zerar recomeça tudo, inclusive a partida, e guarda a nova taxa alvo', () => {
    const acumulado = new AcumuladoDaMedicao();
    acumulado.zerar(100);
    acumulado.somar(janela({}));
    acumulado.somar(janela({taxaHz: 50}));

    acumulado.zerar(200);
    acumulado.somar(janela({taxaHz: 200, amostras: 200}));

    const resumo = acumulado.resumir();
    expect(resumo.taxaAlvoHz).toBe(200);
    expect(resumo.janelasDePartida).toBe(1);
    expect(resumo.janelasContadas).toBe(0);
    expect(resumo.janelasAbaixoDoLimiarDeTaxa).toBe(0);
    expect(resumo.piorTaxaHz).toBeNull();
  });
});
