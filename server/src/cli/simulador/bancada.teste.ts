/**
 * Teste de ponta a ponta **sem aparelho**: servidor de verdade, socket de verdade, simulador no
 * lugar do celular (ATI-023, critérios de aceite 1, 2, 3, 4 e 5).
 *
 * O caminho exercitado é o mesmo do Pixel na mesa: `criarServidorDeTransporte` sem desvio de
 * teste, o codec de `src/protocolo/` nos dois lados e WebSocket sobre o loopback. O que o
 * aparelho não dá — e é a razão de tudo isto existir — é **movimento conhecido**: quando o
 * simulador declara 90°, dá para conferir 90 na outra ponta.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { WebSocketServer, type RawData } from 'ws';
import {
  FLAG_PRIMEIRA_APOS_RETOMAR,
  TAMANHO_MOVIMENTO,
  VERSAO_PROTOCOLO,
  interpretarMensagemDeTexto,
  serializarMensagemDeTexto,
} from '../../protocolo/indice.js';
import { lerCaptura } from '../captura.js';
import { executarBancada } from './bancada.js';
import { criarSimulador } from './cliente.js';
import { criarFonteDeAmostras, resolverParametros, type AmostraSimulada } from './padroes.js';

const pastaTemporaria = mkdtempSync(join(tmpdir(), 'controle-bancada-'));

after(() => {
  rmSync(pastaTemporaria, { recursive: true, force: true });
});

const RADIANOS_PARA_GRAUS = 180 / Math.PI;

/** O que um servidor cru viu de uma execução do simulador. */
interface ConversaCrua {
  /** Campo `t` de cada quadro de texto recebido, na ordem. */
  readonly quadrosDeTexto: readonly string[];
  /** Código do quadro de fechamento; 1006 quando não veio quadro nenhum (socket cortado). */
  readonly codigoDeFechamento: number;
}

/**
 * Conversa com o simulador usando um `WebSocketServer` cru, sem o servidor do projeto.
 *
 * O servidor de transporte trata `close(1000)` e socket cortado do mesmo jeito (ambos viram
 * `conexão fechada`), então ele não serve para distinguir os dois caminhos de encerramento.
 * Aqui o teste enxerga o quadro de fechamento do WebSocket, que é onde a diferença aparece.
 */
async function conversarComServidorCru(opcoes: { enviarBye: boolean }): Promise<ConversaCrua> {
  const servidor = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const quadrosDeTexto: string[] = [];
  let codigoDeFechamento = -1;
  let avisarFechamento: (() => void) | undefined;
  const fechou = new Promise<void>((resolver) => {
    avisarFechamento = resolver;
  });

  servidor.on('connection', (socket) => {
    socket.on('message', (dados: RawData, ehBinario: boolean) => {
      if (ehBinario) return;
      const leitura = interpretarMensagemDeTexto(Buffer.from(dados as Buffer).toString('utf8'));
      if (!leitura.ok) return;
      quadrosDeTexto.push(leitura.mensagem.t);
      if (leitura.mensagem.t !== 'hello') return;
      socket.send(
        serializarMensagemDeTexto({
          t: 'welcome',
          v: VERSAO_PROTOCOLO,
          servidor: { nome: 'cru', versao: '0.0.0', so: 'windows' },
          sessao: { id: 's-cru', taxaHz: 100, transporte: 'usb' },
          tela: { largura: 1920, altura: 1080 },
          perfilAtivo: { id: 'mouse-basico' },
          perfis: [{ id: 'mouse-basico', nome: 'Mouse básico' }],
        }),
      );
    });
    socket.on('close', (codigo: number) => {
      codigoDeFechamento = codigo;
      avisarFechamento?.();
    });
  });

  const porta = await new Promise<number>((resolver) => {
    servidor.once('listening', () => {
      const endereco = servidor.address();
      resolver(endereco === null || typeof endereco === 'string' ? 0 : endereco.port);
    });
  });

  try {
    const simulador = criarSimulador({
      url: `ws://127.0.0.1:${porta}`,
      fonte: criarFonteDeAmostras(
        resolverParametros({ padrao: 'parado', taxaHz: 100, duracaoS: 0.05 }),
      ),
      enviarBye: opcoes.enviarBye,
    });
    const resumo = await simulador.executar();
    assert.equal(resumo.desfecho, 'completo', resumo.motivo);
    await fechou;
    return { quadrosDeTexto, codigoDeFechamento };
  } finally {
    for (const cliente of servidor.clients) cliente.terminate();
    await new Promise<void>((resolver) => {
      servidor.close(() => {
        resolver();
      });
    });
  }
}

/** Integral de ω·dt em graus, sobre o que **chegou** ao servidor. */
function grausRecebidos(amostras: readonly AmostraSimulada[], eixo: 'gx' | 'gy' | 'gz'): number {
  let graus = 0;
  for (const amostra of amostras) {
    graus += amostra[eixo] * RADIANOS_PARA_GRAUS * (amostra.dtMs / 1000);
  }
  return graus;
}

describe('bancada — servidor e simulador no mesmo processo', () => {
  it('rotacao de 90° no eixo y: chega tudo, na ordem, com os 90° inteiros', async () => {
    const enviadas: AmostraSimulada[] = [];
    const resultado = await executarBancada({
      padrao: { padrao: 'rotacao', graus: 90, eixo: 'y', taxaHz: 100 },
      coletarRecebidas: true,
      cliente: { aoEnviar: (amostra) => enviadas.push({ ...amostra }) },
    });

    const { resumo, medidas, recebidas } = resultado;
    assert.equal(resumo.desfecho, 'completo', resumo.motivo);
    assert.equal(resumo.amostrasEnviadas, 101, '90° a 90 °/s a 100 Hz = 100 intervalos');
    assert.equal(resumo.bytesEnviados, 101 * TAMANHO_MOVIMENTO);
    assert.equal(resumo.sessao, 's-1', 'o servidor abriu sessão como abriria para o celular');

    assert.ok(medidas !== undefined, 'o servidor mediu a sessão');
    assert.equal(medidas.pacotesRecebidos, 101, 'nenhum pacote se perdeu no caminho');
    assert.equal(medidas.descartados, 0);
    assert.equal(medidas.descartadosPorTamanho, 0);
    assert.equal(medidas.descartadosPorTipo, 0);
    assert.equal(medidas.foraDeOrdem, 0);
    assert.equal(medidas.pacotesNoSentidoErrado, 0);
    assert.equal(medidas.comBytesExtras, 0);
    assert.equal(medidas.bytesRecebidos, 101 * TAMANHO_MOVIMENTO);

    // O movimento conhecido do simulador chegou inteiro do outro lado. A folga de 1e-3 é o
    // arredondamento do `f32` do fio (PROTOCOLO.md, seção 4.1) — não é folga de teste frouxo.
    const integrado = grausRecebidos(recebidas, 'gy');
    assert.ok(Math.abs(integrado - 90) < 1e-3, `o servidor recebeu ${integrado}°`);
    assert.equal(grausRecebidos(recebidas, 'gx'), 0, 'o eixo que ninguém girou fica em zero');

    // O que saiu é o que entrou, campo por campo — com `Math.fround` porque o fio é f32.
    assert.equal(recebidas.length, enviadas.length);
    for (let indice = 0; indice < recebidas.length; indice += 1) {
      const enviada = enviadas[indice];
      const recebida = recebidas[indice];
      assert.ok(enviada !== undefined && recebida !== undefined);
      assert.equal(recebida.seq, enviada.seq);
      assert.equal(recebida.tDispositivoMs, enviada.tDispositivoMs);
      assert.equal(recebida.dtMs, Math.fround(enviada.dtMs));
      assert.equal(recebida.gy, Math.fround(enviada.gy));
    }

    assert.equal(recebidas[0]?.flags, FLAG_PRIMEIRA_APOS_RETOMAR, 'a primeira amostra se anuncia');
    assert.equal(recebidas[0]?.dtMs, 0);
  });

  it('parado: nada de anormal se acumula no servidor ao longo da sessão', async () => {
    // 1001 amostras é o volume de 10 s a 100 Hz, entregue em ~2 s de relógio para o teste não
    // custar um minuto. O que se vigia é acúmulo — contador, ordem e deriva —, não o calendário.
    const resultado = await executarBancada({
      padrao: { padrao: 'parado', taxaHz: 500, duracaoS: 2, biasGrausPorS: 0.29 },
      coletarRecebidas: true,
    });

    const { resumo, medidas, recebidas } = resultado;
    assert.equal(resumo.desfecho, 'completo', resumo.motivo);
    assert.equal(resumo.amostrasEnviadas, 1001);
    assert.ok(medidas !== undefined);
    assert.equal(medidas.pacotesRecebidos, 1001);
    assert.equal(medidas.descartados, 0);
    assert.equal(medidas.foraDeOrdem, 0);
    assert.equal(medidas.pacotesNoSentidoErrado, 0);
    assert.equal(medidas.pongsRecusados, 0, 'todo pong do simulador bateu com o ping enviado');

    // Nenhuma leitura sequer perto de movimento de verdade: o `parado` não pode virar gesto.
    for (const amostra of recebidas) {
      const maior = Math.max(Math.abs(amostra.gx), Math.abs(amostra.gy), Math.abs(amostra.gz));
      assert.ok(maior * RADIANOS_PARA_GRAUS < 1, `leitura de ${maior * RADIANOS_PARA_GRAUS} °/s`);
    }

    // O único acúmulo esperado é o do bias declarado (0,29 °/s × 0,62 no eixo x × 2 s).
    const deriva = grausRecebidos(recebidas, 'gx');
    assert.ok(Math.abs(deriva - 0.29 * 0.62 * 2) < 0.05, `derivou ${deriva}° em 2 s`);

    // A taxa medida pelo servidor é a taxa pedida, não a nominal de um `setInterval` otimista.
    assert.ok(medidas.taxaHzMedida > 350, `taxa medida ${medidas.taxaHzMedida} Hz`);
    assert.ok(medidas.dtMsMedio > 1.9 && medidas.dtMsMedio < 2.1, `dt ${medidas.dtMsMedio} ms`);
  });

  it('a mesma semente entrega ao servidor exatamente a mesma sequência', async () => {
    const pedido = { padrao: 'tremor', taxaHz: 200, duracaoS: 0.5, semente: 987 } as const;
    const primeira = await executarBancada({ padrao: pedido, coletarRecebidas: true });
    const segunda = await executarBancada({ padrao: pedido, coletarRecebidas: true });

    assert.deepEqual(primeira.recebidas, segunda.recebidas);
    assert.equal(primeira.resumo.amostrasEnviadas, segunda.resumo.amostrasEnviadas);
  });

  it('pico: a amostra absurda chega intacta, sem o codec aparar nada', async () => {
    const resultado = await executarBancada({
      padrao: {
        padrao: 'pico',
        taxaHz: 200,
        duracaoS: 0.5,
        eixo: 'x',
        picoGrausPorS: 2000,
        indiceDoPico: 50,
      },
      coletarRecebidas: true,
    });

    const absurdas = resultado.recebidas.filter(
      (amostra) => Math.abs(amostra.gx) * RADIANOS_PARA_GRAUS > 100,
    );
    assert.equal(absurdas.length, 1);
    assert.equal(resultado.recebidas.indexOf(absurdas[0] as AmostraSimulada), 50);
    // O pico chega somado ao bias e ao ruído da linha de base (é assim que ele aparece num
    // sensor de verdade); o que se confere aqui é que nada aparou os 2000 °/s no caminho.
    assert.ok(Math.abs((absurdas[0]?.gx ?? 0) * RADIANOS_PARA_GRAUS - 2000) < 1);
    assert.equal(resultado.medidas?.descartados, 0, 'pico não é defeito de formato');
  });

  it('grava a sessão em arquivo e reproduz a captura igualzinha', async () => {
    const caminho = join(pastaTemporaria, 'rotacao.captura');

    const original = await executarBancada({
      padrao: { padrao: 'rotacao', graus: 30, eixo: 'z', taxaHz: 200 },
      gravarEm: caminho,
      coletarRecebidas: true,
    });
    assert.equal(original.resumo.desfecho, 'completo', original.resumo.motivo);
    assert.equal(original.amostrasGravadas, original.resumo.amostrasEnviadas);

    const captura = lerCaptura(caminho);
    assert.equal(captura.amostras.length, original.resumo.amostrasEnviadas);

    const reproduzida = await executarBancada({
      padrao: { padrao: 'gravado', amostrasGravadas: captura.amostras },
      coletarRecebidas: true,
    });

    assert.equal(reproduzida.resumo.desfecho, 'completo', reproduzida.resumo.motivo);
    // Ida e volta exatas: o arquivo já guarda valores que passaram pelo f32 do fio, então a
    // reprodução tem de bater **campo a campo**, sem tolerância nenhuma.
    assert.deepEqual(reproduzida.recebidas, original.recebidas);
    assert.ok(Math.abs(grausRecebidos(reproduzida.recebidas, 'gz') - 30) < 1e-3);
  });

  it('encerramento limpo: o servidor fecha a sessão pelo bye do aparelho', async () => {
    const resultado = await executarBancada({
      padrao: { padrao: 'parado', taxaHz: 100, duracaoS: 0.2 },
    });

    assert.equal(resultado.resumo.desfecho, 'completo', resultado.resumo.motivo);
    assert.equal(
      resultado.motivoDoEncerramento,
      'bye: sequência concluída',
      'o caminho limpo do PROTOCOLO.md, seção 3.7',
    );
    assert.equal(resultado.medidas?.pacotesRecebidos, 21);
  });

  it('--sem-bye: encerra abrupto, e o servidor encerra a sessão assim mesmo', async () => {
    const resultado = await executarBancada({
      padrao: { padrao: 'parado', taxaHz: 100, duracaoS: 0.2 },
      cliente: { enviarBye: false },
    });

    assert.equal(resultado.resumo.desfecho, 'completo', resultado.resumo.motivo);
    assert.ok(resultado.medidas !== undefined, 'a sessão foi encerrada e medida assim mesmo');
    // Nenhum `bye` chegou: o servidor descobriu a queda pelo socket, não por aviso do aparelho.
    // (O `motivo` exato do servidor depende de o socket morrer por fechamento ou por erro —
    //  o que se afirma aqui é que **não** foi pelo caminho limpo.)
    assert.ok(
      !(resultado.motivoDoEncerramento ?? '').startsWith('bye'),
      `encerrou por "${resultado.motivoDoEncerramento ?? '—'}"`,
    );
  });

  it('--sem-bye corta o socket: sem quadro bye e sem close handshake', async () => {
    // A prova de que o encerramento é **abrupto** não está no servidor do projeto (que registra
    // "conexão fechada" tanto para `close(1000)` quanto para socket cortado), e sim no quadro de
    // fechamento do WebSocket: no caminho limpo o outro lado recebe o código 1000; no abrupto
    // não recebe quadro nenhum, e o `ws` reporta 1006 (fechamento anormal). Sem esta asserção, o
    // teste de "sem bye" passaria verde contra um fechamento educado — foi o defeito da rodada 1.
    const limpo = await conversarComServidorCru({ enviarBye: true });
    assert.deepEqual(limpo.quadrosDeTexto, ['hello', 'bye'], 'o caminho limpo se despede');
    assert.equal(limpo.codigoDeFechamento, 1000, 'close handshake normal');

    const abrupto = await conversarComServidorCru({ enviarBye: false });
    assert.deepEqual(abrupto.quadrosDeTexto, ['hello'], 'nenhum bye foi enviado');
    assert.equal(abrupto.codigoDeFechamento, 1006, 'o socket morreu sem quadro de fechamento');
  });

  it('responde ao ping do servidor com pong que bate com o carimbo enviado', async () => {
    const resultado = await executarBancada({
      padrao: { padrao: 'parado', taxaHz: 100, duracaoS: 0.6 },
      // Ping bem mais rápido que o de produção (1 s), para o teste não durar segundos à toa.
      servidor: { intervaloPingMs: 50 },
    });

    assert.ok(resultado.resumo.pingsRespondidos >= 3, 'o simulador respondeu aos pings');
    assert.equal(resultado.medidas?.pongsRecusados, 0, 'todo eco conferiu (PROTOCOLO.md 3.6)');
    assert.ok((resultado.medidas?.pongsRecebidos ?? 0) >= 3);
  });

  it('servidor mudo: o simulador desiste em vez de esperar para sempre', async () => {
    // Um `WebSocketServer` cru, que aceita a conexão e não responde nada — é o socket
    // meio-aberto do PROTOCOLO.md, seção 3.6, visto do lado do aparelho. Sem a vigia do
    // `welcome`, o simulador ficaria pendurado e o teste com ele.
    const mudo = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const porta = await new Promise<number>((resolver) => {
      mudo.once('listening', () => {
        const endereco = mudo.address();
        resolver(endereco === null || typeof endereco === 'string' ? 0 : endereco.port);
      });
    });

    try {
      const simulador = criarSimulador({
        url: `ws://127.0.0.1:${porta}`,
        fonte: criarFonteDeAmostras(resolverParametros({ padrao: 'parado', duracaoS: 0.2 })),
        limiteDeWelcomeMs: 300,
      });

      const resumo = await simulador.executar();

      assert.equal(resumo.desfecho, 'erro');
      assert.match(resumo.motivo, /welcome/);
      assert.equal(resumo.amostrasEnviadas, 0, 'sem sessão, não se envia amostra nenhuma');
    } finally {
      for (const cliente of mudo.clients) cliente.terminate();
      await new Promise<void>((resolver) => {
        mudo.close(() => {
          resolver();
        });
      });
    }
  });
});
