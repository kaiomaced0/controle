/**
 * `npm run telemetria` — o PC mostrando, ao vivo, o que o celular está mandando (ATI-006).
 *
 * Sobe **o mesmo servidor** do `npm run dev` — a mesma montagem (`montagem.ts`, ATI-027): backend
 * de entrada, pipeline de movimento, comandos e mapeador de ações, pela mesma configuração — e
 * desenha a cada ~100 ms um painel com os três eixos do giroscópio, o que a cadeia fez com eles
 * (pixels, cliques, bias, recalibração, ajustes), a taxa realmente medida, o jitter do `dt`, o RTT
 * do canal e os contadores de qualidade da tabela do PROTOCOLO.md, seção 7.
 *
 * ```bash
 * npm run telemetria                       # painel até o Ctrl+C
 * npm run telemetria -- --duracao 60       # 60 s e sai sozinho (verificação automática)
 * npm run telemetria > painel.txt          # sem terminal, sai em blocos de texto puro
 * ```
 *
 * Do outro lado, em outro terminal:
 *
 * ```bash
 * npm run simulador -- --padrao rotacao --graus 90 --eixo y
 * ```
 *
 * ## Para onde o movimento vai
 *
 * Pela mesma chave do `npm run dev`: `CONTROLE_MOVIMENTO=ensaio` (o padrão) roda a cadeia inteira
 * e **não** mexe no cursor nem clica — o painel mostra os pixels que teriam saído; `sistema` liga o
 * `SendInput` de verdade; `desligado` nem monta o pipeline. A primeira linha do painel diz qual dos
 * três está valendo. Até a ATI-027 este modo subia só o transporte, e quem o abria via os eixos
 * mexerem e o cursor parado, sem explicação nenhuma — testemunha que engana.
 *
 * `CONTROLE_GRAVACAO` também vale aqui, pelo mesmo motivo: a configuração é uma só.
 *
 * Divisão de trabalho: neste arquivo ficam a linha de comando, o painel e o relógio dele; a
 * montagem do servidor é de `montagem.ts`. O que vira texto e o que vai para a tela moram em
 * `telemetria/`.
 *
 * ⚠️ CAMINHO QUENTE no gancho de pacote que este modo entrega à montagem: roda uma vez por
 * pacote, 100 vezes por segundo, depois de a cadeia inteira ter visto o pacote. Ele só escreve três
 * números num objeto que já existe — nada de alocação, nada de log (regra 2 do CLAUDE.md). Quem
 * monta texto é o painel, na frequência da interface.
 */

import { realpathSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  ErroDeConfiguracao,
  VARIAVEIS_DE_AMBIENTE,
  carregarConfiguracao,
  type ConfiguracaoServidor,
  type OpcoesDeCarga,
} from '../config.js';
import { ROTA_DA_PAGINA } from '../diagnostico/indice.js';
import { instalarEncerramento } from '../encerramento.js';
import { criarRegistrador, ehNivelLog, type NivelLog } from '../log.js';
import { descreverDestinos, montarServidor, prepararPartida } from '../montagem.js';
import type { RepositorioDeBias } from '../movimento/indice.js';
import { TIPO_MOVIMENTO } from '../protocolo/indice.js';
import type { BackendDeEntrada } from '../saida/indice.js';
import type { EnderecoDoTransporte } from '../transporte/indice.js';
import {
  criarMedidorDeCpu,
  criarPainel,
  larguraDeTrabalho,
  montarQuadro,
  type LeituraDosEixos,
} from './telemetria/indice.js';

/** Período padrão de atualização do painel — os ~10 Hz que a ATI-006 pede. */
export const INTERVALO_PADRAO_MS = 100;
/** Abaixo disto o painel gastaria mais CPU do que o fluxo que ele está medindo. */
export const INTERVALO_MINIMO_MS = 20;
/** Acima disto o painel deixa de parecer "ao vivo". */
export const INTERVALO_MAXIMO_MS = 5000;
/**
 * Teto do `--duracao`, em segundos (24 h).
 *
 * Não é gosto: o `setTimeout` guarda o atraso num u32, e acima de ~24,8 dias ele estoura, dispara
 * em 1 ms e o painel encerra na hora dizendo `duração de X ms atingida` — mensagem que mentiria
 * sobre o que aconteceu. Um dia inteiro já é mais do que qualquer bancada precisa; quem quiser
 * mais tempo roda sem `--duracao` e encerra com Ctrl+C.
 */
export const DURACAO_MAXIMA_S = 24 * 60 * 60;

/**
 * Faixa aceita por `--colunas`, que finge um terminal de largura fixa.
 *
 * Existe pelo mesmo motivo de `--duracao` e `--ansi`: com a saída encanada para arquivo não há
 * terminal, `process.stdout.columns` é `undefined`, e sem isto não daria para **verificar** o
 * corte de largura — só afirmar que ele existe. Abaixo de 20 colunas não sobra rótulo nenhum.
 */
export const COLUNAS_MINIMAS = 20;
export const COLUNAS_MAXIMAS = 500;

/** Pedido da linha de comando que não dá para atender. Nunca acontece no caminho quente. */
export class ErroDaTelemetria extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroDaTelemetria';
  }
}

interface DefinicaoDeOpcao {
  readonly nome: string;
  /** `flag` não leva valor; as outras exigem um. */
  readonly tipo: 'texto' | 'numero' | 'flag';
  readonly valor?: string;
  readonly padrao: string;
  readonly descricao: string;
}

/** Tabela **única** das opções: dela saem a validação e o texto do `--ajuda`. */
export const OPCOES: readonly DefinicaoDeOpcao[] = [
  {
    nome: 'intervalo',
    tipo: 'numero',
    valor: 'ms',
    padrao: String(INTERVALO_PADRAO_MS),
    descricao: `período de atualização do painel (${INTERVALO_MINIMO_MS}–${INTERVALO_MAXIMO_MS})`,
  },
  {
    nome: 'duracao',
    tipo: 'numero',
    valor: 'segundos',
    padrao: '0 (até o Ctrl+C)',
    descricao: `encerra sozinho depois deste tempo (0–${DURACAO_MAXIMA_S}) — permite verificar sem apertar tecla`,
  },
  {
    nome: 'sem-ansi',
    tipo: 'flag',
    padrao: 'automático',
    descricao: 'não usa escapes de terminal (já é o padrão quando a saída não é um terminal)',
  },
  {
    nome: 'ansi',
    tipo: 'flag',
    padrao: 'automático',
    descricao: 'usa escapes de terminal mesmo com a saída encanada — serve para conferir o painel',
  },
  {
    nome: 'colunas',
    tipo: 'numero',
    valor: 'colunas',
    padrao: 'as do terminal',
    descricao: `finge um terminal desta largura (${COLUNAS_MINIMAS}–${COLUNAS_MAXIMAS}) — serve para conferir o corte`,
  },
  {
    nome: 'nivel-log',
    tipo: 'texto',
    valor: 'erro|aviso|info|depuracao',
    padrao: 'da configuração',
    descricao: 'verbosidade do log, que sai acima do painel',
  },
  { nome: 'ajuda', tipo: 'flag', padrao: '—', descricao: 'mostra esta ajuda e sai' },
];

const DEFINICOES = new Map(OPCOES.map((opcao) => [opcao.nome, opcao]));

/** Texto do `--ajuda`, montado da tabela acima. */
export function montarAjuda(): string {
  const linhas: string[] = [
    'telemetria ao vivo — mostra no PC o que o celular está mandando e o que o servidor faz com isso',
    '',
    'uso: npm run telemetria -- [opções]',
    '',
    'o servidor é o mesmo do npm run dev, montado pela mesma configuração: no padrão',
    `(${VARIAVEIS_DE_AMBIENTE.movimento}=ensaio) o cursor NÃO se mexe e o painel mostra os pixels que`,
    `teriam saído; com ${VARIAVEIS_DE_AMBIENTE.movimento}=sistema o cursor anda de verdade.`,
    '',
    'opções:',
  ];
  const largura = OPCOES.reduce(
    (maior, opcao) => Math.max(maior, `--${opcao.nome} ${opcao.valor ?? ''}`.trim().length),
    0,
  );
  for (const opcao of OPCOES) {
    const chamada = `--${opcao.nome}${opcao.valor === undefined ? '' : ` <${opcao.valor}>`}`;
    linhas.push(`  ${chamada.padEnd(largura + 2)}  ${opcao.descricao} [padrão: ${opcao.padrao}]`);
  }
  linhas.push(
    '',
    'com o painel de pé, mande movimento de outro terminal:',
    '  npm run simulador -- --padrao rotacao --graus 90 --eixo y',
    '  npm run simulador -- --padrao parado --duracao 60',
    '',
  );
  return linhas.join('\n');
}

/** Argumentos já separados em `nome → valor`. `true` é flag presente. */
export type ArgumentosLidos = ReadonlyMap<string, string | true>;

/**
 * Separa `--chave valor`, `--chave=valor` e `--flag`.
 *
 * @throws {ErroDaTelemetria} opção desconhecida, valor faltando ou argumento solto.
 */
export function lerArgumentos(argumentos: readonly string[]): ArgumentosLidos {
  const lidos = new Map<string, string | true>();

  for (let indice = 0; indice < argumentos.length; indice += 1) {
    const bruto = argumentos[indice] ?? '';
    if (!bruto.startsWith('--')) {
      throw new ErroDaTelemetria(
        `não entendi "${bruto}": as opções vêm nomeadas, como --duracao 60 (veja --ajuda)`,
      );
    }

    const igual = bruto.indexOf('=');
    const nome = (igual === -1 ? bruto.slice(2) : bruto.slice(2, igual)).trim();
    const definicao = DEFINICOES.get(nome);
    if (definicao === undefined) {
      throw new ErroDaTelemetria(`opção desconhecida "--${nome}" (veja --ajuda)`);
    }

    if (definicao.tipo === 'flag') {
      if (igual !== -1) throw new ErroDaTelemetria(`--${nome} não leva valor`);
      lidos.set(nome, true);
      continue;
    }

    let valor: string;
    if (igual !== -1) {
      valor = bruto.slice(igual + 1);
    } else {
      const proximo = argumentos[indice + 1];
      if (proximo === undefined || proximo.startsWith('--')) {
        throw new ErroDaTelemetria(`--${nome} precisa de um valor (veja --ajuda)`);
      }
      valor = proximo;
      indice += 1;
    }
    if (valor === '') throw new ErroDaTelemetria(`--${nome} precisa de um valor não vazio`);
    lidos.set(nome, valor);
  }

  return lidos;
}

function numero(lidos: ArgumentosLidos, nome: string): number | undefined {
  const valor = lidos.get(nome);
  if (typeof valor !== 'string') return undefined;
  const convertido = Number(valor);
  if (!Number.isFinite(convertido)) {
    throw new ErroDaTelemetria(`--${nome} precisa ser um número; recebi "${valor}"`);
  }
  return convertido;
}

/** O pedido inteiro, já validado. */
export interface PedidoDaTelemetria {
  readonly intervaloMs: number;
  /** 0 = fica de pé até o Ctrl+C. */
  readonly duracaoMs: number;
  /** `undefined` = usa o nível da configuração. */
  readonly nivelLog: NivelLog | undefined;
  /**
   * Escapes de terminal: `true` forçado por `--ansi`, `false` por `--sem-ansi`, `undefined`
   * quando ninguém pediu nada — e aí quem decide é a saída ser (ou não) um terminal.
   */
  readonly ansi: boolean | undefined;
  /** Largura fingida por `--colunas`; `undefined` = a do terminal, lida a cada quadro. */
  readonly colunas: number | undefined;
}

/**
 * Transforma os argumentos no pedido. Função pura — nada de `process.env` aqui.
 *
 * @throws {ErroDaTelemetria} qualquer valor fora da faixa declarada.
 */
export function interpretarArgumentos(argumentos: readonly string[]): PedidoDaTelemetria {
  const lidos = lerArgumentos(argumentos);

  const intervaloMs = numero(lidos, 'intervalo') ?? INTERVALO_PADRAO_MS;
  if (intervaloMs < INTERVALO_MINIMO_MS || intervaloMs > INTERVALO_MAXIMO_MS) {
    throw new ErroDaTelemetria(
      `--intervalo precisa estar entre ${INTERVALO_MINIMO_MS} e ${INTERVALO_MAXIMO_MS} ms; recebi ${intervaloMs}`,
    );
  }

  const duracaoS = numero(lidos, 'duracao') ?? 0;
  if (duracaoS < 0 || duracaoS > DURACAO_MAXIMA_S) {
    throw new ErroDaTelemetria(
      `--duracao precisa estar entre 0 e ${DURACAO_MAXIMA_S} s; recebi ${duracaoS}`,
    );
  }

  const colunas = numero(lidos, 'colunas');
  if (colunas !== undefined && (colunas < COLUNAS_MINIMAS || colunas > COLUNAS_MAXIMAS)) {
    throw new ErroDaTelemetria(
      `--colunas precisa estar entre ${COLUNAS_MINIMAS} e ${COLUNAS_MAXIMAS}; recebi ${colunas}`,
    );
  }

  const nivel = lidos.get('nivel-log');
  if (typeof nivel === 'string' && !ehNivelLog(nivel)) {
    throw new ErroDaTelemetria(`--nivel-log inválido: "${nivel}"`);
  }

  const pediuAnsi = lidos.get('ansi') === true;
  const pediuSemAnsi = lidos.get('sem-ansi') === true;
  if (pediuAnsi && pediuSemAnsi) {
    throw new ErroDaTelemetria('--ansi e --sem-ansi pedem coisas opostas; use um dos dois');
  }

  return {
    intervaloMs,
    duracaoMs: Math.round(duracaoS * 1000),
    nivelLog: typeof nivel === 'string' && ehNivelLog(nivel) ? nivel : undefined,
    ansi: pediuAnsi ? true : pediuSemAnsi ? false : undefined,
    colunas: colunas === undefined ? undefined : Math.floor(colunas),
  };
}

export interface OpcoesDeExecucao {
  /** Destino do painel. O padrão é o stdout do processo. */
  readonly escrever?: (texto: string) => void;
  /** Destino das mensagens de recusa da linha de comando. O padrão é o stderr do processo. */
  readonly escreverErro?: (texto: string) => void;
  /** Força (ou proíbe) os escapes de terminal. O padrão é "usa se stdout for um terminal". */
  readonly ansi?: boolean;
  /**
   * Colunas do terminal, lidas **a cada quadro** — é assim que redimensionar a janela com o
   * painel de pé passa a valer no quadro seguinte. `undefined` (saída encanada) vira a largura
   * de referência.
   *
   * Verificado em `telemetria.teste.ts`, "lê a largura do terminal a cada quadro": a costura
   * devolve 60 no primeiro quadro e 200 nos seguintes, e o teste confere que o primeiro saiu a
   * 59 colunas e o último voltou a 78 — o que só fecha se a leitura for por desenho.
   */
  readonly lerColunas?: () => number | undefined;
  /**
   * Registra a rede de segurança da saída do processo e devolve como cancelá-la.
   *
   * O padrão é `process.once('exit', ...)`; a costura existe porque um teste não pode desligar o
   * cursor do terminal de quem está rodando a suíte. Verificada em `telemetria.teste.ts`, "a rede
   * de segurança devolve o cursor no instante do disparo": a tarefa é disparada de dentro do
   * segundo quadro e o teste afirma que o `\x1b[?25h` sai **naquela** escrita e que o painel para
   * de desenhar dali em diante. Esvaziar o corpo da tarefa abaixo derruba as duas asserções — é
   * essa a diferença que a revisão da rodada 3 cobrou, porque olhar só o texto do fim passava
   * igual com a rede gutada.
   */
  readonly registrarSaidaDoProcesso?: (tarefa: () => void) => () => void;
  /**
   * De onde a configuração vem. O padrão é o de produção (`process.env` e
   * `server/controle.config.json`); os testes passam ambiente próprio, `caminhoDoArquivo: null` e
   * `porta: 0` (ATI-030) — o mesmo ponto de injeção do `principal()`, pelo mesmo motivo: nem o
   * servidor de quem está trabalhando, nem a suíte de outro agente, nem um arquivo de configuração
   * local podem mudar o resultado de um teste.
   */
  readonly carga?: OpcoesDeCarga;
  /**
   * Como criar o backend de entrada. O padrão detecta a plataforma, como no `npm run dev`; os
   * testes passam a dubla. Desde a ATI-027 este modo monta o backend de verdade, e a regra do
   * projeto vale aqui também: **teste automático não encosta no cursor de quem está trabalhando**.
   */
  readonly criarBackend?: () => BackendDeEntrada;
  /** Onde o bias por aparelho é guardado; os testes passam uma pasta temporária. */
  readonly criarRepositorio?: () => RepositorioDeBias;
  /**
   * Recebe a promessa da abertura da porta — é como um teste descobre em que porta efêmera
   * conectar o simulador. Mesmo ponto de injeção do `principal()`.
   */
  readonly observarAbertura?: (abertura: Promise<EnderecoDoTransporte>) => void;
}

/**
 * Sobe o servidor e o painel, e só volta quando o modo encerra (Ctrl+C ou `--duracao`).
 *
 * @returns o código de saída do processo (0 quando encerrou como pedido).
 */
export async function executarTelemetriaPorArgumentos(
  argumentos: readonly string[],
  opcoes: OpcoesDeExecucao = {},
): Promise<number> {
  const escrever = opcoes.escrever ?? ((texto: string) => void process.stdout.write(texto));
  const escreverErro = opcoes.escreverErro ?? ((texto: string) => void process.stderr.write(texto));
  const lerColunasDoAmbiente = opcoes.lerColunas ?? (() => process.stdout.columns);
  const registrarSaidaDoProcesso =
    opcoes.registrarSaidaDoProcesso ??
    ((tarefa: () => void) => {
      process.once('exit', tarefa);
      return () => void process.off('exit', tarefa);
    });

  if (argumentos.includes('--ajuda')) {
    escrever(`${montarAjuda()}\n`);
    return 0;
  }

  let pedido: PedidoDaTelemetria;
  try {
    pedido = interpretarArgumentos(argumentos);
  } catch (erro) {
    if (erro instanceof ErroDaTelemetria) {
      escreverErro(`${erro.message}\n`);
      return 1;
    }
    throw erro;
  }

  let configuracao: ConfiguracaoServidor;
  try {
    configuracao = carregarConfiguracao(opcoes.carga);
  } catch (erro) {
    if (erro instanceof ErroDeConfiguracao) {
      escreverErro(`${erro.message}\n`);
      return 1;
    }
    throw erro;
  }

  const ansi = pedido.ansi ?? opcoes.ansi ?? process.stdout.isTTY === true;
  const colunasFingidas = pedido.colunas;
  const lerColunas =
    colunasFingidas === undefined ? lerColunasDoAmbiente : () => colunasFingidas;
  // A primeira linha do quadro diz se o cursor é real ou ensaio (ATI-027): ela sai em destaque.
  const painel = criarPainel({ escrever, ansi, destacarPrimeiraLinha: true });

  // Rede de segurança do terminal: o cursor é escondido no primeiro quadro e só volta em
  // `painel.encerrar()`. Se o processo morrer por outro caminho — exceção dentro do relógio do
  // painel, `process.exit` de fora — a pessoa ficaria com o terminal sem cursor. `encerrar()` é
  // idempotente, então no caminho normal isto não escreve nada.
  const cancelarRedeDeSeguranca = registrarSaidaDoProcesso(() => {
    painel.encerrar();
  });

  // O log passa pelo painel em vez de ir direto para stderr: os dois no mesmo terminal
  // desalinhariam o quadro para sempre (ver o cabeçalho de `telemetria/painel.ts`).
  const registrador = criarRegistrador(pedido.nivelLog ?? configuracao.nivelLog, 'telemetria', (linha) =>
    painel.escreverAcima(linha.endsWith('\n') ? linha.slice(0, -1) : linha),
  );

  // Backend de entrada e arquivo de gravação, pelas mesmas regras do `npm run dev` (ATI-027).
  // Recusa aqui é gravação pedida que não abre: o motivo já saiu no log, e nada ficou de pé.
  const partida = prepararPartida({
    configuracao,
    registrador,
    criarBackend: opcoes.criarBackend,
  });
  if (!partida.ok) {
    painel.encerrar();
    cancelarRedeDeSeguranca();
    return 1;
  }

  // ⚠️ Objeto único, escrito no caminho quente e lido pelo painel. Nunca recriado.
  const eixos: LeituraDosEixos = { gx: 0, gy: 0, gz: 0 };

  const encerramento = instalarEncerramento(registrador);
  let relogioDoQuadro: NodeJS.Timeout | undefined;
  let relogioDaDuracao: NodeJS.Timeout | undefined;

  // As tarefas rodam na ordem inversa do registro. A ordem desejada de execução é: parar o
  // relógio, desligar o teclado, fechar o transporte, soltar o que a montagem segura (backend,
  // gravação, resumos), devolver o terminal e só então soltar quem espera — por isso a espera e o
  // painel são registrados **antes** da montagem, e o relógio depois dela.
  const fim = new Promise<void>((resolver) => {
    encerramento.registrar('espera do modo telemetria', () => {
      resolver();
    });
  });
  encerramento.registrar('painel da telemetria', () => {
    painel.encerrar();
  });

  // A montagem é a mesma do `npm run dev` (`montagem.ts`). O que este modo acrescenta entra pelas
  // duas costuras dela, e só: os eixos para o painel e o zerar deles quando a sessão cai.
  const servidor = montarServidor({
    configuracao,
    registrador,
    encerramento,
    backend: partida.backend,
    gravador: partida.gravador,
    criarRepositorio: opcoes.criarRepositorio,
    motivoDoFechamento: 'telemetria encerrando',
    aoReceberPacote: (pacote) => {
      // ⚠️ CAMINHO QUENTE — 100 Hz. Três atribuições, nada mais.
      if (pacote.tipo !== TIPO_MOVIMENTO) return;
      eixos.gx = pacote.gx;
      eixos.gy = pacote.gy;
      eixos.gz = pacote.gz;
    },
    // Sessão que caiu não tem leitura: sem isto o painel continuaria exibindo os últimos eixos
    // recebidos, e um aparelho desconectado pareceria parado no lugar em vez de ausente.
    aoEncerrarSessao: () => {
      eixos.gx = 0;
      eixos.gy = 0;
      eixos.gz = 0;
    },
  });
  const { transporte } = servidor;

  encerramento.registrar('relógio do painel', () => {
    if (relogioDoQuadro !== undefined) clearInterval(relogioDoQuadro);
    if (relogioDaDuracao !== undefined) clearTimeout(relogioDaDuracao);
    relogioDoQuadro = undefined;
    relogioDaDuracao = undefined;
  });

  const abertura = transporte.ouvir();
  opcoes.observarAbertura?.(abertura);
  try {
    await abertura;
  } catch (erro) {
    registrador.erro('não consegui abrir o transporte', { porta: configuracao.porta, erro });
    await encerramento.encerrar('falha ao abrir o transporte');
    cancelarRedeDeSeguranca();
    return 1;
  }

  const medidorDeCpu = criarMedidorDeCpu({
    lerCpu: () => process.cpuUsage(),
    inicioMs: performance.now(),
  });

  function desenhar(): void {
    medidorDeCpu.atualizar(performance.now());
    painel.desenhar(
      montarQuadro({
        endereco: transporte.endereco(),
        conexoesAbertas: transporte.conexoesAbertas(),
        sessao: transporte.sessaoAtual()?.instantaneo(),
        eixos,
        cpuPorCento: medidorDeCpu.janela,
        cpuMediaPorCento: medidorDeCpu.media,
        intervaloDoQuadroMs: pedido.intervaloMs,
        // Lido a cada quadro, e não uma vez na partida: redimensionar a janela com o painel de
        // pé mudaria a largura sem avisar, e linha mais larga que o terminal é a rolagem que o
        // critério 4 da ATI-006 proíbe (ver `quadro.ts`).
        largura: larguraDeTrabalho(lerColunas()),
        montagem: servidor.instantaneo(),
      }),
    );
  }

  registrador.info('telemetria no ar', {
    ...descreverDestinos(servidor, configuracao),
    simulador: 'npm run simulador -- --padrao rotacao --graus 90 --eixo y',
    celular: `http://localhost:${configuracao.porta}${ROTA_DA_PAGINA}`,
    cursorDeVerdade: `${VARIAVEIS_DE_AMBIENTE.movimento}=sistema npm run telemetria`,
    encerrar: 'Ctrl+C',
  });

  // Primeiro quadro na hora: esperar 100 ms para a tela mostrar alguma coisa faria a partida
  // parecer travada.
  desenhar();
  relogioDoQuadro = setInterval(desenhar, pedido.intervaloMs);

  if (pedido.duracaoMs > 0) {
    relogioDaDuracao = setTimeout(() => {
      void encerramento.encerrar(`duração de ${pedido.duracaoMs} ms atingida`);
    }, pedido.duracaoMs);
  }

  await fim;
  cancelarRedeDeSeguranca();
  return 0;
}

/**
 * Mesma guarda de `principal.ts` e do simulador: este arquivo é programa e também é módulo
 * importado pelos testes. Sem ela, importar o módulo abriria uma porta.
 */
export function ehPontoDeEntrada(): boolean {
  const alvo = process.argv[1];
  if (alvo === undefined) return false;
  try {
    return realpathSync(alvo) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (ehPontoDeEntrada()) {
  void executarTelemetriaPorArgumentos(process.argv.slice(2)).then(
    (codigo) => {
      process.exitCode = codigo;
    },
    (erro: unknown) => {
      process.stderr.write(`falha inesperada na telemetria: ${String(erro)}\n`);
      process.exitCode = 1;
    },
  );
}
