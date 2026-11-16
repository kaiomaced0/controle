/**
 * Medição da calibração de bias e da recalibração automática (ATI-009).
 *
 * Por que existe: os testes provam que o comportamento está lá; esta ferramenta produz os
 * **números** que o relatório de entrega cita, e permite que outra pessoa os refaça (regra 7 do
 * CLAUDE.md). Ela roda o simulador da ATI-023 contra o pipeline da ATI-008 e a calibração desta
 * atividade, sempre com a **dubla** da camada de saída — nada aqui encosta no cursor da máquina,
 * e por isso ela não precisa da variável de ambiente que as `provar-*.mjs` exigem.
 *
 * ```powershell
 * # a partir de server/
 * node --import tsx --expose-gc ferramentas\medir-calibracao.mjs
 * ```
 *
 * `--expose-gc` é opcional: sem ele, a medição de alocação usa a mediana de cinco rodadas em vez
 * de forçar a coleta nas pontas (a mesma defesa do teste de caminho quente do pipeline).
 *
 * Não é código de produção e não entra no `dist/` — `.mjs` fora de `src/`.
 */

import { criarAtendenteDeComandos } from '../src/comandos.ts';
import {
  criarAjusteAutomaticoDeBias,
  criarCalibracaoDeBias,
  criarPipelineDeMovimento,
} from '../src/movimento/indice.ts';
import {
  criarAmostraSimulada,
  criarFonteDeAmostras,
  criarGerador,
  resolverParametros,
} from '../src/cli/simulador/indice.ts';
import { TIPO_MOVIMENTO, criarPacoteDecodificado, proximoSeq } from '../src/protocolo/indice.ts';
import { criarBackendDubla } from '../src/saida/dubla.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerCaptura } from '../src/cli/captura.ts';

const GRAUS_PARA_RAD = Math.PI / 180;
/** Tela grande: o cursor virtual da dubla não pode bater na borda no meio de uma medição. */
const TELA = { largura: 8000, altura: 8000 };
/**
 * Como o bias se reparte pelos três eixos — a mesma proporção do simulador (`padroes.ts`), que por
 * sua vez copia o exemplo da seção 3.5 do PROTOCOLO.md. Um giroscópio parado não acusa o mesmo
 * número nos três eixos.
 */
const PROPORCAO_DO_BIAS = { x: 0.62, y: -0.14, z: 0.24 };

function linha(rotulo, texto) {
  process.stdout.write(`${rotulo.padEnd(16)}${texto}\n`);
}

function titulo(texto) {
  process.stdout.write(`\n== ${texto}\n`);
}

function fonteDe(opcoes) {
  return criarFonteDeAmostras(resolverParametros(opcoes));
}

/** Roda a série inteira pela bancada (e pelo `observar`, quando houver atendente). */
function correr(fonte, bancada, atendente, deriva) {
  const amostra = criarAmostraSimulada();
  const pacote = criarPacoteDecodificado();
  let indice = 0;
  while (fonte.proxima(amostra)) {
    bancada.marcarChegada(amostra.tDispositivoMs);
    const extra = deriva === undefined ? 0 : deriva(indice);
    pacote.tipo = TIPO_MOVIMENTO;
    pacote.flags = amostra.flags;
    pacote.seq = amostra.seq;
    pacote.tDispositivoMs = amostra.tDispositivoMs;
    pacote.dtMs = amostra.dtMs;
    pacote.gx = amostra.gx + extra * PROPORCAO_DO_BIAS.x;
    pacote.gy = amostra.gy + extra * PROPORCAO_DO_BIAS.y;
    pacote.gz = amostra.gz + extra * PROPORCAO_DO_BIAS.z;
    atendente?.observar(pacote);
    bancada.pipeline.processar(pacote);
    indice += 1;
  }
  return indice;
}

/** Alimenta uma coleta de calibração com as `quantas` primeiras amostras da série. */
function calibrarCom(fonte, quantas) {
  const calibracao = criarCalibracaoDeBias();
  const amostra = criarAmostraSimulada();
  const pacote = criarPacoteDecodificado();
  calibracao.iniciar();
  let usadas = 0;
  while (usadas < quantas && fonte.proxima(amostra)) {
    pacote.tipo = TIPO_MOVIMENTO;
    pacote.dtMs = amostra.dtMs;
    pacote.gx = amostra.gx;
    pacote.gy = amostra.gy;
    pacote.gz = amostra.gz;
    calibracao.registrar(pacote);
    usadas += 1;
  }
  return calibracao.finalizar();
}

function montarBancada() {
  const dubla = criarBackendDubla({ tela: TELA });
  let chegadaMs = 0;
  const pipeline = criarPipelineDeMovimento({
    destino: dubla,
    // A chegada acompanha o carimbo do aparelho: atraso relativo zero, senão a guarda de atraso
    // descartaria uma série de 60 s que "chega" toda no mesmo instante.
    relogio: () => chegadaMs,
  });
  return {
    dubla,
    pipeline,
    contadores: pipeline.contadores,
    marcarChegada(ms) {
      chegadaMs = ms;
    },
  };
}

/* ------------------------------------------------------- 1. sincronizar e ficar parado */

titulo('sincronizar → 60 s de aparelho parado (bias de 2 °/s, exagerado de propósito)');

const pedidoParado = { padrao: 'parado', taxaHz: 100, duracaoS: 60, biasGrausPorS: 2 };
const medido = calibrarCom(fonteDe({ ...pedidoParado, duracaoS: 1.2 }), 120);
if (!medido.ok) throw new Error(`a calibração de bancada foi recusada: ${medido.mensagem}`);

linha(
  'bias medido',
  `${(medido.bias.gx / GRAUS_PARA_RAD).toFixed(4)} / ` +
    `${(medido.bias.gy / GRAUS_PARA_RAD).toFixed(4)} / ` +
    `${(medido.bias.gz / GRAUS_PARA_RAD).toFixed(4)} °/s`,
);
linha(
  'coleta',
  `${medido.amostras} amostras (${medido.descartadas} descartadas nas pontas) · ` +
    `dispersão ${medido.dispersaoGrausPorS.toFixed(4)} °/s · ${Math.round(medido.duracaoMs)} ms`,
);

// 60 s e 5 min: o segundo é o critério de aceite da ATI-009 ("não move o cursor por 5 minutos
// seguidos"), e o primeiro é o mesmo caso na duração que os testes automáticos usam.
for (const { rotulo, duracaoS, calibrado } of [
  { rotulo: 'com bias 60 s', duracaoS: 60, calibrado: true },
  { rotulo: 'com bias 5 min', duracaoS: 300, calibrado: true },
  { rotulo: 'sem bias 60 s', duracaoS: 60, calibrado: false },
]) {
  const bancada = montarBancada();
  if (calibrado) bancada.pipeline.definirBias(medido.bias.gx, medido.bias.gy, medido.bias.gz);
  correr(fonteDe({ ...pedidoParado, duracaoS }), bancada);
  const percorrido = Math.hypot(bancada.contadores.pixelsX, bancada.contadores.pixelsY);
  linha(
    rotulo,
    `${bancada.contadores.amostrasRecebidas} amostras · cursor andou ` +
      `${bancada.contadores.pixelsX}/${bancada.contadores.pixelsY} px (módulo ${percorrido.toFixed(0)})`,
  );
}

/* -------------------------------------------------------------------- 2. as recusas */

titulo('as quatro recusas do calibrar-fim');

const durante90 = calibrarCom(fonteDe({ padrao: 'rotacao', graus: 90, eixo: 'y', taxaHz: 100 }), 120);
linha('girando', durante90.ok ? 'ACEITOU (defeito!)' : `${durante90.motivo} — ${durante90.mensagem}`);

// Mão balançando em torno do lugar: média perto de zero (passaria pelo teste de módulo) e
// dispersão enorme. É o caso que **só** a dispersão pega — o espelho do caso de cima.
const balancando = (() => {
  const calibracao = criarCalibracaoDeBias();
  const pacote = criarPacoteDecodificado();
  pacote.tipo = TIPO_MOVIMENTO;
  pacote.dtMs = 10;
  pacote.gy = 0;
  pacote.gz = 0;
  calibracao.iniciar();
  for (let indice = 0; indice < 120; indice += 1) {
    pacote.gx = (indice % 2 === 0 ? 5 : -5) * GRAUS_PARA_RAD;
    calibracao.registrar(pacote);
  }
  return calibracao.finalizar();
})();
linha('balançando', balancando.ok ? 'ACEITOU (defeito!)' : `${balancando.motivo} — ${balancando.mensagem}`);

const curta = calibrarCom(fonteDe({ padrao: 'parado', taxaHz: 100, duracaoS: 1 }), 30);
linha('poucas amostras', curta.ok ? 'ACEITOU (defeito!)' : `${curta.motivo} — ${curta.mensagem}`);

const semInicio = criarCalibracaoDeBias().finalizar();
linha('sem início', semInicio.ok ? 'ACEITOU (defeito!)' : `${semInicio.motivo} — ${semInicio.mensagem}`);

/* --------------------------------------------------- 3. deriva térmica em 10 minutos */

titulo('deriva térmica: 10 min parado, bias saindo de 0,29 para 1,20 °/s');

const MINUTOS = 10;
const pedidoDeriva = { padrao: 'parado', taxaHz: 100, duracaoS: MINUTOS * 60, biasGrausPorS: 0.29 };
const totalDeAmostras = MINUTOS * 60 * 100;
const derivaFinalRad = (1.2 - 0.29) * GRAUS_PARA_RAD;
const deriva = (indice) => (derivaFinalRad * indice) / totalDeAmostras;

for (const ligada of [true, false]) {
  const bancada = montarBancada();
  const inicial = calibrarCom(fonteDe({ ...pedidoDeriva, duracaoS: 1.2 }), 120);
  if (!inicial.ok) throw new Error(`calibração inicial recusada: ${inicial.mensagem}`);
  bancada.pipeline.definirBias(inicial.bias.gx, inicial.bias.gy, inicial.bias.gz);

  const recalibracao = criarAjusteAutomaticoDeBias({
    ativo: ligada,
    aplicar: (gx, gy, gz) => {
      bancada.pipeline.definirBias(gx, gy, gz);
    },
  });
  recalibracao.semear(inicial.bias.gx, inicial.bias.gy, inicial.bias.gz);
  const atendente = criarAtendenteDeComandos({
    pipeline: bancada.pipeline,
    recalibracao,
    haptico: () => true,
  });

  correr(fonteDe(pedidoDeriva), bancada, atendente, deriva);

  const percorrido = Math.hypot(bancada.contadores.pixelsX, bancada.contadores.pixelsY);
  const biasFinal = bancada.pipeline.ajustes;
  linha(
    ligada ? 'recalibrando' : 'sem recalibrar',
    `cursor andou ${bancada.contadores.pixelsX}/${bancada.contadores.pixelsY} px ` +
      `(módulo ${percorrido.toFixed(0)}) · bias final ` +
      `${(biasFinal.biasGxRadPorS / GRAUS_PARA_RAD).toFixed(4)} °/s em x · ` +
      `${recalibracao.contadores.aplicacoes} aplicações`,
  );
}

/* ------------------------------------------- 4. o impasse da estimativa (rodada 2) */

titulo('impasse: estimativa longe da leitura — 10 min, com e sem replantio');

/**
 * Um caso do impasse, medido com o próprio módulo.
 *
 * "Sem replantio" é o comportamento da rodada 1, reproduzido aqui pedindo uma leitura sustentada
 * de uma hora: ela nunca fecha dentro dos 10 min da medição, e o módulo se comporta como se o
 * conserto não existisse. É o antes e o depois na mesma bancada, com a mesma série de amostras.
 */
function medirImpasse({ rotulo, guardadoGrausPorS, leituraGrausPorS, picoGrausPorS, replantio }) {
  const bancada = montarBancada();
  let amostrasAteReplantar;
  const recalibracao = criarAjusteAutomaticoDeBias({
    aplicar: (gx, gy, gz) => {
      bancada.pipeline.definirBias(gx, gy, gz);
    },
    aoReplantar: () => {
      amostrasAteReplantar ??= bancada.contadores.amostrasRecebidas;
    },
    ...(replantio ? {} : { tempoDeLeituraSustentadaMs: 60 * 60 * 1000 }),
  });

  if (guardadoGrausPorS !== undefined) {
    const rad = guardadoGrausPorS * GRAUS_PARA_RAD;
    const guardado = {
      gx: rad * PROPORCAO_DO_BIAS.x,
      gy: rad * PROPORCAO_DO_BIAS.y,
      gz: rad * PROPORCAO_DO_BIAS.z,
    };
    bancada.pipeline.definirBias(guardado.gx, guardado.gy, guardado.gz);
    recalibracao.semear(guardado.gx, guardado.gy, guardado.gz);
  }

  const atendente = criarAtendenteDeComandos({
    pipeline: bancada.pipeline,
    recalibracao,
    haptico: () => true,
  });

  const pico = (picoGrausPorS ?? 0) * GRAUS_PARA_RAD;
  correr(
    fonteDe({ padrao: 'parado', taxaHz: 100, duracaoS: 600, biasGrausPorS: leituraGrausPorS }),
    bancada,
    atendente,
    (indice) => (indice === 0 ? pico : 0),
  );

  const numeros = recalibracao.contadores;
  const percorrido = Math.hypot(bancada.contadores.pixelsX, bancada.contadores.pixelsY);
  linha(
    rotulo,
    `${numeros.replantios} replantios · ${numeros.aplicacoes} aplicações · ` +
      `${numeros.interrupcoes} interrupções · bias final ` +
      `${(bancada.pipeline.ajustes.biasGxRadPorS / GRAUS_PARA_RAD).toFixed(4)} °/s em x · ` +
      `cursor andou ${percorrido.toFixed(0)} px · ` +
      `replantou ${amostrasAteReplantar === undefined ? 'nunca' : `aos ${(amostrasAteReplantar / 100).toFixed(1)} s`}`,
  );
}

// Caso A — o aparelho esquentou **entre** sessões: o bias guardado ontem (0,5 °/s) já não
// corresponde ao que o sensor acusa hoje (4 °/s). É a deriva térmica que a seção "Notas" da
// ATI-009 dá como razão de a recalibração existir.
medirImpasse({
  rotulo: 'A com replantio',
  guardadoGrausPorS: 0.5,
  leituraGrausPorS: 4,
  replantio: true,
});
medirImpasse({
  rotulo: 'A sem replantio',
  guardadoGrausPorS: 0.5,
  leituraGrausPorS: 4,
  replantio: false,
});

// Caso C — primeira conexão, sem bias guardado: a primeira amostra chega logo depois do toque do
// dedo em "ligar" e traz um pico de 60 °/s. Na rodada 1 ela virava a semente da sessão inteira.
medirImpasse({
  rotulo: 'C com replantio',
  leituraGrausPorS: 0.6,
  picoGrausPorS: 60,
  replantio: true,
});
medirImpasse({
  rotulo: 'C sem replantio',
  leituraGrausPorS: 0.6,
  picoGrausPorS: 60,
  replantio: false,
});

/* --------------------------------------------- 5. o portão do replantio (rodada 3) */

titulo('gesto lento e constante não vira bias — os mesmos casos, com os portões de cada rodada');

/**
 * Os portões da rodada 2, para o antes e o depois saírem da **mesma bancada**.
 *
 * Era assim que o replantio decidia: coerência medida pelo limiar de gesto (1,5 °/s), teto de
 * módulo importado do `calibrar-fim` (15 °/s) e nenhuma prova de ângulo. O parecer da rodada 2
 * mostrou que isso aceita giro lento e constante como bias.
 */
const PORTOES_DA_RODADA_2 = Object.freeze({
  coerenciaDaSustentadaGrausPorS: 1.5,
  moduloMaximoDoReplantioGrausPorS: 15,
  // A faixa de bias plausível no teto desliga a prova de ângulo — ela não existia na rodada 2.
  moduloDeBiasPlausivelGrausPorS: 15,
});

/**
 * Um gesto constante seguido de aparelho parado, com o pipeline de verdade e a dubla na saída.
 *
 * O aparelho parte **calibrado** (bias 0 no pipeline, estimativa semeada em 0): é a situação em
 * que o critério de aceite da ATI-009 vale — "após sincronizar, o aparelho parado não move o
 * cursor". As amostras são geradas aqui, e não pelo simulador, porque o `seq` e o carimbo do
 * aparelho precisam ser contínuos entre a fase do gesto e a fase de aparelho parado.
 */
function medirGesto({ grausPorS, segundosDeGesto, ruidoGrausPorS, portoes }) {
  const bancada = montarBancada();
  const recalibracao = criarAjusteAutomaticoDeBias({
    aplicar: (gx, gy, gz) => {
      bancada.pipeline.definirBias(gx, gy, gz);
    },
    ...portoes,
  });
  recalibracao.semear(0, 0, 0);
  const atendente = criarAtendenteDeComandos({
    pipeline: bancada.pipeline,
    recalibracao,
    haptico: () => true,
  });

  const gerador = criarGerador();
  const pacote = criarPacoteDecodificado();
  let tDispositivoMs = 60_000;
  let seq = 0;

  const alimentar = (valorGrausPorS, quantas) => {
    for (let indice = 0; indice < quantas; indice += 1) {
      tDispositivoMs += 10;
      bancada.marcarChegada(tDispositivoMs);
      pacote.tipo = TIPO_MOVIMENTO;
      pacote.flags = 0;
      pacote.seq = seq;
      pacote.tDispositivoMs = tDispositivoMs;
      pacote.dtMs = 10;
      pacote.gx = (valorGrausPorS + ruidoGrausPorS * gerador.normal()) * GRAUS_PARA_RAD;
      pacote.gy = 0;
      pacote.gz = 0;
      atendente.observar(pacote);
      bancada.pipeline.processar(pacote);
      seq = proximoSeq(seq);
    }
  };

  alimentar(grausPorS, segundosDeGesto * 100);
  const pxDoGesto = Math.hypot(bancada.contadores.pixelsX, bancada.contadores.pixelsY);
  // O bias tem de ser lido **aqui**: se o gesto virou bias, o mesmo mecanismo o desfaz depois que
  // a mão para, e no fim da medição os dois casos mostrariam o mesmo número. O estrago não é o
  // bias que sobra; é o cursor que anda enquanto ele existe.
  const ajustesNoFimDoGesto = bancada.pipeline.ajustes;
  const biasNoFimDoGestoGrausPorS =
    Math.hypot(
      ajustesNoFimDoGesto.biasGxRadPorS,
      ajustesNoFimDoGesto.biasGyRadPorS,
      ajustesNoFimDoGesto.biasGzRadPorS,
    ) / GRAUS_PARA_RAD;
  // Meio segundo para a média exponencial soltar o rabo do gesto: esse resíduo é da suavização
  // (ATI-008), e medi-lo aqui responderia pela atividade errada.
  alimentar(0, 50);
  const marcaX = bancada.contadores.pixelsX;
  const marcaY = bancada.contadores.pixelsY;
  alimentar(0, 1000); // 10 s de aparelho parado

  return {
    biasGrausPorS: biasNoFimDoGestoGrausPorS,
    pxDoGesto,
    pxComAparelhoParado: Math.hypot(
      bancada.contadores.pixelsX - marcaX,
      bancada.contadores.pixelsY - marcaY,
    ),
  };
}

for (const ruidoGrausPorS of [0.3, 0]) {
  titulo(
    ruidoGrausPorS === 0
      ? 'sem tremor nenhum — o pior caso: só os portões 2 e 3 seguram'
      : `com tremor de mão — ruído de ${ruidoGrausPorS.toFixed(1)} °/s`,
  );
  for (const [grausPorS, segundosDeGesto] of [
    [10, 6],
    [10, 10],
    [14, 10],
    [3, 8],
  ]) {
    const pedido = { grausPorS, segundosDeGesto, ruidoGrausPorS };
    const antes = medirGesto({ ...pedido, portoes: PORTOES_DA_RODADA_2 });
    const depois = medirGesto({ ...pedido, portoes: {} });
    linha(
      `${grausPorS} °/s ${segundosDeGesto} s`,
      `rodada 2: bias ${antes.biasGrausPorS.toFixed(3)} °/s · parado depois ` +
        `${antes.pxComAparelhoParado.toFixed(0)} px  →  rodada 3: bias ` +
        `${depois.biasGrausPorS.toFixed(3)} °/s · parado depois ` +
        `${depois.pxComAparelhoParado.toFixed(0)} px (gesto ${depois.pxDoGesto.toFixed(0)} px)`,
    );
  }
}

/* -------------------------------- 6. o portão 1 contra sensor de verdade (rodada 3) */

titulo('portão 1 contra a captura de aparelho parado de verdade (ATI-023)');

/**
 * A banda de coerência (0,4 °/s) é dimensionada pelo **ruído do sensor**, e o único sensor de
 * verdade que este projeto tem gravado é a captura de 60 s de aparelho parado da ATI-023. Se a
 * banda for apertada demais, a sequência sustentada quebra o tempo todo e o replantio nunca
 * acontece — o impasse volta pela porta dos fundos. Aqui isso é medido, e não suposto.
 *
 * A captura mora em `dados-locais/` (fora do repositório): sem ela, o bloco diz que pulou.
 */
const CAMINHO_DA_CAPTURA = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'dados-locais',
  'parado-60s.captura',
);

let captura;
try {
  captura = lerCaptura(CAMINHO_DA_CAPTURA);
} catch (erro) {
  linha('pulado', `sem captura em dados-locais: ${erro.message}`);
}

if (captura !== undefined) {
  const recalibracaoDaCaptura = criarAjusteAutomaticoDeBias({ aplicar: () => {} });
  // Estimativa plantada longe de propósito: é o que força o caminho da leitura sustentada, que é
  // justamente o que se quer medir. Sem isso, a estimativa serviria e o portão 1 nem rodaria.
  recalibracaoDaCaptura.semear(30 * GRAUS_PARA_RAD, 0, 0);

  const pacoteDaCaptura = criarPacoteDecodificado();
  let maiorSustentadaMs = 0;
  let quebras = 0;
  let amostraDoReplantio;
  let indiceDaCaptura = 0;
  for (const amostra of captura.amostras) {
    pacoteDaCaptura.tipo = TIPO_MOVIMENTO;
    pacoteDaCaptura.flags = amostra.flags;
    pacoteDaCaptura.seq = amostra.seq;
    pacoteDaCaptura.tDispositivoMs = amostra.tDispositivoMs;
    pacoteDaCaptura.dtMs = amostra.dtMs;
    pacoteDaCaptura.gx = amostra.gx;
    pacoteDaCaptura.gy = amostra.gy;
    pacoteDaCaptura.gz = amostra.gz;
    const antes = recalibracaoDaCaptura.sustentadaMs;
    recalibracaoDaCaptura.observar(pacoteDaCaptura);
    const depois = recalibracaoDaCaptura.sustentadaMs;
    if (depois === 0 && antes > 0 && recalibracaoDaCaptura.contadores.replantios === 0) quebras += 1;
    if (depois > maiorSustentadaMs) maiorSustentadaMs = depois;
    if (recalibracaoDaCaptura.contadores.replantios > 0 && amostraDoReplantio === undefined) {
      amostraDoReplantio = indiceDaCaptura;
    }
    indiceDaCaptura += 1;
  }

  const estimativa = recalibracaoDaCaptura.estimativa();
  linha('captura', `${captura.amostras.length} amostras gravadas de aparelho parado`);
  linha(
    'sequência',
    `${quebras} quebras antes do replantio · maior sustentação ${maiorSustentadaMs} ms · ` +
      `replantou ${amostraDoReplantio === undefined ? 'nunca (PORTÃO APERTADO DEMAIS)' : `na amostra ${amostraDoReplantio}`}`,
  );
  linha(
    'bias medido',
    `${(estimativa.gx / GRAUS_PARA_RAD).toFixed(4)} / ${(estimativa.gy / GRAUS_PARA_RAD).toFixed(4)} / ` +
      `${(estimativa.gz / GRAUS_PARA_RAD).toFixed(4)} °/s`,
  );
}

/* ----------------------------------------------------------- 7. custo do caminho quente */

titulo('caminho quente do observar (calibração coletando + recalibração ligada)');

const AMOSTRAS = 200_000;
const coletar = globalThis.gc;
const mediana = (valores) => [...valores].sort((a, b) => a - b)[Math.floor(valores.length / 2)];

/**
 * Custo de `observar` num cenário, medido como o teste de caminho quente do pipeline (ATI-008):
 * aquece o motor, mede cinco rodadas e fica com a mediana.
 *
 * `valorDaAmostra(indice)` decide a leitura de cada amostra, e é o que separa os cenários: o
 * caminho barato (a estimativa serve e a sequência sustentada nem é executada) do caro (ela roda
 * em toda amostra). Medir só o barato foi o buraco que o parecer da rodada 2 apontou.
 */
function medirCustoDoObservar(rotulo, valorDaAmostra, semear) {
  const calibracaoDeCusto = criarCalibracaoDeBias({ capacidade: 250_000 });
  const recalibracaoDeCusto = criarAjusteAutomaticoDeBias({ aplicar: () => {} });
  if (semear !== undefined) recalibracaoDeCusto.semear(semear * GRAUS_PARA_RAD, 0, 0);
  const atendenteDeCusto = criarAtendenteDeComandos({
    calibracao: calibracaoDeCusto,
    recalibracao: recalibracaoDeCusto,
    haptico: () => true,
  });
  const pacoteDeCusto = criarPacoteDecodificado();
  pacoteDeCusto.tipo = TIPO_MOVIMENTO;
  pacoteDeCusto.dtMs = 10;
  pacoteDeCusto.gy = -0.2 * GRAUS_PARA_RAD;
  pacoteDeCusto.gz = 0.3 * GRAUS_PARA_RAD;

  let indice = 0;
  const rodar = (voltas) => {
    for (let volta = 0; volta < voltas; volta += 1) {
      pacoteDeCusto.gx = valorDaAmostra(indice) * GRAUS_PARA_RAD;
      atendenteDeCusto.observar(pacoteDeCusto);
      indice += 1;
    }
  };

  calibracaoDeCusto.iniciar();
  rodar(100_000); // aquecimento: antes de o motor compilar, toda conta com número quebrado aloca

  const porAmostra = [];
  const tempos = [];
  for (let rodada = 0; rodada < 5; rodada += 1) {
    calibracaoDeCusto.iniciar();
    coletar?.();
    const heapAntes = process.memoryUsage().heapUsed;
    const comeco = process.hrtime.bigint();
    rodar(AMOSTRAS);
    const fim = process.hrtime.bigint();
    coletar?.();
    porAmostra.push((process.memoryUsage().heapUsed - heapAntes) / AMOSTRAS);
    tempos.push(Number(fim - comeco) / 1000 / AMOSTRAS);
  }

  linha(
    rotulo,
    `${mediana(tempos).toFixed(4)} µs/amostra · ${mediana(porAmostra).toFixed(3)} B/amostra`,
  );
}

// O caminho barato: leitura sempre igual, estimativa em cima dela. É o dia a dia do aparelho na
// mesa, e o único cenário que a rodada 2 media.
medirCustoDoObservar('parado', () => 0.7);
// O caminho em que a estimativa **nunca** serve e a sequência sustentada roda em toda amostra —
// o pior caso apontado pelo revisor da rodada 2.
medirCustoDoObservar('interrompendo', (indice) => (indice % 2 === 0 ? 20 : -20));
// O pior caso dos portões novos: leitura coerente e acima da faixa de bias plausível, com a
// estimativa longe. Aqui a prova de ângulo é avaliada em **toda** amostra depois do tempo base.
medirCustoDoObservar('sustentando', () => 3, 30);
linha('rodadas', `mediana de 5 × ${AMOSTRAS}`);
linha('gc', coletar === undefined ? 'sem --expose-gc (mediana defende do ruído)' : 'forçado nas pontas');
process.stdout.write('\n');
