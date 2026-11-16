/**
 * Servidor WebSocket do PC — a porta de entrada do celular (PROTOCOLO.md, seções 1 e 2).
 *
 * No modo cabo o app fala com `ws://127.0.0.1:8765` do **próprio celular**, e o `adb reverse`
 * (ver `server/scripts/adb-reverse.mjs`) encaminha esse endereço para cá pelo USB. Por isso o
 * padrão de escuta é `127.0.0.1`: nada deste servidor aparece na rede local até a ATI-013.
 *
 * Regra de sessão da v1 (ARQUITETURA.md, seção 5): **um aparelho por vez**. Uma conexão nova que
 * complete o handshake assume a sessão, e a anterior recebe `SESSAO_SUBSTITUIDA` antes de cair.
 * A troca acontece só depois de o `hello` novo ser aceito — assim uma conexão malformada nunca
 * derruba a sessão que está funcionando.
 *
 * Desde a ATI-025 a porta é aberta por um `http.Server` **nosso**, e o `WebSocketServer` se
 * pendura nele. Antes o `ws` criava um servidor HTTP interno que respondia `426` a qualquer
 * requisição comum; agora esse mesmo `426` é o padrão daqui, e quem quiser servir alguma coisa
 * na mesma porta passa `atenderHttp` (é o que a página de diagnóstico faz). Uma porta só continua
 * sendo a promessa do PROTOCOLO.md: o `adb reverse` encaminha **uma** porta pelo cabo, e pedir
 * uma segunda para servir uma página de teste seria mais um passo para errar com o celular na mão.
 *
 * O que **não** está aqui, de propósito: pareamento por token (ATI-014), descoberta por Wi-Fi
 * (ATI-013) e qualquer regra de movimento (sprint 2). O ponto de extensão de cada um está
 * marcado: `autorizarHello`, `transporte` e `aoReceberPacote`.
 */

import { STATUS_CODES, createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { hostname, platform } from 'node:os';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Registrador } from '../log.js';
import type {
  MensagemHello,
  MensagemWelcome,
  PacoteDecodificado,
  PerfilResumido,
  TelaDoWelcome,
  Transporte,
} from '../protocolo/indice.js';
import { VERSAO_PROTOCOLO, type MensagemDeTexto } from '../protocolo/indice.js';
import {
  criarSessao,
  type AutorizacaoDoHello,
  type SessaoDeTransporte,
} from './sessao.js';

/** Ping a cada 1 s (PROTOCOLO.md, seção 2). */
export const INTERVALO_DE_PING_MS = 1000;
/** Sem `pong` neste tempo, a sessão cai (PROTOCOLO.md, seção 2). */
export const LIMITE_SEM_PONG_MS = 3000;
/** Conexão que não manda `hello` neste tempo é cortada, para não travar a sessão única. */
export const LIMITE_DO_HANDSHAKE_MS = 5000;
/**
 * Maior quadro aceito. O tráfego real é de 24 a 36 bytes por pacote e algumas centenas no
 * handshake; 64 KB é folga com sobra e ao mesmo tempo um teto contra quadro absurdo.
 */
export const TAMANHO_MAXIMO_DE_QUADRO = 64 * 1024;
/** Tempo dado ao fechamento educado antes de o socket ser cortado no desligamento. */
export const GRACA_DE_FECHAMENTO_MS = 250;

/**
 * Tela provisória do `welcome`.
 *
 * O tamanho real da tela é assunto do backend de saída (`saida/`, ATI-007), que ainda não
 * existe: até lá o campo obrigatório da seção 3.2 do PROTOCOLO.md vai com um valor declarado —
 * e injetável — em vez de um número inventado escondido no meio do código.
 */
export const TELA_PROVISORIA: TelaDoWelcome = Object.freeze({ largura: 1920, altura: 1080 });

/**
 * Perfil provisório do `welcome`.
 *
 * Carregar e validar perfil de verdade é a ATI-009. O `welcome` exige `perfilAtivo` desde já
 * (seção 3.2), então o transporte manda este esqueleto — declarado, não improvisado — para o
 * app ter o que exibir enquanto o módulo `perfis/` não entra.
 */
export const PERFIL_PROVISORIO: Readonly<Record<string, unknown>> = Object.freeze({
  id: 'provisorio',
  nome: 'Provisório (ATI-005)',
  versao: 1,
  saida: 'mouse',
  orientacao: 'retrato',
  controles: [],
});

export interface EnderecoDoTransporte {
  readonly host: string;
  readonly porta: number;
}

export interface OpcoesDoServidorDeTransporte {
  readonly host: string;
  readonly porta: number;
  readonly registrador: Registrador;
  /** Taxa combinada com o app, ecoada no `welcome`. */
  readonly taxaHz?: number;
  /** Versão do servidor exibida no `welcome`. */
  readonly versaoServidor?: string;
  /** Como a sessão está ligada. Nesta fase é sempre `usb`; o Wi-Fi entra na ATI-013. */
  readonly transporte?: Transporte;
  readonly tela?: TelaDoWelcome;
  readonly perfilAtivo?: Readonly<Record<string, unknown>>;
  readonly perfis?: readonly PerfilResumido[];
  readonly intervaloPingMs?: number;
  readonly limiteSemPongMs?: number;
  readonly limiteDoHandshakeMs?: number;
  /** Relógio monotônico em ms. Trocável no teste para não depender de tempo real. */
  readonly relogio?: () => number;
  /**
   * Pareamento por token — **desligado nesta fase** (ATI-014).
   *
   * O modo cabo exige depuração USB ligada, o que já é uma barreira física, e o servidor só
   * escuta em `127.0.0.1`. Quando a ATI-014 entrar, basta passar uma função aqui: o resto do
   * caminho (recusa, `erro`, fechamento) já está pronto em `sessao.ts` e não muda.
   */
  readonly autorizarHello?: (hello: MensagemHello) => AutorizacaoDoHello;
  /** ⚠️ Caminho quente. Onde o pipeline de movimento se pendura (sprint 2). */
  readonly aoReceberPacote?: ((pacote: PacoteDecodificado, sessao: SessaoDeTransporte) => void) | undefined;
  /** Ponto de extensão para `config` e `cmd`; devolver `true` significa "eu respondi". */
  readonly aoReceberTexto?: ((mensagem: MensagemDeTexto, sessao: SessaoDeTransporte) => boolean) | undefined;
  readonly aoAbrirSessao?: ((sessao: SessaoDeTransporte) => void) | undefined;
  /**
   * Atende requisição HTTP **comum** na mesma porta do WebSocket (ATI-025).
   *
   * Devolver `true` significa "eu respondi"; `false` (ou opção ausente) cai no `426 Upgrade
   * Required`, que é o que o servidor HTTP interno do `ws` respondia antes desta atividade.
   * Não é caminho quente: uma página é carregada uma vez, e o fluxo de sensor não passa por aqui.
   */
  readonly atenderHttp?:
    | ((requisicao: IncomingMessage, resposta: ServerResponse) => boolean)
    | undefined;
  /**
   * Chamado no encerramento de uma sessão **adotada** — lugar da soltura de estado preso (ATI-007)
   * e da limpeza da memória do pipeline de movimento (ATI-008).
   *
   * "Adotada" é a palavra exata: só dispara para conexão que completou o handshake e chegou a ser
   * a sessão do servidor. Socket que abre e cai sem `hello` (segunda aba da página de diagnóstico,
   * reconexão que falhou, varredura de porta) não é sessão de ninguém e não pode soltar o botão
   * nem apagar a média exponencial de quem está com o celular na mão.
   */
  readonly aoEncerrarSessao?: ((sessao: SessaoDeTransporte, motivo: string) => void) | undefined;
}

export interface ServidorDeTransporte {
  /** Resolve quando a porta está aberta; rejeita com o erro de abertura (porta ocupada, etc.). */
  ouvir(): Promise<EnderecoDoTransporte>;
  /** Endereço efetivo (com a porta real, quando se pediu porta 0). */
  endereco(): EnderecoDoTransporte | undefined;
  /** A sessão com handshake concluído, se houver. */
  sessaoAtual(): SessaoDeTransporte | undefined;
  /** Quantas conexões existem, incluindo as que ainda não mandaram `hello`. */
  conexoesAbertas(): number;
  /** Fecha tudo: manda `bye`, solta as sessões e fecha a porta. Idempotente. */
  fechar(motivo?: string): Promise<void>;
}

/** Nome do sistema como o `welcome` mostra (PROTOCOLO.md, seção 3.2). */
function nomeDoSistema(): string {
  switch (platform()) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    default:
      return platform();
  }
}

/** Sem pareamento nesta fase: toda conexão que fale a versão certa do protocolo entra. */
const AUTORIZACAO_ABERTA: AutorizacaoDoHello = Object.freeze({ ok: true as const });

/**
 * Resposta a quem bate na porta sem pedir upgrade e sem rota que atenda.
 *
 * É a **mesma resposta**, cabeçalho por cabeçalho, que o servidor HTTP interno do `ws` dava antes
 * da ATI-025 (`ws/lib/websocket-server.js`): corpo `STATUS_CODES[426]`, `Content-Type: text/plain`
 * sem `charset` e nenhum `Connection` declarado — o que deixa valer o keep-alive padrão do
 * HTTP/1.1. Copiar até esse detalhe é de propósito: quem já dependia do comportamento (curl na
 * porta, sonda de porta ocupada, teste de terceiro) não vê diferença nenhuma na troca do servidor
 * HTTP. O corpo vem do próprio `node:http`, e não de uma string escrita à mão, para não haver
 * duas versões da mesma frase.
 */
function responder426(resposta: ServerResponse): void {
  const corpo = STATUS_CODES[426] ?? 'Upgrade Required';
  resposta.writeHead(426, {
    'Content-Length': corpo.length,
    'Content-Type': 'text/plain',
  });
  resposta.end(corpo);
}

export function criarServidorDeTransporte(
  opcoes: OpcoesDoServidorDeTransporte,
): ServidorDeTransporte {
  const registrador = opcoes.registrador;
  const relogio = opcoes.relogio ?? (() => performance.now());
  const taxaHz = opcoes.taxaHz ?? 100;
  const versaoServidor = opcoes.versaoServidor ?? '0.0.0';
  const transporte: Transporte = opcoes.transporte ?? 'usb';
  const tela = opcoes.tela ?? TELA_PROVISORIA;
  const perfilAtivo = opcoes.perfilAtivo ?? PERFIL_PROVISORIO;
  const perfis = opcoes.perfis ?? [{ id: 'provisorio', nome: 'Provisório (ATI-005)' }];
  const intervaloPingMs = opcoes.intervaloPingMs ?? INTERVALO_DE_PING_MS;
  const limiteSemPongMs = opcoes.limiteSemPongMs ?? LIMITE_SEM_PONG_MS;
  const limiteDoHandshakeMs = opcoes.limiteDoHandshakeMs ?? LIMITE_DO_HANDSHAKE_MS;
  const autorizarHello = opcoes.autorizarHello ?? (() => AUTORIZACAO_ABERTA);
  const nomeDoServidor = hostname();

  // O servidor HTTP é nosso (e não o interno do `ws`) porque a mesma porta precisa servir a
  // página de diagnóstico (ATI-025). Exceção dentro de `atenderHttp` vira `500`: um `throw` no
  // ouvinte de requisição sobe como exceção não tratada e derrubaria o processo inteiro — perder
  // a sessão do celular porque um arquivo estático sumiu seria o pior desfecho possível.
  const servidorHttp = createServer((requisicao, resposta) => {
    try {
      if (opcoes.atenderHttp?.(requisicao, resposta) === true) return;
    } catch (erro) {
      registrador.erro('falha ao atender requisição HTTP', { url: requisicao.url, erro });
      if (!resposta.headersSent) resposta.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      resposta.end('erro interno');
      return;
    }
    responder426(resposta);
  });

  const servidorWs = new WebSocketServer({
    server: servidorHttp,
    // Compressão é troca de CPU e latência por banda — exatamente o negócio errado num fluxo de
    // 24 bytes a 100 Hz. Declarado em vez de herdado, para ninguém ligar sem perceber.
    perMessageDeflate: false,
    maxPayload: TAMANHO_MAXIMO_DE_QUADRO,
    // A contagem de clientes é nossa (`sockets`), porque `wss.close()` não fecha conexão viva:
    // ter duas listas da mesma coisa só criaria chance de elas discordarem.
    clientTracking: false,
  });

  const sockets = new Set<WebSocket>();
  const sessoes = new Set<SessaoDeTransporte>();
  /**
   * Quais sessões chegaram a ser **adotadas** — as que passaram por `aoAtivar`, ou seja, que
   * completaram o handshake.
   *
   * Existe porque `aoEncerrarSessao` é o gancho de **soltura de estado** (botão preso, memória do
   * pipeline de movimento), e disparar isso pela queda de uma conexão que nunca foi sessão é
   * estrago vindo de fora: qualquer socket local — segunda aba da página `/diagnostico`, tentativa
   * de reconexão que falha, varredura de porta — apagaria a média exponencial e a fração de pixel
   * de quem está com o celular na mão, e soltaria o botão dele no meio de um arrastar.
   *
   * Um conjunto próprio, e não a comparação com `sessaoAtiva`: a sessão **substituída** já não é a
   * ativa quando o gancho corre (`aoAtivar` a encerra antes de adotar a nova), e ela é justamente
   * uma das que precisam soltar o que estavam segurando.
   */
  const adotadas = new Set<SessaoDeTransporte>();
  let sessaoAtiva: SessaoDeTransporte | undefined;
  let proximaSessao = 0;
  let enderecoAtual: EnderecoDoTransporte | undefined;
  let fechamento: Promise<void> | undefined;

  const abertura = new Promise<EnderecoDoTransporte>((resolver, rejeitar) => {
    servidorHttp.once('listening', () => {
      // `address()` devolve o endereço efetivo — é assim que a porta real aparece quando se
      // pediu porta 0 (o caso dos testes). Texto é o formato de socket Unix; `null` só
      // aconteceria com o servidor já fechado, e aí o que se sabe é o que foi pedido.
      const endereco = servidorHttp.address();
      enderecoAtual =
        endereco === null || typeof endereco === 'string'
          ? { host: opcoes.host, porta: opcoes.porta }
          : { host: endereco.address, porta: endereco.port };
      registrador.info('transporte ouvindo', {
        host: enderecoAtual.host,
        porta: enderecoAtual.porta,
        protocolo: VERSAO_PROTOCOLO,
        taxaHz,
      });
      resolver(enderecoAtual);
    });
    // Quem falha na abertura agora é o servidor HTTP (porta ocupada, host inexistente): é dele
    // que a rejeição precisa vir, porque é ele que carrega a porta desde a ATI-025.
    servidorHttp.once('error', (erro: Error) => {
      rejeitar(erro);
    });
  });
  // Sem este consumidor, uma porta ocupada viraria "unhandled rejection" antes de alguém chamar
  // `ouvir()`. Quem chama continua recebendo a rejeição normalmente — o `catch` aqui é só o
  // guarda-chuva do caso "ninguém esperou".
  void abertura.catch(() => undefined);

  servidorWs.on('error', (erro: Error) => {
    registrador.erro('erro no servidor de transporte', { erro });
  });
  servidorHttp.on('error', (erro: Error) => {
    registrador.erro('erro no servidor HTTP da porta', { erro });
  });

  // A escuta começa aqui, na criação — antes da ATI-025 quem abria a porta era o construtor do
  // `WebSocketServer`, e `ouvir()` sempre foi só a promessa de que ela abriu, nunca o gatilho.
  servidorHttp.listen(opcoes.porta, opcoes.host);

  function montarWelcome(sessao: SessaoDeTransporte): MensagemWelcome {
    return {
      t: 'welcome',
      v: VERSAO_PROTOCOLO,
      servidor: { nome: nomeDoServidor, versao: versaoServidor, so: nomeDoSistema() },
      sessao: { id: sessao.id, taxaHz, transporte },
      tela,
      perfilAtivo,
      perfis,
      // Sem pareamento nesta fase, não há token a emitir: o campo é opcional e fica ausente do
      // fio (PROTOCOLO.md, seção 3 — opcional sem valor é omitido, nunca `null`).
    };
  }

  function aoAtivar(nova: SessaoDeTransporte, hello: MensagemHello): void {
    const anterior = sessaoAtiva;
    if (anterior !== undefined && anterior !== nova) {
      registrador.info('sessão substituída', {
        anterior: anterior.id,
        nova: nova.id,
        aparelho: hello.aparelho.nome,
      });
      anterior.encerrar(
        'sessão assumida por outro aparelho',
        'SESSAO_SUBSTITUIDA',
        'outro aparelho assumiu a sessão neste PC.',
      );
    }
    sessaoAtiva = nova;
    adotadas.add(nova);
    opcoes.aoAbrirSessao?.(nova);
  }

  function aoEncerrar(sessao: SessaoDeTransporte, motivo: string): void {
    sessoes.delete(sessao);
    if (sessaoAtiva === sessao) sessaoAtiva = undefined;
    // Conexão que caiu sem nunca ter sido adotada não tem estado para soltar — e mandar soltar
    // mesmo assim apagaria o estado da sessão de verdade (ver o comentário de `adotadas`).
    if (!adotadas.delete(sessao)) return;
    opcoes.aoEncerrarSessao?.(sessao, motivo);
  }

  servidorWs.on('connection', (socket: WebSocket, requisicao) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });

    proximaSessao += 1;
    const sessao = criarSessao({
      id: `s-${proximaSessao}`,
      socket,
      // O socket cru é onde o `setNoDelay` mora: o `ws` não repassa a opção, e sem ela o Nagle
      // junta pacotes de 24 bytes e inventa atraso (PROTOCOLO.md, seção 1).
      socketCru: requisicao.socket,
      registrador,
      relogio,
      intervaloPingMs,
      limiteSemPongMs,
      limiteDoHandshakeMs,
      transporte,
      montarWelcome: (sessaoDoWelcome) => montarWelcome(sessaoDoWelcome),
      autorizarHello,
      aoAtivar,
      aoEncerrar,
      aoReceberPacote: opcoes.aoReceberPacote,
      aoReceberTexto: opcoes.aoReceberTexto,
    });
    sessoes.add(sessao);
  });

  /**
   * Corta o que sobrou depois do fechamento educado.
   *
   * `close()` manda o quadro de fechamento e espera a resposta do outro lado — que nunca chega
   * quando o cabo foi arrancado. Sem este corte, o desligamento do servidor ficaria pendurado
   * esperando um aparelho que já não existe, e o encerramento estouraria o próprio limite.
   */
  function cortarSocketsPendentes(): Promise<void> {
    if (sockets.size === 0) return Promise.resolve();
    return new Promise<void>((resolver) => {
      setTimeout(() => {
        for (const socket of sockets) socket.terminate();
        resolver();
      }, GRACA_DE_FECHAMENTO_MS);
    });
  }

  async function executarFechamento(motivo: string): Promise<void> {
    for (const sessao of [...sessoes]) {
      // `bye` antes do fechamento: encerramento limpo é o que evita botão preso do outro lado
      // (PROTOCOLO.md, seção 3.7).
      sessao.enviarTexto({ t: 'bye', motivo });
      sessao.encerrar(motivo);
    }
    await cortarSocketsPendentes();
    await new Promise<void>((resolver) => {
      servidorWs.close(() => {
        resolver();
      });
    });
    // `http.Server.close()` só chama de volta quando **toda** conexão morre, e a conexão
    // keep-alive que o navegador deixa aberta depois de carregar a página de diagnóstico fica
    // viva por segundos. Sem este corte, o Ctrl+C penduraria o encerramento esperando um
    // navegador ocioso — e o limite do controle de encerramento estouraria sozinho.
    servidorHttp.closeAllConnections();
    await new Promise<void>((resolver) => {
      servidorHttp.close(() => {
        resolver();
      });
    });
    enderecoAtual = undefined;
    registrador.info('transporte fechado', { motivo });
  }

  return {
    ouvir: () => abertura,
    endereco: () => enderecoAtual,
    sessaoAtual: () => sessaoAtiva,
    conexoesAbertas: () => sessoes.size,
    fechar(motivo = 'servidor encerrando') {
      fechamento ??= executarFechamento(motivo);
      return fechamento;
    },
  };
}
