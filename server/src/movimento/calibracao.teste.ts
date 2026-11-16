/**
 * A calibração de bias da ATI-009 — a coleta, as três recusas e o critério de aceite que importa:
 * **depois de sincronizar, o aparelho parado não move o cursor**.
 *
 * Os números vêm do simulador (ATI-023), que entrega o que celular nenhum entrega: bias conhecido.
 * Quando a execução declara "parado com bias de 2 °/s", o que a calibração tem de medir é aquele
 * número — e o que sobra depois de descontá-lo vira asserção, não impressão.
 *
 * Nada aqui toca no cursor: o destino é sempre a dubla (`saida/dubla.ts`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  criarAmostraSimulada,
  criarFonteDeAmostras,
  resolverParametros,
  type FonteDeAmostras,
  type OpcoesDePadrao,
} from '../cli/simulador/indice.js';
import {
  TIPO_BOTAO,
  TIPO_MOVIMENTO,
  criarPacoteDecodificado,
  type PacoteDecodificado,
} from '../protocolo/indice.js';
import { criarBackendDubla } from '../saida/dubla.js';
import {
  CAPACIDADE_DE_AMOSTRAS,
  MINIMO_DE_AMOSTRAS,
  MOTIVO_DA_RECUSA,
  criarCalibracaoDeBias,
  type CalibracaoDeBias,
} from './calibracao.js';
import { criarPipelineDeMovimento } from './pipeline.js';
import { GRAUS_POR_RADIANO, RADIANOS_POR_GRAU } from './tipos.js';

/** Tela grande para o cursor virtual da dubla não bater na borda no meio de uma medição. */
const TELA_DE_BANCADA = { largura: 8000, altura: 8000 } as const;

function fonteDe(opcoes: OpcoesDePadrao): FonteDeAmostras {
  return criarFonteDeAmostras(resolverParametros(opcoes));
}

/** Um MOVIMENTO com as três leituras pedidas. O objeto é reaproveitado, como no fio. */
function movimentoCom(pacote: PacoteDecodificado, gx: number, gy: number, gz: number, dtMs = 10): PacoteDecodificado {
  pacote.tipo = TIPO_MOVIMENTO;
  pacote.dtMs = dtMs;
  pacote.gx = gx;
  pacote.gy = gy;
  pacote.gz = gz;
  return pacote;
}

/** Alimenta a coleta com uma série do simulador, do começo ao fim. */
function coletarDoSimulador(calibracao: CalibracaoDeBias, fonte: FonteDeAmostras, limite = Infinity): void {
  const amostra = criarAmostraSimulada();
  const pacote = criarPacoteDecodificado();
  let entregues = 0;
  while (entregues < limite && fonte.proxima(amostra)) {
    pacote.tipo = TIPO_MOVIMENTO;
    pacote.dtMs = amostra.dtMs;
    pacote.gx = amostra.gx;
    pacote.gy = amostra.gy;
    pacote.gz = amostra.gz;
    calibracao.registrar(pacote);
    entregues += 1;
  }
}

describe('calibração de bias — o que ela recusa', () => {
  it('calibrar-fim sem calibrar-inicio é recusa, não bias zero', () => {
    const calibracao = criarCalibracaoDeBias();

    const resultado = calibracao.finalizar();

    assert.equal(resultado.ok, false);
    assert.equal(resultado.ok === false && resultado.motivo, MOTIVO_DA_RECUSA.SEM_INICIO);
    assert.equal(calibracao.contadores.recusadasSemInicio, 1);
  });

  it('menos de 60 amostras é recusa com o número na mensagem', () => {
    const calibracao = criarCalibracaoDeBias();
    const pacote = criarPacoteDecodificado();

    calibracao.iniciar();
    for (let indice = 0; indice < MINIMO_DE_AMOSTRAS - 1; indice += 1) {
      calibracao.registrar(movimentoCom(pacote, 0.005, -0.001, 0.002));
    }
    const resultado = calibracao.finalizar();

    assert.equal(resultado.ok, false);
    if (resultado.ok) return;
    assert.equal(resultado.motivo, MOTIVO_DA_RECUSA.POUCAS_AMOSTRAS);
    assert.equal(resultado.amostras, MINIMO_DE_AMOSTRAS - 1);
    assert.match(resultado.mensagem, /59 amostras/);
    assert.match(resultado.mensagem, /60/);
    assert.equal(calibracao.contadores.recusadasPorAmostras, 1);
    assert.equal(calibracao.coletando, false, 'a coleta fecha mesmo quando é recusada');
  });

  it('aparelho sacudido é recusado pela dispersão, mesmo com média perto de zero', () => {
    // Média ~0 e balanço de ±20 °/s: só o teste de dispersão pega este caso — o de módulo não,
    // porque a média de um vaivém simétrico é justamente zero.
    const calibracao = criarCalibracaoDeBias();
    const pacote = criarPacoteDecodificado();

    calibracao.iniciar();
    for (let indice = 0; indice < 200; indice += 1) {
      const balanco = (indice % 2 === 0 ? 20 : -20) * RADIANOS_POR_GRAU;
      calibracao.registrar(movimentoCom(pacote, balanco, 0, 0));
    }
    const resultado = calibracao.finalizar();

    assert.equal(resultado.ok, false);
    if (resultado.ok) return;
    assert.equal(resultado.motivo, MOTIVO_DA_RECUSA.APARELHO_SE_MOVEU);
    assert.match(resultado.mensagem, /se moveu/);
    assert.equal(calibracao.contadores.recusadasPorMovimento, 1);
  });

  it('calibrar durante uma rotação é recusado pelo módulo, que a dispersão não pegaria', () => {
    // 90 °/s constante tem dispersão **zero**: todas as amostras são iguais. É o caso que existe
    // para provar que os dois testes de recusa não são o mesmo teste com dois nomes.
    const calibracao = criarCalibracaoDeBias();

    calibracao.iniciar();
    coletarDoSimulador(calibracao, fonteDe({ padrao: 'rotacao', graus: 90, eixo: 'y', taxaHz: 100 }));
    const resultado = calibracao.finalizar();

    assert.equal(resultado.ok, false);
    if (resultado.ok) return;
    assert.equal(resultado.motivo, MOTIVO_DA_RECUSA.NAO_E_BIAS);
    assert.match(resultado.mensagem, /girando/);
    assert.equal(calibracao.contadores.recusadasPorModulo, 1);
  });
});

describe('calibração de bias — o que ela mede', () => {
  it('mede o bias que o simulador declarou, com o aparelho parado', () => {
    // O simulador reparte o bias pelos três eixos na proporção do exemplo do PROTOCOLO.md
    // (seção 3.5): 0,62 · 2 °/s em x, −0,14 · 2 °/s em y, 0,24 · 2 °/s em z.
    const calibracao = criarCalibracaoDeBias();

    calibracao.iniciar();
    coletarDoSimulador(
      calibracao,
      fonteDe({ padrao: 'parado', taxaHz: 100, duracaoS: 1.2, biasGrausPorS: 2 }),
    );
    const resultado = calibracao.finalizar();

    assert.equal(resultado.ok, true);
    if (!resultado.ok) return;
    assert.equal(resultado.amostras, 121);
    assert.equal(resultado.descartadas, 24, '10 % de cada ponta saem da média');

    const emGraus = (valor: number): number => valor * GRAUS_POR_RADIANO;
    assert.ok(Math.abs(emGraus(resultado.bias.gx) - 2 * 0.62) < 0.05, `gx=${emGraus(resultado.bias.gx)}`);
    assert.ok(Math.abs(emGraus(resultado.bias.gy) - 2 * -0.14) < 0.05, `gy=${emGraus(resultado.bias.gy)}`);
    assert.ok(Math.abs(emGraus(resultado.bias.gz) - 2 * 0.24) < 0.05, `gz=${emGraus(resultado.bias.gz)}`);
    assert.ok(resultado.dispersaoGrausPorS < 0.2, `dispersão de ${resultado.dispersaoGrausPorS} °/s`);
    assert.ok(resultado.duracaoMs > 1100, `duração medida no aparelho: ${resultado.duracaoMs} ms`);
  });

  it('a média aparada ignora as batidas isoladas que a média simples carregaria', () => {
    // 5 % das amostras com uma pancada de 1,4 °/s em cima de um bias de 0,29 °/s. A dispersão
    // continua abaixo do limite (é pouca amostra fora), então a recusa não entra — quem tem de
    // segurar o estrago aqui é a aparagem.
    const calibracao = criarCalibracaoDeBias();
    const pacote = criarPacoteDecodificado();
    const base = 0.005;
    const pancada = 0.025;

    calibracao.iniciar();
    for (let indice = 0; indice < 200; indice += 1) {
      const valor = indice % 20 === 0 ? base + pancada : base;
      calibracao.registrar(movimentoCom(pacote, valor, 0, 0));
    }
    const resultado = calibracao.finalizar();

    assert.equal(resultado.ok, true);
    if (!resultado.ok) return;
    // Média simples seria 0,00625 rad/s (25 % acima do bias real); a aparada devolve o bias.
    assert.ok(
      Math.abs(resultado.bias.gx - base) < 1e-9,
      `a média aparada devolveu ${resultado.bias.gx} em vez de ${base}`,
    );
  });

  it('a coleta tem teto: amostra que chega com a memória cheia é contada, não guardada', () => {
    const calibracao = criarCalibracaoDeBias({ capacidade: 80, minimoDeAmostras: 10 });
    const pacote = criarPacoteDecodificado();

    calibracao.iniciar();
    for (let indice = 0; indice < 200; indice += 1) {
      calibracao.registrar(movimentoCom(pacote, 0.005, 0, 0));
    }

    assert.equal(calibracao.amostras, 80);
    assert.equal(calibracao.contadores.excedentes, 120);
    const resultado = calibracao.finalizar();
    assert.equal(resultado.ok, true);
    assert.equal(resultado.ok === true && resultado.amostras, 80);
  });

  it('o teto de fábrica são 6 s de aparelho parado a 100 Hz', () => {
    assert.equal(CAPACIDADE_DE_AMOSTRAS, 600);
  });

  it('ignora o que não é MOVIMENTO e a leitura que veio NaN', () => {
    const calibracao = criarCalibracaoDeBias({ minimoDeAmostras: 2 });
    const pacote = criarPacoteDecodificado();

    calibracao.iniciar();
    calibracao.registrar(movimentoCom(pacote, 0.004, 0, 0));
    // BOTÃO passa pelo mesmo gancho do transporte e não tem giroscópio nenhum dentro.
    pacote.tipo = TIPO_BOTAO;
    calibracao.registrar(pacote);
    // `f32` passa cru no fio: `NaN` chega de verdade, e envenenaria média e desvio de uma vez.
    calibracao.registrar(movimentoCom(pacote, Number.NaN, 0, 0));
    calibracao.registrar(movimentoCom(pacote, Number.POSITIVE_INFINITY, 0, 0));
    calibracao.registrar(movimentoCom(pacote, 0.006, 0, 0));

    assert.equal(calibracao.amostras, 2);
    assert.equal(calibracao.contadores.naoFinitas, 2);
    const resultado = calibracao.finalizar();
    assert.equal(resultado.ok, true);
    assert.equal(resultado.ok === true && resultado.bias.gx, 0.005);
  });
});

describe('calibração de bias — o estado da coleta', () => {
  it('calibrar-inicio por cima de uma coleta em curso recomeça do zero', () => {
    const calibracao = criarCalibracaoDeBias();
    const pacote = criarPacoteDecodificado();

    calibracao.iniciar();
    for (let indice = 0; indice < 30; indice += 1) calibracao.registrar(movimentoCom(pacote, 0.005, 0, 0));
    calibracao.iniciar();

    assert.equal(calibracao.amostras, 0);
    assert.equal(calibracao.contadores.iniciadas, 2);
    assert.equal(calibracao.contadores.canceladas, 1);
  });

  it('cancelar fecha a coleta e é idempotente — é o caminho do fim de sessão', () => {
    const calibracao = criarCalibracaoDeBias();
    const pacote = criarPacoteDecodificado();

    calibracao.iniciar();
    calibracao.registrar(movimentoCom(pacote, 0.005, 0, 0));
    calibracao.cancelar();
    calibracao.cancelar();

    assert.equal(calibracao.coletando, false);
    assert.equal(calibracao.amostras, 0);
    assert.equal(calibracao.contadores.canceladas, 1, 'cancelar duas vezes conta uma');
    // Amostra que chega depois do cancelamento não entra em coleta nenhuma.
    calibracao.registrar(movimentoCom(pacote, 0.005, 0, 0));
    assert.equal(calibracao.amostras, 0);
  });
});

describe('calibração × pipeline — o critério de aceite da ATI-009', () => {
  it('sincronizou: 60 s de aparelho parado não movem o cursor nem um pixel', () => {
    // Bias de 2 °/s, exagerado de propósito: com o bias de fábrica do simulador (0,29 °/s) a zona
    // morta sozinha engoliria tudo e o teste passaria verde sem provar nada sobre a calibração.
    const pedido: OpcoesDePadrao = { padrao: 'parado', taxaHz: 100, duracaoS: 60, biasGrausPorS: 2 };

    // 1. sincronizar: 1,2 s de coleta com o aparelho parado.
    const calibracao = criarCalibracaoDeBias();
    calibracao.iniciar();
    coletarDoSimulador(calibracao, fonteDe({ ...pedido, duracaoS: 1.2 }));
    const medido = calibracao.finalizar();
    assert.equal(medido.ok, true);
    if (!medido.ok) return;

    // 2. o bias medido vai para o pipeline, como o `calibrar-fim` faz.
    const dubla = criarBackendDubla({ tela: TELA_DE_BANCADA });
    let chegadaMs = 0;
    const pipeline = criarPipelineDeMovimento({
      destino: dubla,
      ajustes: { sensXPixelsPorGrau: 35, sensYPixelsPorGrau: 35 },
      relogio: () => chegadaMs,
    });
    pipeline.definirBias(medido.bias.gx, medido.bias.gy, medido.bias.gz);

    // 3. 60 s de aparelho parado depois disso.
    const fonte = fonteDe(pedido);
    const amostra = criarAmostraSimulada();
    const pacote = criarPacoteDecodificado();
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

    assert.equal(pipeline.contadores.amostrasRecebidas, 6001);
    assert.equal(pipeline.contadores.pixelsX, 0, 'o cursor não andou nenhum pixel em 60 s');
    assert.equal(pipeline.contadores.pixelsY, 0);
    assert.equal(dubla.eventos.length, 0, 'nem uma chamada chegou ao backend');
  });
});
