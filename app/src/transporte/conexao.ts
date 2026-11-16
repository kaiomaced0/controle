/**
 * Cliente de transporte do celular — o outro lado de `server/src/transporte/`.
 *
 * Responsabilidades, em ordem de importância:
 * 1. **Ficar de pé sozinho.** Servidor caiu, cabo saiu, PC dormiu: o app tenta de novo com
 *    espera progressiva (0,5 s → 5 s) e volta a funcionar quando o servidor voltar, sem ninguém
 *    precisar reabrir o app.
 * 2. **Negociar a sessão.** `hello` na abertura, `welcome` como sinal verde. Enquanto o
 *    `welcome` não chega, nada de sensor sai daqui — o servidor descarta o que vier antes dele.
 * 3. **Responder o heartbeat.** `ping` do servidor vira `pong` na mesma hora; sem isso a sessão
 *    cai em 3 s (PROTOCOLO.md, seção 2). E, na direção contrária, se o **servidor** ficar mudo
 *    por 3 s, a vigia de silêncio daqui derruba o socket e religa: socket meio-aberto (PC dormiu,
 *    cabo arrancado sem FIN) não dispara `close` nenhum, e sem a vigia o app ficaria "Conectado"
 *    para sempre mentindo para quem está olhando a tela.
 *
 * ⚠️ `TCP_NODELAY` é obrigatório **nos dois lados** (PROTOCOLO.md, seção 1). Deste lado ele não
 * cabe no JavaScript: o `WebSocket` do React Native não expõe o socket TCP. Quem desliga o Nagle
 * aqui é `android/app/src/main/java/com/nortedata/controle/TcpNoDelayDoWebSocket.kt`, que troca a
 * `SocketFactory` do OkHttp usado pelo `WebSocketModule`. Mexeu num, confira o outro.
 *
 * ⚠️ CAMINHO QUENTE em `enviarBinario`: chamado 100 vezes por segundo pela ATI-006 em diante.
 * Nada de alocação, `JSON.stringify` ou log por chamada (regra 2 do CLAUDE.md).
 *
 * ⚠️ O app **não decide nada** (ADR-4): este módulo não filtra amostra, não calibra e não
 * interpreta perfil. Ele conecta, entrega bytes e avisa a interface do estado.
 *
 * @format
 */

import {
  RESULTADO_DECODIFICACAO,
  VERSAO_PROTOCOLO,
  criarDecodificador,
  interpretarMensagemDeTexto,
  serializarMensagemDeTexto,
  type AparelhoDoHello,
  type CodigoDeErro,
  type ContadoresDoCodec,
  type MensagemDeTexto,
  type PacoteDecodificado,
  type ServidorDoWelcome,
  type SessaoDoWelcome,
} from './protocolo';
import {agoraMs} from '../sensores/relogio';

/** Endereço do modo cabo: o `adb reverse` encaminha esta porta do aparelho para o PC. */
export const URL_PADRAO = 'ws://127.0.0.1:8765';

/** Primeira espera antes de tentar de novo. */
export const ESPERA_INICIAL_MS = 500;
/** Teto da espera progressiva: nunca demora mais que isto entre duas tentativas. */
export const ESPERA_MAXIMA_MS = 5000;
/** Cada tentativa espera o dobro da anterior, até o teto. */
export const FATOR_DE_ESPERA = 2;
/**
 * Sacudida aleatória de ±25 % na espera.
 *
 * Sem ela, app e servidor reiniciados juntos entram em passo travado e tentam sempre no mesmo
 * instante. Com ela, as tentativas se espalham e uma delas cai numa janela em que o servidor
 * já está pronto.
 */
export const JITTER = 0.25;

/**
 * Espera entre tentativas no regime de **sondagem** — a cadência curta e fixa.
 *
 * A escada de 0,5 s a 5 s existe para não martelar um servidor que não vai voltar tão cedo, mas
 * ela sobe muito mais rápido que o tempo de queda (conexão recusada falha na hora): 1,5 s de
 * servidor fora já jogavam a próxima tentativa para 2,4 s, e o critério de aceite 2 da ATI-005
 * pede a sessão de volta em **até 2 s**. A saída é separar os dois casos: enquanto a queda é
 * recente, a sessão já existiu e o app está em primeiro plano — que é exatamente o caso "a pessoa
 * está com o celular na mão e reencaixou o cabo" —, a espera é esta, fixa e curta.
 */
export const ESPERA_DE_SONDAGEM_MS = 400;
/**
 * Por quanto tempo a sondagem curta vale antes de a escada longa assumir.
 *
 * Passados estes 15 s, quem estiver fora provavelmente vai demorar (o PC desligou, o cabo saiu de
 * vez): martelar a 400 ms só gastaria bateria, e a escada volta a valer do primeiro degrau.
 */
export const JANELA_DE_SONDAGEM_MS = 15000;

/**
 * Silêncio do servidor que derruba o socket deste lado — o espelho do limite de `pong` do PC.
 *
 * Mesmos 3 s do servidor (PROTOCOLO.md, seção 2), pelo mesmo motivo: com `ping` a cada 1000 ms,
 * três janelas perdidas é falha, não atraso.
 */
export const LIMITE_SEM_QUADRO_MS = 3000;
/** De quanto em quanto tempo a vigia confere o relógio. Um terço do limite: erro de no máximo 1 s. */
export const INTERVALO_DA_VIGIA_MS = 1000;

/** Estado da conexão, como a interface enxerga. */
export type EstadoDaConexao =
  | 'desconectado'
  | 'conectando'
  | 'conectado'
  | 'erro';

/**
 * Erros de handshake que **não** adianta repetir sozinho.
 *
 * Reconectar em laço contra um servidor que recusou por versão só gastaria bateria e encheria o
 * log; e insistir depois de `SESSAO_SUBSTITUIDA` faria dois aparelhos brigarem pela sessão para
 * sempre. Nesses casos o estado vira `erro` e a próxima tentativa é decisão de quem está usando.
 */
export const ERROS_DEFINITIVOS: readonly CodigoDeErro[] = [
  'VERSAO_INCOMPATIVEL',
  'PAREAMENTO_NECESSARIO',
  'TOKEN_INVALIDO',
  'SESSAO_SUBSTITUIDA',
];

export type SituacaoDaConexao = {
  readonly estado: EstadoDaConexao;
  /** Tentativas de conexão desde o último sucesso. 0 quando conectado. */
  readonly tentativas: number;
  /** Espera agendada até a próxima tentativa, quando houver uma agendada. */
  readonly esperaAtualMs: number | undefined;
  /** `true` quando a próxima tentativa está na cadência curta de sondagem, não na escada. */
  readonly sondando: boolean;
  /** Última falha em texto para pessoa ler; não é código de máquina. */
  readonly ultimoErro: string | undefined;
  /** Código do último `erro` recebido do servidor (PROTOCOLO.md, seção 3.3). */
  readonly ultimoCodigo: CodigoDeErro | undefined;
  /** Dados do `welcome`, quando a sessão está de pé. */
  readonly servidor: ServidorDoWelcome | undefined;
  readonly sessao: SessaoDoWelcome | undefined;
  /** Quantos `ping` foram respondidos nesta sessão — prova de que o canal está vivo. */
  readonly pingsRespondidos: number;
};

/**
 * A parte do `WebSocket` que este módulo usa.
 *
 * Existe para o teste poder passar um dublê sem inventar um `WebSocket` inteiro, e para o
 * arquivo não depender das definições de DOM (o app não tem `lib.dom`).
 */
export type SocketDeTransporte = {
  binaryType: string;
  send(dados: string | ArrayBuffer | ArrayBufferView): void;
  close(codigo?: number, motivo?: string): void;
  onopen: (() => void) | null;
  onmessage: ((evento: {data: unknown}) => void) | null;
  onerror: ((evento: {message?: string}) => void) | null;
  onclose: ((evento: {code?: number; reason?: string}) => void) | null;
};

export type OpcoesDeConexao = {
  /** Endereço do servidor. No modo cabo, `ws://127.0.0.1:8765`. */
  readonly url?: string;
  /** Identificação do aparelho enviada no `hello` (PROTOCOLO.md, seção 3.1). */
  readonly aparelho: AparelhoDoHello;
  readonly capacidades?: readonly string[];
  readonly taxaHzDesejada?: number;
  /** Token de pareamento. Desligado nesta fase; entra na ATI-014. */
  readonly token?: string;
  readonly esperaInicialMs?: number;
  readonly esperaMaximaMs?: number;
  /** Espera da cadência curta. 0 desliga a sondagem e deixa só a escada. */
  readonly esperaDeSondagemMs?: number;
  /** Duração da janela de sondagem depois de uma queda. 0 desliga a sondagem. */
  readonly janelaDeSondagemMs?: number;
  /** Silêncio do servidor que derruba o socket deste lado. 0 desliga a vigia. */
  readonly limiteSemQuadroMs?: number;
  /** Período da vigia de silêncio. */
  readonly intervaloDaVigiaMs?: number;
  /**
   * Se o app está em primeiro plano.
   *
   * A sondagem curta só vale com o app na tela: em segundo plano, martelar a 400 ms seria gastar
   * bateria de alguém que nem está usando o controle. Quem sabe disso é o `AppState` do React
   * Native, ligado em `conexaoDoApp.ts` — aqui entra como função para o teste poder mandar.
   */
  readonly emPrimeiroPlano?: () => boolean;
  /** Relógio monotônico em ms. Trocado no teste; em produção é o `agoraMs` dos sensores. */
  readonly agora?: () => number;
  /** ⚠️ Caminho quente. RUMBLE e HÁPTICO chegam por aqui; o objeto é reaproveitado. */
  readonly aoReceberPacote?: (pacote: PacoteDecodificado) => void;
  /** Mensagens de sessão que não são do ciclo (`config-ok`, `cmd-ok`, `cmd-erro`). */
  readonly aoReceberTexto?: (mensagem: MensagemDeTexto) => void;
  /** Fábrica do socket. Trocada no teste; em produção é o `WebSocket` global do React Native. */
  readonly criarSocket?: (url: string) => SocketDeTransporte;
  /** Sorteio do jitter. Trocado no teste para a espera ficar determinística. */
  readonly aleatorio?: () => number;
};

export type Conexao = {
  /**
   * Endereço em uso, já resolvido (`opcoes.url` ou o padrão do modo cabo).
   *
   * A tela de telemetria (ATI-006) mostra este valor: "não conecta" com o endereço à vista é um
   * problema de `adb reverse`; sem ele, quem está olhando o celular não tem como saber contra
   * qual endereço o app está batendo.
   */
  readonly url: string;
  situacao(): SituacaoDaConexao;
  /** Assina mudanças de estado. Devolve o cancelamento (idempotente). */
  assinar(ouvinte: (situacao: SituacaoDaConexao) => void): () => void;
  /** Liga (ou religa) a conexão. Idempotente enquanto já estiver conectando ou conectado. */
  conectar(): void;
  /** Desliga de propósito: manda `bye`, fecha e **cancela** a reconexão automática. */
  desconectar(motivo?: string): void;
  /** ⚠️ Caminho quente. `false` quando ainda não há sessão — o pacote não é enfileirado. */
  enviarBinario(pacote: Uint8Array): boolean;
  /** Quadro de texto (baixa frequência). `false` quando não há sessão. */
  enviarTexto(mensagem: MensagemDeTexto): boolean;
  /** Contadores do codec desta conexão (PROTOCOLO.md, seção 7). */
  contadores(): ContadoresDoCodec;
};

const CAPACIDADES_PADRAO: readonly string[] = ['giroscopio', 'toque'];

/** `WebSocket` global do React Native; resolvido na chamada, não no import. */
function criarSocketPadrao(url: string): SocketDeTransporte {
  const global = globalThis as unknown as {
    WebSocket?: new (url: string) => SocketDeTransporte;
  };
  const Construtor = global.WebSocket;
  if (Construtor === undefined) {
    throw new Error('WebSocket indisponível neste ambiente JavaScript.');
  }
  return new Construtor(url);
}

export function criarConexao(opcoes: OpcoesDeConexao): Conexao {
  const url = opcoes.url ?? URL_PADRAO;
  const capacidades = opcoes.capacidades ?? CAPACIDADES_PADRAO;
  const taxaHzDesejada = opcoes.taxaHzDesejada ?? 100;
  const esperaInicialMs = opcoes.esperaInicialMs ?? ESPERA_INICIAL_MS;
  const esperaMaximaMs = opcoes.esperaMaximaMs ?? ESPERA_MAXIMA_MS;
  const esperaDeSondagemMs = opcoes.esperaDeSondagemMs ?? ESPERA_DE_SONDAGEM_MS;
  const janelaDeSondagemMs = opcoes.janelaDeSondagemMs ?? JANELA_DE_SONDAGEM_MS;
  const limiteSemQuadroMs = opcoes.limiteSemQuadroMs ?? LIMITE_SEM_QUADRO_MS;
  const intervaloDaVigiaMs = opcoes.intervaloDaVigiaMs ?? INTERVALO_DA_VIGIA_MS;
  const emPrimeiroPlano = opcoes.emPrimeiroPlano ?? (() => true);
  const agora = opcoes.agora ?? agoraMs;
  const criarSocket = opcoes.criarSocket ?? criarSocketPadrao;
  const aleatorio = opcoes.aleatorio ?? Math.random;

  const decodificador = criarDecodificador();
  const ouvintes = new Set<(situacao: SituacaoDaConexao) => void>();

  let socket: SocketDeTransporte | null = null;
  let estado: EstadoDaConexao = 'desconectado';
  let tentativas = 0;
  let esperaAtualMs: number | undefined;
  let ultimoErro: string | undefined;
  let ultimoCodigo: CodigoDeErro | undefined;
  let servidor: ServidorDoWelcome | undefined;
  let sessao: SessaoDoWelcome | undefined;
  let pingsRespondidos = 0;
  let relogioDeReconexao: ReturnType<typeof setTimeout> | undefined;
  /** Verdadeiro entre `desconectar()` e o próximo `conectar()`: nada religa sozinho. */
  let desligadoDeProposito = true;

  /** Uma sessão já foi negociada nesta conexão — é o que autoriza a sondagem curta. */
  let sessaoJaExistiu = false;
  /** Quantas das `tentativas` foram gastas na sondagem; a escada ignora essas. */
  let tentativasDeSondagem = 0;
  /** Quando começou a queda em curso, para a janela de sondagem ter de onde contar. */
  let inicioDaQuedaMs = 0;
  let sondando = false;

  /** Vigia de silêncio: o socket está aberto, mas o servidor mandou alguma coisa? */
  let relogioDaVigia: ReturnType<typeof setInterval> | undefined;
  let ultimoQuadroMs = 0;

  function montarSituacao(): SituacaoDaConexao {
    return {
      estado,
      tentativas,
      esperaAtualMs,
      sondando,
      ultimoErro,
      ultimoCodigo,
      servidor,
      sessao,
      pingsRespondidos,
    };
  }

  function avisar(): void {
    const situacao = montarSituacao();
    for (const ouvinte of Array.from(ouvintes)) {
      ouvinte(situacao);
    }
  }

  function mudarEstado(novo: EstadoDaConexao): void {
    if (estado === novo) {
      return;
    }
    estado = novo;
    avisar();
  }

  function cancelarReconexao(): void {
    if (relogioDeReconexao !== undefined) {
      clearTimeout(relogioDeReconexao);
      relogioDeReconexao = undefined;
    }
    esperaAtualMs = undefined;
  }

  /**
   * Se a próxima tentativa entra no regime de sondagem.
   *
   * As três condições juntas descrevem um caso só: a pessoa estava usando o controle, o canal caiu
   * agora e ela está olhando para a tela esperando ele voltar.
   */
  function podeSondar(): boolean {
    return (
      sessaoJaExistiu &&
      janelaDeSondagemMs > 0 &&
      esperaDeSondagemMs > 0 &&
      agora() - inicioDaQuedaMs < janelaDeSondagemMs &&
      emPrimeiroPlano()
    );
  }

  /** Espera até a próxima tentativa: cadência fixa na sondagem, escada com teto fora dela. */
  function calcularEspera(): number {
    // Na escada, o degrau conta só as tentativas que **não** foram sondagem: sem isso, sair da
    // janela de sondagem depois de 35 tentativas jogaria a espera direto no teto de 5 s.
    const degrau = Math.max(0, tentativas - tentativasDeSondagem - 1);
    const teto = sondando ? esperaDeSondagemMs : esperaMaximaMs;
    const base = sondando
      ? esperaDeSondagemMs
      : Math.min(esperaMaximaMs, esperaInicialMs * Math.pow(FATOR_DE_ESPERA, degrau));
    const sacudida = (aleatorio() * 2 - 1) * JITTER;
    // O jitter é aparado pelo teto do regime: sem isto, "0,5 s até 5 s" viraria "até 6,25 s" no
    // último degrau, e o número declarado na ATI deixaria de ser verdade por causa do sorteio.
    return Math.max(0, Math.min(teto, Math.round(base * (1 + sacudida))));
  }

  function agendarReconexao(): void {
    if (desligadoDeProposito || relogioDeReconexao !== undefined) {
      return;
    }
    sondando = podeSondar();
    if (sondando) {
      tentativasDeSondagem += 1;
    }
    const espera = calcularEspera();
    esperaAtualMs = espera;
    // Atribuição direta em vez de `mudarEstado`: o estado pode já ser 'conectando', e mesmo
    // assim a interface precisa ver a espera nova e a contagem de tentativas.
    estado = 'conectando';
    avisar();
    relogioDeReconexao = setTimeout(() => {
      relogioDeReconexao = undefined;
      esperaAtualMs = undefined;
      abrirSocket();
    }, espera);
  }

  function soltarSocket(): void {
    pararVigia();
    if (socket === null) {
      return;
    }
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket = null;
  }

  /**
   * Uma tentativa falhou: marca o início da queda (se for a primeira) e agenda a volta.
   *
   * A janela de sondagem conta do **início da queda**, não da última tentativa — senão uma queda
   * de meia hora ficaria para sempre na cadência curta, martelando um servidor que não vai voltar.
   */
  function registrarFalha(): void {
    if (tentativas === 0) {
      inicioDaQuedaMs = agora();
    }
    tentativas += 1;
    agendarReconexao();
  }

  /** ⚠️ Caminho quente (um quadro qualquer chegou). Só escreve um número. */
  function marcarQuadro(): void {
    ultimoQuadroMs = agora();
  }

  /**
   * Liga a vigia de silêncio do socket recém-criado.
   *
   * Vale desde a criação, e não só depois do `welcome`, porque conexão que abre e trava sem nunca
   * responder é o mesmo defeito visto de outro ângulo: o app fica "Conectando…" para sempre.
   */
  function iniciarVigia(): void {
    marcarQuadro();
    if (limiteSemQuadroMs <= 0 || relogioDaVigia !== undefined) {
      return;
    }
    relogioDaVigia = setInterval(() => {
      const silencioMs = agora() - ultimoQuadroMs;
      if (silencioMs < limiteSemQuadroMs) {
        return;
      }
      // Socket meio-aberto: nada de `close`, nada de `error`, e o estado continuaria 'conectado'.
      // Derrubar aqui é o que faz a escada de reconexão começar (PROTOCOLO.md, seção 2).
      ultimoErro = `servidor mudo há ${Math.round(silencioMs)} ms`;
      derrubar(socket, 1000, 'silêncio do servidor');
    }, intervaloDaVigiaMs);
  }

  function pararVigia(): void {
    if (relogioDaVigia !== undefined) {
      clearInterval(relogioDaVigia);
      relogioDaVigia = undefined;
    }
  }

  function tratarWelcome(mensagem: Extract<MensagemDeTexto, {t: 'welcome'}>): void {
    servidor = mensagem.servidor;
    sessao = mensagem.sessao;
    ultimoErro = undefined;
    ultimoCodigo = undefined;
    // Sucesso zera a escada de espera: a próxima queda recomeça na sondagem curta, e depois dela
    // em 0,5 s — nunca no teto de 5 s herdado da queda anterior.
    tentativas = 0;
    tentativasDeSondagem = 0;
    sondando = false;
    sessaoJaExistiu = true;
    pingsRespondidos = 0;
    decodificador.zerarContadores();
    // Atribuição direta e **um** `avisar()`: `mudarEstado` já avisa, e chamar os dois notificava
    // cada assinante duas vezes justamente na transição mais importante da tela.
    estado = 'conectado';
    avisar();
  }

  function tratarErroDoServidor(
    mensagem: Extract<MensagemDeTexto, {t: 'erro'}>,
  ): void {
    ultimoCodigo = mensagem.codigo;
    ultimoErro = mensagem.mensagem ?? mensagem.codigo;
    if (ERROS_DEFINITIVOS.includes(mensagem.codigo)) {
      // Fecha sem religar: `desligadoDeProposito` impede a reconexão automática. O estado vira
      // 'erro' **antes** do fechamento, senão o caminho de fechamento publicaria um
      // 'desconectado' intermediário e a tela piscaria um estado que não é verdade.
      desligadoDeProposito = true;
      cancelarReconexao();
      estado = 'erro';
      derrubar(socket, 1000, mensagem.codigo);
      avisar();
    }
  }

  function tratarTexto(quadro: string): void {
    const leitura = interpretarMensagemDeTexto(quadro);
    if (!leitura.ok) {
      // Quadro que este app não entende não derruba a sessão: guardar o motivo é diagnóstico
      // suficiente, e derrubar viraria laço de reconexão por causa de um campo novo.
      ultimoErro = `quadro recusado: ${leitura.motivo}`;
      avisar();
      return;
    }

    const mensagem = leitura.mensagem;
    switch (mensagem.t) {
      case 'welcome':
        tratarWelcome(mensagem);
        return;

      case 'ping':
        // `tServidorMs` volta ecoado: quem mede o RTT é o servidor, com o relógio dele
        // (PROTOCOLO.md, seção 3.6). O app não tenta sincronizar relógio nenhum.
        enviarTexto({
          t: 'pong',
          n: mensagem.n,
          tServidorMs: mensagem.tServidorMs,
          tDispositivoMs: Math.round(agoraMs()),
        });
        pingsRespondidos += 1;
        return;

      case 'erro':
        tratarErroDoServidor(mensagem);
        return;

      case 'bye':
        // Servidor encerrando de propósito: fecha e deixa a reconexão automática cuidar de
        // esperar ele voltar.
        ultimoErro =
          mensagem.motivo === undefined
            ? 'servidor encerrou a sessão'
            : `servidor encerrou: ${mensagem.motivo}`;
        derrubar(socket, 1000, 'bye recebido');
        return;

      default:
        opcoes.aoReceberTexto?.(mensagem);
        return;
    }
  }

  /** ⚠️ CAMINHO QUENTE — RUMBLE e HÁPTICO. Sem alocação, sem log. */
  function tratarBinario(dados: ArrayBuffer): void {
    const resultado = decodificador.decodificar(dados);
    if (resultado !== RESULTADO_DECODIFICACAO.OK) {
      return;
    }
    opcoes.aoReceberPacote?.(decodificador.saida);
  }

  /**
   * Caminho **único** de queda: solta o socket, limpa a sessão e agenda a volta.
   *
   * Recebe qual socket caiu porque `close` e `error` podem chegar os dois para a mesma queda —
   * e podem não chegar os dois. Quem chegar primeiro trata; o segundo vê que `socket` já não é
   * aquele e não faz nada. Sem essa dupla porta de entrada a reconexão trava: o `WebSocket`
   * global do Node (undici), por exemplo, dispara `error` numa conexão recusada e **nunca**
   * dispara `close` — medido na bancada da ATI-005, com o app parando de tentar para sempre.
   */
  function derrubar(
    socketCaido: SocketDeTransporte | null,
    codigo: number,
    motivo: string,
  ): void {
    if (socketCaido === null || socket !== socketCaido) {
      return;
    }
    soltarSocket();
    servidor = undefined;
    sessao = undefined;
    try {
      socketCaido.close(codigo, motivo);
    } catch {
      // Socket já morto: fechar duas vezes não pode virar exceção na interface.
    }
    if (!desligadoDeProposito) {
      registrarFalha();
    } else {
      mudarEstado(estado === 'erro' ? 'erro' : 'desconectado');
    }
  }

  function abrirSocket(): void {
    if (socket !== null) {
      return;
    }
    mudarEstado('conectando');

    let novo: SocketDeTransporte;
    try {
      novo = criarSocket(url);
    } catch (erro) {
      ultimoErro = erro instanceof Error ? erro.message : String(erro);
      registrarFalha();
      return;
    }

    socket = novo;
    // Binário chega como `ArrayBuffer`; sem isto o React Native entregaria texto em base64 e o
    // decodificador não teria bytes para ler.
    novo.binaryType = 'arraybuffer';
    iniciarVigia();

    novo.onopen = () => {
      // A resposta do handshake HTTP é sinal de vida: rearma a vigia antes do primeiro `ping`.
      marcarQuadro();
      // A sessão só existe depois do `welcome`; o estado continua 'conectando' até lá.
      enviarQuadro(
        serializarMensagemDeTexto({
          t: 'hello',
          v: VERSAO_PROTOCOLO,
          aparelho: opcoes.aparelho,
          capacidades,
          taxaHzDesejada,
          token: opcoes.token,
        }),
      );
    };

    novo.onmessage = evento => {
      // Qualquer quadro serve como prova de vida: é isso que a vigia de silêncio vigia.
      marcarQuadro();
      const dados = evento.data;
      if (typeof dados === 'string') {
        tratarTexto(dados);
        return;
      }
      if (dados instanceof ArrayBuffer) {
        tratarBinario(dados);
      }
    };

    novo.onerror = evento => {
      ultimoErro =
        typeof evento?.message === 'string' && evento.message !== ''
          ? evento.message
          : 'falha de socket';
      // Erro de WebSocket é sempre fatal para aquele socket: tratar como queda aqui é o que
      // garante a nova tentativa mesmo quando o `close` não vem.
      derrubar(novo, 1000, 'erro de socket');
    };

    novo.onclose = () => {
      derrubar(novo, 1000, 'fechado pelo servidor');
    };
  }

  function enviarQuadro(quadro: string): boolean {
    if (socket === null) {
      return false;
    }
    try {
      socket.send(quadro);
      return true;
    } catch (erro) {
      ultimoErro = erro instanceof Error ? erro.message : String(erro);
      return false;
    }
  }

  function enviarTexto(mensagem: MensagemDeTexto): boolean {
    return enviarQuadro(serializarMensagemDeTexto(mensagem));
  }

  return {
    url,
    situacao: montarSituacao,

    assinar(ouvinte) {
      ouvintes.add(ouvinte);
      return () => {
        ouvintes.delete(ouvinte);
      };
    },

    conectar() {
      desligadoDeProposito = false;
      if (estado === 'erro') {
        // Tentativa manual depois de uma recusa definitiva: limpa o motivo e recomeça a escada.
        ultimoErro = undefined;
        ultimoCodigo = undefined;
        tentativas = 0;
        tentativasDeSondagem = 0;
        sondando = false;
      }
      if (socket !== null) {
        return;
      }
      cancelarReconexao();
      abrirSocket();
    },

    desconectar(motivo = 'usuário encerrou') {
      desligadoDeProposito = true;
      cancelarReconexao();
      tentativas = 0;
      tentativasDeSondagem = 0;
      sondando = false;
      if (socket !== null) {
        // `bye` antes de fechar: encerramento limpo é o que evita deixar estado preso do outro
        // lado (PROTOCOLO.md, seção 3.7).
        enviarTexto({t: 'bye', motivo});
        derrubar(socket, 1000, motivo);
      }
      estado = 'desconectado';
      avisar();
    },

    enviarBinario(pacote) {
      // Antes do `welcome` o servidor descarta o que chegar: devolver `false` deixa isso
      // explícito para quem chama, em vez de fingir que o pacote foi entregue.
      if (estado !== 'conectado' || socket === null) {
        return false;
      }
      try {
        socket.send(pacote);
        return true;
      } catch {
        // Sem log e sem alocação no caminho quente: a queda aparece no `onclose`.
        return false;
      }
    },

    enviarTexto(mensagem) {
      if (estado !== 'conectado') {
        return false;
      }
      return enviarTexto(mensagem);
    },

    contadores: () => decodificador.contadores,
  };
}
