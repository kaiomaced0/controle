/**
 * Teste de ponta a ponta do transporte, com socket de verdade.
 *
 * Sobe o servidor em **porta efêmera** (porta 0) e conversa com ele por um cliente `ws` — não há
 * simulação de socket: o que o teste exercita é o mesmo caminho que o celular vai usar, incluindo
 * o handshake, o quadro binário e o fechamento.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { criarRegistrador } from '../log.js';
import {
  TAMANHO_MOVIMENTO,
  VERSAO_PROTOCOLO,
  criarCodificador,
  type PacoteDecodificado,
} from '../protocolo/indice.js';
import {
  criarServidorDeTransporte,
  type OpcoesDoServidorDeTransporte,
  type ServidorDeTransporte,
} from './servidor.js';
import type { SessaoDeTransporte } from './sessao.js';

/** Nenhum teste pode ficar pendurado esperando quadro que não vem. */
const LIMITE_DE_ESPERA_MS = 4000;

/** Registrador mudo: o teste não precisa de stderr poluído, mas o código exige um registrador. */
const registradorMudo = criarRegistrador('erro', 'teste', () => {
  // De propósito vazio: a saída do teste é a asserção, não o log.
});

type Quadro = Record<string, unknown>;

interface ClienteDeTeste {
  readonly socket: WebSocket;
  proximoTexto(): Promise<Quadro>;
  enviarTexto(mensagem: unknown): void;
  enviarBinario(bytes: Uint8Array): void;
  esperarFechamento(): Promise<number>;
  fechar(): void;
}

function comLimite<T>(promessa: Promise<T>, oQue: string): Promise<T> {
  return Promise.race([
    promessa,
    new Promise<T>((_, rejeitar) => {
      const relogio = setTimeout(() => {
        rejeitar(new Error(`tempo esgotado esperando ${oQue}`));
      }, LIMITE_DE_ESPERA_MS);
      relogio.unref();
    }),
  ]);
}

/**
 * Espera uma condição do **lado do servidor** virar verdadeira.
 *
 * O `close` que o cliente vê e o `close` que o servidor processa são dois eventos diferentes:
 * afirmar sobre o estado do servidor logo depois de o cliente fechar é corrida garantida.
 */
async function esperarAte(condicao: () => boolean, oQue: string): Promise<void> {
  const limite = Date.now() + LIMITE_DE_ESPERA_MS;
  while (!condicao()) {
    if (Date.now() > limite) throw new Error(`tempo esgotado esperando ${oQue}`);
    await new Promise<void>((resolver) => {
      const relogio = setTimeout(resolver, 5);
      relogio.unref();
    });
  }
}

async function conectar(url: string): Promise<ClienteDeTeste> {
  const socket = new WebSocket(url);
  socket.binaryType = 'nodebuffer';

  const recebidos: Quadro[] = [];
  const esperando: Array<(quadro: Quadro) => void> = [];
  let codigoDeFechamento: number | undefined;
  const fechamentos: Array<(codigo: number) => void> = [];

  socket.on('message', (dados: Buffer, ehBinario: boolean) => {
    if (ehBinario) return;
    const quadro = JSON.parse(dados.toString('utf8')) as Quadro;
    const proximo = esperando.shift();
    if (proximo === undefined) recebidos.push(quadro);
    else proximo(quadro);
  });

  socket.on('close', (codigo: number) => {
    codigoDeFechamento = codigo;
    for (const aguardando of fechamentos.splice(0)) aguardando(codigo);
  });

  await comLimite(
    new Promise<void>((resolver, rejeitar) => {
      socket.once('open', () => {
        resolver();
      });
      socket.once('error', rejeitar);
    }),
    'a conexão abrir',
  );

  return {
    socket,
    proximoTexto() {
      const pronto = recebidos.shift();
      if (pronto !== undefined) return Promise.resolve(pronto);
      return comLimite(
        new Promise<Quadro>((resolver) => esperando.push(resolver)),
        'um quadro de texto',
      );
    },
    enviarTexto(mensagem) {
      socket.send(JSON.stringify(mensagem));
    },
    enviarBinario(bytes) {
      socket.send(bytes, { binary: true });
    },
    esperarFechamento() {
      if (codigoDeFechamento !== undefined) return Promise.resolve(codigoDeFechamento);
      return comLimite(
        new Promise<number>((resolver) => fechamentos.push(resolver)),
        'o fechamento da conexão',
      );
    },
    fechar() {
      socket.close();
    },
  };
}

function helloValido(nome = 'Pixel de teste'): Quadro {
  return {
    t: 'hello',
    v: VERSAO_PROTOCOLO,
    aparelho: {
      id: 'a1b2c3d4e5f6',
      nome,
      so: 'android',
      versaoSo: '14',
      modelo: 'GVU6C',
    },
    capacidades: ['giroscopio', 'haptico'],
    taxaHzDesejada: 100,
  };
}

interface Bancada {
  readonly servidor: ServidorDeTransporte;
  readonly url: string;
}

async function subir(opcoes: Partial<OpcoesDoServidorDeTransporte> = {}): Promise<Bancada> {
  const servidor = criarServidorDeTransporte({
    host: '127.0.0.1',
    porta: 0,
    registrador: registradorMudo,
    versaoServidor: '0.1.0-teste',
    ...opcoes,
  });
  const endereco = await comLimite(servidor.ouvir(), 'a porta abrir');
  return { servidor, url: `ws://127.0.0.1:${endereco.porta}` };
}

/** Cópia dos campos que interessam: o pacote decodificado é um objeto reaproveitado. */
function resumirPacote(pacote: PacoteDecodificado): { tipo: number; seq: number; gx: number } {
  return { tipo: pacote.tipo, seq: pacote.seq, gx: pacote.gx };
}

describe('servidor de transporte — handshake', () => {
  it('responde welcome, registra a sessão com o nome do aparelho e aplica setNoDelay', async () => {
    const { servidor, url } = await subir();
    try {
      const cliente = await conectar(url);
      cliente.enviarTexto(helloValido('Pixel 7 do Kaio'));

      const welcome = await cliente.proximoTexto();
      assert.equal(welcome.t, 'welcome');
      assert.equal(welcome.v, VERSAO_PROTOCOLO);
      assert.deepEqual(welcome.sessao, { id: 's-1', taxaHz: 100, transporte: 'usb' });
      assert.ok(typeof welcome.perfilAtivo === 'object');
      // Sem pareamento nesta fase: o token é opcional e não vai no fio.
      assert.equal('token' in welcome, false);

      const sessao = servidor.sessaoAtual();
      assert.ok(sessao !== undefined);
      assert.equal(sessao.estado, 'ativa');
      assert.equal(sessao.aparelho?.nome, 'Pixel 7 do Kaio');
      assert.equal(sessao.noDelayAplicado, true);

      cliente.fechar();
    } finally {
      await servidor.fechar();
    }
  });

  it('recusa versão de protocolo diferente com VERSAO_INCOMPATIVEL e fecha', async () => {
    const { servidor, url } = await subir();
    try {
      const cliente = await conectar(url);
      cliente.enviarTexto({ ...helloValido(), v: VERSAO_PROTOCOLO + 1 });

      const erro = await cliente.proximoTexto();
      assert.equal(erro.t, 'erro');
      assert.equal(erro.codigo, 'VERSAO_INCOMPATIVEL');

      await cliente.esperarFechamento();
      assert.equal(servidor.sessaoAtual(), undefined);
    } finally {
      await servidor.fechar();
    }
  });

  it('recusa quadro de texto malformado com PROTOCOLO_INVALIDO e fecha', async () => {
    const { servidor, url } = await subir();
    try {
      const cliente = await conectar(url);
      cliente.socket.send('{isto não é JSON');

      const erro = await cliente.proximoTexto();
      assert.equal(erro.t, 'erro');
      assert.equal(erro.codigo, 'PROTOCOLO_INVALIDO');

      await cliente.esperarFechamento();
    } finally {
      await servidor.fechar();
    }
  });

  it('corta conexão que abre e não manda hello', async () => {
    const { servidor, url } = await subir({ limiteDoHandshakeMs: 60 });
    try {
      const cliente = await conectar(url);
      const erro = await cliente.proximoTexto();
      assert.equal(erro.codigo, 'PROTOCOLO_INVALIDO');
      await cliente.esperarFechamento();
      assert.equal(servidor.conexoesAbertas(), 0);
    } finally {
      await servidor.fechar();
    }
  });
});

describe('servidor de transporte — sessão única', () => {
  it('substitui a sessão anterior avisando SESSAO_SUBSTITUIDA', async () => {
    const { servidor, url } = await subir();
    try {
      const primeiro = await conectar(url);
      primeiro.enviarTexto(helloValido('aparelho antigo'));
      assert.equal((await primeiro.proximoTexto()).t, 'welcome');

      const segundo = await conectar(url);
      segundo.enviarTexto(helloValido('aparelho novo'));
      assert.equal((await segundo.proximoTexto()).t, 'welcome');

      const aviso = await primeiro.proximoTexto();
      assert.equal(aviso.t, 'erro');
      assert.equal(aviso.codigo, 'SESSAO_SUBSTITUIDA');
      await primeiro.esperarFechamento();

      const atual = servidor.sessaoAtual();
      assert.equal(atual?.id, 's-2');
      assert.equal(atual?.aparelho?.nome, 'aparelho novo');

      segundo.fechar();
    } finally {
      await servidor.fechar();
    }
  });

  it('não deixa uma conexão malformada derrubar a sessão que está funcionando', async () => {
    const { servidor, url } = await subir();
    try {
      const bom = await conectar(url);
      bom.enviarTexto(helloValido('aparelho bom'));
      assert.equal((await bom.proximoTexto()).t, 'welcome');

      const ruim = await conectar(url);
      ruim.enviarTexto({ ...helloValido(), v: 99 });
      assert.equal((await ruim.proximoTexto()).codigo, 'VERSAO_INCOMPATIVEL');
      await ruim.esperarFechamento();

      assert.equal(servidor.sessaoAtual()?.aparelho?.nome, 'aparelho bom');
      bom.fechar();
    } finally {
      await servidor.fechar();
    }
  });

  it('solta a sessão quando o app manda bye', async () => {
    const encerramentos: string[] = [];
    const { servidor, url } = await subir({
      aoEncerrarSessao: (_sessao, motivo) => {
        encerramentos.push(motivo);
      },
    });
    try {
      const cliente = await conectar(url);
      cliente.enviarTexto(helloValido());
      assert.equal((await cliente.proximoTexto()).t, 'welcome');

      cliente.enviarTexto({ t: 'bye', motivo: 'usuário encerrou' });
      await cliente.esperarFechamento();

      assert.equal(servidor.sessaoAtual(), undefined);
      assert.equal(encerramentos.length, 1);
      assert.match(encerramentos[0] ?? '', /usuário encerrou/);
    } finally {
      await servidor.fechar();
    }
  });

  it('conexão que cai sem virar sessão não dispara a soltura da sessão viva', async () => {
    // `aoEncerrarSessao` é o gancho de soltura de estado: botão preso (ATI-007) e memória do
    // pipeline de movimento (ATI-008). Dispará-lo pela queda de um socket que nunca foi sessão
    // apagaria o estado de quem está com o celular na mão — e a origem desse socket é banal:
    // segunda aba da página /diagnostico, reconexão que falhou, varredura de porta.
    const encerramentos: string[] = [];
    const { servidor, url } = await subir({
      // O socket mudo também é cortado pelo servidor; sem um limite curto isso levaria 5 s.
      limiteDoHandshakeMs: 60,
      aoEncerrarSessao: (sessao, motivo) => {
        encerramentos.push(`${sessao.id}:${motivo}`);
      },
    });
    try {
      const bom = await conectar(url);
      bom.enviarTexto(helloValido('aparelho na mão'));
      assert.equal((await bom.proximoTexto()).t, 'welcome');

      // (a) abre e fecha sem falar nada
      const mudo = await conectar(url);
      mudo.fechar();
      await mudo.esperarFechamento();

      // (b) fala, mas é recusada no handshake
      const recusado = await conectar(url);
      recusado.enviarTexto({ ...helloValido(), v: VERSAO_PROTOCOLO + 1 });
      await recusado.esperarFechamento();

      await esperarAte(() => servidor.conexoesAbertas() === 1, 'as conexões de fora caírem');

      assert.deepEqual(encerramentos, [], 'nenhuma soltura disparada por conexão de terceiro');
      assert.equal(servidor.sessaoAtual()?.aparelho?.nome, 'aparelho na mão', 'a sessão viva ficou');

      // E a sessão de verdade continua soltando o que segurava quando ela mesma cai.
      bom.fechar();
      await esperarAte(() => encerramentos.length === 1, 'o fechamento da sessão de verdade');
      assert.match(encerramentos[0] ?? '', /^s-1:/);
    } finally {
      await servidor.fechar();
    }
  });

  it('a sessão substituída dispara a soltura — ela chegou a ser adotada', async () => {
    // O outro lado da mesma moeda: o portão de "só sessão adotada" não pode calar justamente o
    // caso em que o aparelho novo toma o lugar do anterior com um botão apertado.
    const encerradas: string[] = [];
    const { servidor, url } = await subir({
      aoEncerrarSessao: (sessao) => {
        encerradas.push(sessao.id);
      },
    });
    try {
      const antigo = await conectar(url);
      antigo.enviarTexto(helloValido('aparelho antigo'));
      assert.equal((await antigo.proximoTexto()).t, 'welcome');

      const novo = await conectar(url);
      novo.enviarTexto(helloValido('aparelho novo'));
      assert.equal((await novo.proximoTexto()).t, 'welcome');
      await antigo.esperarFechamento();

      assert.deepEqual(encerradas, ['s-1']);
      assert.equal(servidor.sessaoAtual()?.id, 's-2');
      novo.fechar();
    } finally {
      await servidor.fechar();
    }
  });
});

describe('servidor de transporte — pacotes binários', () => {
  it('decodifica MOVIMENTO e soma os contadores da sessão', async () => {
    let agoraFalso = 0;
    const recebidos: Array<ReturnType<typeof resumirPacote>> = [];
    let avisar: (() => void) | undefined;

    const { servidor, url } = await subir({
      relogio: () => agoraFalso,
      // Ping longe daqui: este teste é sobre contador, não sobre heartbeat.
      intervaloPingMs: 60_000,
      aoReceberPacote: (pacote) => {
        recebidos.push(resumirPacote(pacote));
        avisar?.();
      },
    });

    try {
      const cliente = await conectar(url);
      cliente.enviarTexto(helloValido());
      assert.equal((await cliente.proximoTexto()).t, 'welcome');

      const codificador = criarCodificador();
      const chegou = comLimite(
        new Promise<void>((resolver) => {
          avisar = resolver;
        }),
        'o pacote de movimento chegar',
      );
      cliente.enviarBinario(codificador.movimento(1, 1000, 10, 0.5, -0.25, 0.125));
      await chegou;

      assert.equal(recebidos.length, 1);
      assert.equal(recebidos[0]?.seq, 1);
      assert.equal(Math.round((recebidos[0]?.gx ?? 0) * 1000), 500);

      // A janela de taxa só publica quando fecha: avança o relógio injetado em 1 s.
      agoraFalso = 1000;
      const medidas = servidor.sessaoAtual()?.instantaneo().medidas;
      assert.equal(medidas?.pacotesRecebidos, 1);
      assert.equal(medidas?.bytesRecebidos, TAMANHO_MOVIMENTO);
      assert.equal(medidas?.taxaHzMedida, 1);
      assert.equal(medidas?.dtMsMedio, 10);
      assert.equal(medidas?.descartados, 0);

      cliente.fechar();
    } finally {
      await servidor.fechar();
    }
  });

  it('descarta MOVIMENTO atrasado, mas entrega BOTÃO atrasado', async () => {
    const recebidos: Array<ReturnType<typeof resumirPacote>> = [];
    let avisar: (() => void) | undefined;

    const { servidor, url } = await subir({
      intervaloPingMs: 60_000,
      aoReceberPacote: (pacote) => {
        recebidos.push(resumirPacote(pacote));
        avisar?.();
      },
    });

    try {
      const cliente = await conectar(url);
      cliente.enviarTexto(helloValido());
      assert.equal((await cliente.proximoTexto()).t, 'welcome');

      const codificador = criarCodificador();
      const esperarPacote = (oQue: string): Promise<void> =>
        comLimite(
          new Promise<void>((resolver) => {
            avisar = resolver;
          }),
          oQue,
        );

      let chegou = esperarPacote('o movimento em ordem');
      cliente.enviarBinario(codificador.movimento(5, 1000, 10, 0, 0, 0));
      await chegou;

      // TCP entrega em ordem: quando o BOTÃO chegar, o MOVIMENTO atrasado já foi processado.
      chegou = esperarPacote('o botão atrasado');
      cliente.enviarBinario(codificador.movimento(4, 1010, 10, 9, 9, 9));
      cliente.enviarBinario(codificador.botao(3, 1, false));
      await chegou;

      assert.equal(recebidos.length, 2, 'o movimento atrasado não podia ser entregue');
      assert.equal(recebidos[1]?.seq, 3, 'a soltura de botão atrasada precisa passar');

      const medidas = servidor.sessaoAtual()?.instantaneo().medidas;
      assert.equal(medidas?.foraDeOrdem, 2);
      // Só o MOVIMENTO é jogado fora: descartar uma soltura de botão é como se prende um botão.
      assert.equal(medidas?.descartadosForaDeOrdem, 1);

      cliente.fechar();
    } finally {
      await servidor.fechar();
    }
  });

  it('conta o pacote binário que chega no sentido errado, em vez de deixá-lo sumir', async () => {
    const recebidos: number[] = [];
    const { servidor, url } = await subir({
      intervaloPingMs: 60_000,
      aoReceberPacote: (pacote) => {
        recebidos.push(pacote.tipo);
      },
    });

    try {
      const cliente = await conectar(url);
      cliente.enviarTexto(helloValido());
      assert.equal((await cliente.proximoTexto()).t, 'welcome');

      const codificador = criarCodificador();
      // RUMBLE é do servidor para o app (PROTOCOLO.md, seção 5): vindo do app, é direção errada.
      cliente.enviarBinario(codificador.rumble(200, 100, 50));

      // Um MOVIMENTO logo atrás serve de marcador: TCP entrega em ordem, então quando ele chegar
      // o RUMBLE já foi processado — sem isso o teste dependeria de dormir e torcer.
      const chegou = comLimite(
        new Promise<void>((resolver) => {
          const conferir = (): void => {
            if (recebidos.length > 0) resolver();
            else setTimeout(conferir, 5).unref();
          };
          conferir();
        }),
        'o movimento marcador chegar',
      );
      cliente.enviarBinario(codificador.movimento(1, 1000, 10, 0, 0, 0));
      await chegou;

      const medidas = servidor.sessaoAtual()?.instantaneo().medidas;
      assert.deepEqual(recebidos, [1], 'o RUMBLE não podia ser entregue ao pipeline');
      assert.equal(medidas?.pacotesNoSentidoErrado, 1);
      // Ele não é defeito de formato: `descartados` continua sendo porTamanho + porTipo (seção 7).
      assert.equal(medidas?.descartados, 0);

      cliente.fechar();
    } finally {
      await servidor.fechar();
    }
  });

  it('ignora quadro binário que chegue antes do welcome', async () => {
    const recebidos: number[] = [];
    const { servidor, url } = await subir({
      aoReceberPacote: (pacote) => {
        recebidos.push(pacote.tipo);
      },
    });
    try {
      const cliente = await conectar(url);
      const codificador = criarCodificador();
      cliente.enviarBinario(codificador.movimento(1, 0, 10, 0, 0, 0));

      cliente.enviarTexto(helloValido());
      assert.equal((await cliente.proximoTexto()).t, 'welcome');

      const medidas = servidor.sessaoAtual()?.instantaneo().medidas;
      assert.equal(recebidos.length, 0);
      assert.equal(medidas?.pacotesRecebidos, 0);

      cliente.fechar();
    } finally {
      await servidor.fechar();
    }
  });
});

describe('servidor de transporte — heartbeat', () => {
  it('manda ping periódico e mede o RTT com o eco do tServidorMs', async () => {
    const { servidor, url } = await subir({ intervaloPingMs: 30, limiteSemPongMs: 3000 });
    try {
      const cliente = await conectar(url);
      cliente.enviarTexto(helloValido());
      assert.equal((await cliente.proximoTexto()).t, 'welcome');

      const ping = await cliente.proximoTexto();
      assert.equal(ping.t, 'ping');
      assert.equal(ping.n, 1);
      assert.equal(typeof ping.tServidorMs, 'number');

      cliente.enviarTexto({
        t: 'pong',
        n: ping.n,
        tServidorMs: ping.tServidorMs,
        tDispositivoMs: 4242,
      });

      // O pong seguinte prova que a sessão continua viva e que o RTT foi contabilizado.
      const segundoPing = await cliente.proximoTexto();
      assert.equal(segundoPing.t, 'ping');

      const medidas = servidor.sessaoAtual()?.instantaneo().medidas;
      assert.equal(medidas?.pongsRecebidos, 1);
      assert.ok((medidas?.rttMsUltimo ?? -1) >= 0, 'o RTT medido não pode ser negativo');
      assert.ok((medidas?.rttMsP50 ?? -1) >= 0);

      cliente.fechar();
    } finally {
      await servidor.fechar();
    }
  });

  it('recusa o pong cujo eco de tServidorMs não bate com o ping enviado', async () => {
    const { servidor, url } = await subir({ intervaloPingMs: 30, limiteSemPongMs: 3000 });
    try {
      const cliente = await conectar(url);
      cliente.enviarTexto(helloValido());
      assert.equal((await cliente.proximoTexto()).t, 'welcome');

      const ping = await cliente.proximoTexto();
      assert.equal(ping.t, 'ping');
      // Eco inventado: sem conferência, isto entraria como RTT enorme e envenenaria o p95.
      cliente.enviarTexto({ t: 'pong', n: ping.n, tServidorMs: -12345, tDispositivoMs: 7 });

      const segundoPing = await cliente.proximoTexto();
      assert.equal(segundoPing.t, 'ping', 'eco errado não pode derrubar a sessão');

      const medidas = servidor.sessaoAtual()?.instantaneo().medidas;
      assert.equal(medidas?.pongsRecusados, 1);
      assert.equal(medidas?.pongsRecebidos, 0, 'nenhum RTT podia ter entrado na estatística');
      assert.equal(medidas?.rttMsUltimo, 0);

      cliente.fechar();
    } finally {
      await servidor.fechar();
    }
  });

  it('derruba a sessão quando o pong para de chegar', async () => {
    const { servidor, url } = await subir({ intervaloPingMs: 40, limiteSemPongMs: 120 });
    try {
      const cliente = await conectar(url);
      cliente.enviarTexto(helloValido());
      assert.equal((await cliente.proximoTexto()).t, 'welcome');

      // Nenhum pong é enviado de propósito: em ~120 ms a sessão precisa cair sozinha.
      await cliente.esperarFechamento();
      assert.equal(servidor.sessaoAtual(), undefined);
    } finally {
      await servidor.fechar();
    }
  });
});

describe('servidor de transporte — encerramento', () => {
  it('manda bye, solta a sessão e fecha a porta', async () => {
    const soltas: SessaoDeTransporte[] = [];
    const { servidor, url } = await subir({
      aoEncerrarSessao: (sessao) => {
        soltas.push(sessao);
      },
    });

    const cliente = await conectar(url);
    cliente.enviarTexto(helloValido());
    assert.equal((await cliente.proximoTexto()).t, 'welcome');

    const fechamento = servidor.fechar('teste encerrando');
    const bye = await cliente.proximoTexto();
    assert.equal(bye.t, 'bye');
    assert.equal(bye.motivo, 'teste encerrando');

    await fechamento;
    await cliente.esperarFechamento();

    assert.equal(soltas.length, 1, 'a soltura de estado precisa acontecer uma vez por sessão');
    assert.equal(servidor.endereco(), undefined);

    // Idempotente: fechar de novo não pode lançar nem pendurar.
    await servidor.fechar();
  });
});
