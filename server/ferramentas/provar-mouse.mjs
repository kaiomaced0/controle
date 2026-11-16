/**
 * Prova do `SendInput` — o único lugar do projeto que mexe no cursor de verdade sem ser o
 * servidor rodando.
 *
 * Por que existe: `npm test` fala com a dubla, de propósito (tem gente trabalhando nesta
 * máquina). A dubla prova o formato do quadro e a lógica de estado; ela não prova que a
 * `user32.dll` aceitou os bytes. Esta ferramenta prova — com número, e devolvendo o cursor ao
 * lugar de onde ele saiu.
 *
 * ```powershell
 * # a partir de server/
 * $env:CONTROLE_PROVAR_MOUSE = "1"; node --import tsx ferramentas\provar-mouse.mjs
 * ```
 *
 * Sem `CONTROLE_PROVAR_MOUSE=1` ela **não roda**: um comando que rouba o mouse não pode ser
 * disparado por engano.
 *
 * O padrão anda pouco (40 px para a direita e de volta) e restaura a posição no fim. Clique,
 * rolagem e tecla são **opcionais**, cada um atrás da própria opção, porque cada um age sobre a
 * janela que estiver em primeiro plano:
 *
 * | Opção | O que faz | Risco |
 * |---|---|---|
 * | (padrão) | movimento relativo e volta | nenhum além do cursor andar |
 * | `--clicar` | esquerdo, direito e meio (aperta e solta) | **clica de verdade no que estiver embaixo** |
 * | `--rolar` | um entalhe para baixo e um para cima | rola a janela em foco |
 * | `--tecla` | Shift esquerdo apertado e solto por `soltarTudo()` | nenhum: Shift sozinho não digita |
 *
 * Não é código de produção e não entra no `dist/` — `.mjs` fora de `src/`, como a
 * `sonda-encerramento.mjs`.
 */

import { setTimeout as esperar } from 'node:timers/promises';
import { conferirEstruturas } from '../src/saida/windows/api.ts';
import { criarBackendDeEntrada } from '../src/saida/escolha.ts';
import { centralizarCursor } from '../src/saida/centralizar.ts';

const VARIAVEL = 'CONTROLE_PROVAR_MOUSE';
const PASSOS_DE_UM_PIXEL = 40;
const EVENTOS_DE_CUSTO = 1000;
const SCANCODE_SHIFT_ESQUERDO = 0x2a;

const opcoes = new Set(process.argv.slice(2));

if (opcoes.has('--ajuda')) {
  console.log(`prova do SendInput (ATI-007)

uso (a partir de server/):
  $env:${VARIAVEL} = "1"; node --import tsx ferramentas\\provar-mouse.mjs [opções]

opções:
  --clicar         aperta e solta os três botões  ATENÇÃO: clica no que estiver embaixo do cursor
  --rolar          um entalhe para baixo e um para cima na janela em foco
  --tecla          aperta o Shift esquerdo e solta pelo soltarTudo() (prova a rede de segurança)
  --centralizar    leva o cursor ao centro da tela antes de restaurar a posição
  --sem-espera     não faz a contagem regressiva de 3 s
  --ajuda          mostra isto

o padrão só move o cursor 40 px para a direita e de volta, e restaura a posição no fim.`);
  process.exit(0);
}

if (process.env[VARIAVEL] !== '1') {
  console.error(
    `esta ferramenta mexe no cursor de verdade e só roda com ${VARIAVEL}=1.\n` +
      `  PowerShell: $env:${VARIAVEL} = "1"; node --import tsx ferramentas\\provar-mouse.mjs\n` +
      '  (--ajuda lista as opções)',
  );
  process.exit(1);
}

function linha(rotulo, texto) {
  console.log(`${rotulo.padEnd(14)}${texto}`);
}

/** Diferença entre duas leituras de cursor, formatada com sinal. */
function deslocamento(antes, depois) {
  if (antes === undefined || depois === undefined) return 'posição desconhecida';
  const dx = depois.x - antes.x;
  const dy = depois.y - antes.y;
  return `dx=${dx >= 0 ? '+' : ''}${dx} dy=${dy >= 0 ? '+' : ''}${dy}`;
}

console.log('controle · prova do SendInput (ATI-007)');
linha('plataforma', `${process.platform} ${process.arch} · node ${process.versions.node}`);

const conferencias = conferirEstruturas();
const divergentes = conferencias.filter((item) => item.esperado !== item.encontrado);
const tamanhoDoInput = conferencias.find((item) => item.rotulo === 'sizeof(INPUT)');
linha(
  'estruturas',
  `sizeof(INPUT)=${tamanhoDoInput?.encontrado} · ${conferencias.length} conferências, ` +
    `${divergentes.length} divergência(s)`,
);
for (const item of divergentes) {
  linha('  DIVERGE', `${item.rotulo}: esperado ${item.esperado}, koffi diz ${item.encontrado}`);
}

const backend = criarBackendDeEntrada();
linha('backend', backend.nome);

const tela = backend.tamanhoDaTela();
linha('tela', tela === undefined ? 'desconhecida' : `${tela.largura}x${tela.altura}`);

const origem = backend.lerPosicaoDoMouse();
linha('cursor antes', origem === undefined ? 'desconhecido' : `x=${origem.x} y=${origem.y}`);

if (!opcoes.has('--sem-espera')) {
  const avisos = ['vou mexer no cursor'];
  if (opcoes.has('--clicar')) avisos.push('E CLICAR onde ele estiver');
  if (opcoes.has('--rolar')) avisos.push('e rolar a janela em foco');
  linha('aviso', `${avisos.join(' ')} — 3 s para cancelar com Ctrl+C`);
  for (let restante = 3; restante > 0; restante -= 1) {
    // Num terminal a contagem reescreve a mesma linha; encanada para arquivo, o `\r` viraria
    // uma linha só e ilegível — e é justamente a saída encanada que vai parar no relatório.
    if (process.stdout.isTTY) process.stdout.write(`\r              ${restante}...   `);
    else linha('', `${restante}...`);
    await esperar(1000);
  }
  if (process.stdout.isTTY) process.stdout.write('\r                       \r');
}

try {
  /* ---------------------------------------------- movimento relativo, em passos de 1 px */
  const antesDoIda = backend.lerPosicaoDoMouse();
  const relogioIda = process.hrtime.bigint();
  for (let i = 0; i < PASSOS_DE_UM_PIXEL; i += 1) backend.moverMouseRelativo(1, 0);
  const duracaoIda = Number(process.hrtime.bigint() - relogioIda) / 1e6;
  const depoisDaIda = backend.lerPosicaoDoMouse();
  linha(
    'ida',
    `${PASSOS_DE_UM_PIXEL} eventos de +1 px · pedido dx=+${PASSOS_DE_UM_PIXEL} · ` +
      `medido ${deslocamento(antesDoIda, depoisDaIda)} · ${duracaoIda.toFixed(2)} ms`,
  );

  /* ---------------------------------------------- movimento relativo, um evento só */
  const relogioVolta = process.hrtime.bigint();
  backend.moverMouseRelativo(-PASSOS_DE_UM_PIXEL, 0);
  const duracaoVolta = Number(process.hrtime.bigint() - relogioVolta) / 1e6;
  const depoisDaVolta = backend.lerPosicaoDoMouse();
  linha(
    'volta',
    `1 evento de -${PASSOS_DE_UM_PIXEL} px · ` +
      `medido ${deslocamento(depoisDaIda, depoisDaVolta)} · ${duracaoVolta.toFixed(3)} ms`,
  );

  /* ---------------------------------------------- custo por evento, com movimento nulo */
  // Alterna +1 e -1: mil eventos de verdade, deslocamento líquido de zero. É a medida que
  // interessa para o caminho quente (100 Hz), sem passear com o cursor pela tela.
  const relogioCusto = process.hrtime.bigint();
  for (let i = 0; i < EVENTOS_DE_CUSTO; i += 1) backend.moverMouseRelativo(i % 2 === 0 ? 1 : -1, 0);
  const duracaoCusto = Number(process.hrtime.bigint() - relogioCusto) / 1e6;
  linha(
    'custo',
    `${EVENTOS_DE_CUSTO} eventos em ${duracaoCusto.toFixed(1)} ms · ` +
      `${((duracaoCusto * 1000) / EVENTOS_DE_CUSTO).toFixed(1)} µs/evento · ` +
      `teto teórico ${Math.round(EVENTOS_DE_CUSTO / (duracaoCusto / 1000)).toLocaleString('pt-BR')} eventos/s`,
  );

  /* ---------------------------------------------- opcionais */
  if (opcoes.has('--clicar')) {
    for (const botao of ['esquerdo', 'direito', 'meio']) {
      backend.botaoMouse(botao, true);
      await esperar(80);
      backend.botaoMouse(botao, false);
      await esperar(200);
    }
    linha('clique', 'esquerdo, direito e meio: aperto e soltura separados');
  }

  if (opcoes.has('--rolar')) {
    backend.scroll(-1, 0);
    await esperar(200);
    backend.scroll(1, 0);
    linha('rolagem', 'um entalhe para baixo e um para cima (WHEEL_DELTA = 120)');
  }

  if (opcoes.has('--tecla')) {
    backend.tecla(SCANCODE_SHIFT_ESQUERDO, true);
    const presoDepoisDoAperto = backend.pressionados();
    await esperar(150);
    // De propósito: **não** solta na mão. Quem solta é o `soltarTudo()`, que é o caminho que o
    // encerramento usa — é essa a rede de segurança que interessa provar aqui.
    backend.soltarTudo();
    linha(
      'tecla',
      `Shift esquerdo (scancode 0x2A) apertado (presos=${presoDepoisDoAperto}) e solto por ` +
        `soltarTudo() (presos=${backend.pressionados()})`,
    );
  }

  if (opcoes.has('--centralizar')) {
    const centro = centralizarCursor(backend);
    linha(
      'centralizar',
      centro === undefined
        ? 'sem resolução conhecida: nada foi movido'
        : `SetCursorPos para o centro (${centro.x}, ${centro.y})`,
    );
    await esperar(300);
  }
} finally {
  // Aconteça o que acontecer: solta o que estiver preso e devolve o cursor de onde ele saiu.
  backend.soltarTudo();
  if (origem !== undefined) backend.posicionarMouse(origem.x, origem.y);
  const final = backend.lerPosicaoDoMouse();
  linha(
    'cursor depois',
    final === undefined
      ? 'desconhecido'
      : `x=${final.x} y=${final.y}` +
          (origem !== undefined && final.x === origem.x && final.y === origem.y
            ? ' (restaurado)'
            : ' (NÃO bateu com a origem)'),
  );
  linha('preso no fim', String(backend.pressionados()));
  const c = backend.contadores;
  linha(
    'contadores',
    `enviados=${c.eventosEnviados} recusados=${c.eventosRecusados} ` +
      `erroDeChamada=${c.chamadasComErro} invalidos=${c.pedidosInvalidos} ` +
      `nulos=${c.pedidosNulos} redundantes=${c.pedidosRedundantes} ` +
      `soltasDeSeguranca=${c.soltasDeSeguranca} ultimoCodigoDeErro=${c.ultimoCodigoDeErro}`,
  );
  backend.encerrar();
}
