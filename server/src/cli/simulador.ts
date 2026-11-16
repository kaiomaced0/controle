/**
 * `npm run simulador` — o aparelho de mentira na linha de comando (ATI-023).
 *
 * Conecta no servidor como se fosse o celular, envia um padrão de movimento **conhecido** e
 * imprime o resumo do que saiu. Serve para verificar servidor, protocolo e (a partir da
 * ATI-008) pipeline de movimento sem depender de aparelho conectado.
 *
 * ```bash
 * npm run simulador -- --ajuda
 * npm run simulador -- --padrao rotacao --graus 90 --eixo y
 * npm run simulador -- --padrao parado --duracao 60
 * npm run simulador -- --padrao gravado --arquivo dados-locais/sessao.captura
 * ```
 *
 * Divisão de trabalho: aqui ficam **só** a leitura dos argumentos, a ajuda e a impressão. O
 * simulador de verdade mora em `simulador/` — é ele que os testes usam, sem passar por texto de
 * linha de comando nenhum.
 *
 * A saída para pessoa vai em **stdout** (`process.stdout.write`, e não `console.*`, que o lint
 * proíbe); o log estruturado continua indo para stderr, como manda `src/cli/README.md`.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ErroDeConfiguracao, carregarConfiguracao } from '../config.js';
import { criarRegistrador, ehNivelLog, type NivelLog } from '../log.js';
import { ErroDeCaptura, lerCaptura } from './captura.js';
import {
  EIXOS,
  ErroDoSimulador,
  PADROES,
  RITMOS,
  criarFonteDeAmostras,
  criarSimulador,
  ehEixo,
  ehNomeDePadrao,
  ehRitmo,
  resolverParametros,
  type FonteDeAmostras,
  type OpcoesDePadrao,
  type ParametrosDoPadrao,
  type Ritmo,
  type ResumoDoSimulador,
} from './simulador/indice.js';

/** Uma opção de linha de comando, como ela aparece na ajuda e como ela é lida. */
interface DefinicaoDeOpcao {
  readonly nome: string;
  /** `flag` não leva valor; as outras exigem um. */
  readonly tipo: 'texto' | 'numero' | 'flag';
  /** Nome do valor na ajuda (`--taxa <hz>`). */
  readonly valor?: string;
  readonly padrao: string;
  readonly descricao: string;
}

/**
 * Tabela **única** das opções: é dela que saem a validação e o texto do `--ajuda`.
 *
 * Uma lista só, e não duas, porque ajuda que descreve opção que não existe (ou o contrário) é
 * o jeito mais barato de fazer alguém perder meia hora.
 */
export const OPCOES: readonly DefinicaoDeOpcao[] = [
  {
    nome: 'padrao',
    tipo: 'texto',
    valor: PADROES.join('|'),
    padrao: 'parado',
    descricao: 'o que o aparelho de mentira faz com o giroscópio',
  },
  {
    nome: 'servidor',
    tipo: 'texto',
    valor: 'ws://host:porta',
    padrao: 'ws://<host>:<porta> da configuração',
    descricao: 'endereço completo do servidor (vence --host e --porta)',
  },
  {
    nome: 'host',
    tipo: 'texto',
    valor: 'endereço',
    padrao: 'da configuração',
    descricao: 'host do servidor',
  },
  {
    nome: 'porta',
    tipo: 'numero',
    valor: 'porta',
    padrao: 'da configuração',
    descricao: 'porta do servidor',
  },
  { nome: 'taxa', tipo: 'numero', valor: 'hz', padrao: '100', descricao: 'amostras por segundo' },
  {
    nome: 'duracao',
    tipo: 'numero',
    valor: 'segundos',
    padrao: '5',
    descricao: 'duração da execução (ignorada quando --graus é usado)',
  },
  {
    nome: 'eixo',
    tipo: 'texto',
    valor: EIXOS.join('|'),
    padrao: 'y',
    descricao: 'eixo do giroscópio',
  },
  {
    nome: 'graus',
    tipo: 'numero',
    valor: 'graus',
    padrao: '—',
    descricao: 'rotacao: total de graus a girar; define a duração e é exato',
  },
  {
    nome: 'velocidade',
    tipo: 'numero',
    valor: '°/s',
    padrao: '90',
    descricao: 'rotacao: velocidade angular (com --graus, define quantas amostras cabem)',
  },
  {
    nome: 'amplitude',
    tipo: 'numero',
    valor: '°/s',
    padrao: '0.3',
    descricao: 'tremor: amplitude da oscilação',
  },
  {
    nome: 'frequencia',
    tipo: 'numero',
    valor: 'hz',
    padrao: '8',
    descricao: 'tremor: frequência da oscilação',
  },
  {
    nome: 'ruido',
    tipo: 'numero',
    valor: '°/s',
    padrao: '0.05 (0 em rotacao)',
    descricao: 'desvio padrão do ruído somado a cada eixo',
  },
  {
    nome: 'bias',
    tipo: 'numero',
    valor: '°/s',
    padrao: '0.29',
    descricao: 'parado/pico: bias fixo do giroscópio (o cursor anda sozinho por causa dele)',
  },
  {
    nome: 'pico',
    tipo: 'numero',
    valor: '°/s',
    padrao: '2000',
    descricao: 'pico: valor da amostra absurda isolada',
  },
  {
    nome: 'indice-do-pico',
    tipo: 'numero',
    valor: 'n',
    padrao: 'meio da execução',
    descricao: 'pico: em qual amostra o pico acontece',
  },
  {
    nome: 'semente',
    tipo: 'numero',
    valor: 'n',
    padrao: '20260820',
    descricao: 'semente do gerador — mesma semente, mesma sequência',
  },
  {
    nome: 'arquivo',
    tipo: 'texto',
    valor: 'caminho',
    padrao: '—',
    descricao: 'gravado: arquivo de captura a reproduzir',
  },
  {
    nome: 'acelerometro',
    tipo: 'flag',
    padrao: 'desligado',
    descricao: 'envia ax/ay/az junto (pacote de 36 bytes em vez de 24)',
  },
  {
    nome: 'sem-bye',
    tipo: 'flag',
    padrao: 'desligado',
    descricao: 'encerra abrupto: sem quadro bye e sem close handshake (o socket é cortado)',
  },
  {
    nome: 'ritmo',
    tipo: 'texto',
    valor: RITMOS.join('|'),
    padrao: 'timer',
    descricao:
      'como esperar entre amostras: timer (barato) ou preciso (espaçamento fiel, gira CPU)',
  },
  {
    nome: 'nivel-log',
    tipo: 'texto',
    valor: 'erro|aviso|info|depuracao',
    padrao: 'aviso',
    descricao: 'verbosidade do log em stderr',
  },
  { nome: 'ajuda', tipo: 'flag', padrao: '—', descricao: 'mostra esta ajuda e sai' },
];

const DEFINICOES = new Map(OPCOES.map((opcao) => [opcao.nome, opcao]));

/** Texto do `--ajuda`, montado da tabela acima. */
export function montarAjuda(): string {
  const linhas: string[] = [
    'simulador de aparelho — envia movimento conhecido para o servidor, sem celular na mesa',
    '',
    'uso: npm run simulador -- [opções]',
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
    'padrões de movimento:',
    '  parado   bias fixo + ruído leve — o cursor não pode andar sozinho',
    '  rotacao  velocidade angular constante, com total de graus exato',
    '  tremor   oscilação de baixa amplitude e alta frequência — valida a zona morta',
    '  pico     uma amostra absurda isolada — valida a proteção contra pico de sensor',
    '  gravado  reproduz um arquivo de captura gravado pelo servidor',
    '',
    'exemplos:',
    '  npm run simulador -- --padrao rotacao --graus 90 --eixo y',
    '  npm run simulador -- --padrao parado --duracao 60',
    '  npm run simulador -- --padrao tremor --amplitude 0.2 --frequencia 12',
    '  npm run simulador -- --padrao gravado --arquivo dados-locais/sessao.captura',
    '',
  );
  return linhas.join('\n');
}

/** Argumentos já separados em `nome → valor`. `true` é flag presente. */
export type ArgumentosLidos = ReadonlyMap<string, string | true>;

/**
 * Separa `--chave valor`, `--chave=valor` e `--flag`.
 *
 * @throws {ErroDoSimulador} opção desconhecida, valor faltando ou argumento solto.
 */
export function lerArgumentos(argumentos: readonly string[]): ArgumentosLidos {
  const lidos = new Map<string, string | true>();

  for (let indice = 0; indice < argumentos.length; indice += 1) {
    const bruto = argumentos[indice] ?? '';
    if (!bruto.startsWith('--')) {
      throw new ErroDoSimulador(
        `não entendi "${bruto}": as opções vêm nomeadas, como --padrao rotacao (veja --ajuda)`,
      );
    }

    const igual = bruto.indexOf('=');
    const nome = (igual === -1 ? bruto.slice(2) : bruto.slice(2, igual)).trim();
    const definicao = DEFINICOES.get(nome);
    if (definicao === undefined) {
      throw new ErroDoSimulador(`opção desconhecida "--${nome}" (veja --ajuda)`);
    }

    if (definicao.tipo === 'flag') {
      if (igual !== -1) throw new ErroDoSimulador(`--${nome} não leva valor`);
      lidos.set(nome, true);
      continue;
    }

    let valor: string;
    if (igual !== -1) {
      valor = bruto.slice(igual + 1);
    } else {
      const proximo = argumentos[indice + 1];
      if (proximo === undefined || proximo.startsWith('--')) {
        throw new ErroDoSimulador(`--${nome} precisa de um valor (veja --ajuda)`);
      }
      valor = proximo;
      indice += 1;
    }
    if (valor === '') throw new ErroDoSimulador(`--${nome} precisa de um valor não vazio`);
    lidos.set(nome, valor);
  }

  return lidos;
}

function texto(lidos: ArgumentosLidos, nome: string): string | undefined {
  const valor = lidos.get(nome);
  return typeof valor === 'string' ? valor : undefined;
}

function numero(lidos: ArgumentosLidos, nome: string): number | undefined {
  const valor = texto(lidos, nome);
  if (valor === undefined) return undefined;
  const convertido = Number(valor);
  if (!Number.isFinite(convertido)) {
    throw new ErroDoSimulador(`--${nome} precisa ser um número; recebi "${valor}"`);
  }
  return convertido;
}

/** O pedido inteiro, já validado: para onde conectar e o que enviar. */
export interface PedidoDoSimulador {
  readonly url: string;
  readonly opcoesDePadrao: OpcoesDePadrao;
  /** Caminho do arquivo de captura (só no padrão `gravado`). */
  readonly arquivo: string | undefined;
  readonly nivelLog: NivelLog;
  readonly enviarBye: boolean;
  readonly ritmo: Ritmo;
}

export interface PadraoDeEndereco {
  readonly host: string;
  readonly porta: number;
}

/**
 * Transforma os argumentos no pedido.
 *
 * Função pura de propósito (o endereço padrão entra como parâmetro, não lido do ambiente):
 * é o que permite testar a leitura da linha de comando sem tocar em `process.env`.
 *
 * @throws {ErroDoSimulador} qualquer valor fora do conjunto declarado.
 */
export function interpretarArgumentos(
  argumentos: readonly string[],
  enderecoPadrao: PadraoDeEndereco,
): PedidoDoSimulador {
  const lidos = lerArgumentos(argumentos);

  const padrao = texto(lidos, 'padrao');
  if (padrao !== undefined && !ehNomeDePadrao(padrao)) {
    throw new ErroDoSimulador(
      `--padrao precisa ser um de: ${PADROES.join(', ')}; recebi "${padrao}"`,
    );
  }

  const eixo = texto(lidos, 'eixo');
  if (eixo !== undefined && !ehEixo(eixo)) {
    throw new ErroDoSimulador(`--eixo precisa ser um de: ${EIXOS.join(', ')}; recebi "${eixo}"`);
  }

  const ritmo = texto(lidos, 'ritmo') ?? 'timer';
  if (!ehRitmo(ritmo)) {
    throw new ErroDoSimulador(`--ritmo precisa ser um de: ${RITMOS.join(', ')}; recebi "${ritmo}"`);
  }

  const nivelLog = texto(lidos, 'nivel-log') ?? 'aviso';
  if (!ehNivelLog(nivelLog)) {
    throw new ErroDoSimulador(`--nivel-log inválido: "${nivelLog}"`);
  }

  const host = texto(lidos, 'host') ?? enderecoPadrao.host;
  const porta = numero(lidos, 'porta') ?? enderecoPadrao.porta;
  const url = texto(lidos, 'servidor') ?? `ws://${host}:${porta}`;

  const arquivo = texto(lidos, 'arquivo');
  if (padrao === 'gravado' && arquivo === undefined) {
    throw new ErroDoSimulador('--padrao gravado precisa de --arquivo <caminho da captura>');
  }
  if (padrao !== 'gravado' && arquivo !== undefined) {
    throw new ErroDoSimulador('--arquivo só faz sentido com --padrao gravado');
  }

  return {
    url,
    arquivo,
    nivelLog,
    ritmo,
    enviarBye: lidos.get('sem-bye') !== true,
    opcoesDePadrao: {
      padrao,
      eixo,
      taxaHz: numero(lidos, 'taxa'),
      duracaoS: numero(lidos, 'duracao'),
      graus: numero(lidos, 'graus'),
      velocidadeGrausPorS: numero(lidos, 'velocidade'),
      amplitudeGrausPorS: numero(lidos, 'amplitude'),
      frequenciaHz: numero(lidos, 'frequencia'),
      ruidoGrausPorS: numero(lidos, 'ruido'),
      biasGrausPorS: numero(lidos, 'bias'),
      picoGrausPorS: numero(lidos, 'pico'),
      indiceDoPico: numero(lidos, 'indice-do-pico'),
      semente: numero(lidos, 'semente'),
      acelerometro: lidos.get('acelerometro') === true,
    },
  };
}

function escrever(linha: string): void {
  process.stdout.write(`${linha}\n`);
}

/** Resumo final, em bloco, para pessoa ler. */
export function formatarResumo(resumo: ResumoDoSimulador, taxaHzPedida: number): string {
  const linhas = [
    'resumo',
    `  desfecho           ${resumo.desfecho} (${resumo.motivo})`,
    `  sessão             ${resumo.sessao ?? '—'}`,
    `  amostras enviadas  ${resumo.amostrasEnviadas} de ${resumo.amostrasPrevistas}`,
    `  bytes enviados     ${resumo.bytesEnviados}`,
    `  taxa efetiva       ${resumo.taxaHzEfetiva.toFixed(2)} Hz (pedida ${taxaHzPedida} Hz)`,
    `  atraso de envio    médio ${resumo.atrasoMedioMs.toFixed(2)} ms · máximo ` +
      `${resumo.atrasoMaximoMs.toFixed(2)} ms · fora do ritmo ${resumo.amostrasForaDoRitmo}` +
      ` · em lote ${resumo.amostrasEmLote}`,
    `  pings respondidos  ${resumo.pingsRespondidos}`,
  ];
  if (resumo.grausTotais !== 0) {
    linhas.push(`  graus integrados   ${resumo.grausTotais.toFixed(3)}°`);
  }
  if (resumo.quadrosBinariosRecebidos > 0) {
    linhas.push(
      `  do servidor        ${resumo.quadrosBinariosRecebidos} quadros binários ` +
        `(${resumo.rumblesRecebidos} rumble, ${resumo.hapticosRecebidos} háptico)`,
    );
  }
  return linhas.join('\n');
}

/**
 * Executa o simulador com os argumentos dados.
 *
 * @returns o código de saída do processo (0 quando a sequência foi até o fim).
 */
export async function executarSimuladorPorArgumentos(
  argumentos: readonly string[],
  enderecoPadrao: PadraoDeEndereco,
): Promise<number> {
  if (argumentos.includes('--ajuda')) {
    escrever(montarAjuda());
    return 0;
  }

  let pedido: PedidoDoSimulador;
  let parametros: ParametrosDoPadrao;
  let fonte: FonteDeAmostras;
  try {
    pedido = interpretarArgumentos(argumentos, enderecoPadrao);
    const captura = pedido.arquivo === undefined ? undefined : lerCaptura(pedido.arquivo);
    parametros = resolverParametros({
      ...pedido.opcoesDePadrao,
      amostrasGravadas: captura?.amostras,
    });
    // A fonte entra no mesmo `try` porque parte da validação só é possível depois de saber
    // quantas amostras a execução tem (`--indice-do-pico`): fora daqui, a recusa viraria
    // "falha inesperada no simulador" em vez da mensagem pronta para o terminal.
    fonte = criarFonteDeAmostras(parametros);
  } catch (erro) {
    if (erro instanceof ErroDoSimulador || erro instanceof ErroDeCaptura) {
      process.stderr.write(`${erro.message}\n`);
      return 1;
    }
    throw erro;
  }

  escrever(`simulador  ${fonte.descricao}`);
  escrever(`servidor   ${pedido.url}`);

  const simulador = criarSimulador({
    url: pedido.url,
    fonte,
    registrador: criarRegistrador(pedido.nivelLog, 'simulador'),
    taxaHzDesejada: parametros.taxaHz,
    enviarBye: pedido.enviarBye,
    ritmo: pedido.ritmo,
  });

  // Ctrl+C não pode deixar socket aberto nem temporizador de pé (regra 5 do CLAUDE.md):
  // `cancelar` é o mesmo caminho de saída do fim normal da sequência.
  const aoInterromper = (): void => {
    simulador.cancelar('Ctrl+C');
  };
  process.once('SIGINT', aoInterromper);

  try {
    const resumo = await simulador.executar();
    escrever(formatarResumo(resumo, parametros.taxaHz));
    return resumo.desfecho === 'completo' ? 0 : 1;
  } finally {
    process.off('SIGINT', aoInterromper);
  }
}

/**
 * Se esta execução precisa mesmo carregar a configuração.
 *
 * `--ajuda` não precisa: quem pede ajuda muitas vezes está justamente tentando descobrir por que
 * nada funciona, e um `controle.config.json` quebrado engoliria o texto e devolveria saída 1 no
 * lugar dele (parecer ATI-023-r1, sugestão 5).
 */
export function precisaDaConfiguracao(argumentos: readonly string[]): boolean {
  return !argumentos.includes('--ajuda');
}

/** Endereço usado quando a configuração nem chega a ser lida (só o caminho do `--ajuda`). */
const ENDERECO_SEM_CONFIGURACAO: PadraoDeEndereco = { host: '', porta: 0 };

/**
 * Endereço padrão do servidor, vindo da **configuração** (`src/config.ts`) — nunca de um
 * número mágico aqui: quem muda `CONTROLE_PORTA` muda o servidor e o simulador de uma vez.
 */
function enderecoDaConfiguracao(): PadraoDeEndereco {
  try {
    const configuracao = carregarConfiguracao();
    return { host: configuracao.host, porta: configuracao.porta };
  } catch (erro) {
    if (erro instanceof ErroDeConfiguracao) {
      process.stderr.write(`${erro.message}\n`);
      process.exitCode = 1;
      return { host: '', porta: 0 };
    }
    throw erro;
  }
}

/**
 * Mesma guarda de `principal.ts`: este arquivo é programa (`npm run simulador`) e também é
 * módulo importado pelos testes. Sem ela, importar o módulo tentaria conectar num servidor.
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
  const argumentosDaLinha = process.argv.slice(2);
  const endereco = precisaDaConfiguracao(argumentosDaLinha)
    ? enderecoDaConfiguracao()
    : ENDERECO_SEM_CONFIGURACAO;
  if (process.exitCode !== 1) {
    void executarSimuladorPorArgumentos(argumentosDaLinha, endereco).then(
      (codigo) => {
        process.exitCode = codigo;
      },
      (erro: unknown) => {
        process.stderr.write(`falha inesperada no simulador: ${String(erro)}\n`);
        process.exitCode = 1;
      },
    );
  }
}
