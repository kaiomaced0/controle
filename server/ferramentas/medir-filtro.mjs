/**
 * Medição do filtro adaptativo do tremor (ATI-033): antes e depois, com número.
 *
 * Os três números que decidem se o filtro `euro` pode ser o padrão, mais o contrapeso de cada um:
 *
 * 1. **Tremor** — quantos pixels o cursor anda com a mão "parada" (padrão `tremor` do simulador,
 *    4 amplitudes × 3 frequências de 8 a 12 Hz), hoje × euro.
 * 2. **Mira lenta** — aproximação a 0,5, 1 e 2 °/s com tremor por cima: quanto do gesto sai, qual a
 *    maior parada do cursor e quanto ele escorrega depois de a mão parar.
 * 3. **Gesto rápido** — atraso médio que o filtro acrescenta contra a mesma série sem filtro, em
 *    quatro gestos de atravessar a tela.
 *
 * E o aparelho **apoiado** (60 s de ruído de sensor, e o trecho parado da captura real), porque
 * a zona morta mais baixa que o euro permite só vale se a mesa continuar dando zero pixel.
 *
 * As séries e as réguas são as de `src/movimento/bancada-do-filtro.ts` — as mesmas que o teste
 * `filtro-adaptativo.teste.ts` usa para travar os critérios. **Não encosta no cursor**: o destino
 * só anota.
 *
 * ```powershell
 * # a partir de server/
 * node --import tsx ferramentas\medir-filtro.mjs
 * node --import tsx ferramentas\medir-filtro.mjs --corte=1.5 --beta=0.1 --zona-morta=0.1
 * node --import tsx ferramentas\medir-filtro.mjs --varredura
 * ```
 *
 * Não é código de produção e não entra no `dist/`.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { lerCaptura } from '../src/cli/captura.ts';
import {
  AJUSTES_DE_HOJE,
  atrasoMedioMs,
  avaliarMira,
  instanteDaFracaoMs,
  percorrer,
  semFiltro,
  serieApoiada,
  serieDaCaptura,
  serieDeGestoRapido,
  serieDeMiraLenta,
  serieDeTremor,
} from '../src/movimento/bancada-do-filtro.ts';
import { AJUSTES_PADRAO, criarPipelineDeMovimento } from '../src/movimento/indice.ts';
import { TIPO_MOVIMENTO, criarPacoteDecodificado, proximoSeq } from '../src/protocolo/indice.ts';

const argumentos = process.argv.slice(2);
const bandeiras = new Set(argumentos.filter((item) => !item.includes('=')));

function opcao(chave, padrao) {
  const bruto = argumentos.find((item) => item.startsWith(`--${chave}=`));
  if (bruto === undefined) return padrao;
  return bruto.slice(chave.length + 3);
}

function numero(chave, padrao) {
  const valor = Number(opcao(chave, String(padrao)));
  return Number.isFinite(valor) ? valor : padrao;
}

if (bandeiras.has('--ajuda')) {
  console.log(`medição do filtro adaptativo (ATI-033) — não mexe no cursor

uso (a partir de server/):
  node --import tsx ferramentas\\medir-filtro.mjs [opções]

opções (o euro medido; o padrão é o de fábrica de ajustes.ts):
  --corte=N             corte mínimo em Hz
  --beta=N              Hz por °/s
  --corte-velocidade=N  passa-baixa da rapidez, em Hz
  --zona-morta=N        zona morta do euro, em °/s
  --captura=CAMINHO     captura real (padrão dados-locais/s20-apoiado-ati033.captura)
  --mao=DE:ATE          trecho da captura com o aparelho na mão (padrão 18.5:24)
  --apoiado=DE:ATE      trecho da captura com o aparelho na mesa (padrão 55:115)
  --varredura           tabela de vários corte × beta × zona morta (sem custo nem captura)
  --ajuda               mostra isto`);
  process.exit(0);
}

const EURO = Object.freeze({
  filtro: 'euro',
  filtroCorteMinimoHz: numero('corte', AJUSTES_PADRAO.filtroCorteMinimoHz),
  filtroBeta: numero('beta', AJUSTES_PADRAO.filtroBeta),
  filtroCorteDaVelocidadeHz: numero('corte-velocidade', AJUSTES_PADRAO.filtroCorteDaVelocidadeHz),
  zonaMortaGrausPorS: numero('zona-morta', AJUSTES_PADRAO.zonaMortaGrausPorS),
});

const linha = (rotulo, texto) => console.log(`${rotulo.padEnd(34)} ${texto}`);
const fx = (valor, casas = 1) => (Number.isFinite(valor) ? valor.toFixed(casas) : String(valor));

/* ------------------------------------------------------------------------------ cenários */

const TREMORES = [];
for (const amplitude of [0.5, 1, 2, 3]) {
  for (const frequencia of [8, 10, 12]) TREMORES.push(serieDeTremor(amplitude, frequencia));
}

const MIRAS = [0.5, 1, 2].map((velocidade) =>
  serieDeMiraLenta({
    velocidadeGrausPorS: velocidade,
    duracaoS: 3,
    tremorGrausPorS: 1.5,
    tremorHz: 10,
  }),
);

/** A mesma aproximação sem tremor nenhum, só ruído de sensor: é onde a zona morta alta come o gesto. */
const MIRAS_SEM_TREMOR = [0.5, 1].map((velocidade) =>
  serieDeMiraLenta({ velocidadeGrausPorS: velocidade, duracaoS: 3 }),
);

const GESTOS = [
  serieDeGestoRapido(30, 200),
  serieDeGestoRapido(45, 300),
  serieDeGestoRapido(90, 500),
  serieDeGestoRapido(20, 400),
];

/** Tremor: caminho de hoje × do ajuste, e a queda. */
function medirTremor(ajustes) {
  let somaHoje = 0;
  let somaAjuste = 0;
  let piorQueda = Number.POSITIVE_INFINITY;
  const linhas = [];
  for (const serie of TREMORES) {
    const hoje = percorrer(serie, AJUSTES_DE_HOJE).caminhoPx;
    const ajuste = percorrer(serie, ajustes).caminhoPx;
    somaHoje += hoje;
    somaAjuste += ajuste;
    const queda = hoje === 0 ? Number.NaN : 100 * (1 - ajuste / hoje);
    if (hoje > 0) piorQueda = Math.min(piorQueda, queda);
    linhas.push({ serie: serie.nome, hoje, ajuste, queda });
  }
  return { linhas, somaHoje, somaAjuste, queda: 100 * (1 - somaAjuste / somaHoje), piorQueda };
}

/** Gesto rápido: atraso médio contra a mesma série sem filtro (mesma zona morta). */
function medirGestos(ajustes) {
  const zona = ajustes.zonaMortaGrausPorS ?? AJUSTES_PADRAO.zonaMortaGrausPorS;
  return GESTOS.map((serie) => {
    const referencia = percorrer(serie, semFiltro(zona));
    const medida = percorrer(serie, ajustes);
    const total = referencia.x[referencia.x.length - 1];
    return {
      serie: serie.nome,
      atrasoMs: atrasoMedioMs(referencia, medida),
      metadeMs: instanteDaFracaoMs(medida, 0.5, total) - instanteDaFracaoMs(referencia, 0.5, total),
      totalRef: total,
      totalMedido: medida.x[medida.x.length - 1],
    };
  });
}

function medirMiras(ajustes, series = MIRAS) {
  return series.map((serie) => ({ serie: serie.nome, ...avaliarMira(serie, percorrer(serie, ajustes)) }));
}

/* ------------------------------------------------------------------------ captura real */

const caminhoDaCaptura = resolve(opcao('captura', 'dados-locais/s20-apoiado-ati033.captura'));
const [maoDe, maoAte] = opcao('mao', '18.5:24').split(':').map(Number);
const [mesaDe, mesaAte] = opcao('apoiado', '55:115').split(':').map(Number);
const captura = existsSync(caminhoDaCaptura) ? lerCaptura(caminhoDaCaptura).amostras : undefined;
const trechoNaMao =
  captura === undefined ? undefined : serieDaCaptura(`na mão ${maoDe}–${maoAte} s`, captura, maoDe, maoAte);
const trechoNaMesa =
  captura === undefined
    ? undefined
    : serieDaCaptura(`na mesa ${mesaDe}–${mesaAte} s`, captura, mesaDe, mesaAte);

/* --------------------------------------------------------------------------- varredura */

if (bandeiras.has('--varredura')) {
  console.log('varredura — tremor = queda média do caminho contra hoje (pior caso entre parênteses);');
  console.log('mira = entregue no fim % / maior parada ms / deslize px a 0,5 · 1 · 2 °/s com tremor;');
  console.log('limpa = entregue no fim % a 0,5 · 1 °/s sem tremor; atraso = pior gesto, ms;');
  console.log('mesa = px em 60 s de simulador (ruído 0,05) / px no trecho parado da captura;');
  console.log('mão = queda do caminho no trecho na mão da captura (retrato / apontador)\n');
  const resumir = (ajustes) => {
    const tremor = medirTremor(ajustes);
    const mira = medirMiras(ajustes);
    const limpa = medirMiras(ajustes, MIRAS_SEM_TREMOR);
    const gestos = medirGestos(ajustes);
    const mesaSimulada = percorrer(serieApoiada(60, 0.05), ajustes).caminhoPx;
    const mesaReal = trechoNaMesa === undefined ? '-' : percorrer(trechoNaMesa, ajustes).caminhoPx;
    let mao = '-';
    if (trechoNaMao !== undefined) {
      mao = ['retrato', 'apontador']
        .map((orientacao) => {
          const hoje = percorrer(trechoNaMao, { ...AJUSTES_DE_HOJE, orientacao }).caminhoPx;
          const euro = percorrer(trechoNaMao, { ...ajustes, orientacao }).caminhoPx;
          return fx(100 * (1 - euro / hoje), 0);
        })
        .join('/');
    }
    return (
      `tremor ${fx(tremor.queda, 0)} % (${fx(tremor.piorQueda, 0)}) · mira ${mira
        .map((m) => `${fx(m.entregueNoFimPct, 0)}/${fx(m.maiorParadaMs, 0)}/${m.deslizeAposPararPx}`)
        .join(' ')} · limpa ${limpa.map((m) => fx(m.entregueNoFimPct, 0)).join('/')} · ` +
      `atraso ${fx(Math.max(...gestos.map((g) => g.atrasoMs)))} · mesa ${mesaSimulada}/${mesaReal} · mão ${mao} %`
    );
  };
  linha('hoje (exp 0,15 · zm 0,35)', resumir(AJUSTES_DE_HOJE));
  const lista = (chave, padrao) => opcao(chave, padrao).split(',').map(Number);
  for (const zona of lista('zonas', '0.35,0.2,0.15,0.1')) {
    for (const corte of lista('cortes', '1,1.5,2,3')) {
      for (const beta of lista('betas', '0.2,0.3,0.5')) {
        for (const corteVelocidade of lista('cvs', '3,10')) {
          const ajustes = {
            filtro: 'euro',
            filtroCorteMinimoHz: corte,
            filtroBeta: beta,
            filtroCorteDaVelocidadeHz: corteVelocidade,
            zonaMortaGrausPorS: zona,
          };
          linha(`zm ${zona} · corte ${corte} · beta ${beta} · cv ${corteVelocidade}`, resumir(ajustes));
        }
      }
    }
  }
  process.exit(0);
}

/* ------------------------------------------------------------------------------ relatório */

console.log(
  `euro medido: corte ${EURO.filtroCorteMinimoHz} Hz · beta ${EURO.filtroBeta} Hz/(°/s) · ` +
    `corte da velocidade ${EURO.filtroCorteDaVelocidadeHz} Hz · zona morta ${EURO.zonaMortaGrausPorS} °/s`,
);
console.log('hoje: média exponencial 0,15 · zona morta 0,35 °/s (o padrão de antes da ATI-033)\n');

console.log('== 1. mão "parada" com tremor (simulador, 10 s cada, eixo horizontal) — pixels andados');
const tremor = medirTremor(EURO);
for (const item of tremor.linhas) {
  linha(item.serie, `hoje ${String(item.hoje).padStart(5)} px · euro ${String(item.ajuste).padStart(4)} px · queda ${fx(item.queda, 1)} %`);
}
linha('TOTAL', `hoje ${tremor.somaHoje} px · euro ${tremor.somaAjuste} px · queda ${fx(tremor.queda, 1)} % (pior caso ${fx(tremor.piorQueda, 1)} %)`);

console.log('\n== 2. mira lenta (3 s; com tremor de 1,5 °/s a 10 Hz por cima, e sem) — o cursor não pode engasgar');
for (const [rotulo, ajustes] of [['hoje', AJUSTES_DE_HOJE], ['euro', EURO]]) {
  for (const item of [...medirMiras(ajustes), ...medirMiras(ajustes, MIRAS_SEM_TREMOR)]) {
    linha(
      `${rotulo} · ${item.serie.replace('mira lenta ', '').replace(' com tremor 1.5 °/s a 10 Hz', ' +tremor')}`,
      `ideal ${fx(item.idealPx, 0)} px · no fim ${fx(item.entregueNoFimPct, 0)} % · total ${fx(item.entregueTotalPct, 0)} % · ` +
        `1º pixel ${fx(item.primeiroPixelMs, 0)} ms · maior parada ${fx(item.maiorParadaMs, 0)} ms (liso: ${fx(item.intervaloIdealMs, 0)}) · ` +
        `deslize ${item.deslizeAposPararPx} px`,
    );
  }
}

console.log('\n== 3. gesto rápido — atraso médio contra a mesma série sem filtro');
for (const [rotulo, ajustes] of [['hoje', AJUSTES_DE_HOJE], ['euro', EURO]]) {
  for (const item of medirGestos(ajustes)) {
    linha(
      `${rotulo} · ${item.serie}`,
      `atraso médio ${fx(item.atrasoMs, 1)} ms · na metade do gesto ${fx(item.metadeMs, 0)} ms · ` +
        `total ${item.totalMedido}/${item.totalRef} px`,
    );
  }
}

console.log('\n== 4. aparelho apoiado — a zona morta precisa continuar dando zero');
for (const [rotulo, ajustes] of [['hoje', AJUSTES_DE_HOJE], ['euro', EURO]]) {
  for (const ruido of [0.05, 0.1]) {
    const trilha = percorrer(serieApoiada(60, ruido), ajustes);
    linha(`${rotulo} · simulador 60 s, ruído ${ruido} °/s`, `${trilha.caminhoPx} px andados`);
  }
}

console.log(`\n== 5. captura real — ${caminhoDaCaptura}`);
if (trechoNaMao === undefined || trechoNaMesa === undefined) {
  console.log('pulado: a captura não existe nesta máquina (dados-locais/ fica fora do repositório)');
} else {
  for (const serie of [trechoNaMao, trechoNaMesa]) {
    for (const orientacao of ['retrato', 'paisagem', 'apontador']) {
      const hoje = percorrer(serie, { ...AJUSTES_DE_HOJE, orientacao }).caminhoPx;
      const euro = percorrer(serie, { ...EURO, orientacao }).caminhoPx;
      linha(
        `${serie.nome} · ${orientacao}`,
        `${serie.amostras.length} amostras · hoje ${hoje} px · euro ${euro} px` +
          (hoje > 0 ? ` · queda ${fx(100 * (1 - euro / hoje), 1)} %` : ''),
      );
    }
  }
}

/* ----------------------------------------------------------------------- caminho quente */

// Sem coleta forçada nas pontas, de propósito: a coleta no fim da rodada recolhe o lixo de vida
// curta e esconde exatamente a alocação que se quer pegar. Medido nesta atividade, no mesmo código:
// 0,000 B/amostra com `gc()` nas pontas e 6,8 B/amostra sem ela (o argumento quebrado encaixotado
// na chamada do filtro). A mediana de 7 rodadas descarta a rodada em que o coletor passou.
console.log('\n== 6. caminho quente (200 mil amostras × 7 rodadas, mediana, sem coleta forçada)');
for (const [rotulo, ajustes] of [['exponencial', { filtro: 'exponencial' }], ['euro', EURO]]) {
  const destino = { nome: 'custo', moverMouseRelativo() {} };
  let chegada = 60_000;
  const pipeline = criarPipelineDeMovimento({
    destino,
    ajustes: { ...ajustes, sensXPixelsPorGrau: 35 },
    relogio: () => chegada,
  });
  const pacote = criarPacoteDecodificado();
  pacote.tipo = TIPO_MOVIMENTO;
  pacote.tDispositivoMs = 60_000;
  pacote.dtMs = 10;
  pacote.gx = 0.7 * (Math.PI / 180);
  pacote.gy = 1.3 * (Math.PI / 180);
  pacote.gz = 0.2 * (Math.PI / 180);
  const rodar = (voltas) => {
    for (let volta = 0; volta < voltas; volta += 1) {
      pacote.seq = proximoSeq(pacote.seq);
      pipeline.processar(pacote);
    }
  };
  rodar(200_000);
  const tempos = [];
  const bytes = [];
  for (let rodada = 0; rodada < 7; rodada += 1) {
    const antes = process.memoryUsage().heapUsed;
    const comeco = process.hrtime.bigint();
    rodar(200_000);
    const fim = process.hrtime.bigint();
    bytes.push((process.memoryUsage().heapUsed - antes) / 200_000);
    tempos.push(Number(fim - comeco) / 1000 / 200_000);
  }
  const mediana = (lista) => [...lista].sort((a, b) => a - b)[3];
  linha(
    rotulo,
    `${mediana(tempos).toFixed(4)} µs/amostra · ${mediana(bytes).toFixed(3)} B/amostra ` +
      `(rodadas: ${bytes.map((valor) => valor.toFixed(2)).join(' ')})`,
  );
}
