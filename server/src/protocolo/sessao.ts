/**
 * Mensagens JSON de sessão (PROTOCOLO.md, seção 3) — tipos, serialização e validação.
 *
 * Estas mensagens são de **baixa frequência** (handshake, ajuste, comando, ping a cada 1 s):
 * aqui `JSON.parse` é bem-vindo, ao contrário do caminho quente, que é binário e mora em
 * `binario.ts`. Nada neste arquivo pode ser chamado por amostra de sensor.
 *
 * O quadro de texto é **estrito nos dois sentidos** (PROTOCOLO.md, seção 3). Viram recusa com
 * `PROTOCOLO_INVALIDO`:
 *
 * - `t` desconhecido ou não textual;
 * - campo obrigatório ausente;
 * - **valor fora do conjunto declarado** (`espaco: "mundial"`, `codigo: "DEU_RUIM"`);
 * - **número não finito** (`NaN`, `Infinity` — e `JSON.parse('1e999')` devolve `Infinity`);
 * - **campo opcional presente com o tipo errado** — presente e imprestável não é o mesmo que
 *   ausente, e tratar os dois igual faria o servidor responder `config-ok` para um ajuste que
 *   ele jogou fora.
 *
 * Só **campo desconhecido a mais** é ignorado, que é como uma versão futura acrescenta
 * informação sem quebrar quem é velho. O "ignora silenciosamente" da seção 6 do PROTOCOLO.md
 * vale só para os quadros binários, onde tipo novo pode aparecer sem quebrar quem é velho.
 *
 * `interpretarMensagemDeTexto` **não lança**: JSON quebrado devolve recusa, nunca exceção.
 */

/** Versão do protocolo falada por este servidor (campo `v` do handshake). */
export const VERSAO_PROTOCOLO = 1;

/** Códigos de `erro` (PROTOCOLO.md, seção 3.3). */
export const CODIGOS_DE_ERRO = [
  'VERSAO_INCOMPATIVEL',
  'PAREAMENTO_NECESSARIO',
  'TOKEN_INVALIDO',
  'SESSAO_SUBSTITUIDA',
  'PROTOCOLO_INVALIDO',
  'PERFIL_INEXISTENTE',
] as const;
export type CodigoDeErro = (typeof CODIGOS_DE_ERRO)[number];

/** Comandos aceitos em `cmd` (PROTOCOLO.md, seção 3.5). */
export const COMANDOS = [
  'centralizar',
  'calibrar-inicio',
  'calibrar-fim',
  'trocar-perfil',
  'pausar',
  'retomar',
] as const;
export type Comando = (typeof COMANDOS)[number];

/**
 * Códigos de `aviso` (PROTOCOLO.md, seção 3.8). Conjunto fechado, como o de `erro`: um aviso novo
 * entra aqui, no espelho do app e na tabela do documento, na mesma entrega.
 */
export const CODIGOS_DE_AVISO = ['BIAS_ALTO'] as const;
export type CodigoDeAviso = (typeof CODIGOS_DE_AVISO)[number];

/** Sistemas operacionais reconhecidos no `hello`. */
export const SISTEMAS_DE_APARELHO = ['android', 'ios'] as const;
export type SistemaDeAparelho = (typeof SISTEMAS_DE_APARELHO)[number];

/** Como a sessão está fisicamente ligada. */
export const TRANSPORTES = ['usb', 'wifi'] as const;
export type Transporte = (typeof TRANSPORTES)[number];

/** Espaço de mapeamento dos eixos do giroscópio (ARQUITETURA.md, seção 3.1). */
export const ESPACOS_DE_GIRO = ['local', 'mundo'] as const;
export type EspacoDeGiro = (typeof ESPACOS_DE_GIRO)[number];

/* ================================================================================= tipos */

export interface AparelhoDoHello {
  readonly id: string;
  readonly nome: string;
  readonly so: SistemaDeAparelho;
  readonly versaoSo: string;
  readonly modelo: string;
}

export interface MensagemHello {
  readonly t: 'hello';
  readonly v: number;
  readonly aparelho: AparelhoDoHello;
  readonly capacidades: readonly string[];
  readonly taxaHzDesejada: number;
  readonly token?: string | undefined;
  readonly codigoPareamento?: string | undefined;
}

export interface ServidorDoWelcome {
  readonly nome: string;
  readonly versao: string;
  readonly so: string;
}

export interface SessaoDoWelcome {
  readonly id: string;
  readonly taxaHz: number;
  readonly transporte: Transporte;
}

export interface TelaDoWelcome {
  readonly largura: number;
  readonly altura: number;
}

export interface PerfilResumido {
  readonly id: string;
  readonly nome: string;
}

export interface MensagemWelcome {
  readonly t: 'welcome';
  readonly v: number;
  readonly servidor: ServidorDoWelcome;
  readonly sessao: SessaoDoWelcome;
  readonly tela: TelaDoWelcome;
  /**
   * Objeto completo do perfil ativo. O schema do perfil não é assunto do codec — quem valida
   * conteúdo é o módulo `perfis/`; aqui só se garante que veio um objeto.
   */
  readonly perfilAtivo: Readonly<Record<string, unknown>>;
  readonly perfis: readonly PerfilResumido[];
  readonly token?: string | undefined;
}

export interface MensagemErro {
  readonly t: 'erro';
  readonly codigo: CodigoDeErro;
  readonly mensagem?: string | undefined;
}

/** Ajustes de giro trafegados em `config` e devolvidos em `config-ok` já saturados. */
export interface AjustesDeGiro {
  readonly sensX?: number | undefined;
  readonly sensY?: number | undefined;
  readonly deadzone?: number | undefined;
  readonly suavizacao?: number | undefined;
  readonly inverterX?: boolean | undefined;
  readonly inverterY?: boolean | undefined;
  readonly espaco?: EspacoDeGiro | undefined;
}

export interface MensagemConfig {
  readonly t: 'config';
  readonly gyro: AjustesDeGiro;
}

export interface MensagemConfigOk {
  readonly t: 'config-ok';
  /** Valores **efetivos** depois dos limites da seção 3.4 do PROTOCOLO.md. */
  readonly gyro: AjustesDeGiro;
}

export interface MensagemCmd {
  readonly t: 'cmd';
  readonly comando: Comando;
  /** Obrigatório quando `comando` é `trocar-perfil`. */
  readonly perfilId?: string | undefined;
}

export interface MensagemCmdOk {
  readonly t: 'cmd-ok';
  readonly comando: Comando;
  readonly resultado?: Readonly<Record<string, unknown>> | undefined;
}

export interface MensagemCmdErro {
  readonly t: 'cmd-erro';
  readonly comando: Comando;
  readonly motivo: string;
}

export interface MensagemPing {
  readonly t: 'ping';
  readonly n: number;
  readonly tServidorMs: number;
}

export interface MensagemPong {
  readonly t: 'pong';
  readonly n: number;
  /** Ecoado do `ping`: o RTT sai do relógio do servidor, sem sincronizar relógios. */
  readonly tServidorMs: number;
  readonly tDispositivoMs: number;
}

export interface MensagemBye {
  readonly t: 'bye';
  readonly motivo?: string | undefined;
}

/**
 * Aviso do servidor para a tela do aparelho (PROTOCOLO.md, seção 3.8) — estado, e não evento: o
 * último `aviso` de cada `codigo` é o que vale, até chegar outro do mesmo código.
 */
export interface MensagemAviso {
  readonly t: 'aviso';
  readonly codigo: CodigoDeAviso;
  /** `true` acende (ou troca o texto de) o aviso deste código; `false` o tira da tela. */
  readonly ativo: boolean;
  /**
   * Texto para pessoa ler, pronto para a tela — quem escreve é o servidor, que é quem sabe o que
   * resolve (CLAUDE.md, regra 4). Obrigatório quando `ativo` é `true`.
   */
  readonly mensagem?: string | undefined;
}

export type MensagemDeTexto =
  | MensagemHello
  | MensagemWelcome
  | MensagemErro
  | MensagemConfig
  | MensagemConfigOk
  | MensagemCmd
  | MensagemCmdOk
  | MensagemCmdErro
  | MensagemPing
  | MensagemPong
  | MensagemBye
  | MensagemAviso;

/* ================================================================== leitura e validação */

export type ResultadoDeTexto =
  | { readonly ok: true; readonly mensagem: MensagemDeTexto }
  | { readonly ok: false; readonly codigo: CodigoDeErro; readonly motivo: string };

function recusar(motivo: string, codigo: CodigoDeErro = 'PROTOCOLO_INVALIDO'): ResultadoDeTexto {
  return { ok: false, codigo, motivo };
}

function aceitar(mensagem: MensagemDeTexto): ResultadoDeTexto {
  return { ok: true, mensagem };
}

/**
 * Marcador de **campo presente com valor imprestável**.
 *
 * Sem ele, "ausente" e "presente e errado" cairiam os dois em `undefined`, e campo opcional
 * inválido viraria "não veio" em silêncio — que é justamente o que a seção 3 do PROTOCOLO.md
 * proíbe. O estrago é invisível para quem usa: a pessoa mexe num ajuste no celular, o servidor
 * responde `config-ok` e o ajuste simplesmente não existe, sem erro nem contador.
 *
 * Com o marcador, `undefined` quer dizer só "ausente"; qualquer outra falha vira `INVALIDO` e
 * quem chama recusa a mensagem inteira.
 */
const INVALIDO = Symbol('campo presente com valor inválido');
type Invalido = typeof INVALIDO;

/** Campo lido: o valor, `undefined` se ausente, `INVALIDO` se presente e imprestável. */
type Lido<T> = T | undefined | Invalido;

function ehInvalido(lido: unknown): lido is Invalido {
  return lido === INVALIDO;
}

/** Campo obrigatório: ausente e inválido dão no mesmo, e quem chama recusa dos dois jeitos. */
function exigido<T>(lido: Lido<T>): T | undefined {
  if (lido === undefined || lido === INVALIDO) return undefined;
  return lido;
}

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function texto(origem: Record<string, unknown>, campo: string): Lido<string> {
  const valor = origem[campo];
  if (valor === undefined) return undefined;
  return typeof valor === 'string' ? valor : INVALIDO;
}

/**
 * Número **finito**: `NaN` e infinito são recusados, porque envenenam qualquer conta adiante.
 * Vale lembrar que `JSON.parse('1e999')` devolve `Infinity` sem erro nenhum — é exatamente
 * por aqui que ele entraria.
 */
function numero(origem: Record<string, unknown>, campo: string): Lido<number> {
  const valor = origem[campo];
  if (valor === undefined) return undefined;
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return INVALIDO;
  return valor;
}

function booleano(origem: Record<string, unknown>, campo: string): Lido<boolean> {
  const valor = origem[campo];
  if (valor === undefined) return undefined;
  return typeof valor === 'boolean' ? valor : INVALIDO;
}

function objeto(origem: Record<string, unknown>, campo: string): Lido<Record<string, unknown>> {
  const valor = origem[campo];
  if (valor === undefined) return undefined;
  return ehObjeto(valor) ? valor : INVALIDO;
}

function lista(origem: Record<string, unknown>, campo: string): Lido<readonly unknown[]> {
  const valor = origem[campo];
  if (valor === undefined) return undefined;
  return Array.isArray(valor) ? (valor as readonly unknown[]) : INVALIDO;
}

/** Texto de conjunto fechado: fora do conjunto é `INVALIDO`, nunca "ausente". */
function daLista<T extends string>(valores: readonly T[], candidato: Lido<string>): Lido<T> {
  if (candidato === undefined) return undefined;
  if (ehInvalido(candidato)) return INVALIDO;
  return valores.includes(candidato as T) ? (candidato as T) : INVALIDO;
}

function lerAparelho(bruto: Record<string, unknown>): AparelhoDoHello | undefined {
  const id = exigido(texto(bruto, 'id'));
  const nome = exigido(texto(bruto, 'nome'));
  const so = exigido(daLista(SISTEMAS_DE_APARELHO, texto(bruto, 'so')));
  const versaoSo = exigido(texto(bruto, 'versaoSo'));
  const modelo = exigido(texto(bruto, 'modelo'));
  if (id === undefined || nome === undefined || so === undefined) return undefined;
  if (versaoSo === undefined || modelo === undefined) return undefined;
  return { id, nome, so, versaoSo, modelo };
}

/**
 * Leitura dos ajustes de giro. Todos os campos são **opcionais**, e é por isso que o retorno
 * carrega o nome do campo que reprovou: sem ele a recusa não diria o que o usuário mexeu.
 */
type LeituraDeGiro =
  | { readonly ok: true; readonly gyro: AjustesDeGiro }
  | { readonly ok: false; readonly campo: string };

function lerAjustesDeGiro(bruto: Record<string, unknown>): LeituraDeGiro {
  const sensX = numero(bruto, 'sensX');
  if (ehInvalido(sensX)) return { ok: false, campo: 'sensX' };
  const sensY = numero(bruto, 'sensY');
  if (ehInvalido(sensY)) return { ok: false, campo: 'sensY' };
  const deadzone = numero(bruto, 'deadzone');
  if (ehInvalido(deadzone)) return { ok: false, campo: 'deadzone' };
  const suavizacao = numero(bruto, 'suavizacao');
  if (ehInvalido(suavizacao)) return { ok: false, campo: 'suavizacao' };
  const inverterX = booleano(bruto, 'inverterX');
  if (ehInvalido(inverterX)) return { ok: false, campo: 'inverterX' };
  const inverterY = booleano(bruto, 'inverterY');
  if (ehInvalido(inverterY)) return { ok: false, campo: 'inverterY' };
  const espaco = daLista(ESPACOS_DE_GIRO, texto(bruto, 'espaco'));
  if (ehInvalido(espaco)) return { ok: false, campo: 'espaco' };

  return {
    ok: true,
    gyro: { sensX, sensY, deadzone, suavizacao, inverterX, inverterY, espaco },
  };
}

function lerHello(bruto: Record<string, unknown>): ResultadoDeTexto {
  const v = exigido(numero(bruto, 'v'));
  if (v === undefined) return recusar('hello: campo "v" ausente ou não é número finito');

  const aparelhoBruto = exigido(objeto(bruto, 'aparelho'));
  if (aparelhoBruto === undefined) return recusar('hello: campo "aparelho" ausente ou inválido');
  const aparelho = lerAparelho(aparelhoBruto);
  if (aparelho === undefined) return recusar('hello: "aparelho" incompleto ou com "so" inválido');

  const capacidadesBrutas = exigido(lista(bruto, 'capacidades'));
  if (capacidadesBrutas === undefined) return recusar('hello: campo "capacidades" não é lista');
  const capacidades: string[] = [];
  for (const item of capacidadesBrutas) {
    if (typeof item !== 'string') return recusar('hello: "capacidades" só aceita texto');
    capacidades.push(item);
  }

  const taxaHzDesejada = exigido(numero(bruto, 'taxaHzDesejada'));
  if (taxaHzDesejada === undefined) {
    return recusar('hello: "taxaHzDesejada" ausente ou não é número finito');
  }

  const token = texto(bruto, 'token');
  if (ehInvalido(token)) return recusar('hello: "token" precisa ser texto quando presente');
  const codigoPareamento = texto(bruto, 'codigoPareamento');
  if (ehInvalido(codigoPareamento)) {
    return recusar('hello: "codigoPareamento" precisa ser texto quando presente');
  }

  return aceitar({
    t: 'hello',
    v,
    aparelho,
    capacidades,
    taxaHzDesejada,
    token,
    codigoPareamento,
  });
}

function lerWelcome(bruto: Record<string, unknown>): ResultadoDeTexto {
  const v = exigido(numero(bruto, 'v'));
  if (v === undefined) return recusar('welcome: campo "v" ausente ou não é número finito');

  const servidorBruto = exigido(objeto(bruto, 'servidor'));
  if (servidorBruto === undefined) return recusar('welcome: "servidor" ausente ou não é objeto');
  const nome = exigido(texto(servidorBruto, 'nome'));
  const versao = exigido(texto(servidorBruto, 'versao'));
  const soServidor = exigido(texto(servidorBruto, 'so'));
  if (nome === undefined || versao === undefined || soServidor === undefined) {
    return recusar('welcome: "servidor" incompleto');
  }

  const sessaoBruta = exigido(objeto(bruto, 'sessao'));
  if (sessaoBruta === undefined) return recusar('welcome: "sessao" ausente ou não é objeto');
  const idSessao = exigido(texto(sessaoBruta, 'id'));
  const taxaHz = exigido(numero(sessaoBruta, 'taxaHz'));
  const transporte = exigido(daLista(TRANSPORTES, texto(sessaoBruta, 'transporte')));
  if (idSessao === undefined || taxaHz === undefined || transporte === undefined) {
    return recusar('welcome: "sessao" incompleta ou com "transporte" inválido');
  }

  const telaBruta = exigido(objeto(bruto, 'tela'));
  if (telaBruta === undefined) return recusar('welcome: "tela" ausente ou não é objeto');
  const largura = exigido(numero(telaBruta, 'largura'));
  const altura = exigido(numero(telaBruta, 'altura'));
  if (largura === undefined || altura === undefined) return recusar('welcome: "tela" incompleta');

  const perfilAtivo = exigido(objeto(bruto, 'perfilAtivo'));
  if (perfilAtivo === undefined) return recusar('welcome: "perfilAtivo" ausente ou não é objeto');

  const perfisBrutos = exigido(lista(bruto, 'perfis'));
  if (perfisBrutos === undefined) return recusar('welcome: "perfis" não é lista');
  const perfis: PerfilResumido[] = [];
  for (const item of perfisBrutos) {
    if (!ehObjeto(item)) return recusar('welcome: item de "perfis" não é objeto');
    const idPerfil = exigido(texto(item, 'id'));
    const nomePerfil = exigido(texto(item, 'nome'));
    if (idPerfil === undefined || nomePerfil === undefined) {
      return recusar('welcome: item de "perfis" precisa de "id" e "nome"');
    }
    perfis.push({ id: idPerfil, nome: nomePerfil });
  }

  const token = texto(bruto, 'token');
  if (ehInvalido(token)) return recusar('welcome: "token" precisa ser texto quando presente');

  return aceitar({
    t: 'welcome',
    v,
    servidor: { nome, versao, so: soServidor },
    sessao: { id: idSessao, taxaHz, transporte },
    tela: { largura, altura },
    perfilAtivo,
    perfis,
    token,
  });
}

function lerErro(bruto: Record<string, unknown>): ResultadoDeTexto {
  const codigo = exigido(daLista(CODIGOS_DE_ERRO, texto(bruto, 'codigo')));
  if (codigo === undefined) return recusar('erro: "codigo" ausente ou desconhecido');
  const mensagem = texto(bruto, 'mensagem');
  if (ehInvalido(mensagem)) return recusar('erro: "mensagem" precisa ser texto quando presente');
  return aceitar({ t: 'erro', codigo, mensagem });
}

function lerConfig(bruto: Record<string, unknown>, tipo: 'config' | 'config-ok'): ResultadoDeTexto {
  const gyroBruto = exigido(objeto(bruto, 'gyro'));
  if (gyroBruto === undefined) return recusar(`${tipo}: campo "gyro" ausente ou não é objeto`);
  const leitura = lerAjustesDeGiro(gyroBruto);
  if (!leitura.ok) {
    return recusar(`${tipo}: "gyro.${leitura.campo}" com tipo, valor ou número inválido`);
  }
  const gyro = leitura.gyro;
  return aceitar(tipo === 'config' ? { t: 'config', gyro } : { t: 'config-ok', gyro });
}

function lerCmd(bruto: Record<string, unknown>): ResultadoDeTexto {
  const comando = exigido(daLista(COMANDOS, texto(bruto, 'comando')));
  if (comando === undefined) return recusar('cmd: "comando" ausente ou desconhecido');
  const perfilId = texto(bruto, 'perfilId');
  if (ehInvalido(perfilId)) return recusar('cmd: "perfilId" precisa ser texto quando presente');
  if (comando === 'trocar-perfil' && perfilId === undefined) {
    return recusar('cmd: "trocar-perfil" exige "perfilId"');
  }
  return aceitar({ t: 'cmd', comando, perfilId });
}

function lerCmdOk(bruto: Record<string, unknown>): ResultadoDeTexto {
  const comando = exigido(daLista(COMANDOS, texto(bruto, 'comando')));
  if (comando === undefined) return recusar('cmd-ok: "comando" ausente ou desconhecido');
  const resultado = objeto(bruto, 'resultado');
  if (ehInvalido(resultado)) {
    return recusar('cmd-ok: "resultado" precisa ser objeto quando presente');
  }
  return aceitar({ t: 'cmd-ok', comando, resultado });
}

function lerCmdErro(bruto: Record<string, unknown>): ResultadoDeTexto {
  const comando = exigido(daLista(COMANDOS, texto(bruto, 'comando')));
  if (comando === undefined) return recusar('cmd-erro: "comando" ausente ou desconhecido');
  const motivo = exigido(texto(bruto, 'motivo'));
  if (motivo === undefined) return recusar('cmd-erro: "motivo" ausente ou não textual');
  return aceitar({ t: 'cmd-erro', comando, motivo });
}

function lerPing(bruto: Record<string, unknown>): ResultadoDeTexto {
  const n = exigido(numero(bruto, 'n'));
  const tServidorMs = exigido(numero(bruto, 'tServidorMs'));
  if (n === undefined || tServidorMs === undefined) {
    return recusar('ping: "n" e "tServidorMs" são obrigatórios e finitos');
  }
  return aceitar({ t: 'ping', n, tServidorMs });
}

function lerPong(bruto: Record<string, unknown>): ResultadoDeTexto {
  const n = exigido(numero(bruto, 'n'));
  const tServidorMs = exigido(numero(bruto, 'tServidorMs'));
  const tDispositivoMs = exigido(numero(bruto, 'tDispositivoMs'));
  if (n === undefined || tServidorMs === undefined || tDispositivoMs === undefined) {
    return recusar('pong: "n", "tServidorMs" e "tDispositivoMs" são obrigatórios e finitos');
  }
  return aceitar({ t: 'pong', n, tServidorMs, tDispositivoMs });
}

function lerBye(bruto: Record<string, unknown>): ResultadoDeTexto {
  const motivo = texto(bruto, 'motivo');
  if (ehInvalido(motivo)) return recusar('bye: "motivo" precisa ser texto quando presente');
  return aceitar({ t: 'bye', motivo });
}

function lerAviso(bruto: Record<string, unknown>): ResultadoDeTexto {
  const codigo = exigido(daLista(CODIGOS_DE_AVISO, texto(bruto, 'codigo')));
  if (codigo === undefined) return recusar('aviso: "codigo" ausente ou desconhecido');
  const ativo = exigido(booleano(bruto, 'ativo'));
  if (ativo === undefined) return recusar('aviso: "ativo" ausente ou não é booleano');
  const mensagem = texto(bruto, 'mensagem');
  if (ehInvalido(mensagem)) return recusar('aviso: "mensagem" precisa ser texto quando presente');
  // Aviso aceso sem texto não tem o que mostrar: a tela ficaria com um aviso em branco, que é pior
  // do que nenhum — a pessoa veria que algo está errado e não saberia o quê.
  if (ativo && mensagem === undefined) return recusar('aviso: "ativo": true exige "mensagem"');
  return aceitar({ t: 'aviso', codigo, ativo, mensagem });
}

/**
 * Lê um quadro de texto e devolve a mensagem tipada ou o motivo da recusa.
 * Nunca lança — nem com JSON quebrado, nem com tipo desconhecido.
 */
export function interpretarMensagemDeTexto(quadro: string): ResultadoDeTexto {
  let bruto: unknown;
  try {
    bruto = JSON.parse(quadro) as unknown;
  } catch {
    return recusar('JSON inválido');
  }
  if (!ehObjeto(bruto)) return recusar('a mensagem precisa ser um objeto JSON');

  const tipo = bruto['t'];
  if (typeof tipo !== 'string') return recusar('campo "t" ausente ou não textual');

  switch (tipo) {
    case 'hello':
      return lerHello(bruto);
    case 'welcome':
      return lerWelcome(bruto);
    case 'erro':
      return lerErro(bruto);
    case 'config':
      return lerConfig(bruto, 'config');
    case 'config-ok':
      return lerConfig(bruto, 'config-ok');
    case 'cmd':
      return lerCmd(bruto);
    case 'cmd-ok':
      return lerCmdOk(bruto);
    case 'cmd-erro':
      return lerCmdErro(bruto);
    case 'ping':
      return lerPing(bruto);
    case 'pong':
      return lerPong(bruto);
    case 'bye':
      return lerBye(bruto);
    case 'aviso':
      return lerAviso(bruto);
    default:
      return recusar(`tipo de mensagem desconhecido: ${tipo}`);
  }
}

/**
 * Serializa uma mensagem para o quadro de texto.
 *
 * `JSON.stringify` já omite campo `undefined`, que é exatamente o que o protocolo quer: campo
 * opcional ausente é ausente no fio, não `null`.
 */
export function serializarMensagemDeTexto(mensagem: MensagemDeTexto): string {
  return JSON.stringify(mensagem);
}
