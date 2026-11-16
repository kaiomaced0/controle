/**
 * Uma sessão de transporte — o ciclo de vida de **um** aparelho ligado ao servidor.
 *
 * Cobre o que o PROTOCOLO.md, seção 2, desenha: handshake `hello` → `welcome`, tráfego binário
 * de alta frequência, heartbeat `ping`/`pong` e encerramento (limpo por `bye`, ou à força por
 * versão incompatível, protocolo inválido, silêncio do aparelho ou substituição de sessão).
 *
 * Divisão de trabalho com `servidor.ts`: aqui mora tudo que é **de uma** sessão; lá mora o
 * `WebSocketServer`, a regra de "um aparelho por vez" e o encerramento do processo.
 *
 * ⚠️ CAMINHO QUENTE em `tratarBinario`: 100 pacotes por segundo, para sempre. Nenhuma alocação
 * por pacote (o decodificador escreve num objeto reaproveitado), nenhuma linha de log por pacote
 * — só contador (regra 2 do CLAUDE.md). Log aqui é sempre de **evento de sessão**.
 *
 * ⚠️ ESTADO PRESO (regra 5 do CLAUDE.md): `encerrar()` é o caminho único de saída, e ele roda
 * `aoEncerrar` **exatamente uma vez**, aconteça o que acontecer (fechamento pelo aparelho, erro
 * de socket, silêncio, substituição, desligamento do servidor). É nesse gancho que a ATI-007
 * pendura a soltura de botão e tecla.
 */

import type { Socket } from 'node:net';
import type { RawData, WebSocket } from 'ws';
import type { Registrador } from '../log.js';
import {
  RESULTADO_DECODIFICACAO,
  TIPO_BOTAO,
  TIPO_EIXO,
  TIPO_MOVIMENTO,
  TIPO_SCROLL,
  VERSAO_PROTOCOLO,
  criarDecodificador,
  interpretarMensagemDeTexto,
  serializarMensagemDeTexto,
  type AparelhoDoHello,
  type CodigoDeErro,
  type MensagemDeTexto,
  type MensagemHello,
  type MensagemWelcome,
  type PacoteDecodificado,
  type Transporte,
} from '../protocolo/indice.js';
import {
  compararSeq,
  criarMedidorDaSessao,
  type MedidasDaSessao,
  type MedidorDaSessao,
} from './metricas.js';

/** Em que ponto do ciclo a sessão está. */
export type EstadoDaSessao = 'aguardando-hello' | 'ativa' | 'encerrada';

/** Leitura completa de uma sessão, para telemetria (ATI-006) e log de encerramento. */
export interface InstantaneoDaSessao {
  readonly id: string;
  readonly estado: EstadoDaSessao;
  readonly aparelho: AparelhoDoHello | undefined;
  readonly transporte: Transporte;
  readonly medidas: MedidasDaSessao;
}

export interface SessaoDeTransporte {
  readonly id: string;
  readonly estado: EstadoDaSessao;
  /** Só existe depois do `hello` aceito. */
  readonly aparelho: AparelhoDoHello | undefined;
  /**
   * Se o `TCP_NODELAY` foi aplicado no socket desta sessão.
   *
   * Existe para ser **verificável**: "setNoDelay obrigatório dos dois lados" (PROTOCOLO.md,
   * seção 1) só vale como garantia se der para provar que aconteceu, e nem o `ws` nem o
   * `net.Socket` expõem o estado da opção depois de aplicada.
   */
  readonly noDelayAplicado: boolean;
  instantaneo(): InstantaneoDaSessao;
  /** Envia um quadro de texto. Devolve `false` quando o socket não está aberto. */
  enviarTexto(mensagem: MensagemDeTexto): boolean;
  /** Envia um quadro binário. Devolve `false` quando o socket não está aberto. */
  enviarBinario(pacote: Uint8Array): boolean;
  /**
   * Caminho único de saída. `codigo` vira `{"t":"erro"}` antes do fechamento (PROTOCOLO.md,
   * seção 3.3). Chamar duas vezes não faz nada na segunda.
   */
  encerrar(motivo: string, codigo?: CodigoDeErro, mensagem?: string): void;
}

/** Resposta do ponto de extensão de pareamento (ATI-014). */
export type AutorizacaoDoHello =
  | { readonly ok: true }
  | { readonly ok: false; readonly codigo: CodigoDeErro; readonly mensagem: string };

export interface OpcoesDaSessao {
  readonly id: string;
  readonly socket: WebSocket;
  /** Socket TCP cru, onde o `setNoDelay` é aplicado. `undefined` só em teste de unidade. */
  readonly socketCru: Socket | undefined;
  readonly registrador: Registrador;
  /** Relógio **monotônico** em ms. O `tServidorMs` do ping sai daqui. */
  readonly relogio: () => number;
  readonly intervaloPingMs: number;
  readonly limiteSemPongMs: number;
  /** Quanto tempo a conexão pode ficar sem mandar `hello` antes de ser cortada. */
  readonly limiteDoHandshakeMs: number;
  readonly transporte: Transporte;
  /** Monta o `welcome` (perfil, tela, taxa). Quem sabe disso é o servidor, não a sessão. */
  readonly montarWelcome: (sessao: SessaoDeTransporte, hello: MensagemHello) => MensagemWelcome;
  /**
   * Ponto de extensão do **pareamento por token** (ATI-014).
   *
   * Nesta fase o modo cabo não pareia: o padrão de `servidor.ts` sempre autoriza. Quando a
   * ATI-014 entrar, é aqui que `PAREAMENTO_NECESSARIO` e `TOKEN_INVALIDO` passam a nascer — o
   * resto do ciclo (recusa, `erro`, fechamento) já está pronto e não muda.
   */
  readonly autorizarHello: (hello: MensagemHello) => AutorizacaoDoHello;
  /** Chamado com o `hello` aceito, **antes** do `welcome`: é quando o servidor adota a sessão. */
  readonly aoAtivar: (sessao: SessaoDeTransporte, hello: MensagemHello) => void;
  /** Chamado uma vez só, em qualquer saída. Lugar da soltura de estado preso (ATI-007). */
  readonly aoEncerrar: (sessao: SessaoDeTransporte, motivo: string) => void;
  /** ⚠️ Caminho quente. Recebe o pacote já decodificado e em ordem. O objeto é reaproveitado. */
  readonly aoReceberPacote?: ((pacote: PacoteDecodificado, sessao: SessaoDeTransporte) => void) | undefined;
  /**
   * Ponto de extensão para `config` e `cmd` (sprint 2: pipeline de movimento e perfis).
   * Devolver `true` significa "eu respondi"; `false` cai na resposta padrão desta fase.
   */
  readonly aoReceberTexto?:
    | ((mensagem: MensagemDeTexto, sessao: SessaoDeTransporte) => boolean)
    | undefined;
}

/**
 * Quantos carimbos de `ping` ficam lembrados para conferir o eco do `pong`.
 *
 * Quatro é folga com sobra: com ping a cada 1000 ms e queda em 3000 ms de silêncio, nunca há
 * mais de três pings sem resposta. Guardar mais seria lembrar de ping que a sessão já desistiu.
 */
const CARIMBOS_DE_PING = 4;

/** Tipos que só fazem sentido no sentido app → servidor (PROTOCOLO.md, seção 4). */
function ehPacoteDoAparelho(tipo: number): boolean {
  return tipo === TIPO_MOVIMENTO || tipo === TIPO_BOTAO || tipo === TIPO_EIXO || tipo === TIPO_SCROLL;
}

/**
 * O motivo do `close` do WebSocket vai no quadro de fechamento, que aceita no máximo 123 bytes.
 * Passar disso faz o `ws` lançar — e derrubar o processo por causa de uma mensagem de log seria
 * o pior desfecho possível para um caminho de encerramento.
 */
function motivoCurto(motivo: string): string {
  const bytes = Buffer.from(motivo, 'utf8');
  if (bytes.byteLength <= 123) return motivo;
  return bytes.subarray(0, 120).toString('utf8') + '...';
}

/**
 * Texto de um quadro recebido. Só o caminho de baixa frequência passa por aqui (`ws` entrega
 * `Buffer`; a lista só aparece em quadro fragmentado).
 */
function comoTexto(dados: RawData): string {
  if (Buffer.isBuffer(dados)) return dados.toString('utf8');
  if (Array.isArray(dados)) return Buffer.concat(dados).toString('utf8');
  return Buffer.from(dados).toString('utf8');
}

/**
 * Bytes de um quadro binário **sem copiar** no caminho comum: com `binaryType` `nodebuffer`
 * (padrão do `ws`), o quadro já chega como `Buffer`, que é um `Uint8Array`. A cópia só existe
 * no caso raro do quadro fragmentado, onde não há como evitar.
 */
function comoBytes(dados: RawData): Uint8Array | undefined {
  if (Buffer.isBuffer(dados)) return dados;
  if (Array.isArray(dados)) return Buffer.concat(dados);
  if (dados instanceof ArrayBuffer) return new Uint8Array(dados);
  return undefined;
}

export function criarSessao(opcoes: OpcoesDaSessao): SessaoDeTransporte {
  const {
    id,
    socket,
    socketCru,
    registrador,
    relogio,
    intervaloPingMs,
    limiteSemPongMs,
    limiteDoHandshakeMs,
    transporte,
    montarWelcome,
    autorizarHello,
    aoAtivar,
    aoEncerrar,
    aoReceberPacote,
    aoReceberTexto,
  } = opcoes;

  const inicioMs = relogio();
  const decodificador = criarDecodificador();
  const medidor: MedidorDaSessao = criarMedidorDaSessao(decodificador.contadores, inicioMs);

  let estado: EstadoDaSessao = 'aguardando-hello';
  let aparelho: AparelhoDoHello | undefined;
  let noDelayAplicado = false;

  let ultimoSeq = 0;
  let temUltimoSeq = false;

  let relogioDoHandshake: NodeJS.Timeout | undefined;
  let relogioDoHeartbeat: NodeJS.Timeout | undefined;
  let proximoPing = 0;
  let ultimoPongMs = inicioMs;
  /** Carimbo de cada ping enviado, por `n % CARIMBOS_DE_PING`. Alocado uma vez, na abertura. */
  const carimbosDePing = new Float64Array(CARIMBOS_DE_PING);

  // `setNoDelay` desliga o algoritmo de Nagle, que junta pacotes pequenos para poupar cabeçalho.
  // Num fluxo de 24 bytes a 100 Hz isso é atraso puro: é o item obrigatório da seção 1 do
  // PROTOCOLO.md, e o motivo de a sessão pedir o socket cru em vez de só o WebSocket.
  if (socketCru !== undefined) {
    socketCru.setNoDelay(true);
    noDelayAplicado = true;
  }

  const sessao: SessaoDeTransporte = {
    id,
    get estado() {
      return estado;
    },
    get aparelho() {
      return aparelho;
    },
    get noDelayAplicado() {
      return noDelayAplicado;
    },
    instantaneo() {
      return {
        id,
        estado,
        aparelho,
        transporte,
        medidas: medidor.instantaneo(relogio()),
      };
    },
    enviarTexto,
    enviarBinario,
    encerrar,
  };

  function enviarTexto(mensagem: MensagemDeTexto): boolean {
    if (socket.readyState !== socket.OPEN) return false;
    try {
      socket.send(serializarMensagemDeTexto(mensagem));
      return true;
    } catch (erro) {
      registrador.aviso('falhei ao enviar quadro de texto', { sessao: id, erro });
      return false;
    }
  }

  function enviarBinario(pacote: Uint8Array): boolean {
    if (socket.readyState !== socket.OPEN) return false;
    try {
      socket.send(pacote, { binary: true });
      return true;
    } catch (erro) {
      registrador.aviso('falhei ao enviar quadro binário', { sessao: id, erro });
      return false;
    }
  }

  function limparRelogios(): void {
    if (relogioDoHandshake !== undefined) {
      clearTimeout(relogioDoHandshake);
      relogioDoHandshake = undefined;
    }
    if (relogioDoHeartbeat !== undefined) {
      clearInterval(relogioDoHeartbeat);
      relogioDoHeartbeat = undefined;
    }
  }

  function encerrar(motivo: string, codigo?: CodigoDeErro, mensagem?: string): void {
    if (estado === 'encerrada') return;
    const estadoAnterior = estado;
    estado = 'encerrada';
    limparRelogios();

    if (codigo !== undefined) {
      enviarTexto({ t: 'erro', codigo, mensagem });
    }

    try {
      // 1000 = fechamento normal: o "porquê" semântico já viajou no quadro `erro` acima, e
      // inventar código privado aqui só criaria um segundo vocabulário para a mesma coisa.
      socket.close(1000, motivoCurto(motivo));
    } catch {
      // Socket já morto: não há o que fechar, e o caminho de saída não pode lançar.
    }

    if (estadoAnterior === 'ativa') {
      const medidas = medidor.instantaneo(relogio());
      registrador.info('sessão encerrada', {
        sessao: id,
        aparelho: aparelho?.nome ?? '—',
        motivo,
        codigo: codigo ?? '—',
        pacotes: medidas.pacotesRecebidos,
        bytes: medidas.bytesRecebidos,
        foraDeOrdem: medidas.foraDeOrdem,
        descartados: medidas.descartados,
        rttP50: Math.round(medidas.rttMsP50),
        duracaoMs: Math.round(medidas.duracaoMs),
      });
    } else {
      registrador.depuracao('conexão encerrada antes do handshake', { sessao: id, motivo });
    }

    aoEncerrar(sessao, motivo);
  }

  function iniciarHeartbeat(): void {
    ultimoPongMs = relogio();
    relogioDoHeartbeat = setInterval(() => {
      const agora = relogio();
      // Silêncio do aparelho: derruba. Sem isto, cabo arrancado deixaria a sessão viva para
      // sempre — e a próxima conexão viraria "substituição" de uma sessão que já morreu.
      if (agora - ultimoPongMs >= limiteSemPongMs) {
        encerrar(`sem pong há ${Math.round(agora - ultimoPongMs)} ms`);
        return;
      }
      proximoPing += 1;
      carimbosDePing[proximoPing % CARIMBOS_DE_PING] = agora;
      enviarTexto({ t: 'ping', n: proximoPing, tServidorMs: agora });
    }, intervaloPingMs);
  }

  function tratarHello(hello: MensagemHello): void {
    if (estado !== 'aguardando-hello') {
      encerrar('hello repetido', 'PROTOCOLO_INVALIDO', 'o handshake acontece uma vez por conexão');
      return;
    }

    if (hello.v !== VERSAO_PROTOCOLO) {
      registrador.aviso('handshake recusado por versão', {
        sessao: id,
        recebida: hello.v,
        suportada: VERSAO_PROTOCOLO,
      });
      encerrar(
        'versão de protocolo incompatível',
        'VERSAO_INCOMPATIVEL',
        `este servidor fala a versão ${VERSAO_PROTOCOLO} do protocolo; o app pediu ${hello.v}.`,
      );
      return;
    }

    const autorizacao = autorizarHello(hello);
    if (!autorizacao.ok) {
      registrador.aviso('handshake recusado no pareamento', {
        sessao: id,
        codigo: autorizacao.codigo,
      });
      encerrar('pareamento recusado', autorizacao.codigo, autorizacao.mensagem);
      return;
    }

    aparelho = hello.aparelho;
    estado = 'ativa';
    if (relogioDoHandshake !== undefined) {
      clearTimeout(relogioDoHandshake);
      relogioDoHandshake = undefined;
    }

    // O servidor adota esta sessão AQUI, antes do `welcome`: é o ponto em que a sessão anterior
    // (se houver) recebe `SESSAO_SUBSTITUIDA` e cai. Fazer isso antes de o handshake dar certo
    // deixaria qualquer conexão malformada derrubar a sessão boa.
    aoAtivar(sessao, hello);

    enviarTexto(montarWelcome(sessao, hello));
    iniciarHeartbeat();

    registrador.info('sessão aberta', {
      sessao: id,
      aparelho: hello.aparelho.nome,
      modelo: hello.aparelho.modelo,
      so: `${hello.aparelho.so} ${hello.aparelho.versaoSo}`,
      idAparelho: hello.aparelho.id,
      capacidades: hello.capacidades.join(','),
      taxaHzDesejada: hello.taxaHzDesejada,
      transporte,
    });
  }

  function tratarPong(n: number, tServidorMs: number): void {
    if (estado !== 'ativa') return;
    const agora = relogio();
    // Vida da sessão e medida de RTT são coisas diferentes: o quadro chegou, então o aparelho
    // está vivo — é só isso que o limite de silêncio vigia. Derrubar a sessão por causa de um
    // eco errado seria matar um canal que está funcionando.
    ultimoPongMs = agora;

    // Já a **medida** exige o eco certo: `n` sozinho não protege nada, porque um cliente com
    // defeito pode devolver qualquer `tServidorMs` e inflar o RTT sem deixar rastro. O carimbo
    // conferido é o que o próprio servidor mandou naquele ping (PROTOCOLO.md, seção 3.6).
    if (n <= 0 || n > proximoPing || carimbosDePing[n % CARIMBOS_DE_PING] !== tServidorMs) {
      medidor.registrarPongRecusado();
      return;
    }

    // RTT pelo relógio do servidor, dos dois lados da conta. Nada de sincronizar relógio com o
    // celular: o `tDispositivoMs` do pong não entra aqui.
    medidor.registrarRtt(agora - tServidorMs);
  }

  function tratarTexto(quadro: string): void {
    const leitura = interpretarMensagemDeTexto(quadro);
    if (!leitura.ok) {
      registrador.aviso('quadro de texto recusado', { sessao: id, motivo: leitura.motivo });
      encerrar('quadro de texto inválido', leitura.codigo, leitura.motivo);
      return;
    }

    const mensagem = leitura.mensagem;
    if (mensagem.t === 'hello') {
      tratarHello(mensagem);
      return;
    }

    if (estado !== 'ativa') {
      encerrar(
        'mensagem antes do handshake',
        'PROTOCOLO_INVALIDO',
        'a primeira mensagem da conexão precisa ser o hello',
      );
      return;
    }

    switch (mensagem.t) {
      case 'pong':
        tratarPong(mensagem.n, mensagem.tServidorMs);
        return;

      case 'bye':
        // Encerramento limpo: quem recebe `bye` solta o que estiver preso antes de fechar
        // (PROTOCOLO.md, seção 3.7) — é o que `aoEncerrar` faz dentro de `encerrar`.
        encerrar(mensagem.motivo === undefined ? 'bye do aparelho' : `bye: ${mensagem.motivo}`);
        return;

      case 'config':
        if (aoReceberTexto?.(mensagem, sessao) === true) return;
        // Nesta fase não existe pipeline de movimento para aplicar ajuste nenhum. Responder
        // `config-ok` com os valores recebidos seria mentir; o honesto é dizer que o conjunto
        // efetivo é vazio. O dono de verdade entra no sprint 2.
        enviarTexto({ t: 'config-ok', gyro: {} });
        return;

      case 'cmd':
        if (aoReceberTexto?.(mensagem, sessao) === true) return;
        enviarTexto({
          t: 'cmd-erro',
          comando: mensagem.comando,
          motivo: 'este comando ainda não tem dono no servidor (entra no sprint 2)',
        });
        return;

      default:
        // `welcome`, `erro`, `ping`, `config-ok`, `cmd-ok`, `cmd-erro` e `aviso` são do servidor
        // para o app. Chegando na direção contrária, o quadro é bem-formado mas está no sentido
        // errado.
        encerrar(
          `mensagem "${mensagem.t}" no sentido errado`,
          'PROTOCOLO_INVALIDO',
          `"${mensagem.t}" é mensagem do servidor para o app`,
        );
        return;
    }
  }

  /** ⚠️ CAMINHO QUENTE — 100 Hz. Sem alocação, sem log, sem exceção. */
  function tratarBinario(dados: RawData): void {
    // Antes do `welcome` o app não pode falar binário (regra do cliente). Descartar em silêncio
    // é mais seguro do que derrubar: quadro atrasado de uma sessão morta não vira incidente.
    if (estado !== 'ativa') return;

    const bytes = comoBytes(dados);
    if (bytes === undefined) return;

    const resultado = decodificador.decodificar(bytes);
    // Truncado ou de tipo desconhecido: o próprio codec já somou o contador (seção 7).
    if (resultado !== RESULTADO_DECODIFICACAO.OK) return;

    const pacote = decodificador.saida;
    if (!ehPacoteDoAparelho(pacote.tipo)) {
      // RUMBLE/HÁPTICO vindo do app: quadro bem-formado, direção errada (PROTOCOLO.md, seção 5).
      // Não entra em `descartados` (que é defeito de formato) e o codec já somou `pacotesRecebidos`
      // e `bytesRecebidos` — sem contador próprio, este pacote sumiria sem deixar rastro nenhum.
      medidor.registrarSentidoErrado();
      return;
    }

    if (temUltimoSeq) {
      const ordem = compararSeq(pacote.seq, ultimoSeq);
      if (ordem <= 0) {
        // MOVIMENTO atrasado é jogado fora: reproduzir amostra velha gera salto de cursor
        // (ARQUITETURA.md, seção 3). BOTÃO/EIXO/SCROLL atrasado é entregue mesmo assim, porque
        // descartar uma soltura de botão é justamente como se prende um botão (regra 5).
        const descartar = pacote.tipo === TIPO_MOVIMENTO;
        medidor.registrarForaDeOrdem(descartar);
        if (descartar) return;
      } else {
        ultimoSeq = pacote.seq;
      }
    } else {
      ultimoSeq = pacote.seq;
      temUltimoSeq = true;
    }

    medidor.registrarPacote(relogio());
    if (pacote.tipo === TIPO_MOVIMENTO) medidor.registrarDt(pacote.dtMs);

    aoReceberPacote?.(pacote, sessao);
  }

  socket.on('message', (dados: RawData, ehBinario: boolean) => {
    if (ehBinario) {
      tratarBinario(dados);
      return;
    }
    tratarTexto(comoTexto(dados));
  });

  socket.on('close', () => {
    encerrar('conexão fechada');
  });

  socket.on('error', (erro: Error) => {
    registrador.aviso('erro de socket', { sessao: id, erro });
    encerrar(`erro de socket: ${erro.message}`);
  });

  // Conexão que abre e não fala não pode ficar segurando lugar: sem o `hello` dentro do limite,
  // ela é cortada. Sem isso, um socket mudo travaria o slot da sessão única para sempre.
  relogioDoHandshake = setTimeout(() => {
    relogioDoHandshake = undefined;
    encerrar(
      `handshake não chegou em ${limiteDoHandshakeMs} ms`,
      'PROTOCOLO_INVALIDO',
      'o hello precisa ser a primeira mensagem da conexão',
    );
  }, limiteDoHandshakeMs);

  return sessao;
}
