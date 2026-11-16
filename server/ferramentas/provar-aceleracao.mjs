/**
 * Bancada da aceleração de ponteiro (ATI-026) — **mexe no cursor de verdade**, sem clicar.
 *
 * Mede as três saídas de mouse com a tabela da spec (40 × +1 px e 1 × −40 px), lendo o cursor:
 *
 * - `relativo`   — o antes: o `SendInput` relativo cru, que passa pela curva do Windows;
 * - `compensado` — a estratégia (a): a curva inversa aplicada antes de mandar, com as constantes de
 *                  fábrica do modelo **e** com as ajustadas nesta execução;
 * - `absoluto`   — a estratégia (b): posição absoluta normalizada sobre a área virtual.
 *
 * Antes da tabela, uma varredura de magnitudes (n eventos de +M e n de −M, para M de 1 a 40) mede o
 * ganho real do Windows; é dela que sai o ajuste das duas constantes do modelo. Depois, a régua do
 * absoluto (cada pixel alcançado) e o custo por evento. A borda (nada gruda) e a travessia de
 * monitor só rodam com `--borda`, porque **saltam para longe do centro** (tabela abaixo).
 *
 * ```powershell
 * # a partir de server/
 * $env:CONTROLE_PROVAR_MOUSE = "1"; node --import tsx ferramentas\provar-aceleracao.mjs
 * ```
 *
 * Sem `CONTROLE_PROVAR_MOUSE=1` ela não roda. **Nada é clicado**, e o cursor volta de onde saiu no
 * `finally`. Se a pessoa mexer no mouse no meio, a linha da medição marca `interferência` — repita.
 *
 * Até onde o cursor vai:
 *
 * | Execução | Onde o cursor anda |
 * |---|---|
 * | (padrão) | O cursor é levado ao centro do monitor primário (`SetCursorPos`, de onde ele estiver) e anda perto dele. O maior gesto é o da varredura: 2 × 40 mickeys relativos para o mesmo lado, que na bancada do projeto (velocidade 11/20, 96 DPI, curva de fábrica) andam ~190 px — medido: até 189 px em x e 34 px em y. Cresce com a velocidade do ponteiro e com a escala de DPI (na velocidade 20, ~1,8 × isso). A linha `afastamento` diz o maior afastamento lido nesta execução |
 * | `--borda` | Tudo o de cima e, **depois**, dois saltos por `SetCursorPos`: (1) para 10 px antes da borda direita da **área virtual**, na altura do centro do primário — com um segundo monitor à direita, é a borda direita **do outro monitor** —, pedindo 50 px além e 10 de volta; (2) com mais de um monitor, para 5 px antes da borda direita do **primário**, andando 10 px para o vizinho e 10 de volta |
 *
 * **Nenhuma configuração do sistema é alterada**: a configuração de ponteiro é só lida.
 */

import { setTimeout as esperar } from 'node:timers/promises';
import { carregarApiDoWindows } from '../src/saida/windows/api.ts';
import { criarBackendWindows } from '../src/saida/windows/backend.ts';
import {
  CONSTANTES_MEDIDAS,
  criarModeloDaAceleracao,
  curvaInversivel,
  multiplicadorDaVelocidade,
  aceleracaoEstaLigada,
  resolverSaidaDoMouse,
} from '../src/saida/windows/aceleracao.ts';
import {
  SM_CXSCREEN,
  SM_CXVIRTUALSCREEN,
  SM_CYSCREEN,
  SM_CYVIRTUALSCREEN,
  SM_XVIRTUALSCREEN,
  SM_YVIRTUALSCREEN,
} from '../src/saida/windows/constantes.ts';

const VARIAVEL = 'CONTROLE_PROVAR_MOUSE';
const opcoes = new Set(process.argv.slice(2));
/** Borda e travessia saltam para longe do centro: só quando pedidas. */
const COM_BORDA = opcoes.has('--borda');
/** Quantas vezes cada tabela roda: a mediana segura uma rodada em que a mão encostou no mouse. */
const REPETICOES = 3;
/** Magnitudes da varredura, em mickeys por evento. */
const MAGNITUDES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 35, 40];
/** Mickeys por bloco da varredura: n = ~60/M eventos, para todo bloco andar parecido. */
const MICKEYS_POR_BLOCO = 60;
/** Espera antes de cada leitura do cursor: folga para o Windows ter aplicado o último evento. */
const FOLGA_DE_LEITURA_MS = 30;

if (opcoes.has('--ajuda')) {
  console.log(`bancada da aceleração de ponteiro (ATI-026)

uso (a partir de server/):
  $env:${VARIAVEL} = "1"; node --import tsx ferramentas\\provar-aceleracao.mjs [opções]

opções:
  --borda          ATENÇÃO: também salta para longe do centro — para a borda direita da área virtual
                   (com um segundo monitor à direita, a borda direita DELE) e, com mais de um
                   monitor, para a borda direita do primário, atravessando para o vizinho
  --sem-espera     não faz a contagem regressiva de 3 s
  --ajuda          mostra isto

o padrão leva o cursor (sem clicar) ao centro do monitor primário e o move perto dele: o maior
gesto é de 2 × 40 mickeys relativos para o mesmo lado, ~190 px na bancada do projeto (velocidade
11/20, 96 DPI), mais com velocidade ou escala maiores; a linha "afastamento" diz o maior lido.
o cursor volta ao lugar no fim. nenhuma configuração do sistema é alterada.`);
  process.exit(0);
}

if (process.env[VARIAVEL] !== '1') {
  console.error(
    `esta ferramenta mexe no cursor de verdade e só roda com ${VARIAVEL}=1.\n` +
      `  PowerShell: $env:${VARIAVEL} = "1"; node --import tsx ferramentas\\provar-aceleracao.mjs\n` +
      '  (--ajuda lista as opções)',
  );
  process.exit(1);
}

function linha(rotulo, texto) {
  console.log(`${rotulo.padEnd(16)}${texto}`);
}

function comSinal(valor) {
  return `${valor >= 0 ? '+' : ''}${valor}`;
}

function mediana(valores) {
  const ordenados = [...valores].sort((a, b) => a - b);
  return ordenados[Math.floor(ordenados.length / 2)];
}

/* ------------------------------------------------------------------ o que o sistema informa */

const api = carregarApiDoWindows();
const parametros = api.lerParametrosDoPonteiro();

console.log('controle · bancada da aceleração de ponteiro (ATI-026)');
linha('plataforma', `${process.platform} ${process.arch} · node ${process.versions.node}`);
if (parametros === undefined) {
  linha('ponteiro', 'SystemParametersInfo falhou — sem configuração, a bancada para aqui');
  process.exit(1);
}
const ligada = aceleracaoEstaLigada(parametros);
linha(
  'ponteiro',
  `aceleração ${ligada ? 'LIGADA' : 'desligada'} (SPI_GETMOUSE ${parametros.limiar1}/${parametros.limiar2}/` +
    `${parametros.aceleracao}) · velocidade ${parametros.velocidade}/20 ` +
    `(×${multiplicadorDaVelocidade(parametros.velocidade, ligada)}) · DPI ${parametros.dpi}`,
);
linha('curva X', parametros.curvaX?.map((v) => v.toFixed(4)).join(' ') ?? 'não lida');
linha('curva Y', parametros.curvaY?.map((v) => v.toFixed(4)).join(' ') ?? 'não lida');
linha('curva', curvaInversivel(parametros.curvaX, parametros.curvaY) ? 'inversível' : 'NÃO inversível');
{
  // O que o servidor escolheria com `saidaMouse=auto` (o padrão) nesta configuração — a mesma função
  // que o backend usa. É a linha que o roteiro de campo da aceleração desligada confere.
  const auto = resolverSaidaDoMouse('auto', parametros, undefined);
  linha('auto escolheria', `${auto.efetivo} (${auto.motivo})`);
}

/* ------------------------------------------------------------------ os backends medidos */

function criar(saidaDoMouse, constantesDoModelo) {
  return criarBackendWindows({
    saidaDoMouse,
    ...(constantesDoModelo === undefined ? {} : { constantesDoModelo }),
  });
}

const relativo = criar('relativo');
// O absoluto liga a consciência de DPI por monitor na thread: daqui em diante as leituras de cursor
// e de área virtual desta ferramenta são em pixel físico — iguais às de antes num sistema a 100 %.
const absoluto = criar('absoluto');
const compensadoDeFabrica = criar('compensado', CONSTANTES_MEDIDAS);
const backends = [relativo, absoluto, compensadoDeFabrica];

linha('saídas', backends.map((b) => `${b.saidaDoMouse?.pedido}→${b.saidaDoMouse?.efetivo}`).join(' · '));

// As métricas são lidas **depois** de o absoluto existir: ele liga a consciência de DPI por monitor
// nesta thread, e a régua tem de ser a mesma que ele usa.
const primario = { largura: api.metricaDoSistema(SM_CXSCREEN), altura: api.metricaDoSistema(SM_CYSCREEN) };
const virtual = {
  esquerda: api.metricaDoSistema(SM_XVIRTUALSCREEN),
  topo: api.metricaDoSistema(SM_YVIRTUALSCREEN),
  largura: api.metricaDoSistema(SM_CXVIRTUALSCREEN),
  altura: api.metricaDoSistema(SM_CYVIRTUALSCREEN),
};
const MONITORES = api.metricaDoSistema(80); // SM_CMONITORS
linha('primário', `${primario.largura}x${primario.altura}`);
linha(
  'área virtual',
  `${virtual.largura}x${virtual.altura} com origem em (${virtual.esquerda}, ${virtual.topo}) · ` +
    `${MONITORES} monitor(es)`,
);

const origem = relativo.lerPosicaoDoMouse();
linha('cursor antes', origem === undefined ? 'desconhecido' : `x=${origem.x} y=${origem.y}`);
const centro = { x: Math.floor(primario.largura / 2), y: Math.floor(primario.altura / 2) };

/**
 * O maior afastamento do centro lido na parte padrão (a que roda sem `--borda`). É o número que
 * sustenta a promessa de "perto do centro": cada bloco anda para um lado só entre duas leituras
 * (ou alterna ±1), então o extremo do gesto cai numa leitura.
 */
const afastamento = { x: 0, y: 0 };
let medindoAfastamento = true;

async function ler() {
  await esperar(FOLGA_DE_LEITURA_MS);
  const posicao = relativo.lerPosicaoDoMouse();
  if (posicao !== undefined && medindoAfastamento) {
    afastamento.x = Math.max(afastamento.x, Math.abs(posicao.x - centro.x));
    afastamento.y = Math.max(afastamento.y, Math.abs(posicao.y - centro.y));
  }
  return posicao;
}

/** Leva o cursor a um ponto conhecido e espera a mão (se houver) sair do caminho. */
async function posicionar(ponto) {
  relativo.posicionarMouse(ponto.x, ponto.y);
  await esperar(60);
}

/**
 * A tabela da spec numa saída: 40 × +1 px (de uma vez, como na ATI-007, e a 100 Hz, como o pipeline
 * manda) e 1 × −40 px. `interferencia` marca deslocamento vertical, que nenhum pedido daqui produz.
 */
async function tabela(backend, cadenciaMs) {
  await posicionar(centro);
  const inicio = await ler();
  for (let i = 0; i < 40; i += 1) {
    backend.moverMouseRelativo(1, 0);
    if (cadenciaMs > 0) await esperar(cadenciaMs);
  }
  const meio = await ler();
  backend.moverMouseRelativo(-40, 0);
  const fim = await ler();
  if (inicio === undefined || meio === undefined || fim === undefined) return undefined;
  return {
    ida: meio.x - inicio.x,
    volta: fim.x - meio.x,
    interferencia: meio.y !== inicio.y || fim.y !== inicio.y,
  };
}

async function medirTabela(rotulo, backend) {
  for (const [nome, cadencia] of [
    ['de uma vez', 0],
    ['a 100 Hz', 10],
  ]) {
    const idas = [];
    const voltas = [];
    let interferencias = 0;
    for (let r = 0; r < REPETICOES; r += 1) {
      const resultado = await tabela(backend, cadencia);
      if (resultado === undefined) continue;
      idas.push(resultado.ida);
      voltas.push(resultado.volta);
      if (resultado.interferencia) interferencias += 1;
    }
    linha(
      `${rotulo}`,
      `${nome.padEnd(10)} 40 × +1 → ${idas.map(comSinal).join('/')} px (mediana ${comSinal(mediana(idas))}) · ` +
        `1 × −40 → ${voltas.map(comSinal).join('/')} px (mediana ${comSinal(mediana(voltas))})` +
        (interferencias > 0 ? ` · interferência em ${interferencias}` : ''),
    );
  }
}

/**
 * Custo por evento: mil eventos alternando ±1 px, a partir do centro. O pedido líquido é zero, mas a
 * curva pode não devolver o +1 e o −1 iguais: a `deriva` diz quanto o cursor saiu do lugar.
 */
async function medirCusto(rotulo, backend) {
  await posicionar(centro);
  const antes = await ler();
  const relogio = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) backend.moverMouseRelativo(i % 2 === 0 ? 1 : -1, 0);
  const ms = Number(process.hrtime.bigint() - relogio) / 1e6;
  const depois = await ler();
  const deriva =
    antes === undefined || depois === undefined
      ? 'deriva desconhecida'
      : `deriva ${comSinal(depois.x - antes.x)}/${comSinal(depois.y - antes.y)} px`;
  linha(rotulo, `1000 eventos em ${ms.toFixed(1)} ms · ${((ms * 1000) / 1000).toFixed(1)} µs/evento · ${deriva}`);
}

/**
 * Ajusta as duas escalas do modelo ao ganho medido: para cada `a` (unidades da curva por mickey)
 * numa grade logarítmica, o melhor `s` (pixels por unidade de saída) sai fechado por mínimos
 * quadrados; fica o par de menor resíduo.
 */
function ajustar(medidas) {
  const xs = parametros.curvaX;
  const ys = parametros.curvaY;
  function curva(x) {
    if (x <= 0) return 0;
    let i = 1;
    while (i < xs.length - 1 && x > xs[i]) i += 1;
    return ys[i - 1] + ((x - xs[i - 1]) * (ys[i] - ys[i - 1])) / (xs[i] - xs[i - 1]);
  }
  let melhor;
  for (let k = 0; k <= 4000; k += 1) {
    const a = 0.005 * 400 ** (k / 4000); // 0,005 a 2
    let sgf = 0;
    let sff = 0;
    for (const { magnitude, ganho } of medidas) {
      const f = curva(a * magnitude) / magnitude;
      sgf += ganho * f;
      sff += f * f;
    }
    const s = sgf / sff;
    let residuo = 0;
    for (const { magnitude, ganho } of medidas) {
      const erro = ganho - (s * curva(a * magnitude)) / magnitude;
      residuo += erro * erro;
    }
    if (melhor === undefined || residuo < melhor.residuo) melhor = { a, s, residuo };
  }
  const escalaDoSistema = (parametros.dpi / 96) * multiplicadorDaVelocidade(parametros.velocidade, ligada);
  return {
    constantes: { entradaPorMickey: melhor.a, saidaA96Dpi: melhor.s / escalaDoSistema },
    residuo: Math.sqrt(melhor.residuo / medidas.length),
  };
}

if (!opcoes.has('--sem-espera')) {
  linha(
    'aviso',
    COM_BORDA
      ? 'vou mexer no cursor (SEM clicar), SALTANDO para a borda direita da área virtual e do primário ' +
          '(--borda), e devolvê-lo ao lugar — 3 s para cancelar com Ctrl+C'
      : 'vou mexer no cursor (SEM clicar) perto do centro do primário e devolvê-lo ao lugar — ' +
          '3 s para cancelar com Ctrl+C',
  );
  for (let restante = 3; restante > 0; restante -= 1) {
    linha('', `${restante}...`);
    await esperar(1000);
  }
}

const compensadosAjustados = [];
try {
  /* ------------------------------------------------ 1. varredura do ganho real do relativo */
  console.log('\n== varredura: ganho real do Windows por magnitude (relativo cru)');
  const medidas = [];
  for (const magnitude of MAGNITUDES) {
    const eventos = Math.max(1, Math.round(MICKEYS_POR_BLOCO / magnitude));
    await posicionar(centro);
    const a = await ler();
    for (let i = 0; i < eventos; i += 1) relativo.moverMouseRelativo(magnitude, 0);
    const b = await ler();
    for (let i = 0; i < eventos; i += 1) relativo.moverMouseRelativo(-magnitude, 0);
    const c = await ler();
    if (a === undefined || b === undefined || c === undefined) continue;
    const pedidos = eventos * magnitude;
    const ida = b.x - a.x;
    const volta = c.x - b.x;
    const ganho = (ida - volta) / (2 * pedidos);
    const interferencia = b.y !== a.y || c.y !== a.y;
    medidas.push({ magnitude, ganho });
    linha(
      `M=${magnitude}`,
      `${eventos} × ±${magnitude} · pedido ±${pedidos} · andou ${comSinal(ida)}/${comSinal(volta)} px · ` +
        `ganho ${ganho.toFixed(3)}` +
        (interferencia ? ' · interferência' : ''),
    );
  }

  const modeloDeFabrica = criarModeloDaAceleracao(parametros, CONSTANTES_MEDIDAS);
  if (modeloDeFabrica !== undefined && medidas.length > 0) {
    let somaDeQuadrados = 0;
    for (const { magnitude, ganho } of medidas) {
      somaDeQuadrados += (ganho - modeloDeFabrica.ganho(magnitude)) ** 2;
    }
    linha(
      'modelo fábrica',
      `entrada=${CONSTANTES_MEDIDAS.entradaPorMickey} saída=${CONSTANTES_MEDIDAS.saidaA96Dpi} · ` +
        `erro RMS do ganho ${Math.sqrt(somaDeQuadrados / medidas.length).toFixed(4)}`,
    );
  }
  let ajuste;
  if (curvaInversivel(parametros.curvaX, parametros.curvaY) && medidas.length >= 2 && ligada) {
    ajuste = ajustar(medidas);
    linha(
      'modelo ajustado',
      `entrada=${ajuste.constantes.entradaPorMickey.toFixed(5)} ` +
        `saída=${ajuste.constantes.saidaA96Dpi.toFixed(5)} · erro RMS do ganho ${ajuste.residuo.toFixed(4)}`,
    );
    const modeloAjustado = criarModeloDaAceleracao(parametros, ajuste.constantes);
    if (modeloAjustado !== undefined) {
      linha(
        'ajust. × medido',
        medidas
          .map(({ magnitude, ganho }) => `${magnitude}:${ganho.toFixed(2)}/${modeloAjustado.ganho(magnitude).toFixed(2)}`)
          .join(' '),
      );
    }
    const compensadoAjustado = criar('compensado', ajuste.constantes);
    compensadosAjustados.push(compensadoAjustado);
  }

  /* ------------------------------------------------ 2. a tabela da spec, em cada saída */
  console.log('\n== tabela da spec (pedido: 40 × +1 px e 1 × −40 px) — 3 repetições cada');
  await medirTabela('relativo', relativo);
  await medirTabela('compens. fábr.', compensadoDeFabrica);
  for (const compensado of compensadosAjustados) await medirTabela('compens. ajust.', compensado);
  await medirTabela('absoluto', absoluto);

  /* ------------------------------------------------ 3. a régua do absoluto, pixel a pixel */
  console.log('\n== absoluto: cada pixel alcançado');
  {
    await posicionar(centro);
    let divergencias = 0;
    let passos = 0;
    for (const [dx, dy] of [
      [1, 0], [1, 0], [1, 0], [0, 1], [0, 1], [-1, 0], [0, -1], [7, -3], [-13, 11], [25, 25], [-25, -25],
      [1, 1], [-1, -1], [-7, 3], [13, -11],
    ]) {
      const antes = await ler();
      absoluto.moverMouseRelativo(dx, dy);
      const depois = await ler();
      passos += 1;
      if (antes === undefined || depois === undefined) continue;
      if (depois.x - antes.x !== dx || depois.y - antes.y !== dy) divergencias += 1;
    }
    linha('régua', `${passos} passos de −25 a +25 px nos dois eixos · ${divergencias} divergência(s)`);
  }

  /* ------------------------------------------------ 4. custo por evento */
  console.log('\n== custo por evento (1000 eventos alternando ±1 px, a partir do centro)');
  await medirCusto('relativo', relativo);
  await medirCusto('absoluto', absoluto);
  await medirCusto('compensado', compensadoDeFabrica);

  // Fim da parte padrão: daqui para baixo, só com `--borda`, o cursor salta para longe do centro.
  medindoAfastamento = false;
  console.log('');
  linha(
    'afastamento',
    `o cursor ficou a até ${afastamento.x} px (x) e ${afastamento.y} px (y) do centro do primário ` +
      `(${centro.x}, ${centro.y}) na parte padrão`,
  );

  /* ------------------------------------------------ 5. borda e travessia (só com --borda) */
  console.log('\n== absoluto: a borda e a travessia de monitor');
  if (!COM_BORDA) {
    linha('borda', 'pulada: salta para a borda direita da área virtual — só com --borda');
    linha('travessia', 'pulada: salta para a borda direita do primário — só com --borda');
  } else {
    // Borda direita da ÁREA VIRTUAL, na altura do centro do primário: com um monitor só, é a borda
    // do primário; com um segundo monitor à direita (a bancada do projeto: retrato, área virtual
    // 3000×1920), é a borda direita do outro monitor. 50 px pedidos além da borda, depois 10 de volta
    // — a volta tem de partir da borda, sem resto acumulado. Se nenhum monitor cobrir essa altura na
    // borda, o Windows encosta o cursor no mais próximo e a linha pode dizer GRUDOU sem ser defeito.
    await posicionar({ x: virtual.esquerda + virtual.largura - 10, y: centro.y });
    const antesDaBorda = await ler();
    absoluto.moverMouseRelativo(50, 0);
    const naBorda = await ler();
    absoluto.moverMouseRelativo(-10, 0);
    const depoisDaBorda = await ler();
    if (antesDaBorda !== undefined && naBorda !== undefined && depoisDaBorda !== undefined) {
      linha(
        'borda',
        `de x=${antesDaBorda.x}: +50 → x=${naBorda.x} (borda) · −10 → x=${depoisDaBorda.x} ` +
          `(${depoisDaBorda.x === naBorda.x - 10 ? 'não grudou' : 'GRUDOU'})`,
      );
    }

    if (MONITORES > 1) {
      // O monitor da direita, se existir: a travessia sai 5 px antes da borda direita do primário, na
      // altura do centro, e anda 10 px para fora dele.
      await posicionar({ x: primario.largura - 5, y: centro.y });
      const antes = await ler();
      absoluto.moverMouseRelativo(10, 0);
      const depois = await ler();
      absoluto.moverMouseRelativo(-10, 0);
      const volta = await ler();
      if (antes !== undefined && depois !== undefined && volta !== undefined) {
        linha(
          'travessia',
          `de x=${antes.x}: +10 → x=${depois.x} (${depois.x >= primario.largura ? 'ATRAVESSOU' : 'parou na borda do primário'}) ` +
            `· −10 → x=${volta.x}`,
        );
      }
    } else {
      linha('travessia', `pulada: ${MONITORES} monitor ligado agora (a lógica está nos testes, contra a API de mentira)`);
    }
  }
} finally {
  // Aconteça o que acontecer: nada foi apertado, mas o soltarTudo é a regra; e o cursor volta.
  for (const backend of [...backends, ...compensadosAjustados]) backend.soltarTudo();
  if (origem !== undefined) relativo.posicionarMouse(origem.x, origem.y);
  const final = relativo.lerPosicaoDoMouse();
  console.log('');
  linha(
    'cursor depois',
    final === undefined
      ? 'desconhecido'
      : `x=${final.x} y=${final.y}` +
          (origem !== undefined && final.x === origem.x && final.y === origem.y
            ? ' (restaurado)'
            : ' (NÃO bateu com a origem)'),
  );
  const presos = [...backends, ...compensadosAjustados].reduce((soma, b) => soma + b.pressionados(), 0);
  linha('preso no fim', String(presos));
  for (const [nome, backend] of [
    ['relativo', relativo],
    ['absoluto', absoluto],
    ['compens.', compensadoDeFabrica],
  ]) {
    const c = backend.contadores;
    linha(
      `cont. ${nome}`,
      `enviados=${c.eventosEnviados} recusados=${c.eventosRecusados} erroDeChamada=${c.chamadasComErro} ` +
        `nulos=${c.pedidosNulos} ultimoCodigoDeErro=${c.ultimoCodigoDeErro}`,
    );
  }
  const depois = api.lerParametrosDoPonteiro();
  linha(
    'configuração',
    depois !== undefined &&
      depois.aceleracao === parametros.aceleracao &&
      depois.velocidade === parametros.velocidade &&
      depois.limiar1 === parametros.limiar1 &&
      depois.limiar2 === parametros.limiar2
      ? 'inalterada (lida de novo no fim: mesma aceleração, limiares e velocidade)'
      : 'MUDOU durante a bancada — confira',
  );
  for (const backend of [...backends, ...compensadosAjustados]) backend.encerrar();
}
