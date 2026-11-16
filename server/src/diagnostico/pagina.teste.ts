/**
 * A `pagina.js` **rodando de verdade**, contra o transporte de verdade (ATI-025, rodada 2).
 *
 * Por que este arquivo existe: `pagina.js` é o maior pedaço de lógica da atividade (máquina de
 * estados da conexão, reconexão, sensor, soltura de botão) e é o único arquivo que o `tsc` não
 * olha — o programa do `tsconfig.json` só enxerga os `.ts` de `src/`. Antes desta rodada a única
 * verificação sobre ele era expressão regular no texto, e foi por isso que a corrida do `onclose`
 * passou: teste nenhum executava a página. Aqui ela executa.
 *
 * Como funciona a bancada: o servidor de transporte sobe numa porta efêmera com a rota de
 * diagnóstico ligada; a `pagina.js` e os quatro módulos do codec são **baixados pelo HTTP do
 * próprio servidor** (nada é lido do disco do lado do teste), gravados numa pasta temporária e
 * importados como módulo de verdade, com `window`, `document`, `navigator` e temporizadores de
 * mentira — e um `WebSocket` que é o cliente `ws` real. Ou seja: o único pedaço fingido é o
 * navegador; o fio, o codec e o servidor são os do projeto.
 *
 * O que só o aparelho do Kaio pode dizer continua fora do alcance daqui: giroscópio de silício,
 * o motor vibrando e a sensação de instantaneidade ao girar. O que dá para provar sem aparelho —
 * handshake, N amostras virando N × 24 bytes, botão virando BOTÃO, HÁPTICO virando
 * `navigator.vibrate`, permissão do iOS, a não-regressão da corrida e, desde a ATI-031, os três
 * caminhos do sensor que não chega e a aba escondida que não disputa a sessão — está tudo aqui.
 */

import assert from 'node:assert/strict';
import { randomFillSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { criarMapeadorDeAcoes, type MapeadorDeAcoes } from '../acoes/indice.js';
import { criarAtendenteDeComandos, type AtendenteDeComandos } from '../comandos.js';
import { criarRegistrador } from '../log.js';
import { criarPipelineDeMovimento, type PipelineDeMovimento } from '../movimento/indice.js';
import { criarFechamentoDeSessao } from '../principal.js';
import {
  TIPO_BOTAO,
  TIPO_MOVIMENTO,
  TIPO_SCROLL,
  VERSAO_PROTOCOLO,
  type PacoteDecodificado,
} from '../protocolo/indice.js';
import { criarBackendDubla, type BackendDubla } from '../saida/dubla.js';
import { criarServidorDeTransporte, type ServidorDeTransporte } from '../transporte/indice.js';
import {
  MODULOS_DO_CODEC,
  PREFIXO_DO_CODEC,
  ROTA_DO_SCRIPT,
  criarAtendenteDeDiagnostico,
} from './estaticos.js';
import { enviarHaptico, enviarRumble } from './vibracao.js';

/** Nenhum teste pode ficar pendurado esperando quadro que não vem. */
const LIMITE_DE_ESPERA_MS = 4000;
/**
 * Limite para a página voltar a "conectado" depois de um desliga/liga.
 *
 * É de propósito **menor** que `ESPERA_PARA_RECONECTAR_MS` (2 s) da página: com a corrida do
 * `onclose` (parecer r1, apontamento 1) a única saída era a reconexão automática, então qualquer
 * limite abaixo de 2 s falha se o defeito voltar. Com o dono do socket respeitado, a reconexão
 * acontece na mesma volta do event loop.
 */
const LIMITE_DO_RELIGA_MS = 1200;
/** Grau por segundo em radiano por segundo — a mesma conta que a página faz. */
const GRAUS_PARA_RAD = Math.PI / 180;
/** `float32` no fio: comparar rad/s exige tolerância, e esta é folgada para 32 bits. */
const TOLERANCIA_FLOAT32 = 1e-6;

const registradorMudo = criarRegistrador('erro', 'teste', () => {
  // De propósito vazio: a saída do teste é a asserção, não o log.
});

/* ================================================================== servidor da bancada */

/** Cópia dos campos que interessam: o pacote decodificado é reaproveitado a cada chegada. */
interface PacoteVisto {
  readonly tipo: number;
  readonly seq: number;
  readonly dtMs: number;
  readonly gx: number;
  readonly gy: number;
  readonly gz: number;
  readonly idControle: number;
  readonly pressionado: boolean;
  readonly deltaVertical: number;
  readonly deltaHorizontal: number;
}

let servidor: ServidorDeTransporte;
let base: string;
let porta = 0;
let vistos: PacoteVisto[] = [];

/** Textos baixados uma vez do próprio servidor e reusados por todas as bancadas. */
let scriptDaPagina = '';
const codecServido = new Map<string, string>();
let htmlDaPagina = '';

/**
 * O atendente de comandos da ATI-009, do lado do servidor desta bancada.
 *
 * Ele fala com a **dubla** da camada de saída e com um pipeline de verdade: é o caminho inteiro do
 * botão da página até o posicionamento do cursor — menos o cursor, que nesta máquina tem dono.
 * Sem repositório de bias de propósito: teste nenhum escreve no `dados-locais/` do projeto.
 */
let dublaDeSaida: BackendDubla;
let pipelineDeComandos: PipelineDeMovimento;
let comandos: AtendenteDeComandos;
/**
 * O mapeador de ações da ATI-010, do lado do servidor desta bancada.
 *
 * Com ele ligado, o toque na página vira **evento na dubla**: é o caminho inteiro do dedo até o
 * clique, menos o clique, que nesta máquina tem dono. O háptico é o de verdade (`enviarHaptico`),
 * então o `click` de retorno volta pelo fio e chega ao motor de mentira da bancada — o ciclo
 * fechado, ida e volta.
 */
let mapeadorDeAcoes: MapeadorDeAcoes;

before(async () => {
  dublaDeSaida = criarBackendDubla({
    tela: { largura: 1920, altura: 1080 },
    posicaoInicial: { x: 0, y: 0 },
  });
  pipelineDeComandos = criarPipelineDeMovimento({ destino: dublaDeSaida });
  comandos = criarAtendenteDeComandos({
    pipeline: pipelineDeComandos,
    backend: dublaDeSaida,
    // Verdade aqui porque "de verdade" é a dubla: quem anda é o cursor virtual dela.
    cursorDeVerdade: true,
  });
  mapeadorDeAcoes = criarMapeadorDeAcoes({ destino: dublaDeSaida });

  // O fechamento de sessão **do produto**, e não uma imitação: é ele que solta o botão quando o
  // cabo é arrancado no meio de um arrastar (ATI-010, critério de aceite).
  const fecharSessao = criarFechamentoDeSessao({
    backend: dublaDeSaida,
    pipeline: pipelineDeComandos,
    acoes: mapeadorDeAcoes,
  });

  servidor = criarServidorDeTransporte({
    host: '127.0.0.1',
    porta: 0,
    registrador: registradorMudo,
    atenderHttp: criarAtendenteDeDiagnostico({ registrador: registradorMudo }),
    // Ping rápido para o `pong` da página caber no tempo de um teste sem esperar 1 s parado.
    intervaloPingMs: 150,
    aoReceberTexto: (mensagem, sessao) => comandos.tratar(mensagem, sessao),
    // Como a montagem do produto: a sessão adotada vai para o atendente, que devolve o bias do
    // aparelho e passa a ter para onde mandar o quadro `aviso` (ATI-029).
    aoAbrirSessao: (sessao) => {
      comandos.aoAbrirSessao(sessao);
    },
    aoReceberPacote: (pacote: PacoteDecodificado, sessao) => {
      comandos.observar(pacote);
      mapeadorDeAcoes.processar(pacote, sessao);
      vistos.push({
        tipo: pacote.tipo,
        seq: pacote.seq,
        dtMs: pacote.dtMs,
        gx: pacote.gx,
        gy: pacote.gy,
        gz: pacote.gz,
        idControle: pacote.idControle,
        pressionado: pacote.pressionado,
        deltaVertical: pacote.deltaVertical,
        deltaHorizontal: pacote.deltaHorizontal,
      });
    },
    aoEncerrarSessao: (sessao) => {
      comandos.aoEncerrarSessao(sessao);
      fecharSessao();
    },
  });
  const endereco = await servidor.ouvir();
  porta = endereco.porta;
  base = `http://127.0.0.1:${porta}`;

  scriptDaPagina = await baixar(ROTA_DO_SCRIPT);
  for (const nome of MODULOS_DO_CODEC) {
    codecServido.set(nome, await baixar(`${PREFIXO_DO_CODEC}${nome}.js`));
  }
  htmlDaPagina = await baixar('/diagnostico');
});

after(async () => {
  await servidor.fechar('teste encerrando');
});

async function baixar(rota: string): Promise<string> {
  const resposta = await fetch(`${base}${rota}`);
  assert.equal(resposta.status, 200, `${rota} não veio 200`);
  return resposta.text();
}

/**
 * Uma constante numérica da `pagina.js` servida, lida do próprio texto.
 *
 * Os tempos da página (espera pelo sensor, espera para reconectar, período do painel) são o que os
 * cenários da ATI-031 medem contra. Copiá-los para cá faria o teste continuar passando — ou
 * falhando — por um número que a página já não usa.
 */
function constanteDaPagina(nome: string): number {
  const achado = new RegExp(`const ${nome} = (\\d+);`).exec(scriptDaPagina);
  assert.ok(achado?.[1] !== undefined, `a pagina.js não declara ${nome}`);
  return Number(achado[1]);
}

/* ==================================================================== espera com limite */

function esperarAte(condicao: () => boolean, oQue: string, limiteMs = LIMITE_DE_ESPERA_MS): Promise<void> {
  return new Promise<void>((resolver, rejeitar) => {
    const comeco = Date.now();
    const olhar = setInterval(() => {
      if (condicao()) {
        clearInterval(olhar);
        resolver();
        return;
      }
      if (Date.now() - comeco >= limiteMs) {
        clearInterval(olhar);
        rejeitar(new Error(`tempo esgotado esperando ${oQue}`));
      }
    }, 5);
    olhar.unref();
  });
}

function dormir(ms: number): Promise<void> {
  return new Promise<void>((resolver) => {
    setTimeout(resolver, ms);
  });
}

/**
 * Deixa o painel da página redesenhar ao menos duas vezes.
 *
 * O vigia do sensor só decide no redesenho (10 Hz), não por evento: para afirmar que um aviso
 * **não** apareceu, é preciso ter dado a ele a chance de aparecer.
 */
function esperarOPainel(): Promise<void> {
  return dormir(constanteDaPagina('PERIODO_DO_PAINEL_MS') * 2 + 50);
}

/* ============================================================== o navegador de mentira */

type Ouvinte = (evento: unknown) => void;

/** Elemento de tela com o mínimo que a página usa — e nada além. */
class ElementoFalso {
  textContent = '';
  className = '';
  hidden = false;
  disabled = false;
  readonly dataset: Record<string, string> = {};
  readonly classes = new Set<string>();
  readonly classList = {
    add: (nome: string): void => {
      this.classes.add(nome);
    },
    remove: (nome: string): void => {
      this.classes.delete(nome);
    },
  };

  private readonly ouvintes = new Map<string, Ouvinte[]>();

  constructor(private readonly capturaQuebrada = false) {}

  addEventListener(nome: string, ouvinte: Ouvinte): void {
    const lista = this.ouvintes.get(nome) ?? [];
    lista.push(ouvinte);
    this.ouvintes.set(nome, lista);
  }

  setPointerCapture(_ponteiro: number): void {
    // O navegador de verdade prende o ponteiro no elemento; aqui não há ponteiro para prender.
    // Quando a bancada pede, imita o `NotFoundError` que o Chrome lança para ponteiro que já
    // não está ativo — foi assim que o defeito de engolir o toque apareceu.
    if (this.capturaQuebrada) throw new Error('NotFoundError: No active pointer with the given id');
  }

  disparar(nome: string, evento: unknown): void {
    for (const ouvinte of this.ouvintes.get(nome) ?? []) ouvinte(evento);
  }
}

interface OpcoesDaBancada {
  /** Presente = plataforma que pede permissão (iOS 13+). Ausente = Android/desktop. */
  readonly permissaoIos?: 'granted' | 'denied';
  /** `false` finge um Safari/iPhone: sem `navigator.vibrate`. */
  readonly comVibrate?: boolean;
  /** `true` faz `setPointerCapture` lançar, como o Chrome faz com ponteiro já inativo. */
  readonly capturaQuebrada?: boolean;
  /** `true` finge um navegador sem `DeviceMotionEvent` (a janela não tem o construtor). */
  readonly semDeviceMotion?: boolean;
  /** `true` finge a página aberta fora de contexto seguro (Wi-Fi sem HTTPS). */
  readonly contextoInseguro?: boolean;
}

interface Bancada {
  readonly elemento: (id: string) => ElementoFalso;
  readonly texto: (id: string) => string;
  readonly clicarLigar: () => void;
  readonly mover: (grausX: number, grausY: number, grausZ: number, intervalo?: number) => void;
  /**
   * Dispara um `devicemotion` com o evento exatamente como veio — inclusive sem `rotationRate`,
   * ou com os três eixos nulos, que é o que o navegador entrega com o sensor bloqueado (ATI-031).
   */
  readonly moverCru: (evento: unknown) => void;
  readonly pressionar: (id: string) => void;
  readonly soltar: (id: string) => void;
  /** Arrasta o dedo na faixa de scroll: uma lista de deslocamentos em pixels (positivo = desce). */
  readonly arrastarFaixa: (passosEmPixels: readonly number[]) => void;
  readonly esconderAba: () => void;
  /** A aba voltando ao primeiro plano (`visibilitychange` com `visible`). */
  readonly mostrarAba: () => void;
  /**
   * Adianta o `performance.now()` da página, sem esperar de verdade.
   *
   * É o relógio do navegador de mentira: o vigia do sensor decide por `performance.now()` contra
   * uma espera de 2,5 s, e esperar isso de verdade em cada cenário só deixaria a suíte lenta. O
   * relógio continua andando no tempo real; isto soma um adiantamento por cima.
   */
  readonly avancarRelogio: (ms: number) => void;
  /** Dispara o `pagehide` da janela: a aba sendo fechada, sem volta. */
  readonly fecharPagina: () => void;
  readonly vibracoes: readonly (number | readonly number[])[];
  readonly socketsCriados: () => number;
  readonly encerrar: () => Promise<void>;
}

/**
 * Semeia os elementos com o que o **HTML servido** já traz: texto, `hidden`, `disabled` e
 * `data-controle`.
 *
 * Sem isto o teste começaria de um estado que não é o da página real (tudo com texto vazio e
 * botão habilitado), e passaria a medir a mentira em vez do produto. Assim o ponto de partida do
 * cenário é o mesmo que o do celular ao abrir a página, e trocar um id ou um `data-controle` no
 * HTML aparece aqui em vez de virar mistério de bancada.
 */
function semearDoHtml(elemento: (id: string) => ElementoFalso): void {
  let comControle = 0;
  // O `<` final fica em olhada adiante de propósito: consumi-lo engoliria a abertura do elemento
  // seguinte, e quem some da lista é justamente o irmão colado no anterior (o `botaoEsquerdo`).
  for (const achado of htmlDaPagina.matchAll(/<[a-z]+\s([^>]*)>([^<]*)(?=<)/g)) {
    const atributos = achado[1] ?? '';
    const id = /id="([^"]+)"/.exec(atributos)?.[1];
    if (id === undefined) continue;

    const alvo = elemento(id);
    alvo.textContent = (achado[2] ?? '').trim();
    alvo.hidden = /(^|\s)hidden(\s|$)/.test(atributos);
    alvo.disabled = /(^|\s)disabled(\s|$)/.test(atributos);
    const controle = /data-controle="([^"]+)"/.exec(atributos)?.[1];
    if (controle !== undefined) {
      alvo.dataset['controle'] = controle;
      comControle += 1;
    }
  }
  assert.ok(comControle >= 2, 'a página precisa de ao menos dois botões de controle distintos');
}

/**
 * Monta a página numa pasta temporária e a importa com o navegador de mentira já instalado.
 *
 * Pasta nova a cada bancada de propósito: módulo ESM é carregado uma vez por caminho, e cada
 * cenário precisa de uma página com estado zerado.
 */
async function abrirBancada(opcoes: OpcoesDaBancada = {}): Promise<Bancada> {
  const pasta = mkdtempSync(join(tmpdir(), 'controle-pagina-'));
  writeFileSync(join(pasta, 'package.json'), '{"type":"module"}', 'utf8');
  writeFileSync(join(pasta, 'pagina.js'), scriptDaPagina, 'utf8');
  mkdirSync(join(pasta, 'protocolo'));
  for (const [nome, corpo] of codecServido) {
    writeFileSync(join(pasta, 'protocolo', `${nome}.js`), corpo, 'utf8');
  }

  const elementos = new Map<string, ElementoFalso>();
  const elemento = (id: string): ElementoFalso => {
    let achado = elementos.get(id);
    if (achado === undefined) {
      achado = new ElementoFalso(opcoes.capturaQuebrada === true);
      elementos.set(id, achado);
    }
    return achado;
  };
  semearDoHtml(elemento);

  const relogios = new Set<NodeJS.Timeout>();
  const agendar = (acao: () => void, atraso: number): NodeJS.Timeout => {
    const relogio = setTimeout(() => {
      relogios.delete(relogio);
      acao();
    }, atraso);
    relogio.unref();
    relogios.add(relogio);
    return relogio;
  };
  const repetir = (acao: () => void, periodo: number): NodeJS.Timeout => {
    const relogio = setInterval(acao, periodo);
    relogio.unref();
    relogios.add(relogio);
    return relogio;
  };

  const vibracoes: (number | readonly number[])[] = [];
  const guardados = new Map<string, string>();
  const ouvintesDaJanela = new Map<string, Ouvinte[]>();
  const ouvintesDoDocumento = new Map<string, Ouvinte[]>();

  const navegador: {
    userAgent: string;
    maxTouchPoints: number;
    vibrate?: (padrao: number | readonly number[]) => boolean;
    wakeLock: { request: (tipo: string) => Promise<{ addEventListener: (n: string, f: () => void) => void; release: () => Promise<void> }> };
  } = {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36',
    maxTouchPoints: 5,
    wakeLock: {
      request: (_tipo: string) =>
        Promise.resolve({
          addEventListener: (_nome: string, _acao: () => void): void => {
            // A trava de mentira nunca é solta pelo sistema.
          },
          release: () => Promise.resolve(),
        }),
    },
  };
  if (opcoes.comVibrate !== false) {
    navegador.vibrate = (padrao) => {
      vibracoes.push(padrao);
      return true;
    };
  }

  const eventoDeMovimento: { requestPermission?: () => Promise<string> } = {};
  if (opcoes.permissaoIos !== undefined) {
    const resposta = opcoes.permissaoIos;
    eventoDeMovimento.requestPermission = () => Promise.resolve(resposta);
  }

  let criados = 0;
  class WebSocketContado extends WebSocket {
    constructor(endereco: string) {
      super(endereco);
      criados += 1;
    }
  }

  const documento = {
    visibilityState: 'visible',
    getElementById: (id: string): ElementoFalso => elemento(id),
    addEventListener: (nome: string, ouvinte: Ouvinte): void => {
      const lista = ouvintesDoDocumento.get(nome) ?? [];
      lista.push(ouvinte);
      ouvintesDoDocumento.set(nome, lista);
    },
  };

  const janela = {
    location: { protocol: 'http:', host: `127.0.0.1:${porta}` },
    isSecureContext: opcoes.contextoInseguro !== true,
    navigator: navegador,
    DeviceMotionEvent: opcoes.semDeviceMotion === true ? undefined : eventoDeMovimento,
    localStorage: {
      getItem: (chave: string): string | null => guardados.get(chave) ?? null,
      setItem: (chave: string, valor: string): void => {
        guardados.set(chave, valor);
      },
    },
    crypto: {
      getRandomValues: (alvo: Uint8Array): Uint8Array => randomFillSync(alvo),
    },
    setTimeout: agendar,
    clearTimeout: (relogio: NodeJS.Timeout): void => {
      clearTimeout(relogio);
      relogios.delete(relogio);
    },
    setInterval: repetir,
    addEventListener: (nome: string, ouvinte: Ouvinte): void => {
      const lista = ouvintesDaJanela.get(nome) ?? [];
      lista.push(ouvinte);
      ouvintesDaJanela.set(nome, lista);
    },
    removeEventListener: (nome: string, ouvinte: Ouvinte): void => {
      const lista = ouvintesDaJanela.get(nome);
      if (lista === undefined) return;
      const posicao = lista.indexOf(ouvinte);
      if (posicao !== -1) lista.splice(posicao, 1);
    },
  };

  // `performance` é global no navegador e no Node, e a página o usa sem `window.`. Trocar o global
  // não mexe no servidor da bancada: o transporte e o pipeline importam o de `node:perf_hooks`,
  // que é outra referência e continua sendo o relógio de verdade.
  const relogioReal = globalThis.performance;
  let adiantamentoMs = 0;
  const relogioDaPagina = { now: (): number => relogioReal.now() + adiantamentoMs };

  const globais = globalThis as unknown as Record<string, unknown>;
  globais['window'] = janela;
  globais['document'] = documento;
  globais['WebSocket'] = WebSocketContado;
  globais['performance'] = relogioDaPagina;

  const carregar = (endereco: string): Promise<unknown> => import(endereco) as Promise<unknown>;
  await carregar(pathToFileURL(join(pasta, 'pagina.js')).href);

  const dispararNaJanela = (nome: string, evento: unknown): void => {
    for (const ouvinte of [...(ouvintesDaJanela.get(nome) ?? [])]) ouvinte(evento);
  };

  const encerrar = async (): Promise<void> => {
    if (elemento('ligar').textContent === 'desligar') {
      elemento('ligar').disparar('click', {});
      // Dá uma volta ao event loop para o `bye` sair e o socket fechar antes do próximo cenário.
      await new Promise<void>((resolver) => {
        const relogio = setTimeout(resolver, 60);
        relogio.unref();
      });
    }
    for (const relogio of relogios) {
      clearTimeout(relogio);
      clearInterval(relogio);
    }
    relogios.clear();
    delete globais['window'];
    delete globais['document'];
    delete globais['WebSocket'];
    globais['performance'] = relogioReal;
    rmSync(pasta, { recursive: true, force: true });
  };

  const mudarVisibilidade = (estado: 'hidden' | 'visible'): void => {
    documento.visibilityState = estado;
    for (const ouvinte of ouvintesDoDocumento.get('visibilitychange') ?? []) ouvinte({});
  };

  return {
    elemento,
    texto: (id) => elemento(id).textContent,
    clicarLigar: () => {
      elemento('ligar').disparar('click', {});
    },
    mover: (grausX, grausY, grausZ, intervalo = 16) => {
      dispararNaJanela('devicemotion', {
        // `beta → gx`, `gamma → gy`, `alpha → gz` (PROTOCOLO.md, seção 1, e `pagina.js`).
        rotationRate: { beta: grausX, gamma: grausY, alpha: grausZ },
        interval: intervalo,
      });
    },
    moverCru: (evento) => {
      dispararNaJanela('devicemotion', evento);
    },
    pressionar: (id) => {
      elemento(id).disparar('pointerdown', {
        pointerId: 1,
        preventDefault: () => {
          // O navegador de verdade cancelaria o gesto; aqui não há gesto.
        },
      });
    },
    soltar: (id) => {
      elemento(id).disparar('pointerup', {});
    },
    arrastarFaixa: (passosEmPixels) => {
      const faixa = elemento('faixaScroll');
      let y = 0;
      faixa.disparar('pointerdown', {
        pointerId: 9,
        clientY: y,
        preventDefault: () => {
          // O navegador de verdade cancelaria a rolagem da própria página; aqui não há página.
        },
      });
      for (const passo of passosEmPixels) {
        y += passo;
        faixa.disparar('pointermove', { pointerId: 9, clientY: y });
      }
      faixa.disparar('pointerup', {});
    },
    esconderAba: () => {
      mudarVisibilidade('hidden');
    },
    mostrarAba: () => {
      mudarVisibilidade('visible');
    },
    avancarRelogio: (ms) => {
      adiantamentoMs += ms;
    },
    /**
     * A aba sendo fechada, ou o app do navegador saindo de cena: é o `pagehide` da janela.
     *
     * É a saída mais comum de todas no celular, e a única que não tem volta — não há
     * `visibilitychange` depois, nem reconexão. Se a soltura não sair daqui, quem fecha a aba com
     * o dedo no botão depende da rede de segurança do PC (o fim de sessão, que pode demorar até o
     * limite de `pong`).
     */
    fecharPagina: () => {
      dispararNaJanela('pagehide', {});
    },
    vibracoes,
    socketsCriados: () => criados,
    encerrar,
  };
}

function zerarObservacao(): void {
  vistos = [];
}

function medidas(): { pacotesRecebidos: number; bytesRecebidos: number; descartados: number; foraDeOrdem: number } {
  const instantaneo = servidor.sessaoAtual()?.instantaneo().medidas;
  return {
    pacotesRecebidos: instantaneo?.pacotesRecebidos ?? 0,
    bytesRecebidos: instantaneo?.bytesRecebidos ?? 0,
    descartados: instantaneo?.descartados ?? 0,
    foraDeOrdem: instantaneo?.foraDeOrdem ?? 0,
  };
}

/**
 * Um segundo aparelho, cru: abre o socket, completa o `hello` e responde `ping`.
 *
 * É ele que tira a sessão da página no caso de campo da ATI-031. Lá era a outra aba do Chrome;
 * aqui é um cliente `ws` de verdade, porque o que interessa é o servidor ver um `hello` novo e
 * mandar `SESSAO_SUBSTITUIDA` para a página, como fez com o aparelho. Ele responde `ping` para não
 * cair por silêncio no meio do cenário: "a página não reconectou" não pode ser confundido com
 * "ninguém mais está conectado".
 */
async function conectarOutroAparelho(nome: string): Promise<WebSocket> {
  const outro = new WebSocket(`ws://127.0.0.1:${porta}`);
  let recebeuWelcome = false;
  outro.on('message', (dados: Buffer, ehBinario: boolean) => {
    if (ehBinario) return;
    const quadro = JSON.parse(dados.toString('utf8')) as { t?: unknown; n?: unknown; tServidorMs?: unknown };
    if (quadro.t === 'welcome') recebeuWelcome = true;
    if (quadro.t === 'ping') {
      outro.send(JSON.stringify({ t: 'pong', n: quadro.n, tServidorMs: quadro.tServidorMs, tDispositivoMs: 0 }));
    }
  });
  await new Promise<void>((resolver, rejeitar) => {
    outro.once('open', () => {
      resolver();
    });
    outro.once('error', rejeitar);
  });
  outro.send(
    JSON.stringify({
      t: 'hello',
      v: VERSAO_PROTOCOLO,
      aparelho: { id: 'b0a1b2c3d4e5', nome, so: 'android', versaoSo: '14', modelo: 'Chrome/151' },
      capacidades: ['giroscopio', 'toque'],
      taxaHzDesejada: 100,
    }),
  );
  await esperarAte(() => recebeuWelcome, 'o welcome do outro aparelho');
  return outro;
}

/* ======================================================================= o caminho feliz */

describe('a página de diagnóstico rodando contra o servidor', () => {
  it('conecta, manda MOVIMENTO e BOTÃO, responde pong e vibra com o que vem do PC', async () => {
    zerarObservacao();
    const bancada = await abrirBancada();

    try {
      assert.equal(bancada.texto('estado'), 'desligado');
      // Botão só existe depois do `welcome`: apertar antes não pode virar pacote.
      assert.equal(bancada.elemento('botaoEsquerdo').disabled, true);
      // `localhost` é contexto seguro: o cartão de aviso não pode aparecer aqui.
      assert.equal(bancada.elemento('cartaoInseguro').hidden, true);

      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');
      assert.equal(bancada.elemento('botaoEsquerdo').disabled, false);
      assert.match(bancada.texto('detalhe'), /^sessão s-\d+ · /);

      // 30 amostras de 30 °/s em X e 90 °/s em Y — os mesmos números do relatório da rodada 1.
      for (let i = 0; i < 30; i += 1) bancada.mover(30, 90, 0);

      await esperarAte(() => vistos.length >= 30, 'as 30 amostras chegarem no servidor');

      const movimentos = vistos.filter((pacote) => pacote.tipo === TIPO_MOVIMENTO);
      assert.equal(movimentos.length, 30);
      const primeiro = movimentos[0];
      assert.ok(primeiro !== undefined);
      // A conversão de unidade acontece uma vez, na página, antes do fio (°/s → rad/s).
      assert.ok(Math.abs(primeiro.gx - 30 * GRAUS_PARA_RAD) < TOLERANCIA_FLOAT32, `gx=${primeiro.gx}`);
      assert.ok(Math.abs(primeiro.gy - 90 * GRAUS_PARA_RAD) < TOLERANCIA_FLOAT32, `gy=${primeiro.gy}`);
      assert.equal(primeiro.gz, 0);
      // `event.interval` é crível (16 ms), então é ele que vai no `dtMs`, não a medição própria.
      assert.ok(Math.abs(primeiro.dtMs - 16) < 0.01, `dtMs=${primeiro.dtMs}`);

      // Dois controles distintos, pressionar e soltar: quatro pacotes de BOTÃO.
      bancada.pressionar('botaoEsquerdo');
      bancada.soltar('botaoEsquerdo');
      bancada.pressionar('botaoDireito');
      bancada.soltar('botaoDireito');

      await esperarAte(() => vistos.length >= 34, 'os quatro BOTÃO chegarem');

      const botoes = vistos.filter((pacote) => pacote.tipo === TIPO_BOTAO);
      assert.deepEqual(
        botoes.map((pacote) => `${pacote.idControle}:${pacote.pressionado ? 'baixo' : 'cima'}`),
        ['1:baixo', '1:cima', '2:baixo', '2:cima'],
      );

      // A conta de bytes do servidor: 30 × 24 (MOVIMENTO) + 4 × 8 (BOTÃO).
      const conta = medidas();
      assert.equal(conta.pacotesRecebidos, 34);
      assert.equal(conta.bytesRecebidos, 30 * 24 + 4 * 8);
      assert.equal(conta.descartados, 0);
      assert.equal(conta.foraDeOrdem, 0);

      // O painel da própria página (atualizado no intervalo de desenho, não por pacote).
      await esperarAte(() => bancada.texto('enviados') === '30', 'o painel somar os 30 movimentos');
      await esperarAte(() => bancada.texto('botoesEnviados') === '4', 'o painel somar os 4 botões');

      // Heartbeat: sem `pong` a sessão cairia em 3 s (PROTOCOLO.md, seção 2).
      await esperarAte(() => bancada.texto('pongs') !== '0', 'a página responder ao menos um pong');
      assert.equal(servidor.sessaoAtual()?.instantaneo().estado, 'ativa');

      // Retorno háptico do clique (ATI-010): o `click` sai do PC no **aperto**, e só nele — dois
      // apertos, duas vibrações de 25 ms (PROTOCOLO.md, seção 5.2).
      await esperarAte(() => bancada.vibracoes.length >= 2, 'os dois clicks de retorno chegarem');
      assert.deepEqual(bancada.vibracoes.slice(0, 2), [25, 25]);

      // Sentido de volta: o PC dispara, a página decodifica e chama `navigator.vibrate`.
      const antesDaVibracao = bancada.vibracoes.length;
      assert.equal(enviarHaptico(servidor.sessaoAtual(), 'sucesso'), true);
      assert.equal(enviarRumble(servidor.sessaoAtual(), 200, 80, 250), true);
      await esperarAte(
        () => bancada.vibracoes.length >= antesDaVibracao + 2,
        'as duas vibrações chegarem',
      );
      assert.deepEqual(bancada.vibracoes[antesDaVibracao], [25, 60, 25]);
      assert.equal(bancada.vibracoes[antesDaVibracao + 1], 250);
      await esperarAte(
        () => bancada.texto('vibracoes') === String(antesDaVibracao + 2),
        'o painel somar as vibrações',
      );
    } finally {
      await bancada.encerrar();
    }
  });

  it('não vibra onde navigator.vibrate não existe (Safari/iOS), mas conta o pacote recebido', async () => {
    zerarObservacao();
    const bancada = await abrirBancada({ comVibrate: false });

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');

      assert.equal(enviarHaptico(servidor.sessaoAtual(), 'click'), true);
      await esperarAte(() => bancada.texto('vibracoes') === '1', 'o marcador de vibração subir');

      // Nenhuma chamada ao motor: no iPhone o número sobe e nada se mexe — é por isso que o
      // rótulo da página diz "vib. recebidas", e não "vibrações".
      assert.equal(bancada.vibracoes.length, 0);
    } finally {
      await bancada.encerrar();
    }
  });
});

/* =========================================================== a corrida do onclose (r1 #1) */

describe('desligar e ligar em seguida', () => {
  it('mantém o socket novo vivo: o onclose do socket velho não apaga a sessão nova', async () => {
    zerarObservacao();
    const bancada = await abrirBancada();

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o primeiro welcome');

      for (let i = 0; i < 5; i += 1) bancada.mover(10, 0, 0);
      await esperarAte(() => vistos.length >= 5, 'as cinco primeiras amostras');

      // O toque duplo de quem está com o celular na mão: desligar e ligar de novo. O `onclose`
      // do socket velho chega **depois** de `conectar()` já ter guardado o socket novo.
      bancada.clicarLigar();
      assert.equal(bancada.texto('estado'), 'desligado');
      bancada.clicarLigar();

      await esperarAte(
        () => bancada.texto('estado') === 'conectado',
        'a página voltar a conectar sem depender da reconexão automática',
        LIMITE_DO_RELIGA_MS,
      );

      // Dois sockets e só dois: o religa não precisou da reconexão automática para se salvar.
      assert.equal(bancada.socketsCriados(), 2);

      const antes = vistos.length;
      for (let i = 0; i < 20; i += 1) bancada.mover(45, 0, 0);
      await esperarAte(() => vistos.length >= antes + 20, 'as 20 amostras da sessão nova');

      // A sessão nova conta as 20 amostras — com a corrida, o servidor não recebia nenhuma.
      const conta = medidas();
      assert.equal(conta.pacotesRecebidos, 20);
      assert.equal(conta.bytesRecebidos, 20 * 24);
    } finally {
      await bancada.encerrar();
    }
  });

  it('desligar solta todo botão pressionado antes de fechar o socket', async () => {
    zerarObservacao();
    const bancada = await abrirBancada();

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');

      // Dedo ainda em cima do botão quando a pessoa desliga o diagnóstico: sem a soltura, o PC
      // ficaria com o botão preso para sempre (regra 5 do CLAUDE.md).
      bancada.pressionar('botaoEsquerdo');
      await esperarAte(() => vistos.length >= 1, 'o BOTÃO pressionado chegar');

      bancada.clicarLigar();
      await esperarAte(() => vistos.length >= 2, 'a soltura chegar antes do fechamento');

      const botoes = vistos.filter((pacote) => pacote.tipo === TIPO_BOTAO);
      assert.deepEqual(
        botoes.map((pacote) => pacote.pressionado),
        [true, false],
      );
    } finally {
      await bancada.encerrar();
    }
  });

  it('o toque vira pacote mesmo quando setPointerCapture falha', async () => {
    zerarObservacao();
    const bancada = await abrirBancada({ capturaQuebrada: true });

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');

      // Medido no Chrome: `setPointerCapture` lança `NotFoundError` quando o ponteiro já não está
      // ativo. Se a captura vier antes do pacote, a exceção aborta o ouvinte e o toque some — o
      // dedo aperta e nada chega ao PC, que num instrumento de diagnóstico é resposta mentirosa.
      bancada.pressionar('botaoEsquerdo');
      await esperarAte(() => vistos.length >= 1, 'o BOTÃO do toque sem captura');
      bancada.soltar('botaoEsquerdo');
      await esperarAte(() => vistos.length >= 2, 'a soltura do toque sem captura');

      const botoes = vistos.filter((pacote) => pacote.tipo === TIPO_BOTAO);
      assert.deepEqual(
        botoes.map((pacote) => pacote.pressionado),
        [true, false],
      );
    } finally {
      await bancada.encerrar();
    }
  });

  it('aba escondida solta o botão sem derrubar a sessão', async () => {
    zerarObservacao();
    const bancada = await abrirBancada();

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');

      bancada.pressionar('botaoDireito');
      await esperarAte(() => vistos.length >= 1, 'o BOTÃO pressionado chegar');

      // Notificação no meio do teste: a aba vai para segundo plano com o dedo no botão.
      bancada.esconderAba();
      await esperarAte(() => vistos.length >= 2, 'a soltura da aba escondida');

      const ultimo = vistos[vistos.length - 1];
      assert.ok(ultimo !== undefined);
      assert.equal(ultimo.tipo, TIPO_BOTAO);
      assert.equal(ultimo.pressionado, false);
      assert.equal(bancada.texto('estado'), 'conectado');
    } finally {
      await bancada.encerrar();
    }
  });
});

/* ================================================================ permissão de sensor (iOS) */

describe('permissão de movimento do iOS', () => {
  it('permissão concedida segue para o handshake', async () => {
    zerarObservacao();
    const bancada = await abrirBancada({ permissaoIos: 'granted' });

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');
      assert.equal(bancada.socketsCriados(), 1);
    } finally {
      await bancada.encerrar();
    }
  });

  it('permissão recusada não abre socket nenhum e diz o motivo na tela', async () => {
    zerarObservacao();
    const bancada = await abrirBancada({ permissaoIos: 'denied' });

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'sem permissão', 'a recusa aparecer');

      // Nada de conexão: sem sensor a página não tem o que medir, e uma sessão aberta só
      // roubaria a do aparelho seguinte (a v1 é um aparelho por vez).
      assert.equal(bancada.socketsCriados(), 0);
      assert.equal(bancada.texto('ligar'), 'ligar');
      assert.equal(bancada.elemento('botaoEsquerdo').disabled, true);
    } finally {
      await bancada.encerrar();
    }
  });
});

/* ============================================ os comandos da ATI-009 pela página de bancada */

describe('centralizar e sincronizar pela página', () => {
  it('o botão centralizar leva o cursor ao centro e a resposta volta para a tela', async () => {
    zerarObservacao();
    const bancada = await abrirBancada();

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');
      // Comando só existe depois do `welcome`: antes dele não há sessão para responder.
      assert.equal(bancada.elemento('centralizar').disabled, false);

      // Movimento antes de centralizar: é ele que deixa fração de pixel guardada no acumulador,
      // que é justamente o que o comando precisa zerar (ATI-009).
      for (let i = 0; i < 20; i += 1) bancada.mover(0, 5, 0);
      await esperarAte(() => vistos.length >= 20, 'as amostras chegarem antes do comando');

      bancada.elemento('centralizar').disparar('click', {});
      await esperarAte(
        () => /^centralizar:/.test(bancada.texto('respostaDoComando')),
        'a resposta do centralizar aparecer na tela',
      );

      assert.equal(bancada.texto('respostaDoComando'), 'centralizar: 960,540 · cursor movido');
      // "O celular vibra ao concluir cada comando" (ATI-009): o padrão `sucesso` chega e o motor
      // é chamado — aqui, o motor de mentira da bancada.
      await esperarAte(() => bancada.vibracoes.length >= 1, 'o háptico de sucesso chegar');
      assert.deepEqual(bancada.vibracoes[0], [25, 60, 25], 'padrão sucesso (PROTOCOLO.md, 5.2)');
      assert.deepEqual(dublaDeSaida.lerPosicaoDoMouse(), { x: 960, y: 540 });
      assert.equal(pipelineDeComandos.fracaoX, 0, 'a fração guardada foi embora com o salto');
      assert.equal(pipelineDeComandos.fracaoY, 0);
    } finally {
      await bancada.encerrar();
    }
  });

  it('o botão sincronizar mede o bias do aparelho parado e o mostra em °/s', async () => {
    zerarObservacao();
    const bancada = await abrirBancada();

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');

      bancada.elemento('sincronizar').disparar('click', {});
      // Enquanto a coleta corre, o botão fica travado e a tela pede para não mexer.
      assert.equal(bancada.elemento('sincronizar').disabled, true);

      // 150 amostras de aparelho "parado" com um bias pequeno em cada eixo — o que um giroscópio
      // de verdade acusa em cima da mesa.
      for (let i = 0; i < 150; i += 1) bancada.mover(0.3, -0.1, 0.2);
      await esperarAte(() => vistos.length >= 150, 'as amostras da coleta chegarem');
      await esperarAte(
        () => /^sincronizando — não mexa:/.test(bancada.texto('respostaDoComando')),
        'a contagem regressiva aparecer',
      );

      await esperarAte(
        () => /^bias /.test(bancada.texto('respostaDoComando')),
        'o calibrar-fim ser respondido',
      );

      assert.match(bancada.texto('respostaDoComando'), /^bias 0\.300 \/ -0\.100 \/ 0\.200 °\/s · \d+ amostras$/);
      assert.equal(bancada.elemento('sincronizar').disabled, false, 'o botão volta ao normal');
      // O háptico de conclusão também vale para o `calibrar-fim`.
      await esperarAte(() => bancada.vibracoes.length >= 1, 'o háptico de sucesso chegar');
      assert.deepEqual(bancada.vibracoes[bancada.vibracoes.length - 1], [25, 60, 25]);

      // E o bias medido está valendo no pipeline: é o que faz o aparelho parado não mover nada.
      const emGraus = (valor: number): number => valor / GRAUS_PARA_RAD;
      assert.ok(Math.abs(emGraus(pipelineDeComandos.ajustes.biasGxRadPorS) - 0.3) < 0.001);
      assert.ok(Math.abs(emGraus(pipelineDeComandos.ajustes.biasGyRadPorS) + 0.1) < 0.001);
      assert.ok(Math.abs(emGraus(pipelineDeComandos.ajustes.biasGzRadPorS) - 0.2) < 0.001);
    } finally {
      await bancada.encerrar();
    }
  });
});

/* ================================ o perfil Mouse básico pela página de bancada (ATI-010) */

/**
 * Bancada limpa do lado do **servidor**: solta o que ficou preso, joga fora a fração de entalhe
 * guardada e zera a lista de eventos da dubla.
 *
 * A dubla e o mapeador são de propósito compartilhados por todos os cenários deste arquivo (é um
 * servidor só, como na máquina de verdade), então cada cenário precisa começar do zero — senão o
 * primeiro `assert.deepEqual(dubla.eventos, ...)` leria o toque do teste anterior.
 */
function zerarSaida(): void {
  mapeadorDeAcoes.reiniciar();
  dublaDeSaida.limpar();
}

describe('o toque na página virando clique no PC', () => {
  it('aperto e soltura chegam separados ao destino — é o que faz arrastar existir', async () => {
    zerarObservacao();
    zerarSaida();
    const bancada = await abrirBancada();

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');

      bancada.pressionar('botaoEsquerdo');
      await esperarAte(() => dublaDeSaida.pressionados() === 1, 'o aperto chegar ao destino');

      // O dedo continua na tela: nenhuma soltura pode ter sido inventada pelo caminho. É esta a
      // diferença entre um clique atômico e um arrastar de verdade.
      for (let i = 0; i < 10; i += 1) bancada.mover(20, 20, 0);
      await esperarAte(() => vistos.length >= 11, 'as amostras do arrastar chegarem');
      assert.equal(dublaDeSaida.pressionados(), 1, 'o botão segue apertado durante o movimento');

      bancada.soltar('botaoEsquerdo');
      await esperarAte(() => dublaDeSaida.pressionados() === 0, 'a soltura chegar ao destino');

      assert.deepEqual(
        dublaDeSaida.eventos.filter((evento) => evento.tipo === 'botao'),
        [
          { tipo: 'botao', botao: 'esquerdo', pressionado: true },
          { tipo: 'botao', botao: 'esquerdo', pressionado: false },
        ],
      );
    } finally {
      await bancada.encerrar();
    }
  });

  it('cada botão da tela vira o botão certo do mouse', async () => {
    zerarObservacao();
    zerarSaida();
    const bancada = await abrirBancada();

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');

      for (const id of ['botaoEsquerdo', 'botaoDireito', 'botaoMeio']) {
        bancada.pressionar(id);
        bancada.soltar(id);
      }
      await esperarAte(
        () => dublaDeSaida.eventos.filter((evento) => evento.tipo === 'botao').length >= 6,
        'os três apertos e as três solturas chegarem',
      );

      assert.deepEqual(
        dublaDeSaida.eventos
          .filter((evento) => evento.tipo === 'botao' && evento.pressionado)
          .map((evento) => (evento.tipo === 'botao' ? evento.botao : '')),
        ['esquerdo', 'direito', 'meio'],
      );
      assert.equal(dublaDeSaida.pressionados(), 0);
    } finally {
      await bancada.encerrar();
    }
  });

  it('o botão de passo rola um entalhe e não deixa nada preso', async () => {
    zerarObservacao();
    zerarSaida();
    const bancada = await abrirBancada();

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');

      bancada.pressionar('scrollCima');
      bancada.soltar('scrollCima');
      bancada.pressionar('scrollBaixo');
      bancada.soltar('scrollBaixo');
      await esperarAte(
        () => dublaDeSaida.eventos.filter((evento) => evento.tipo === 'scroll').length >= 2,
        'os dois entalhes chegarem',
      );

      assert.deepEqual(
        dublaDeSaida.eventos.filter((evento) => evento.tipo === 'scroll'),
        [
          { tipo: 'scroll', vertical: 1, horizontal: 0 },
          { tipo: 'scroll', vertical: -1, horizontal: 0 },
        ],
      );
      // A soltura de um controle de impulso não repete o entalhe — e não prende nada.
      assert.equal(dublaDeSaida.pressionados(), 0);
    } finally {
      await bancada.encerrar();
    }
  });
});

describe('a faixa de scroll da página', () => {
  it('arrastar para baixo rola para baixo, em entalhe fracionário', async () => {
    zerarObservacao();
    zerarSaida();
    const bancada = await abrirBancada();

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');

      // Os contadores do mapeador são acumulados do processo (`reiniciar` solta e esquece a
      // fração, mas não zera número): o que este cenário afirma é a **diferença**.
      const detentesAntes = mapeadorDeAcoes.contadores.detentes;

      // 36 px de dedo = um entalhe (PIXELS_POR_ENTALHE da página). Três passos para baixo.
      bancada.arrastarFaixa([36, 36, 36]);
      await esperarAte(
        () => vistos.filter((pacote) => pacote.tipo === TIPO_SCROLL).length >= 3,
        'os três SCROLL chegarem',
      );

      const scrolls = vistos.filter((pacote) => pacote.tipo === TIPO_SCROLL);
      assert.equal(scrolls.length, 3);
      for (const pacote of scrolls) {
        // No fio o positivo é para cima (Win32): dedo descendo tem de mandar negativo.
        assert.ok(
          Math.abs(pacote.deltaVertical + 1) < TOLERANCIA_FLOAT32,
          `deltaVertical=${pacote.deltaVertical}`,
        );
        assert.equal(pacote.deltaHorizontal, 0);
      }

      await esperarAte(
        () => dublaDeSaida.eventos.filter((evento) => evento.tipo === 'scroll').length >= 3,
        'os três entalhes chegarem à roda',
      );
      assert.deepEqual(dublaDeSaida.eventos.filter((evento) => evento.tipo === 'scroll'), [
        { tipo: 'scroll', vertical: -1, horizontal: 0 },
        { tipo: 'scroll', vertical: -1, horizontal: 0 },
        { tipo: 'scroll', vertical: -1, horizontal: 0 },
      ]);
      // Três entalhes inteiros = três detentes, e o `tick` (12 ms) volta para o aparelho.
      assert.equal(mapeadorDeAcoes.contadores.detentes - detentesAntes, 3);
      await esperarAte(() => bancada.vibracoes.includes(12), 'o tick da detente chegar');
      await esperarAte(() => bancada.texto('scrollsEnviados') === '3', 'o painel somar os scrolls');
    } finally {
      await bancada.encerrar();
    }
  });

  it('dedo devagar não some: cinco migalhas somam um passo de roda', async () => {
    zerarObservacao();
    zerarSaida();
    const bancada = await abrirBancada();

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');

      // 1 px por evento é 1/36 de entalhe: abaixo do passo mínimo do PC (1/8). Sem acumulador, os
      // cinco pacotes seriam arredondados para zero e o dedo devagar não rolaria nada.
      bancada.arrastarFaixa([1, 1, 1, 1, 1]);
      await esperarAte(
        () => vistos.filter((pacote) => pacote.tipo === TIPO_SCROLL).length >= 5,
        'as cinco migalhas chegarem',
      );
      await esperarAte(
        () => dublaDeSaida.eventos.filter((evento) => evento.tipo === 'scroll').length >= 1,
        'o passo completo sair para a roda',
      );

      assert.deepEqual(
        dublaDeSaida.eventos.filter((evento) => evento.tipo === 'scroll'),
        [{ tipo: 'scroll', vertical: -0.125, horizontal: 0 }],
        'cinco migalhas de 1/36 fecham um passo de 1/8 — e só um',
      );
    } finally {
      await bancada.encerrar();
    }
  });

  it('a faixa não manda nada antes do welcome', async () => {
    zerarObservacao();
    zerarSaida();
    const bancada = await abrirBancada();

    try {
      // Sem sessão não há o que controlar: o gesto na faixa não pode virar pacote.
      bancada.arrastarFaixa([36, 36]);

      assert.equal(bancada.texto('scrollsEnviados'), '0');
      assert.equal(dublaDeSaida.eventos.length, 0);
    } finally {
      await bancada.encerrar();
    }
  });
});

describe('estado preso, pela página (CLAUDE.md, regra 5)', () => {
  it('cabo arrancado no meio do arrastar: o PC solta o botão sozinho', async () => {
    zerarObservacao();
    zerarSaida();
    const bancada = await abrirBancada();

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');

      bancada.pressionar('botaoEsquerdo');
      await esperarAte(() => dublaDeSaida.pressionados() === 1, 'o aperto chegar ao destino');

      // O cabo sendo arrancado, do ponto de vista do servidor: a sessão cai e o "soltou" que
      // estava a caminho **nunca vai chegar**. Sem o fechamento de sessão, o botão ficaria
      // apertado no Windows inteiro.
      servidor.sessaoAtual()?.encerrar('cabo arrancado no meio do arrastar');

      await esperarAte(() => dublaDeSaida.pressionados() === 0, 'o PC soltar o botão sozinho');
      assert.equal(dublaDeSaida.contadores.soltasDeSeguranca, 1);
      const ultimo = dublaDeSaida.eventos[dublaDeSaida.eventos.length - 1];
      assert.deepEqual(ultimo, { tipo: 'botao', botao: 'esquerdo', pressionado: false });
    } finally {
      await bancada.encerrar();
    }
  });

  it('aba escondida no meio do arrastar: quem solta é a página, antes de o PC precisar', async () => {
    zerarObservacao();
    zerarSaida();
    const bancada = await abrirBancada();

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');

      bancada.pressionar('botaoDireito');
      await esperarAte(() => dublaDeSaida.pressionados() === 1, 'o aperto chegar ao destino');

      // Notificação chegando com o dedo no botão: a aba vai para segundo plano.
      bancada.esconderAba();

      await esperarAte(() => dublaDeSaida.pressionados() === 0, 'a soltura da aba escondida');
      // A soltura veio do BOTÃO de verdade, e não da rede de segurança do fim de sessão: a sessão
      // continua de pé, e é isso que deixa a pessoa voltar sem reconectar.
      assert.equal(dublaDeSaida.contadores.soltasDeSeguranca, 0);
      assert.equal(bancada.texto('estado'), 'conectado');
    } finally {
      await bancada.encerrar();
    }
  });

  it('desligar com o dedo na tela solta antes de fechar o socket', async () => {
    zerarObservacao();
    zerarSaida();
    const bancada = await abrirBancada();

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');

      bancada.pressionar('botaoMeio');
      await esperarAte(() => dublaDeSaida.pressionados() === 1, 'o aperto chegar ao destino');

      bancada.clicarLigar();

      await esperarAte(() => dublaDeSaida.pressionados() === 0, 'a soltura chegar antes do bye');
      assert.equal(
        dublaDeSaida.contadores.soltasDeSeguranca,
        0,
        'a soltura foi o BOTÃO da página, não a rede de segurança do PC',
      );
    } finally {
      await bancada.encerrar();
    }
  });

  it('aba fechada com o dedo no botão: o pagehide solta antes de o socket morrer', async () => {
    zerarObservacao();
    zerarSaida();
    const bancada = await abrirBancada();

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');

      bancada.pressionar('botaoEsquerdo');
      await esperarAte(() => dublaDeSaida.pressionados() === 1, 'o aperto chegar ao destino');

      // Trocar de app, fechar a aba, o navegador ser descarregado da memória: é a saída mais
      // comum no celular, e a única sem volta. Sem esta linha, quem solta é o fim de sessão do
      // PC — que, num socket meio-aberto, só acontece no limite de `pong` (até 3 s com o botão
      // apertado no Windows inteiro).
      bancada.fecharPagina();

      await esperarAte(() => dublaDeSaida.pressionados() === 0, 'a soltura sair no pagehide');
      assert.equal(
        dublaDeSaida.contadores.soltasDeSeguranca,
        0,
        'a soltura foi o BOTÃO da página, não a rede de segurança do PC',
      );
      const ultimo = dublaDeSaida.eventos[dublaDeSaida.eventos.length - 1];
      assert.deepEqual(ultimo, { tipo: 'botao', botao: 'esquerdo', pressionado: false });
    } finally {
      await bancada.encerrar();
    }
  });
});

/* ======================================================= o sensor que não chega (ATI-031) */

/** Movimento é o único tipo que interessa nos cenários do sensor. */
function movimentosVistos(): number {
  return vistos.filter((pacote) => pacote.tipo === TIPO_MOVIMENTO).length;
}

/**
 * Os três caminhos que a página precisa separar quando o giroscópio não aparece no PC.
 *
 * Cada um pede uma ação diferente de quem está com o aparelho na mão. Foi por não separá-los que o
 * teste de campo de 2026-08-25 gastou uma sessão inteira: `aoMover` descartava em silêncio o
 * evento sem `rotationRate`, e a tela mostrava zero em tudo. O vigia decide no redesenho do painel
 * contra `ESPERA_PELO_SENSOR_MS`, e a bancada **adianta** o relógio da página em vez de esperar.
 */
describe('o sensor que não chega (ATI-031)', () => {
  it('nenhum evento: depois da espera, o aviso manda ativar "Sensores de movimento"', async () => {
    zerarObservacao();
    const bancada = await abrirBancada();
    const espera = constanteDaPagina('ESPERA_PELO_SENSOR_MS');

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');

      // Antes da espera o vigia não julga: o navegador leva um tempo para entregar o primeiro
      // evento, e avisar cedo demais seria alarme falso em toda conexão.
      bancada.avancarRelogio(espera / 2);
      await esperarOPainel();
      assert.equal(bancada.elemento('cartaoInseguro').hidden, true, 'o aviso saiu antes da espera');

      bancada.avancarRelogio(espera);
      await esperarAte(() => !bancada.elemento('cartaoInseguro').hidden, 'o aviso de nenhum evento');

      assert.match(bancada.texto('textoInseguro'), /NENHUM evento de movimento/);
      assert.match(bancada.texto('textoInseguro'), /Permissões → ative "Sensores de movimento"/);
      assert.equal(bancada.texto('eventos'), '0');
      assert.equal(movimentosVistos(), 0);
    } finally {
      await bancada.encerrar();
    }
  });

  /**
   * As três formas de evento vazio. As duas primeiras são as que a ATI-031 nomeia (`rotationRate`
   * nulo, e o objeto com os três eixos nulos que alguns aparelhos entregam com a permissão negada);
   * a terceira é o evento sem o campo, que a guarda da página trata igual.
   */
  const eventosVazios: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['rotationRate nulo', { rotationRate: null, interval: 16 }],
    ['os três eixos nulos', { rotationRate: { alpha: null, beta: null, gamma: null }, interval: 16 }],
    ['sem o campo rotationRate', { interval: 16 }],
  ];

  for (const [nome, evento] of eventosVazios) {
    it(`evento vazio (${nome}): o painel conta os vazios, o aviso é o outro e nenhum MOVIMENTO sai`, async () => {
      zerarObservacao();
      const bancada = await abrirBancada();
      const espera = constanteDaPagina('ESPERA_PELO_SENSOR_MS');

      try {
        bancada.clicarLigar();
        await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');

        for (let i = 0; i < 5; i += 1) bancada.moverCru(evento);
        // Contado antes de qualquer filtro, e o descarte deixou de ser silencioso.
        await esperarAte(() => bancada.texto('eventos') === '5 (5 vazios)', 'o painel contar os cinco vazios');
        assert.equal(bancada.elemento('cartaoInseguro').hidden, true, 'o aviso saiu antes da espera');

        bancada.avancarRelogio(espera);
        await esperarAte(() => !bancada.elemento('cartaoInseguro').hidden, 'o aviso de evento vazio');

        assert.match(bancada.texto('textoInseguro'), /SEM velocidade angular/);
        assert.doesNotMatch(bancada.texto('textoInseguro'), /NENHUM/, 'chegou evento: a causa é outra');
        // Evento vazio não pode virar MOVIMENTO zerado no fio: para o PC isso seria um aparelho
        // parado, e o diagnóstico mentiria do lado de lá também.
        assert.equal(bancada.texto('enviados'), '0');
        assert.equal(movimentosVistos(), 0);
        assert.equal(medidas().pacotesRecebidos, 0);
      } finally {
        await bancada.encerrar();
      }
    });
  }

  it('evento bom: o aviso não aparece, e eventos do sensor é igual a movimento enviado', async () => {
    zerarObservacao();
    const bancada = await abrirBancada();
    const espera = constanteDaPagina('ESPERA_PELO_SENSOR_MS');

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');

      for (let i = 0; i < 20; i += 1) bancada.mover(10, -5, 2);
      await esperarAte(() => movimentosVistos() >= 20, 'as 20 amostras chegarem no servidor');

      // Bem depois da espera: sensor vivo não tem aviso, nem atrasado.
      bancada.avancarRelogio(espera * 2);
      await esperarOPainel();
      assert.equal(bancada.elemento('cartaoInseguro').hidden, true);
      assert.equal(bancada.texto('textoInseguro'), '');

      await esperarAte(() => bancada.texto('enviados') === '20', 'o painel somar os 20 movimentos');
      assert.equal(bancada.texto('eventos'), '20', 'tudo que chegou saiu: nada foi descartado');
    } finally {
      await bancada.encerrar();
    }
  });
});

/**
 * O vigia julga **a sessão**, e não a página (parecer r1, apontamentos 3 e 4).
 *
 * Os contadores do painel somam desde o carregamento, e a reconexão é caminho comum (queda, aba que
 * volta ao primeiro plano). Comparando o total com uma janela que reinicia a cada sessão, a sessão
 * 2 sem evento passava por saudável por causa da sessão 1, e o aviso da sessão 1 ficava na tela de
 * uma sessão 2 saudável. E a causa que a partida já provou não pode ser trocada por "ative a
 * permissão", que não resolve nada.
 */
describe('o vigia do sensor julga a sessão, não a página (ATI-031)', () => {
  it('sessão 2 sem evento depois de uma sessão 1 saudável: o vigia avisa', async () => {
    zerarObservacao();
    const bancada = await abrirBancada();
    const espera = constanteDaPagina('ESPERA_PELO_SENSOR_MS');

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o primeiro welcome');

      for (let i = 0; i < 20; i += 1) bancada.mover(10, 0, 0);
      await esperarAte(() => movimentosVistos() >= 20, 'as amostras da sessão 1');

      // A queda do lado do servidor, com a aba à vista: a página reconecta sozinha, que é o
      // caminho que a ATI-031 tornou comum.
      servidor.sessaoAtual()?.encerrar('queda no meio do teste');
      await esperarAte(
        () => bancada.socketsCriados() === 2 && bancada.texto('estado') === 'conectado',
        'a reconexão automática',
      );

      // Sessão 2: nada chega.
      bancada.avancarRelogio(espera);
      await esperarAte(() => !bancada.elemento('cartaoInseguro').hidden, 'o aviso da sessão 2');
      assert.match(bancada.texto('textoInseguro'), /NENHUM evento de movimento/);
      // O painel continua somando desde que a página abriu: é a conta da página, não a do vigia.
      assert.equal(bancada.texto('eventos'), '20');
    } finally {
      await bancada.encerrar();
    }
  });

  it('o aviso da sessão 1 sai da tela quando a sessão 2 é saudável', async () => {
    zerarObservacao();
    const bancada = await abrirBancada();
    const espera = constanteDaPagina('ESPERA_PELO_SENSOR_MS');

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o primeiro welcome');
      bancada.avancarRelogio(espera);
      await esperarAte(() => !bancada.elemento('cartaoInseguro').hidden, 'o aviso da sessão 1');

      // Desliga e liga: a sessão 2 assina o sensor de novo.
      bancada.clicarLigar();
      assert.equal(bancada.texto('estado'), 'desligado');
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o segundo welcome', LIMITE_DO_RELIGA_MS);

      for (let i = 0; i < 5; i += 1) bancada.mover(10, 0, 0);
      await esperarAte(() => bancada.elemento('cartaoInseguro').hidden, 'o aviso velho sair da tela');
      assert.equal(bancada.texto('textoInseguro'), '');

      // E não volta depois da espera: sessão saudável não tem aviso (critério 4 da ATI-031).
      bancada.avancarRelogio(espera * 2);
      await esperarOPainel();
      assert.equal(bancada.elemento('cartaoInseguro').hidden, true);
    } finally {
      await bancada.encerrar();
    }
  });

  const causasDaPartida: ReadonlyArray<readonly [string, OpcoesDaBancada, RegExp]> = [
    ['navegador sem DeviceMotionEvent', { semDeviceMotion: true }, /não tem DeviceMotionEvent/],
    ['contexto inseguro', { contextoInseguro: true }, /contexto inseguro/],
  ];

  for (const [nome, opcoes, causa] of causasDaPartida) {
    it(`${nome}: o vigia não troca a causa provada na partida pela instrução de permissão`, async () => {
      zerarObservacao();
      const bancada = await abrirBancada(opcoes);
      const espera = constanteDaPagina('ESPERA_PELO_SENSOR_MS');

      try {
        // A causa aparece na carga da página, antes de qualquer conexão.
        assert.equal(bancada.elemento('cartaoInseguro').hidden, false);
        assert.match(bancada.texto('textoInseguro'), causa);
        const daPartida = bancada.texto('textoInseguro');

        bancada.clicarLigar();
        await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');
        bancada.avancarRelogio(espera * 2);
        await esperarOPainel();

        assert.equal(bancada.texto('textoInseguro'), daPartida);
        assert.equal(bancada.elemento('cartaoInseguro').hidden, false);
      } finally {
        await bancada.encerrar();
      }
    });
  }
});

/* =============================================== a aba escondida não disputa (ATI-031) */

/**
 * A aba escondida não volta a disputar a sessão: o segundo defeito do teste de campo.
 *
 * Em campo, duas abas do Chrome abertas na página se substituíram a cada ~2 s por 90 s. A aba em
 * segundo plano não recebe `devicemotion`, mas reconectava sozinha a cada queda e tirava a sessão
 * de quem estava com o sensor vivo. O conserto é `agendarReconexao` desistir com a aba escondida.
 * Estes cenários são a regressão dele, e por isso esperam **de verdade** mais que
 * `ESPERA_PARA_RECONECTAR_MS`: o que se afirma é que nenhuma tentativa sai nesse tempo.
 */
describe('a aba escondida não disputa a sessão (ATI-031)', () => {
  it('perde a sessão para outro aparelho e não a toma de volta; na volta à frente, reconecta', async () => {
    zerarObservacao();
    const bancada = await abrirBancada();
    const esperaParaReconectar = constanteDaPagina('ESPERA_PARA_RECONECTAR_MS');
    let outro: WebSocket | undefined;

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');
      assert.equal(bancada.socketsCriados(), 1);

      bancada.esconderAba();
      // A sessão de pé continua: quem atende uma notificação e volta não perde a conexão.
      assert.equal(bancada.texto('estado'), 'conectado');

      // A outra aba do caso de campo: um `hello` novo, e o servidor substitui a sessão.
      outro = await conectarOutroAparelho('Outra aba');
      await esperarAte(
        () => /esperando a aba voltar/.test(bancada.texto('estado')),
        'a página ver que perdeu a sessão',
      );

      await dormir(esperaParaReconectar + 600);
      assert.equal(bancada.socketsCriados(), 1, 'a aba escondida tentou retomar a sessão');
      assert.equal(servidor.sessaoAtual()?.aparelho?.nome, 'Outra aba');
      // A tela diz o que vai acontecer, e não "tentando de novo" sem tentativa nenhuma.
      assert.match(bancada.texto('estado'), /esperando a aba voltar/);

      bancada.mostrarAba();
      await esperarAte(
        () => bancada.texto('estado') === 'conectado',
        'a reconexão na volta ao primeiro plano',
        LIMITE_DO_RELIGA_MS,
      );
      assert.equal(bancada.socketsCriados(), 2);
      assert.equal(servidor.sessaoAtual()?.aparelho?.nome, 'Navegador de diagnostico');
    } finally {
      outro?.close();
      await bancada.encerrar();
    }
  });

  it('a tentativa já agendada é cancelada quando a aba se esconde', async () => {
    zerarObservacao();
    const bancada = await abrirBancada();
    const esperaParaReconectar = constanteDaPagina('ESPERA_PARA_RECONECTAR_MS');

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');

      // A queda acontece com a aba à vista: a reconexão fica agendada para daqui a 2 s.
      servidor.sessaoAtual()?.encerrar('queda com a aba à vista');
      await esperarAte(() => bancada.texto('estado') === 'caiu · tentando de novo', 'a reconexão ser agendada');

      bancada.esconderAba();
      assert.match(bancada.texto('estado'), /esperando a aba voltar/);

      await dormir(esperaParaReconectar + 600);
      assert.equal(bancada.socketsCriados(), 1, 'a tentativa agendada saiu com a aba escondida');
      assert.equal(servidor.sessaoAtual(), undefined);

      bancada.mostrarAba();
      await esperarAte(
        () => bancada.texto('estado') === 'conectado',
        'a reconexão na volta ao primeiro plano',
        LIMITE_DO_RELIGA_MS,
      );
      assert.equal(bancada.socketsCriados(), 2);
    } finally {
      await bancada.encerrar();
    }
  });
});

/* ========================================== o aviso de bias alto do PC na página (ATI-029) */

describe('o aviso de bias alto na página (ATI-029)', () => {
  const FRASE = 'bias alto detectado (2,0 °/s) — use sincronizar';

  /**
   * Sensor com 2 °/s de bias num eixo e o aparelho parado: 2,5 s de amostras de 10 ms, o bastante
   * para a leitura se sustentar pelo tempo base e o PC acender o aviso.
   */
  async function sensorRuimParado(bancada: Bancada): Promise<void> {
    const antes = vistos.length;
    for (let i = 0; i < 250; i += 1) bancada.mover(2, 0, 0, 10);
    await esperarAte(() => vistos.length >= antes + 250, 'as amostras do sensor ruim chegarem');
  }

  it('aparece ao lado do sincronizar com o texto do PC, e sincronizar o tira da tela', async () => {
    zerarObservacao();
    const bancada = await abrirBancada();

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');
      assert.equal(bancada.elemento('avisoDoPc').hidden, true, 'nada na tela de uma sessão nova');

      await sensorRuimParado(bancada);
      await esperarAte(() => !bancada.elemento('avisoDoPc').hidden, 'o aviso do PC aparecer');
      assert.equal(bancada.texto('avisoDoPc'), FRASE);

      // A instrução, seguida: sincronizar com o aparelho parado (o mesmo bias de 2 °/s).
      bancada.elemento('sincronizar').disparar('click', {});
      for (let i = 0; i < 150; i += 1) bancada.mover(2, 0, 0, 10);
      await esperarAte(() => /^bias /.test(bancada.texto('respostaDoComando')), 'o calibrar-fim ser respondido');

      await esperarAte(() => bancada.elemento('avisoDoPc').hidden, 'o aviso sair da tela');
      assert.equal(bancada.texto('avisoDoPc'), '');
      assert.ok(
        Math.abs(pipelineDeComandos.ajustes.biasGxRadPorS / GRAUS_PARA_RAD - 2) < 0.001,
        'o bias de 2 °/s passou a ser descontado',
      );
    } finally {
      await bancada.encerrar();
    }
  });

  it('sai da tela quando a página desliga: o PC esqueceu a estimativa junto com a sessão', async () => {
    zerarObservacao();
    const bancada = await abrirBancada();

    try {
      bancada.clicarLigar();
      await esperarAte(() => bancada.texto('estado') === 'conectado', 'o welcome chegar');
      await sensorRuimParado(bancada);
      await esperarAte(() => !bancada.elemento('avisoDoPc').hidden, 'o aviso do PC aparecer');

      bancada.clicarLigar(); // desligar

      assert.equal(bancada.elemento('avisoDoPc').hidden, true);
      assert.equal(bancada.texto('avisoDoPc'), '');
    } finally {
      await bancada.encerrar();
    }
  });
});
