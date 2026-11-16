/** Medidas por sessão: janela de taxa, estatística de `dt`, percentis de RTT e volta do `seq`. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ContadoresDoCodec } from '../protocolo/indice.js';
import { JANELA_DE_MEDICAO_MS, compararSeq, criarMedidorDaSessao } from './metricas.js';

function contadoresZerados(): ContadoresDoCodec {
  return {
    pacotesRecebidos: 0,
    bytesRecebidos: 0,
    descartadosPorTamanho: 0,
    descartadosPorTipo: 0,
    comBytesExtras: 0,
    visoesCriadas: 0,
  };
}

describe('criarMedidorDaSessao', () => {
  it('só publica a taxa quando a janela de 1 s fecha', () => {
    const contadores = contadoresZerados();
    const medidor = criarMedidorDaSessao(contadores, 0);

    for (let i = 0; i < 100; i += 1) medidor.registrarPacote(i * 10);

    // Ainda dentro da janela: nada foi fechado, então não há taxa a publicar.
    assert.equal(medidor.instantaneo(999).taxaHzMedida, 0);

    // Fechada a janela, a taxa é a dos 100 pacotes do último segundo.
    assert.equal(medidor.instantaneo(JANELA_DE_MEDICAO_MS).taxaHzMedida, 100);
  });

  it('usa o tempo decorrido de verdade, e não a janela nominal, depois de um silêncio', () => {
    const medidor = criarMedidorDaSessao(contadoresZerados(), 0);

    medidor.registrarPacote(10);
    medidor.registrarPacote(20);

    // 10 s sem nada: a taxa honesta é 2 pacotes / 10 s, não a taxa da janela cheia.
    const medidas = medidor.instantaneo(10_000);
    assert.equal(medidas.taxaHzMedida, 0.2);
  });

  it('separa sentido errado e pong recusado dos contadores de formato', () => {
    const contadores = contadoresZerados();
    const medidor = criarMedidorDaSessao(contadores, 0);

    // O codec já somou o pacote como recebido antes de a sessão descobrir a direção errada.
    contadores.pacotesRecebidos = 1;
    medidor.registrarSentidoErrado();
    medidor.registrarPongRecusado();
    medidor.registrarPongRecusado();

    const medidas = medidor.instantaneo(JANELA_DE_MEDICAO_MS);
    assert.equal(medidas.pacotesNoSentidoErrado, 1);
    assert.equal(medidas.pongsRecusados, 2);
    // Nem um nem outro é defeito de formato: `descartados` continua sendo porTamanho + porTipo.
    assert.equal(medidas.descartados, 0);
    assert.equal(medidas.pongsRecebidos, 0);
  });

  it('calcula média e desvio do dt da janela e ignora dt não positivo', () => {
    const medidor = criarMedidorDaSessao(contadoresZerados(), 0);

    // 0 é a primeira amostra do ciclo (sem intervalo anterior) e não pode entrar na média.
    medidor.registrarDt(0);
    medidor.registrarDt(8);
    medidor.registrarDt(12);
    medidor.registrarPacote(1);

    const medidas = medidor.instantaneo(JANELA_DE_MEDICAO_MS);
    assert.equal(medidas.dtMsMedio, 10);
    assert.equal(medidas.dtMsDesvio, 2);
  });

  it('devolve p50 e p95 por posto, sem interpolar', () => {
    const medidor = criarMedidorDaSessao(contadoresZerados(), 0);

    for (let valor = 1; valor <= 100; valor += 1) medidor.registrarRtt(valor);

    const medidas = medidor.instantaneo(0);
    assert.equal(medidas.amostrasDeRtt, 100);
    assert.equal(medidas.pongsRecebidos, 100);
    assert.equal(medidas.rttMsP50, 50);
    assert.equal(medidas.rttMsP95, 95);
    assert.equal(medidas.rttMsUltimo, 100);
  });

  it('guarda só as últimas amostras de RTT (anel de capacidade fixa)', () => {
    const medidor = criarMedidorDaSessao(contadoresZerados(), 0);

    // 300 amostras num anel de 128: as primeiras somem, e o p50 acompanha as recentes.
    for (let valor = 1; valor <= 300; valor += 1) medidor.registrarRtt(valor);

    const medidas = medidor.instantaneo(0);
    assert.equal(medidas.amostrasDeRtt, 128);
    assert.equal(medidas.pongsRecebidos, 300);
    assert.ok(medidas.rttMsP50 > 200, `p50 deveria estar entre as amostras recentes: ${medidas.rttMsP50}`);
  });

  it('separa fora de ordem de fora de ordem descartado', () => {
    const medidor = criarMedidorDaSessao(contadoresZerados(), 0);

    medidor.registrarForaDeOrdem(true);
    medidor.registrarForaDeOrdem(false);

    const medidas = medidor.instantaneo(0);
    assert.equal(medidas.foraDeOrdem, 2);
    assert.equal(medidas.descartadosForaDeOrdem, 1);
  });

  it('soma descartados por tamanho e por tipo, como manda a seção 7', () => {
    const contadores = contadoresZerados();
    const medidor = criarMedidorDaSessao(contadores, 0);

    contadores.pacotesRecebidos = 7;
    contadores.bytesRecebidos = 168;
    contadores.descartadosPorTamanho = 2;
    contadores.descartadosPorTipo = 3;

    const medidas = medidor.instantaneo(0);
    assert.equal(medidas.pacotesRecebidos, 7);
    assert.equal(medidas.bytesRecebidos, 168);
    assert.equal(medidas.descartados, 5);
  });
});

describe('compararSeq', () => {
  it('reconhece avanço, repetição e atraso', () => {
    assert.equal(compararSeq(11, 10), 1);
    assert.equal(compararSeq(10, 10), 0);
    assert.equal(compararSeq(9, 10), -1);
  });

  it('atravessa a volta do u16 sem inverter o sentido', () => {
    // A cada ~11 minutos a 100 Hz o `seq` dá a volta: comparar cru diria que 0 é anterior a
    // 65535 e o fluxo inteiro viraria "fora de ordem".
    assert.equal(compararSeq(0, 65535), 1);
    assert.equal(compararSeq(2, 65534), 1);
    assert.equal(compararSeq(65535, 0), -1);
  });
});
