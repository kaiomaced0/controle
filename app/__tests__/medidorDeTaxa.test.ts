/**
 * @format
 */

import {MedidorDeTaxa} from '../src/sensores/medidorDeTaxa';

describe('MedidorDeTaxa', () => {
  it('mede 100 Hz com dt de 10 ms e desvio zero', () => {
    const medidor = new MedidorDeTaxa();
    medidor.reiniciar(0);

    // Primeira amostra chega com dtMs 0: não existe intervalo anterior.
    medidor.registrar(0, 0);
    for (let i = 1; i < 100; i += 1) {
      medidor.registrar(10, i * 10);
    }

    const resumo = medidor.fechar(1000);

    expect(resumo.amostras).toBe(100);
    expect(resumo.janelaMs).toBe(1000);
    expect(resumo.taxaHz).toBeCloseTo(100, 6);
    expect(resumo.dtMedioMs).toBeCloseTo(10, 6);
    expect(resumo.dtDesvioMs).toBeCloseTo(0, 6);
    expect(resumo.dtMaximoMs).toBe(10);
  });

  it('calcula desvio padrão e maior intervalo do sensor', () => {
    const medidor = new MedidorDeTaxa();
    medidor.reiniciar(0);

    // Média 10, desvio populacional 2 (8, 12, 8, 12).
    medidor.registrar(8, 10);
    medidor.registrar(12, 20);
    medidor.registrar(8, 30);
    medidor.registrar(12, 40);

    const resumo = medidor.fechar(40);

    expect(resumo.dtMedioMs).toBeCloseTo(10, 6);
    expect(resumo.dtDesvioMs).toBeCloseTo(2, 6);
    expect(resumo.dtMaximoMs).toBe(12);
  });

  it('separa o atraso da ponte do intervalo carimbado pelo sensor', () => {
    const medidor = new MedidorDeTaxa();
    medidor.reiniciar(0);

    // O sensor carimba 10 ms em todas, mas o JS recebe duas juntas depois de uma pausa de 40 ms.
    medidor.registrar(10, 10);
    medidor.registrar(10, 50);
    medidor.registrar(10, 50);

    const resumo = medidor.fechar(60);

    expect(resumo.dtMaximoMs).toBe(10);
    expect(resumo.intervaloJsMaximoMs).toBe(40);
  });

  it('não conta a primeira amostra do ciclo no cálculo do dt', () => {
    const medidor = new MedidorDeTaxa();
    medidor.reiniciar(0);

    medidor.registrar(0, 0);
    medidor.registrar(20, 20);

    const resumo = medidor.fechar(20);

    expect(resumo.amostras).toBe(2);
    // Duas amostras, um intervalo: é o peso desta janela no acumulado.
    expect(resumo.intervalos).toBe(1);
    expect(resumo.dtMedioMs).toBe(20);
    expect(resumo.dtMaximoMs).toBe(20);
  });

  it('devolve resumo zerado quando a janela não teve amostra', () => {
    const medidor = new MedidorDeTaxa();
    medidor.reiniciar(0);

    const resumo = medidor.fechar(1000);

    expect(resumo.amostras).toBe(0);
    expect(resumo.taxaHz).toBe(0);
    expect(resumo.dtMedioMs).toBe(0);
    expect(resumo.janelaMs).toBe(1000);
  });

  it('zera os acumuladores entre janelas, mas mantém a cadeia de chegadas', () => {
    const medidor = new MedidorDeTaxa();
    medidor.reiniciar(0);

    medidor.registrar(10, 10);
    medidor.registrar(10, 20);
    medidor.fechar(1000);

    // Chegada seguinte 30 ms depois da última da janela anterior: o atraso não pode se perder.
    medidor.registrar(10, 1050);
    const segunda = medidor.fechar(2000);

    expect(segunda.amostras).toBe(1);
    expect(segunda.dtMaximoMs).toBe(10);
    expect(segunda.intervaloJsMaximoMs).toBe(1030);
  });
});
