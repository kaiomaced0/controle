/**
 * Os limites conhecidos da recalibração automática, e o aviso de bias alto (ATI-029).
 *
 * Por que existe: a revisão da rodada 3 da ATI-009 mediu dois cantos que os portões do replantio
 * aceitam de propósito (508 px e 0,215 °/s), com uma bancada própria que não ficou no repositório.
 * Limite conhecido sem a bancada que o reproduz vira número de ouvir falar; esta ferramenta é a
 * bancada, e é ela que o `src/movimento/README.md` cita.
 *
 * ```powershell
 * # a partir de server/
 * node --import tsx --expose-gc ferramentas\medir-limites-da-recalibracao.mjs
 * ```
 *
 * `--expose-gc` é opcional: sem ele, o bloco de custo só dá a medida sem coleta forçada.
 *
 * Tudo aqui fala com a **dubla** da camada de saída — nada encosta no cursor da máquina — e usa o
 * pipeline, o ajuste automático e o atendente de comandos **de verdade**, com os ajustes de fábrica.
 * Cada caso roda em duas cadeias:
 *
 * - **fábrica de hoje**: filtro adaptativo 1€ e zona morta de 0,15 °/s (ATI-033);
 * - **fábrica da revisão**: média exponencial e zona morta de 0,35 °/s — a cadeia de 2026-08-24, em
 *   que os números do parecer foram medidos. É o que permite comparar com eles.
 *
 * O ruído é normal com semente fixa (o gerador do simulador), então a saída é a mesma em toda
 * execução. Não é código de produção e não entra no `dist/` — `.mjs` fora de `src/`.
 */

import { criarAtendenteDeComandos } from '../src/comandos.ts';
import {
  ANGULO_DE_PROVA_GRAUS,
  criarAjusteAutomaticoDeBias,
  criarPipelineDeMovimento,
  textoDoAvisoDeBiasAlto,
} from '../src/movimento/indice.ts';
import { criarGerador } from '../src/cli/simulador/indice.ts';
import { TIPO_MOVIMENTO, criarPacoteDecodificado, proximoSeq } from '../src/protocolo/indice.ts';
import { criarBackendDubla } from '../src/saida/dubla.ts';

const GRAUS_PARA_RAD = Math.PI / 180;
/** Tela enorme: o cursor virtual da dubla não pode bater na borda no meio de uma medição. */
const TELA = { largura: 80_000, altura: 80_000 };
/** Ruído do giroscópio dos casos do parecer: ±0,05 °/s (desvio da normal). */
const RUIDO_GRAUS_POR_S = 0.05;

const CADEIAS = [
  { rotulo: 'fábrica de hoje', ajustes: {} },
  { rotulo: 'fábrica da revisão', ajustes: { filtro: 'exponencial', zonaMortaGrausPorS: 0.35 } },
];

function linha(rotulo, texto) {
  process.stdout.write(`${rotulo.padEnd(26)}${texto}\n`);
}

function titulo(texto) {
  process.stdout.write(`\n== ${texto}\n`);
}

const numero = (valor, casas) => valor.toFixed(casas);

/**
 * Bancada de um caso: pipeline de verdade com a dubla, ajuste automático ligado ao pipeline e o
 * atendente de comandos (o mesmo `observar` da produção). O aparelho parte **calibrado** — bias 0
 * no pipeline e estimativa semeada em 0 —, que é a situação do critério de aceite da ATI-009.
 */
function montarBancada(ajustes) {
  const dubla = criarBackendDubla({ tela: TELA });
  let chegadaMs = 0;
  const pipeline = criarPipelineDeMovimento({ destino: dubla, ajustes, relogio: () => chegadaMs });
  const eventosDoAviso = [];
  let amostras = 0;
  const recalibracao = criarAjusteAutomaticoDeBias({
    aplicar: (gx, gy, gz) => {
      pipeline.definirBias(gx, gy, gz);
    },
    aoMudarAvisoDeBiasAlto: (grausPorS) => {
      eventosDoAviso.push({ amostra: amostras, grausPorS });
    },
  });
  recalibracao.semear(0, 0, 0);
  const atendente = criarAtendenteDeComandos({ pipeline, recalibracao, haptico: () => true });

  const gerador = criarGerador();
  const pacote = criarPacoteDecodificado();
  let tDispositivoMs = 60_000;
  let seq = 0;

  return {
    pipeline,
    recalibracao,
    atendente,
    eventosDoAviso,
    get amostras() {
      return amostras;
    },
    /** `quantas` amostras de 10 ms com `grausPorS` no eixo X do sensor, mais o ruído. */
    alimentar(grausPorS, quantas, ruido = RUIDO_GRAUS_POR_S) {
      for (let indice = 0; indice < quantas; indice += 1) {
        tDispositivoMs += 10;
        chegadaMs = tDispositivoMs;
        amostras += 1;
        pacote.tipo = TIPO_MOVIMENTO;
        pacote.flags = 0;
        pacote.seq = seq;
        pacote.tDispositivoMs = tDispositivoMs;
        pacote.dtMs = 10;
        pacote.gx = (grausPorS + ruido * gerador.normal()) * GRAUS_PARA_RAD;
        pacote.gy = 0;
        pacote.gz = 0;
        atendente.observar(pacote);
        pipeline.processar(pacote);
        seq = proximoSeq(seq);
      }
    },
    /** Pixels percorridos (módulo dos dois eixos da tela) desde a marca. */
    marca() {
      const x = pipeline.contadores.pixelsX;
      const y = pipeline.contadores.pixelsY;
      return () => Math.hypot(pipeline.contadores.pixelsX - x, pipeline.contadores.pixelsY - y);
    },
    biasGrausPorS() {
      return pipeline.ajustes.biasGxRadPorS / GRAUS_PARA_RAD;
    },
  };
}

/**
 * Um gesto constante, a mão para, e o que o cursor faz **depois**: o número que importa é o cursor
 * andando com o aparelho já parado — é o "volta sozinho" do parecer.
 */
function medirGesto(ajustes, grausPorS, segundos) {
  const bancada = montarBancada(ajustes);
  bancada.alimentar(grausPorS, segundos * 100);
  const estimativaNoFim = bancada.recalibracao.estimativa().gx / GRAUS_PARA_RAD;
  const biasNoFim = bancada.biasGrausPorS();
  // A contagem começa na amostra seguinte ao gesto, sem folga para o filtro: é como o parecer
  // mediu. Nos dois limites o rabo do gesto é desprezível — no de 3 °/s, durante o fim do gesto a
  // leitura e o bias já se anulavam; no de 1,2 °/s, o que sai depois é quase todo o bias.
  const depoisDaMao = bancada.marca();
  bancada.alimentar(0, 1000);
  const em10s = depoisDaMao();
  const biasEm10s = bancada.biasGrausPorS();
  bancada.alimentar(0, 3000);
  return {
    replantios: bancada.recalibracao.contadores.replantios,
    estimativaNoFim,
    biasNoFim,
    biasEm10s,
    em10s,
    em40s: depoisDaMao(),
  };
}

/* ------------------------------------- 1. limite: gesto lento, constante e longo (portão 3) */

titulo(
  `limite 1 — gesto de 3 °/s sustentado, ruído ±${RUIDO_GRAUS_POR_S} °/s ` +
    `(a prova de ângulo cobra ${ANGULO_DE_PROVA_GRAUS}° ÷ 3 °/s = 20 s)`,
);
for (const { rotulo, ajustes } of CADEIAS) {
  for (const segundos of [20, 23, 24, 25, 30]) {
    const r = medirGesto(ajustes, 3, segundos);
    linha(
      `${rotulo} ${segundos} s`,
      `${r.replantios} replantio(s) · bias no fim do gesto ${numero(r.biasNoFim, 3)} °/s · ` +
        `mão parada: volta ${numero(r.em10s, 0)} px em 10 s, ${numero(r.em40s, 0)} px em 40 s`,
    );
  }
}

/* --------------------------------- 2. limite: gesto abaixo do limiar de parado (1,5 °/s) */

titulo('limite 2 — gesto de 1,2 °/s, abaixo do limiar de parado: a média lenta o segue');
for (const { rotulo, ajustes } of CADEIAS) {
  for (const segundos of [3, 5, 10, 30]) {
    const r = medirGesto(ajustes, 1.2, segundos);
    linha(
      `${rotulo} ${segundos} s`,
      `${r.replantios} replantio(s) · estimativa no fim ${numero(r.estimativaNoFim, 3)} °/s · ` +
        `bias 10 s depois ${numero(r.biasEm10s, 3)} °/s · ` +
        `mão parada: volta ${numero(r.em10s, 0)} px em 10 s, ${numero(r.em40s, 0)} px em 40 s`,
    );
  }
}

/* ------------------------------------------------------------- 3. o aviso de bias alto */

titulo('o aviso de bias alto — sensor com bias num eixo, aparelho parado, sem sincronizar (60 s)');

/** Quando o aviso acendeu e apagou, e o cursor andando sozinho com ele aceso e depois. */
function medirAviso(ajustes, biasGrausPorS) {
  const bancada = montarBancada(ajustes);
  const desdeOInicio = bancada.marca();
  let pixelsAteApagar;
  let depoisDeApagar;
  for (let passo = 0; passo < 6000; passo += 10) {
    bancada.alimentar(biasGrausPorS, 10);
    const ultimo = bancada.eventosDoAviso.at(-1);
    if (pixelsAteApagar === undefined && ultimo !== undefined && ultimo.grausPorS === undefined) {
      pixelsAteApagar = desdeOInicio();
      bancada.alimentar(biasGrausPorS, 50); // o filtro solta o resto
      depoisDeApagar = bancada.marca();
    }
  }
  const acendeu = bancada.eventosDoAviso.find((evento) => evento.grausPorS !== undefined);
  const apagou = bancada.eventosDoAviso.find((evento) => evento.grausPorS === undefined);
  return {
    acendeuS: acendeu === undefined ? undefined : acendeu.amostra / 100,
    valor: acendeu?.grausPorS,
    apagouS: apagou === undefined ? undefined : apagou.amostra / 100,
    pixelsAteApagar: pixelsAteApagar ?? desdeOInicio(),
    depoisDeApagar: depoisDeApagar === undefined ? undefined : depoisDeApagar(),
    replantios: bancada.recalibracao.contadores.replantios,
    recusas: bancada.recalibracao.contadores.replantiosRecusados,
  };
}

for (const { rotulo, ajustes } of CADEIAS) {
  for (const bias of [1.4, 2, 3, 5, 7, 20]) {
    const r = medirAviso(ajustes, bias);
    const aviso =
      r.acendeuS === undefined
        ? 'sem aviso'
        : `aviso aceso aos ${numero(r.acendeuS, 2)} s (${numero(r.valor, 2)} °/s)` +
          (r.apagouS === undefined ? ', aceso até o fim' : `, apagou aos ${numero(r.apagouS, 2)} s`);
    const depois = r.depoisDeApagar === undefined ? '' : ` · depois de apagar ${numero(r.depoisDeApagar, 0)} px`;
    linha(
      `${rotulo} ${bias} °/s`,
      `${aviso} · cursor andou ${numero(r.pixelsAteApagar, 0)} px até apagar${depois} · ` +
        `${r.replantios} replantio(s), ${r.recusas} recusa(s)`,
    );
  }
}

titulo('o aviso seguido: sincronizar assim que ele aparece (bias de 2 °/s, fábrica de hoje)');
{
  const bancada = montarBancada({});
  const sessao = {
    id: 's-bancada',
    estado: 'ativa',
    aparelho: undefined,
    noDelayAplicado: true,
    enviadas: [],
    instantaneo() {
      throw new Error('sem instantâneo na bancada');
    },
    enviarTexto(mensagem) {
      this.enviadas.push(mensagem);
      return true;
    },
    enviarBinario: () => true,
    encerrar: () => undefined,
  };
  const desdeOInicio = bancada.marca();
  bancada.alimentar(2, 201);
  const aceso = bancada.recalibracao.biasAltoGrausPorS;
  bancada.atendente.tratar({ t: 'cmd', comando: 'calibrar-inicio' }, sessao);
  bancada.alimentar(2, 120);
  bancada.atendente.tratar({ t: 'cmd', comando: 'calibrar-fim' }, sessao);
  const ateSincronizar = desdeOInicio();
  bancada.alimentar(2, 50);
  const depois = bancada.marca();
  bancada.alimentar(2, 3000);
  linha(
    'sincronizou',
    `aviso aceso aos ${numero((bancada.eventosDoAviso[0]?.amostra ?? Number.NaN) / 100, 2)} s ` +
      `(${numero(aceso ?? Number.NaN, 2)} °/s) · calibrar-fim → ${sessao.enviadas.at(-1)?.t ?? '—'} · ` +
      `aviso depois: ${bancada.recalibracao.biasAltoGrausPorS === undefined ? 'apagado' : 'ACESO'} · ` +
      `cursor andou ${numero(ateSincronizar, 0)} px até sincronizar, ${numero(depois(), 0)} px nos 30 s seguintes`,
  );
}

/* --------------------------------------------- 4. custo do caminho quente com o aviso */

titulo('caminho quente: recalibracao.observar com o aviso ouvido como na produção');

const AMOSTRAS = 200_000;
const coletar = globalThis.gc;
const mediana = (valores) => [...valores].sort((a, b) => a - b)[Math.floor(valores.length / 2)];

/**
 * Custo de `observar` do ajuste automático, com um ouvinte do aviso que faz o que o atendente da
 * produção faz (monta o texto e compara com o que está na tela). `aplicar` é vazio de propósito: a
 * aplicação aloca por desenho (`definirBias` monta ajustes novos a cada 500 ms) e esconderia o
 * resto.
 *
 * Duas medidas por rodada: **sem** coleta forçada, a que pega caixa de número de vida curta (ver
 * `src/movimento/README.md`), e **com** coleta forçada nas pontas, quando há `--expose-gc`.
 */
function medirCusto(rotulo, grausPorS) {
  let naTela;
  const recalibracao = criarAjusteAutomaticoDeBias({
    aplicar: () => {},
    aoMudarAvisoDeBiasAlto: (valor) => {
      const texto = valor === undefined ? undefined : textoDoAvisoDeBiasAlto(valor);
      if (texto !== naTela) naTela = texto;
    },
  });
  recalibracao.semear(0, 0, 0);
  const pacote = criarPacoteDecodificado();
  pacote.tipo = TIPO_MOVIMENTO;
  pacote.dtMs = 10;
  pacote.gx = grausPorS * GRAUS_PARA_RAD;
  pacote.gy = 0;
  pacote.gz = 0;
  const rodar = (voltas) => {
    for (let volta = 0; volta < voltas; volta += 1) recalibracao.observar(pacote);
  };
  rodar(100_000);
  const tempos = [];
  const semColeta = [];
  const comColeta = [];
  for (let rodada = 0; rodada < 7; rodada += 1) {
    const heapAntes = process.memoryUsage().heapUsed;
    const comeco = process.hrtime.bigint();
    rodar(AMOSTRAS);
    const fim = process.hrtime.bigint();
    semColeta.push((process.memoryUsage().heapUsed - heapAntes) / AMOSTRAS);
    tempos.push(Number(fim - comeco) / 1000 / AMOSTRAS);
    if (coletar !== undefined) {
      coletar();
      const antes = process.memoryUsage().heapUsed;
      rodar(AMOSTRAS);
      coletar();
      comColeta.push((process.memoryUsage().heapUsed - antes) / AMOSTRAS);
    }
  }
  linha(
    rotulo,
    `${numero(mediana(tempos), 4)} µs/amostra · ${numero(mediana(semColeta), 3)} B/amostra sem coleta` +
      (coletar === undefined ? '' : ` · ${numero(mediana(comColeta), 3)} B/amostra com coleta`) +
      ` · ${recalibracao.contadores.avisosDeBiasAlto} acendimento(s)`,
  );
}

// Referência: o aparelho na mesa, sem aviso nenhum.
medirCusto('0,3 °/s parado', 0.3);
// Bias de 2 °/s: o aviso acende, a prova de ângulo espera 30 s, o replantio e a aplicação o apagam.
medirCusto('2 °/s parado', 2);
// 7 °/s: recusa a cada 2 s, e cada recusa confirma o aviso — o pior caso de chamadas ao ouvinte.
medirCusto('7 °/s parado', 7);
linha('rodadas', `mediana de 7 × ${AMOSTRAS}`);
linha('gc', coletar === undefined ? 'sem --expose-gc: só a medida sem coleta' : 'as duas medidas');
process.stdout.write('\n');
