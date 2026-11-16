/**
 * Prova do pipeline de movimento de ponta a ponta, **com o cursor de verdade** (ATI-008).
 *
 * Por que existe: `npm test` fala com a dubla, de propósito (tem gente trabalhando nesta máquina),
 * e o servidor sobe com `movimento=ensaio`, que mede e não move nada. As duas coisas juntas provam
 * a cadeia inteira menos o último centímetro — que a `user32.dll` aceitou os pixels que a cadeia
 * calculou. Esta ferramenta prova esse centímetro, com número e devolvendo o cursor ao lugar.
 *
 * O caminho exercitado é o mesmo do celular na mesa: simulador da ATI-023 → WebSocket de verdade →
 * codec de `src/protocolo/` → pipeline de `src/movimento/` → `SendInput` de `src/saida/windows/`.
 *
 * ```powershell
 * # a partir de server/
 * $env:CONTROLE_PROVAR_PIPELINE = "1"; node --import tsx ferramentas\provar-pipeline.mjs
 * ```
 *
 * Sem `CONTROLE_PROVAR_PIPELINE=1` ela **não roda**: um comando que rouba o mouse não pode ser
 * disparado por engano.
 *
 * O padrão é pequeno de propósito — 4° de rotação a 10 px/grau, ou seja ~40 px de pedido — e a
 * posição do cursor é restaurada no fim. `--graus` e `--sens` mudam o tamanho do gesto.
 *
 * ⚠️ O deslocamento **medido** não bate com o pedido, e isso não é defeito da cadeia: a aceleração
 * de ponteiro do Windows reescala movimento relativo (ATI-007 mediu 40 eventos de +1 px virando
 * 25 px). Por isso a medição é feita lendo o cursor (`GetCursorPos`), nunca somando o que foi
 * pedido.
 *
 * Não é código de produção e não entra no `dist/` — `.mjs` fora de `src/`, como a
 * `provar-mouse.mjs`.
 */

import { setTimeout as esperar } from 'node:timers/promises';
import { executarBancada } from '../src/cli/simulador/indice.ts';
import { criarPipelineDeMovimento } from '../src/movimento/indice.ts';
import { centralizarCursor } from '../src/saida/centralizar.ts';
import { criarBackendDeEntrada } from '../src/saida/escolha.ts';

const VARIAVEL = 'CONTROLE_PROVAR_PIPELINE';
const GRAUS_PADRAO = 4;
const SENS_PADRAO = 10;
/** 4 °/s: o giro de 4° leva 1 s e rende ~100 amostras, como um gesto lento de verdade. */
const VELOCIDADE_PADRAO = 4;

const argumentos = process.argv.slice(2);
const opcoes = new Set(argumentos.filter((item) => !item.includes('=')));

/** Lê `--chave=valor` da linha de comando. */
function numero(chave, padrao) {
  const bruto = argumentos.find((item) => item.startsWith(`${chave}=`));
  if (bruto === undefined) return padrao;
  const valor = Number(bruto.slice(chave.length + 1));
  return Number.isFinite(valor) && valor !== 0 ? valor : padrao;
}

if (opcoes.has('--ajuda')) {
  console.log(`prova do pipeline de movimento (ATI-008)

uso (a partir de server/):
  $env:${VARIAVEL} = "1"; node --import tsx ferramentas\\provar-pipeline.mjs [opções]

opções:
  --graus=N        quantos graus o aparelho de mentira gira (padrão ${GRAUS_PADRAO})
  --velocidade=N   graus por segundo (padrão ${VELOCIDADE_PADRAO}) — é ela que decide quantas amostras
  --sens=N         sensibilidade em pixels por grau (padrão ${SENS_PADRAO})
  --eixo=x|y|z     eixo do giro (padrão y — o horizontal em retrato)
  --sem-centro     não leva o cursor ao centro da tela antes do gesto
  --sem-espera     não faz a contagem regressiva de 3 s
  --ajuda          mostra isto

o padrão move o cursor uns 40 px e restaura a posição no fim.`);
  process.exit(0);
}

if (process.env[VARIAVEL] !== '1') {
  console.error(
    `esta ferramenta mexe no cursor de verdade e só roda com ${VARIAVEL}=1.\n` +
      `  PowerShell: $env:${VARIAVEL} = "1"; node --import tsx ferramentas\\provar-pipeline.mjs\n` +
      '  (--ajuda lista as opções)',
  );
  process.exit(1);
}

function linha(rotulo, texto) {
  console.log(`${rotulo.padEnd(16)}${texto}`);
}

function deslocamento(antes, depois) {
  if (antes === undefined || depois === undefined) return 'posição desconhecida';
  const dx = depois.x - antes.x;
  const dy = depois.y - antes.y;
  return `dx=${dx >= 0 ? '+' : ''}${dx} dy=${dy >= 0 ? '+' : ''}${dy}`;
}

const graus = numero('--graus', GRAUS_PADRAO);
const sens = numero('--sens', SENS_PADRAO);
const velocidadeGrausPorS = numero('--velocidade', VELOCIDADE_PADRAO);
const eixoBruto = argumentos.find((item) => item.startsWith('--eixo='))?.slice(7);
const eixo = eixoBruto === 'x' || eixoBruto === 'y' || eixoBruto === 'z' ? eixoBruto : 'y';

console.log('controle · prova do pipeline de movimento (ATI-008)');
linha('plataforma', `${process.platform} ${process.arch} · node ${process.versions.node}`);

const backend = criarBackendDeEntrada();
linha('backend', backend.nome);
const tela = backend.tamanhoDaTela();
linha('tela', tela === undefined ? 'desconhecida' : `${tela.largura}x${tela.altura}`);

const origem = backend.lerPosicaoDoMouse();
linha('cursor antes', origem === undefined ? 'desconhecido' : `x=${origem.x} y=${origem.y}`);

const pipeline = criarPipelineDeMovimento({
  destino: backend,
  ajustes: { sensXPixelsPorGrau: sens, sensYPixelsPorGrau: sens },
});
linha(
  'gesto',
  `${graus}° no eixo ${eixo} a ${velocidadeGrausPorS} °/s · ${sens} px/grau · pedido ~${Math.round(graus * sens)} px`,
);
linha('ajustes', `zona morta ${pipeline.ajustes.zonaMortaGrausPorS} °/s · suavizacao ${pipeline.ajustes.suavizacao}`);

if (!opcoes.has('--sem-espera')) {
  linha('aviso', 'vou mexer no cursor de verdade — 3 s para cancelar com Ctrl+C');
  for (let restante = 3; restante > 0; restante -= 1) {
    if (process.stdout.isTTY) process.stdout.write(`\r                ${restante}...   `);
    else linha('', `${restante}...`);
    await esperar(1000);
  }
  if (process.stdout.isTTY) process.stdout.write('\r                         \r');
}

try {
  // O centro dá espaço para o gesto nos dois sentidos: encostado na borda, o cursor para e a
  // medição diria que a cadeia não moveu nada.
  if (!opcoes.has('--sem-centro')) {
    const centro = centralizarCursor(backend);
    linha('centralizar', centro === undefined ? 'sem resolução conhecida' : `x=${centro.x} y=${centro.y}`);
  }

  const antesDoGesto = backend.lerPosicaoDoMouse();
  const relogio = process.hrtime.bigint();
  const resultado = await executarBancada({
    padrao: { padrao: 'rotacao', graus, eixo, taxaHz: 100, velocidadeGrausPorS },
    aoReceberPacote: (pacote) => {
      pipeline.processar(pacote);
    },
  });
  const duracaoMs = Number(process.hrtime.bigint() - relogio) / 1e6;
  const depoisDoGesto = backend.lerPosicaoDoMouse();

  linha('sessão', `${resultado.resumo.desfecho} · ${resultado.medidas?.pacotesRecebidos} pacotes · ${duracaoMs.toFixed(0)} ms`);
  linha(
    'pipeline',
    `amostras=${pipeline.contadores.amostrasRecebidas} aplicadas=${pipeline.contadores.amostrasAplicadas} ` +
      `pedido dx=${pipeline.contadores.pixelsX} dy=${pipeline.contadores.pixelsY}`,
  );
  linha(
    'descartes',
    `dt=${pipeline.contadores.descartadasPorDt} ordem=${pipeline.contadores.descartadasPorOrdem} ` +
      `atraso=${pipeline.contadores.descartadasPorAtraso} leitura=${pipeline.contadores.descartadasPorLeituraInvalida} ` +
      `picos=${pipeline.contadores.limitadasPorPico}`,
  );
  linha('cursor medido', deslocamento(antesDoGesto, depoisDoGesto));
  linha(
    'nota',
    'medido ≠ pedido é a aceleração de ponteiro do Windows (ARQUITETURA.md, seção 2.3)',
  );
} finally {
  // Devolver o cursor é obrigação, não cortesia: quem rodou isto estava usando a máquina.
  if (origem !== undefined) backend.posicionarMouse(origem.x, origem.y);
  const fim = backend.lerPosicaoDoMouse();
  linha('cursor depois', fim === undefined ? 'desconhecido' : `x=${fim.x} y=${fim.y} (restaurado)`);
  linha('preso no fim', String(backend.pressionados()));
  linha(
    'contadores',
    `enviados=${backend.contadores.eventosEnviados} recusados=${backend.contadores.eventosRecusados} ` +
      `erroDeChamada=${backend.contadores.chamadasComErro} ultimoCodigoDeErro=${backend.contadores.ultimoCodigoDeErro}`,
  );
  backend.encerrar();
}
