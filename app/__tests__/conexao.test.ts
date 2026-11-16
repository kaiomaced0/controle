/**
 * Testa a máquina de estados do cliente de transporte: handshake, heartbeat, espera progressiva
 * e cancelamento.
 *
 * O socket é um dublê — o que se testa aqui é a **regra**, não o WebSocket do React Native. Os
 * temporizadores são falsos, para a espera progressiva ser conferida em número exato em vez de
 * "esperar e torcer".
 *
 * @format
 */

import {
  ESPERA_DE_SONDAGEM_MS,
  ESPERA_INICIAL_MS,
  ESPERA_MAXIMA_MS,
  LIMITE_SEM_QUADRO_MS,
  criarConexao,
  type Conexao,
  type OpcoesDeConexao,
  type SocketDeTransporte,
} from '../src/transporte/conexao';
import {VERSAO_PROTOCOLO, type AparelhoDoHello} from '../src/transporte/protocolo';

type SocketFalso = SocketDeTransporte & {
  readonly enviados: Array<string | ArrayBuffer | ArrayBufferView>;
  fechamentos: number;
  abrir(): void;
  receber(quadro: string): void;
  cair(): void;
  errar(mensagem: string): void;
};

const APARELHO: AparelhoDoHello = {
  id: 'a1b2c3d4e5f6',
  nome: 'Pixel de teste',
  so: 'android',
  versaoSo: '14',
  modelo: 'GVU6C',
};

function criarSocketFalso(): SocketFalso {
  const socket: SocketFalso = {
    binaryType: '',
    enviados: [],
    fechamentos: 0,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(dados) {
      socket.enviados.push(dados);
    },
    close() {
      socket.fechamentos += 1;
    },
    abrir() {
      socket.onopen?.();
    },
    receber(quadro) {
      socket.onmessage?.({data: quadro});
    },
    cair() {
      socket.onclose?.({code: 1006});
    },
    errar(mensagem) {
      socket.onerror?.({message: mensagem});
    },
  };
  return socket;
}

type Bancada = {
  readonly conexao: Conexao;
  readonly sockets: SocketFalso[];
  readonly ultimo: () => SocketFalso;
  /** Avança o relógio injetado e os temporizadores falsos juntos. */
  readonly avancar: (ms: number) => void;
};

/**
 * Desliga a sondagem curta para testar a escada longa isolada.
 *
 * Os dois regimes convivem no mesmo caminho (`agendarReconexao`), e misturá-los num teste só
 * esconderia qual dos dois produziu o número.
 */
const SEM_SONDAGEM: Partial<OpcoesDeConexao> = {janelaDeSondagemMs: 0};

function montar(opcoes: Partial<OpcoesDeConexao> = {}): Bancada {
  const sockets: SocketFalso[] = [];
  // Relógio próprio: `jest.advanceTimersByTime` move os temporizadores, não o relógio monotônico
  // que a vigia de silêncio e a janela de sondagem consultam.
  let agoraMs = 0;
  const conexao = criarConexao({
    aparelho: APARELHO,
    // Jitter fixo no meio da faixa: (0,5 × 2 − 1) = 0, então a espera sai exata.
    aleatorio: () => 0.5,
    agora: () => agoraMs,
    criarSocket: () => {
      const socket = criarSocketFalso();
      sockets.push(socket);
      return socket;
    },
    ...opcoes,
  });
  return {
    conexao,
    sockets,
    ultimo: () => {
      const socket = sockets[sockets.length - 1];
      if (socket === undefined) {
        throw new Error('nenhum socket foi criado');
      }
      return socket;
    },
    avancar: ms => {
      agoraMs += ms;
      jest.advanceTimersByTime(ms);
    },
  };
}

function quadroDeWelcome(idSessao = 's-1'): string {
  return JSON.stringify({
    t: 'welcome',
    v: VERSAO_PROTOCOLO,
    servidor: {nome: 'PC-KAIO', versao: '0.1.0', so: 'windows'},
    sessao: {id: idSessao, taxaHz: 100, transporte: 'usb'},
    tela: {largura: 1920, altura: 1080},
    perfilAtivo: {id: 'provisorio'},
    perfis: [],
  });
}

function textosEnviados(socket: SocketFalso): Array<Record<string, unknown>> {
  return socket.enviados
    .filter((dados): dados is string => typeof dados === 'string')
    .map(dados => JSON.parse(dados) as Record<string, unknown>);
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('handshake', () => {
  it('manda hello ao abrir e só fica conectado com o welcome', () => {
    const {conexao, ultimo} = montar();

    conexao.conectar();
    expect(conexao.situacao().estado).toBe('conectando');

    ultimo().abrir();
    const [hello] = textosEnviados(ultimo());
    expect(hello?.t).toBe('hello');
    expect(hello?.v).toBe(VERSAO_PROTOCOLO);
    expect(hello?.aparelho).toEqual(APARELHO);
    // Abrir o socket não é ter sessão: o servidor ainda pode recusar.
    expect(conexao.situacao().estado).toBe('conectando');

    ultimo().receber(quadroDeWelcome());
    const situacao = conexao.situacao();
    expect(situacao.estado).toBe('conectado');
    expect(situacao.servidor?.nome).toBe('PC-KAIO');
    expect(situacao.sessao?.id).toBe('s-1');
  });

  it('pede binário só depois do welcome', () => {
    const {conexao, ultimo} = montar();
    const pacote = new Uint8Array([1, 2, 3]);

    conexao.conectar();
    ultimo().abrir();
    expect(conexao.enviarBinario(pacote)).toBe(false);

    ultimo().receber(quadroDeWelcome());
    expect(conexao.enviarBinario(pacote)).toBe(true);
    expect(ultimo().enviados).toContain(pacote);
  });

  it('avisa a interface a cada mudança de estado', () => {
    const {conexao, ultimo} = montar();
    const estados: string[] = [];
    const cancelar = conexao.assinar(situacao => estados.push(situacao.estado));

    conexao.conectar();
    ultimo().abrir();
    ultimo().receber(quadroDeWelcome());
    cancelar();
    ultimo().cair();

    expect(estados).toContain('conectando');
    expect(estados).toContain('conectado');
    // Depois de cancelar, nenhum aviso novo chega.
    expect(estados[estados.length - 1]).toBe('conectado');
  });
});

describe('heartbeat', () => {
  it('responde ping com pong ecoando o tServidorMs', () => {
    const {conexao, ultimo} = montar();

    conexao.conectar();
    ultimo().abrir();
    ultimo().receber(quadroDeWelcome());
    ultimo().receber(JSON.stringify({t: 'ping', n: 7, tServidorMs: 1234}));

    const enviados = textosEnviados(ultimo());
    const pong = enviados[enviados.length - 1];
    expect(pong?.t).toBe('pong');
    expect(pong?.n).toBe(7);
    // O eco é o que permite ao servidor medir o RTT sem sincronizar relógio.
    expect(pong?.tServidorMs).toBe(1234);
    expect(typeof pong?.tDispositivoMs).toBe('number');
    expect(conexao.situacao().pingsRespondidos).toBe(1);
  });
});

describe('reconexão', () => {
  it('espera 0,5 s, depois 1 s, depois 2 s entre as tentativas', () => {
    const {conexao, sockets, ultimo, avancar} = montar(SEM_SONDAGEM);

    conexao.conectar();
    ultimo().abrir();
    ultimo().receber(quadroDeWelcome());

    ultimo().cair();
    expect(conexao.situacao().estado).toBe('conectando');
    expect(conexao.situacao().esperaAtualMs).toBe(ESPERA_INICIAL_MS);

    avancar(ESPERA_INICIAL_MS);
    expect(sockets).toHaveLength(2);

    ultimo().cair();
    expect(conexao.situacao().esperaAtualMs).toBe(ESPERA_INICIAL_MS * 2);

    avancar(ESPERA_INICIAL_MS * 2);
    ultimo().cair();
    expect(conexao.situacao().esperaAtualMs).toBe(ESPERA_INICIAL_MS * 4);
    expect(sockets).toHaveLength(3);
  });

  it('não passa do teto de 5 s', () => {
    const {conexao, ultimo, avancar} = montar(SEM_SONDAGEM);
    conexao.conectar();

    for (let tentativa = 0; tentativa < 12; tentativa += 1) {
      ultimo().cair();
      avancar(ESPERA_MAXIMA_MS);
    }

    ultimo().cair();
    expect(conexao.situacao().esperaAtualMs).toBe(ESPERA_MAXIMA_MS);
  });

  it('o jitter não estoura o teto declarado', () => {
    // Jitter no máximo (+25 %): sem aparo, o último degrau viraria 6,25 s e a ATI passaria a
    // prometer "0,5 s até 5 s" enquanto o código esperava mais que isso.
    const {conexao, ultimo, avancar} = montar({...SEM_SONDAGEM, aleatorio: () => 1});
    conexao.conectar();

    for (let tentativa = 0; tentativa < 12; tentativa += 1) {
      ultimo().cair();
      avancar(ESPERA_MAXIMA_MS);
    }

    ultimo().cair();
    expect(conexao.situacao().esperaAtualMs).toBe(ESPERA_MAXIMA_MS);
  });

  it('zera a escada de espera depois de uma sessão bem-sucedida', () => {
    const {conexao, ultimo, avancar} = montar(SEM_SONDAGEM);

    conexao.conectar();
    ultimo().cair();
    avancar(ESPERA_INICIAL_MS);
    ultimo().cair();
    expect(conexao.situacao().esperaAtualMs).toBe(ESPERA_INICIAL_MS * 2);

    avancar(ESPERA_INICIAL_MS * 2);
    ultimo().abrir();
    ultimo().receber(quadroDeWelcome('s-9'));
    expect(conexao.situacao().tentativas).toBe(0);

    ultimo().cair();
    expect(conexao.situacao().esperaAtualMs).toBe(ESPERA_INICIAL_MS);
  });

  it('desconectar manda bye e cancela a reconexão', () => {
    const {conexao, sockets, ultimo} = montar();

    conexao.conectar();
    ultimo().abrir();
    ultimo().receber(quadroDeWelcome());

    conexao.desconectar('usuário encerrou');
    const enviados = textosEnviados(sockets[0]!);
    expect(enviados[enviados.length - 1]?.t).toBe('bye');
    expect(conexao.situacao().estado).toBe('desconectado');

    jest.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('reconecta quando o servidor manda bye (ele voltou a subir depois)', () => {
    const {conexao, sockets, ultimo} = montar();

    conexao.conectar();
    ultimo().abrir();
    ultimo().receber(quadroDeWelcome());
    ultimo().receber(JSON.stringify({t: 'bye', motivo: 'servidor encerrando'}));

    expect(conexao.situacao().estado).toBe('conectando');
    jest.advanceTimersByTime(ESPERA_INICIAL_MS);
    expect(sockets).toHaveLength(2);
  });

  it('para de tentar quando a recusa é definitiva', () => {
    const {conexao, sockets, ultimo} = montar();

    conexao.conectar();
    ultimo().abrir();
    ultimo().receber(
      JSON.stringify({
        t: 'erro',
        codigo: 'VERSAO_INCOMPATIVEL',
        mensagem: 'este servidor fala a versão 1 do protocolo',
      }),
    );

    expect(conexao.situacao().estado).toBe('erro');
    expect(conexao.situacao().ultimoCodigo).toBe('VERSAO_INCOMPATIVEL');

    // Insistir sozinho contra uma recusa de versão só gastaria bateria.
    jest.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);

    // Tentativa manual continua valendo: quem manda é quem está usando o app.
    conexao.conectar();
    expect(sockets).toHaveLength(2);
    expect(conexao.situacao().estado).toBe('conectando');
  });

  it('tenta de novo quando só chega "error", sem "close"', () => {
    const {conexao, sockets, ultimo} = montar();

    conexao.conectar();
    // Medido na bancada da ATI-005: o WebSocket global do Node dispara `error` numa conexão
    // recusada e nunca dispara `close`. Se a queda dependesse só do `close`, o app pararia de
    // tentar para sempre — que é justamente o critério "matar o servidor não trava o app".
    ultimo().errar('Received network error or non-101 status code.');
    expect(conexao.situacao().estado).toBe('conectando');

    jest.advanceTimersByTime(ESPERA_INICIAL_MS);
    expect(sockets).toHaveLength(2);
  });

  it('trata a mesma queda uma vez só quando error e close chegam juntos', () => {
    const {conexao, sockets, ultimo} = montar();

    conexao.conectar();
    const caido = ultimo();
    caido.errar('falhou');
    caido.cair();

    // Uma queda, uma tentativa: contar duas vezes pularia um degrau da espera progressiva.
    expect(conexao.situacao().tentativas).toBe(1);
    jest.advanceTimersByTime(ESPERA_INICIAL_MS);
    expect(sockets).toHaveLength(2);
  });

  it('não derruba a sessão por um quadro que não entende', () => {
    const {conexao, ultimo} = montar();

    conexao.conectar();
    ultimo().abrir();
    ultimo().receber(quadroDeWelcome());
    ultimo().receber('{isto não é JSON');

    expect(conexao.situacao().estado).toBe('conectado');
    expect(conexao.situacao().ultimoErro).toMatch(/quadro recusado/);
  });

  it('avisa a interface uma única vez na transição para conectado', () => {
    const {conexao, ultimo} = montar();
    const avisos: string[] = [];
    conexao.assinar(situacao => avisos.push(situacao.estado));

    conexao.conectar();
    ultimo().abrir();
    const antesDoWelcome = avisos.length;
    ultimo().receber(quadroDeWelcome());

    // Dois avisos idênticos na transição mais importante fariam a tela renderizar duas vezes.
    expect(avisos.length - antesDoWelcome).toBe(1);
  });
});

describe('sondagem depois de uma queda', () => {
  it('religa em cadência curta quando a sessão já existiu e o app está em primeiro plano', () => {
    const {conexao, sockets, ultimo, avancar} = montar();

    conexao.conectar();
    ultimo().abrir();
    ultimo().receber(quadroDeWelcome());

    ultimo().cair();
    expect(conexao.situacao().sondando).toBe(true);
    // O critério de aceite 2 pede a sessão de volta em até 2 s: a escada de 0,5→5 s não cabe aí.
    expect(conexao.situacao().esperaAtualMs).toBe(ESPERA_DE_SONDAGEM_MS);

    avancar(ESPERA_DE_SONDAGEM_MS);
    expect(sockets).toHaveLength(2);

    // A cadência é fixa: falhar de novo não dobra a espera enquanto a janela vale.
    ultimo().cair();
    expect(conexao.situacao().esperaAtualMs).toBe(ESPERA_DE_SONDAGEM_MS);
  });

  it('volta para a escada quando a janela de sondagem vence', () => {
    const {conexao, ultimo, avancar} = montar({janelaDeSondagemMs: 1000});

    conexao.conectar();
    ultimo().abrir();
    ultimo().receber(quadroDeWelcome());

    ultimo().cair();
    expect(conexao.situacao().sondando).toBe(true);

    avancar(ESPERA_DE_SONDAGEM_MS);
    ultimo().cair();
    avancar(ESPERA_DE_SONDAGEM_MS);
    ultimo().cair();
    avancar(ESPERA_DE_SONDAGEM_MS);
    ultimo().cair();

    // Passou a janela: a escada assume — e assume do primeiro degrau, não do teto.
    expect(conexao.situacao().sondando).toBe(false);
    expect(conexao.situacao().esperaAtualMs).toBe(ESPERA_INICIAL_MS);
  });

  it('usa a escada, e não a sondagem, com o app em segundo plano', () => {
    const {conexao, ultimo} = montar({emPrimeiroPlano: () => false});

    conexao.conectar();
    ultimo().abrir();
    ultimo().receber(quadroDeWelcome());
    ultimo().cair();

    expect(conexao.situacao().sondando).toBe(false);
    expect(conexao.situacao().esperaAtualMs).toBe(ESPERA_INICIAL_MS);
  });

  it('usa a escada na primeira conexão, quando nunca houve sessão', () => {
    const {conexao, ultimo} = montar();

    conexao.conectar();
    ultimo().cair();

    expect(conexao.situacao().sondando).toBe(false);
    expect(conexao.situacao().esperaAtualMs).toBe(ESPERA_INICIAL_MS);
  });
});

describe('vigia de silêncio', () => {
  it('derruba a conexão quando o servidor para de falar e religa sozinho', () => {
    const {conexao, sockets, ultimo, avancar} = montar();

    conexao.conectar();
    ultimo().abrir();
    ultimo().receber(quadroDeWelcome());
    expect(conexao.situacao().estado).toBe('conectado');

    const caido = ultimo();
    // Socket meio-aberto (PC dormiu, cabo arrancado): nenhum `close`, nenhum `error`, só silêncio.
    avancar(LIMITE_SEM_QUADRO_MS);

    expect(conexao.situacao().estado).toBe('conectando');
    expect(conexao.situacao().ultimoErro).toMatch(/mudo/);
    expect(caido.fechamentos).toBe(1);
    // O pior defeito era este: a faixa verde e o envio dizendo "entreguei" com o canal morto.
    expect(conexao.enviarBinario(new Uint8Array([1, 2, 3]))).toBe(false);

    avancar(ESPERA_DE_SONDAGEM_MS);
    expect(sockets).toHaveLength(2);
  });

  it('o ping do servidor rearma a vigia', () => {
    const {conexao, ultimo, avancar} = montar();

    conexao.conectar();
    ultimo().abrir();
    ultimo().receber(quadroDeWelcome());

    // Um quadro por segundo é o heartbeat do servidor (PROTOCOLO.md, seção 2): mesmo depois do
    // dobro do limite de silêncio, a sessão continua de pé porque cada ping rearma a vigia.
    for (let n = 1; n <= 6; n += 1) {
      avancar(1000);
      ultimo().receber(JSON.stringify({t: 'ping', n, tServidorMs: n * 1000}));
    }

    expect(conexao.situacao().estado).toBe('conectado');
    expect(conexao.situacao().pingsRespondidos).toBe(6);
  });
});
