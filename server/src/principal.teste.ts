/**
 * Teste do ponto de entrada.
 *
 * O ganho de ter a guarda `ehPontoDeEntrada()` é justamente este arquivo existir: se
 * `principal()` rodasse no import, importar o módulo aqui subiria o servidor e a âncora do
 * event loop seguraria o processo de teste para sempre.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import {
  CONTROLES_DO_MOUSE_BASICO,
  TABELA_MOUSE_BASICO,
  criarDestinoDeAcoesDeEnsaio,
  criarMapeadorDeAcoes,
} from './acoes/indice.js';
import {
  CONFIGURACAO_PADRAO,
  VARIAVEIS_DE_AMBIENTE,
  carregarConfiguracao,
  type ConfiguracaoServidor,
  type OpcoesDeCarga,
} from './config.js';
import type { ControleDeEncerramento } from './encerramento.js';
import { criarRegistrador, type Registrador } from './log.js';
import {
  AJUSTES_PADRAO,
  CAMINHO_PADRAO,
  criarContadoresDoPipeline,
  criarPipelineDeMovimento,
  criarRepositorioDeBias,
  resolverAjustes,
  type RepositorioDeBias,
} from './movimento/indice.js';
import {
  OPCAO_TESTE_DE_MOUSE,
  OPCAO_TESTE_DE_MOUSE_SEM_CLIQUE,
  VERSAO_SERVIDOR,
  ajustesDaConfiguracao,
  criarFechamentoDeSessao,
  ehPontoDeEntrada,
  interpretarArgumentosDaPartida,
  montarComandos,
  montarMapeadorDeAcoes,
  montarPipeline,
  principal,
  registrarTotalDaExecucao,
  type OpcoesDaPartida,
  type PecasDaSessao,
} from './principal.js';
import {
  TIPO_BOTAO,
  TIPO_MOVIMENTO,
  copiar,
  criarCodificador,
  criarPacoteDecodificado,
} from './protocolo/indice.js';
import { criarBackendDubla, type BackendDubla, type EventoDaDubla } from './saida/dubla.js';
import { ErroDeSaida } from './saida/indice.js';
import type { EnderecoDoTransporte, SessaoDeTransporte } from './transporte/indice.js';

/** Registrador mudo: a saída de um teste é a asserção, não o log. */
function registradorMudo(): Registrador {
  return criarRegistrador('depuracao', 'teste', () => {
    // de propósito vazio
  });
}

const pastaTemporaria = mkdtempSync(join(tmpdir(), 'controle-principal-'));
let proximoArquivoDeBias = 0;

after(() => {
  rmSync(pastaTemporaria, { recursive: true, force: true });
});

/**
 * O bias guardado de toda partida deste arquivo mora em pasta temporária.
 *
 * Mesma regra do `comDubla`, um degrau ao lado: **teste automático não encosta na máquina de quem
 * está trabalhando**. Uma sessão fechada aqui pode gravar bias, e sem isto ela gravaria no
 * `server/dados-locais/bias.json` de verdade — e um arquivo de verdade nessa pasta mudaria o que
 * estes testes leem, que é um vetor de teste intermitente.
 */
function criarRepositorioTemporario(): RepositorioDeBias {
  proximoArquivoDeBias += 1;
  return criarRepositorioDeBias({
    caminho: join(pastaTemporaria, `bias-${proximoArquivoDeBias}.json`),
  });
}

/** Timers vivos: é a âncora do event loop que aparece aqui. */
function contarTemporizadoresAtivos(): number {
  return process.getActiveResourcesInfo().filter((recurso) => recurso === 'Timeout').length;
}

/**
 * Toda partida deste arquivo usa a dubla.
 *
 * Sem isto, `npm test` criaria o backend do Windows de verdade — e um teste que pega a `user32` na
 * máquina de quem está trabalhando é exatamente o que este sprint combinou não fazer.
 */
function comDubla(): { criarBackend: () => BackendDubla; dubla: BackendDubla } {
  const dubla = criarBackendDubla();
  return { criarBackend: () => dubla, dubla };
}

/**
 * A carga de configuração de **toda** partida deste arquivo (ATI-030).
 *
 * Porta 0 (efêmera), nenhum `controle.config.json` e um ambiente que só tem o que o teste disser.
 * Nem o `npm run dev` de quem está trabalhando (que segura a 8765), nem a suíte de outro agente
 * rodando ao mesmo tempo, nem um arquivo de configuração esquecido nesta máquina podem mudar o
 * resultado daqui — e o `process.env` real também não: um `CONTROLE_MOVIMENTO=sistema` no
 * terminal de quem roda a suíte não chega à partida de teste. O log fica em `erro` para a partida
 * não escrever no meio do relatório.
 */
function cargaDeTeste(ambiente: Readonly<Record<string, string>> = {}, porta = 0): OpcoesDeCarga {
  return {
    ambiente: { [VARIAVEIS_DE_AMBIENTE.nivelLog]: 'erro', ...ambiente },
    caminhoDoArquivo: null,
    porta,
  };
}

/**
 * Traduz a falha de abertura da porta para o que ela é.
 *
 * Antes da ATI-030, porta ocupada chegava ao relatório como `'test failed'` no arquivo inteiro (o
 * `principal()` marca `process.exitCode = 1` nesse caso), e a primeira hipótese de quem lia era
 * regressão na entrega.
 *
 * O número vem **do erro**, e não do que o teste pediu: se a carga de teste deixar de valer (alguém
 * volta a ler a porta da configuração), a colisão acontece numa porta que o teste nem pediu, e é
 * essa que a pessoa precisa saber qual é para achar o servidor que está nela.
 */
function explicarFalhaDeAbertura(erro: unknown, portaPedida: number): Error {
  const falha = erro as (NodeJS.ErrnoException & { port?: number }) | undefined;
  const porta = falha?.port ?? portaPedida;
  if (falha?.code === 'EADDRINUSE') {
    return new Error(
      `porta ${porta} ocupada, encerre o servidor que está nela (npm run dev, npm run telemetria) ` +
        'e rode a suíte de novo — ou, melhor, suba este teste em porta efêmera (0)',
      { cause: erro },
    );
  }
  return new Error(`o servidor do teste não abriu a porta ${porta}: ${String(erro)}`, { cause: erro });
}

interface ServidorDoTeste {
  readonly encerramento: ControleDeEncerramento;
  /** A porta que o sistema deu de verdade — é nela que o cliente do teste conecta. */
  readonly porta: number;
}

/**
 * Sobe o `principal()` de verdade e só volta com a porta **aberta**.
 *
 * A porta é efêmera por padrão; o endereço efetivo vem da abertura que o `principal()` entrega
 * (`observarAbertura`). Se a porta não abrir, o servidor é encerrado aqui e o erro sai com nome e
 * número (`explicarFalhaDeAbertura`).
 */
async function subirServidor(
  opcoes: Omit<OpcoesDaPartida, 'carga' | 'observarAbertura'>,
  ambiente: Readonly<Record<string, string>> = {},
  porta = 0,
): Promise<ServidorDoTeste> {
  const aberturas: Promise<EnderecoDoTransporte>[] = [];
  const encerramento = principal({
    ...opcoes,
    carga: cargaDeTeste(ambiente, porta),
    observarAbertura: (abertura) => {
      aberturas.push(abertura);
    },
  });
  assert.ok(encerramento, 'o principal() recusou a partida');
  const [abertura] = aberturas;
  assert.ok(abertura, 'o principal() não entregou a abertura da porta');

  try {
    const endereco = await abertura;
    return { encerramento, porta: endereco.porta };
  } catch (erro) {
    await encerramento.encerrar('teste: a porta não abriu');
    throw explicarFalhaDeAbertura(erro, porta);
  }
}

/** Porta efêmera tomada por um servidor qualquer: é o `npm run dev` de alguém, em miniatura. */
async function ocuparPortaEfemera(): Promise<{ porta: number; liberar: () => Promise<void> }> {
  const ocupante = createServer((socket) => socket.destroy());
  await new Promise<void>((resolver, rejeitar) => {
    ocupante.once('error', rejeitar);
    ocupante.listen(0, '127.0.0.1', resolver);
  });
  const endereco = ocupante.address();
  assert.ok(endereco !== null && typeof endereco === 'object');
  return {
    porta: endereco.port,
    liberar: () =>
      new Promise<void>((resolver) => {
        ocupante.close(() => {
          resolver();
        });
      }),
  };
}

/** Sessão sem socket: só o que o ciclo de sessão dos comandos lê dela. */
function criarSessaoFalsa(idAparelho: string): SessaoDeTransporte {
  return {
    id: 's-teste',
    estado: 'ativa',
    aparelho: {
      id: idAparelho,
      nome: 'Aparelho de teste',
      so: 'android',
      versaoSo: '14',
      modelo: 'teste',
    },
    noDelayAplicado: true,
    instantaneo() {
      throw new Error('a sessão falsa não produz instantâneo');
    },
    enviarTexto() {
      return true;
    },
    enviarBinario() {
      return true;
    },
    encerrar() {
      // Nada a encerrar numa sessão que não tem socket.
    },
  };
}

/** Espera uma mensagem de texto de um tipo, com teto — nenhum teste fica pendurado. */
async function esperarMensagem(
  recebidas: Record<string, unknown>[],
  tipo: string,
  limiteMs = 3000,
): Promise<Record<string, unknown>> {
  const comeco = Date.now();
  for (;;) {
    const achada = recebidas.find((mensagem) => mensagem['t'] === tipo);
    if (achada !== undefined) return achada;
    if (Date.now() - comeco >= limiteMs) throw new Error(`tempo esgotado esperando "${tipo}"`);
    await new Promise<void>((resolver) => {
      const relogio = setTimeout(resolver, 5);
      relogio.unref();
    });
  }
}

describe('ehPontoDeEntrada', () => {
  it('diz que NÃO é o programa quando quem roda é o runner de teste', () => {
    // Dentro do `node --test`, `process.argv[1]` aponta para o runner, não para este módulo.
    assert.equal(ehPontoDeEntrada(), false);
  });

  it('diz que É o programa quando o node aponta para o próprio arquivo', () => {
    const original = process.argv[1];
    // `principal.ts` ao lado deste arquivo: é o que o `npm run dev` passa para o node.
    process.argv[1] = fileURLToPath(new URL('./principal.ts', import.meta.url));
    try {
      assert.equal(ehPontoDeEntrada(), true);
    } finally {
      if (original === undefined) process.argv.splice(1, 1);
      else process.argv[1] = original;
    }
  });

  it('não quebra quando argv[1] não é arquivo nenhum (REPL, node -e)', () => {
    const original = process.argv[1];
    process.argv[1] = 'nem-existe-esse-caminho';
    try {
      assert.equal(ehPontoDeEntrada(), false);
    } finally {
      if (original === undefined) process.argv.splice(1, 1);
      else process.argv[1] = original;
    }
  });
});

describe('principal', () => {
  it('sobe quando chamado de propósito e solta tudo no encerramento', async () => {
    const antes = contarTemporizadoresAtivos();
    const { criarBackend, dubla } = comDubla();
    const encerramento = principal({
      criarBackend,
      argumentos: [],
      criarRepositorio: criarRepositorioTemporario,
      carga: cargaDeTeste(),
    });

    assert.ok(encerramento, 'devolve o controle para pendurar tarefa de soltura');
    assert.equal(
      contarTemporizadoresAtivos(),
      antes + 1,
      'a âncora do event loop está de pé, senão o processo sairia antes do Ctrl+C',
    );

    await encerramento.encerrar('teste');

    assert.equal(
      contarTemporizadoresAtivos(),
      antes,
      'depois do encerramento não sobra handle segurando o processo',
    );
    assert.equal(
      dubla.encerramentos(),
      1,
      'o backend de entrada foi solto no encerramento (regra 5 do CLAUDE.md)',
    );
  });

  it('recusa configuração inválida sem subir nada', () => {
    const saidaOriginal = process.exitCode;

    const antes = contarTemporizadoresAtivos();
    try {
      const encerramento = principal({
        criarBackend: comDubla().criarBackend,
        argumentos: [],
        criarRepositorio: criarRepositorioTemporario,
        carga: cargaDeTeste({ [VARIAVEIS_DE_AMBIENTE.taxaHz]: 'rapido' }),
      });

      assert.equal(encerramento, undefined, 'nada subiu, não há o que soltar');
      assert.equal(contarTemporizadoresAtivos(), antes, 'nem âncora ficou para trás');
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = saidaOriginal;
    }
  });

  it('não trunca a captura que já existe quando a gravação é pedida na partida', () => {
    // O cenário medido na revisão da ATI-023: uma captura de sessão real no disco, o servidor
    // subindo de novo com a mesma `CONTROLE_GRAVACAO` e o arquivo virando 147 bytes de cabeçalho
    // antes mesmo de a porta abrir. Captura é dado irreprodutível — a partida falha, o arquivo fica.
    const pasta = mkdtempSync(join(tmpdir(), 'controle-principal-'));
    const caminho = join(pasta, 'preciosa.captura');
    const conteudo = '# controle-captura v1\n# sessão de ontem\n1 0 10 10 0.1 0.2 0.3\n';
    writeFileSync(caminho, conteudo, 'utf8');

    const saidaOriginal = process.exitCode;

    const antes = contarTemporizadoresAtivos();
    const { criarBackend, dubla } = comDubla();
    try {
      const encerramento = principal({
        criarBackend,
        argumentos: [],
        criarRepositorio: criarRepositorioTemporario,
        carga: cargaDeTeste({ [VARIAVEIS_DE_AMBIENTE.gravacao]: caminho }),
      });

      assert.equal(encerramento, undefined, 'nada subiu: a gravação falhou antes do transporte');
      assert.equal(process.exitCode, 1);
      assert.equal(contarTemporizadoresAtivos(), antes, 'nem âncora ficou para trás');
      assert.equal(readFileSync(caminho, 'utf8'), conteudo, 'a captura de ontem continua inteira');
      assert.equal(dubla.encerramentos(), 1, 'o backend criado antes da falha foi desfeito');
    } finally {
      process.exitCode = saidaOriginal;
      rmSync(pasta, { recursive: true, force: true });
    }
  });

  it('a versão exposta é a que vai no welcome do handshake', () => {
    assert.match(VERSAO_SERVIDOR, /^\d+\.\d+\.\d+$/);
  });
});

describe('interpretarArgumentosDaPartida', () => {
  it('--teste-mouse pede o gesto com clique', () => {
    assert.deepEqual(interpretarArgumentosDaPartida([OPCAO_TESTE_DE_MOUSE]), {
      testeDeMouse: true,
      clicarNoTeste: true,
      desconhecidos: [],
    });
  });

  it('--teste-mouse-sem-clique pede o mesmo gesto sem clicar no que estiver embaixo', () => {
    assert.deepEqual(interpretarArgumentosDaPartida([OPCAO_TESTE_DE_MOUSE_SEM_CLIQUE]), {
      testeDeMouse: true,
      clicarNoTeste: false,
      desconhecidos: [],
    });
  });

  it('sem argumento nenhum, não pede teste de mouse', () => {
    assert.deepEqual(interpretarArgumentosDaPartida([]), {
      testeDeMouse: false,
      clicarNoTeste: false,
      desconhecidos: [],
    });
  });

  it('argumento desconhecido é coletado para virar aviso, não recusa de partida', () => {
    const pedido = interpretarArgumentosDaPartida(['--taxa', '200', OPCAO_TESTE_DE_MOUSE]);

    assert.equal(pedido.testeDeMouse, true);
    assert.deepEqual(pedido.desconhecidos, ['--taxa', '200']);
  });
});

describe('criarFechamentoDeSessao', () => {
  it('sessão que cai solta o que o backend estava segurando', () => {
    const dubla = criarBackendDubla();
    dubla.botaoMouse('esquerdo', true);
    dubla.tecla(0x2a, true);

    criarFechamentoDeSessao({ backend: dubla })();

    assert.equal(dubla.pressionados(), 0, 'cabo arrancado no meio de um arrastar não prende botão');
    assert.equal(dubla.contadores.soltasDeSeguranca, 2);
  });

  it('sem backend e sem gravação, não estoura', () => {
    assert.doesNotThrow(() => criarFechamentoDeSessao({})());
  });

  it('zera a memória do pipeline: a fração de um aparelho não escapa para o próximo', () => {
    const dubla = criarBackendDubla();
    const pipeline = criarPipelineDeMovimento({
      destino: dubla,
      ajustes: { zonaMortaGrausPorS: 0, suavizacao: 0, sensXPixelsPorGrau: 10 },
    });
    const pacote = criarPacoteDecodificado();
    pacote.tipo = TIPO_MOVIMENTO;
    pacote.seq = 1;
    pacote.tDispositivoMs = 1000;
    pacote.dtMs = 10;
    pacote.gy = 0.5 * (Math.PI / 180);
    pipeline.processar(pacote);
    assert.notEqual(pipeline.fracaoX, 0, 'sobrou fração de pixel da sessão que vai cair');

    criarFechamentoDeSessao({ backend: dubla, pipeline })();

    assert.equal(pipeline.fracaoX, 0);
    assert.equal(pipeline.fracaoY, 0);
    // O reinício do fim de sessão é da sessão que fechou: entra no total do processo, e a conta da
    // sessão seguinte começa em zero (ATI-028). Antes, este `reinicios` continuava valendo 1 na
    // conta "da sessão" — que era, na verdade, a do processo.
    assert.equal(pipeline.totalDoProcesso().reinicios, 1);
    assert.equal(pipeline.contadores.reinicios, 0, 'a conta da próxima sessão começa do zero');
  });

  it('duas sessões seguidas: cada resumo fala só da própria sessão, e o total fica à parte (ATI-028)', () => {
    // O cenário do log da ATI-008: a segunda sessão saía com `amostras=202 pixelsX=-6264`, que é
    // a soma das duas. As sessões daqui têm tamanhos **diferentes** de propósito: com a soma, o
    // número da segunda não bateria com nada do que ela fez — nem com os pixels que a dubla viu.
    const { registrador, linhas } = registradorQueGuarda();
    const dubla = criarBackendDubla();
    let tDispositivoMs = 60_000;
    const pipeline = criarPipelineDeMovimento({
      destino: dubla,
      // Cadeia crua (ATI-033: o padrão virou o filtro adaptativo, que deixa o fim do giro pendente).
      ajustes: { zonaMortaGrausPorS: 0, suavizacao: 0, filtro: 'exponencial', sensXPixelsPorGrau: 10 },
      // Chegada perfeita: o relógio anda junto com o aparelho, e nenhuma amostra é descartada.
      relogio: () => tDispositivoMs,
    });
    const acoes = criarMapeadorDeAcoes({
      destino: criarDestinoDeAcoesDeEnsaio(),
      registrador: registrador.comEscopo('acoes'),
      haptico: () => true,
    });
    const fechar = criarFechamentoDeSessao({
      backend: dubla,
      pipeline,
      acoes,
      registrador: registrador.comEscopo('movimento'),
    });
    const pacote = criarPacoteDecodificado();

    /** Uma sessão inteira: giro, cliques e fim. Devolve os pixels X que a dubla recebeu nela. */
    function passarSessao(amostras: number, cliques: number): number {
      const eventosAntes = dubla.eventos.length;
      for (let indice = 0; indice < amostras; indice += 1) {
        tDispositivoMs += 10;
        pacote.tipo = TIPO_MOVIMENTO;
        pacote.flags = 0;
        pacote.seq = indice + 1;
        pacote.tDispositivoMs = tDispositivoMs;
        pacote.dtMs = 10;
        pacote.gx = 0;
        pacote.gy = 90 * (Math.PI / 180);
        pacote.gz = 0;
        pipeline.processar(pacote);
      }
      for (let indice = 0; indice < cliques; indice += 1) {
        for (const pressionado of [true, false]) {
          pacote.tipo = TIPO_BOTAO;
          pacote.idControle = CONTROLES_DO_MOUSE_BASICO.esquerdo;
          pacote.pressionado = pressionado;
          acoes.processar(pacote);
        }
      }
      const pixelsX = somarPixelsX(dubla.eventos.slice(eventosAntes));
      fechar();
      return pixelsX;
    }

    // 90 °/s × 10 px/grau × 10 ms = 9 px por amostra, para a esquerda (gy > 0 em retrato).
    const pixelsDaPrimeira = passarSessao(100, 2);
    const pixelsDaSegunda = passarSessao(40, 1);
    assert.equal(pixelsDaPrimeira, -900);
    assert.equal(pixelsDaSegunda, -360);

    const resumos = linhas.filter((linha) => linha.includes('pipeline de movimento — resumo da sessão'));
    assert.equal(resumos.length, 2);
    assert.equal(campoDoLog(resumos[0], 'amostras'), '100');
    assert.equal(campoDoLog(resumos[0], 'aplicadas'), '100');
    assert.equal(campoDoLog(resumos[0], 'pixelsX'), String(pixelsDaPrimeira));
    assert.equal(campoDoLog(resumos[1], 'amostras'), '40', 'a segunda sessão não repete a primeira');
    assert.equal(campoDoLog(resumos[1], 'aplicadas'), '40');
    assert.equal(
      campoDoLog(resumos[1], 'pixelsX'),
      String(pixelsDaSegunda),
      'o resumo da segunda bate com os pixels que saíram nela, e não com a soma',
    );

    // O mapeador de ações tinha o mesmo vício, e o mesmo conserto.
    const resumosDasAcoes = linhas.filter((linha) => linha.includes('ações — resumo da sessão'));
    assert.equal(resumosDasAcoes.length, 2);
    assert.match(resumosDasAcoes[0] ?? '', /apertos=2 solturas=2 /);
    assert.match(resumosDasAcoes[1] ?? '', /apertos=1 solturas=1 /);

    // Fechada a segunda, a conta da sessão está zerada por inteiro — e o total do processo existe à
    // parte, com nome próprio.
    assert.deepEqual({ ...pipeline.contadores }, criarContadoresDoPipeline());
    assert.equal(pipeline.sessoesFechadas, 2);
    const total = pipeline.totalDoProcesso();
    assert.equal(total.amostrasRecebidas, 140);
    assert.equal(total.amostrasAplicadas, 140);
    assert.equal(total.pixelsX, pixelsDaPrimeira + pixelsDaSegunda);
    assert.equal(total.reinicios, 2, 'um reinício por fim de sessão, cada um na conta da sua');
    assert.equal(acoes.totalDoProcesso().botoesApertados, 3);
    assert.equal(acoes.contadores.botoesApertados, 0);

    // E o total vai para o log com o nome do que é — numa linha própria, nunca misturado ao resumo.
    registrarTotalDaExecucao({ pipeline, acoes, registrador });
    const [totalDoPipeline] = linhas.filter((linha) =>
      linha.includes('pipeline de movimento — total da execução'),
    );
    assert.equal(campoDoLog(totalDoPipeline, 'sessoes'), '2');
    assert.equal(campoDoLog(totalDoPipeline, 'amostras'), '140');
    assert.equal(campoDoLog(totalDoPipeline, 'pixelsX'), String(pixelsDaPrimeira + pixelsDaSegunda));
    const [totalDasAcoes] = linhas.filter((linha) => linha.includes('ações — total da execução'));
    assert.match(totalDasAcoes ?? '', /apertos=3 solturas=3 /);
  });

  it('descarrega a gravação antes de soltar a entrada', () => {
    const ordem: string[] = [];
    const dubla = criarBackendDubla();
    dubla.botaoMouse('meio', true);
    const gravador = {
      descarregar: () => ordem.push('gravacao'),
    } as unknown as PecasDaSessao['gravador'];

    criarFechamentoDeSessao({
      gravador,
      backend: {
        ...dubla,
        soltarTudo: () => {
          ordem.push('saida');
          dubla.soltarTudo();
        },
      },
    })();

    assert.deepEqual(ordem, ['gravacao', 'saida']);
    assert.equal(dubla.pressionados(), 0);
  });
});

describe('montarPipeline — para onde o movimento vai', () => {
  it('desligado não cria pipeline nenhum', () => {
    const dubla = criarBackendDubla();

    assert.equal(montarPipeline('desligado', dubla, registradorMudo()), undefined);
  });

  it('ensaio é o padrão e NÃO fala com o backend de verdade', () => {
    const dubla = criarBackendDubla();

    const montagem = montarPipeline('ensaio', dubla, registradorMudo());

    assert.ok(montagem);
    assert.equal(montagem.pipeline.destino.nome, 'ensaio');
    assert.notEqual(montagem.pipeline.destino, dubla);
    assert.ok(montagem.ensaio, 'o destino de ensaio é quem mede o que teria acontecido');
  });

  it('sistema liga o pipeline no backend de verdade — o cursor anda', () => {
    const dubla = criarBackendDubla();

    const montagem = montarPipeline('sistema', dubla, registradorMudo());

    assert.ok(montagem);
    assert.equal(montagem.pipeline.destino, dubla, 'é o backend, sem intermediário');
    assert.equal(montagem.ensaio, undefined);
  });

  it('sistema sem backend cai para o ensaio em vez de subir sem destino', () => {
    const montagem = montarPipeline('sistema', undefined, registradorMudo());

    assert.ok(montagem);
    assert.equal(montagem.pipeline.destino.nome, 'ensaio');
  });
});

/** A configuração pelo mesmo caminho da partida de verdade: variável de ambiente e validação. */
function configuracaoCom(ambiente: Record<string, string> = {}): ConfiguracaoServidor {
  return carregarConfiguracao({ caminhoDoArquivo: null, ambiente });
}

const TELA_1080P = Object.freeze({ largura: 1920, altura: 1080 });

/** Os ajustes **efetivos**: o pedido da configuração depois de passar pelo `resolverAjustes`. */
function efetivos(configuracao: ConfiguracaoServidor, tela?: { largura: number; altura: number }) {
  return resolverAjustes(ajustesDaConfiguracao(configuracao, tela).ajustes);
}

/**
 * O valor de um campo `chave=valor` numa linha de log, ou `undefined`.
 *
 * Procura a chave no começo de um campo (depois de espaço) para `amostras=` não casar dentro de
 * outro nome; valor aspeado (com espaço dentro) não é o caso dos campos numéricos lidos aqui.
 */
function campoDoLog(linha: string | undefined, chave: string): string | undefined {
  return new RegExp(` ${chave}=(\\S+)`).exec(linha ?? '')?.[1];
}

/** Soma dos `dx` que chegaram à dubla — a testemunha independente dos pixels de uma sessão. */
function somarPixelsX(eventos: readonly EventoDaDubla[]): number {
  let soma = 0;
  for (const evento of eventos) if (evento.tipo === 'mover') soma += evento.dx;
  return soma;
}

/** Registrador que guarda as linhas: aqui a asserção **é** o log. */
function registradorQueGuarda(): { registrador: Registrador; linhas: string[] } {
  const linhas: string[] = [];
  const registrador = criarRegistrador('depuracao', 'teste', (linha) => {
    linhas.push(linha);
  });
  return { registrador, linhas };
}

describe('ajustesDaConfiguracao — cada chave chega ao pipeline (ATI-032)', () => {
  it('sem nada pedido, o pipeline fica com o padrão de fábrica e ninguém é avisado', () => {
    const giro = ajustesDaConfiguracao(configuracaoCom(), TELA_1080P);

    assert.deepEqual(resolverAjustes(giro.ajustes), AJUSTES_PADRAO);
    assert.deepEqual(giro.avisos, []);
  });

  it('45° na horizontal e 25° na vertical numa tela 1920×1080 dão 42,67 e 43,2 px/grau', () => {
    const ajustes = efetivos(
      configuracaoCom({
        [VARIAVEIS_DE_AMBIENTE.grausTelaCheia]: '45',
        [VARIAVEIS_DE_AMBIENTE.grausTelaCheiaY]: '25',
      }),
      TELA_1080P,
    );

    assert.equal(ajustes.sensXPixelsPorGrau, 1920 / 45);
    assert.equal(Math.round(ajustes.sensXPixelsPorGrau * 100) / 100, 42.67);
    assert.equal(ajustes.sensYPixelsPorGrau, 43.2);
  });

  it('sem grausTelaCheiaY, o vertical usa os mesmos graus: 45° dão 42,67 e 24', () => {
    const ajustes = efetivos(configuracaoCom({ [VARIAVEIS_DE_AMBIENTE.grausTelaCheia]: '45' }), TELA_1080P);

    assert.equal(ajustes.sensXPixelsPorGrau, 1920 / 45);
    assert.equal(ajustes.sensYPixelsPorGrau, 24);
  });

  it('a sensibilidade em px/grau vale igual nos dois eixos, com fração', () => {
    const ajustes = efetivos(configuracaoCom({ [VARIAVEIS_DE_AMBIENTE.sensibilidade]: '20.5' }), TELA_1080P);

    assert.equal(ajustes.sensXPixelsPorGrau, 20.5);
    assert.equal(ajustes.sensYPixelsPorGrau, 20.5);
  });

  it('cada chave chega com o nome certo: orientação, zona morta, suavização e as duas inversões', () => {
    // É o teste que teria pegado o `deadzone` no lugar de `zonaMortaGrausPorS`: o valor **efetivo**
    // tem de ser o pedido, e não o de fábrica. Cada número aqui é diferente do padrão de propósito.
    const ajustes = efetivos(
      configuracaoCom({
        [VARIAVEIS_DE_AMBIENTE.orientacao]: 'apontador-torcao',
        [VARIAVEIS_DE_AMBIENTE.zonaMorta]: '1.5',
        [VARIAVEIS_DE_AMBIENTE.suavizacao]: '0.3',
        [VARIAVEIS_DE_AMBIENTE.inverterX]: 'sim',
        [VARIAVEIS_DE_AMBIENTE.inverterY]: '1',
      }),
      TELA_1080P,
    );

    assert.equal(ajustes.orientacao, 'apontador-torcao');
    assert.equal(ajustes.zonaMortaGrausPorS, 1.5);
    assert.equal(ajustes.suavizacao, 0.3);
    assert.equal(ajustes.inverterX, true);
    assert.equal(ajustes.inverterY, true);
    // O que não foi pedido continua de fábrica.
    assert.equal(ajustes.sensXPixelsPorGrau, AJUSTES_PADRAO.sensXPixelsPorGrau);
    assert.equal(ajustes.limitePixelsPorAmostra, AJUSTES_PADRAO.limitePixelsPorAmostra);
  });

  it('zona morta 0 e suavização 0 são pedido de verdade (desligar), e não o sentinela', () => {
    const ajustes = efetivos(
      configuracaoCom({
        [VARIAVEIS_DE_AMBIENTE.zonaMorta]: '0',
        [VARIAVEIS_DE_AMBIENTE.suavizacao]: '0',
      }),
    );

    assert.equal(ajustes.zonaMortaGrausPorS, 0);
    assert.equal(ajustes.suavizacao, 0);
  });

  it('o sentinela vira campo presente com undefined — nunca um campo omitido por spread', () => {
    // Campo por extenso é o que faz nome errado virar erro de compilação (ver o comentário da
    // função). Este teste segura a forma: as dez chaves estão lá, mesmo as que valem "não mexi"
    // (as três do filtro entraram na ATI-033).
    const { ajustes } = ajustesDaConfiguracao(configuracaoCom());

    assert.deepEqual(Object.keys(ajustes).sort(), [
      'filtro',
      'filtroBeta',
      'filtroCorteMinimoHz',
      'inverterX',
      'inverterY',
      'orientacao',
      'sensXPixelsPorGrau',
      'sensYPixelsPorGrau',
      'suavizacao',
      'zonaMortaGrausPorS',
    ]);
    assert.equal(ajustes.zonaMortaGrausPorS, undefined);
    assert.equal(ajustes.suavizacao, undefined);
    assert.equal(ajustes.sensXPixelsPorGrau, undefined);
    assert.equal(ajustes.filtroCorteMinimoHz, undefined);
    assert.equal(ajustes.filtroBeta, undefined);
  });

  it('graus sem tamanho de tela: vale o padrão de fábrica, e o aviso diz isso', () => {
    // Revisão r1, apontamento 1c: sem backend (ou com o GetSystemMetrics respondendo 0) a conversão
    // caía para a fábrica sem nada no log.
    const configuracao = configuracaoCom({ [VARIAVEIS_DE_AMBIENTE.grausTelaCheia]: '45' });

    for (const tela of [undefined, { largura: 0, altura: 0 }]) {
      const giro = ajustesDaConfiguracao(configuracao, tela);
      const ajustes = resolverAjustes(giro.ajustes);

      assert.equal(ajustes.sensXPixelsPorGrau, AJUSTES_PADRAO.sensXPixelsPorGrau);
      assert.equal(giro.avisos.length, 1, JSON.stringify(tela));
      assert.match(giro.avisos[0] ?? '', /grausTelaCheia=45\/45° pedido, mas o tamanho da tela é desconhecido/);
      assert.match(giro.avisos[0] ?? '', /vale sens=35\/35 px\/grau, o padrão de fábrica/);
    }
  });

  it('graus sem tamanho de tela, com sensibilidade: vale a sensibilidade, e o aviso diz isso', () => {
    const giro = ajustesDaConfiguracao(
      configuracaoCom({
        [VARIAVEIS_DE_AMBIENTE.grausTelaCheia]: '45',
        [VARIAVEIS_DE_AMBIENTE.sensibilidade]: '20',
      }),
      undefined,
    );

    assert.equal(resolverAjustes(giro.ajustes).sensYPixelsPorGrau, 20);
    assert.equal(giro.avisos.length, 1);
    assert.match(giro.avisos[0] ?? '', /vale sensibilidade=20\/20 px\/grau, da configuração/);
  });

  it('graus e sensibilidade juntos: os graus vencem, e a sensibilidade ignorada é avisada', () => {
    const giro = ajustesDaConfiguracao(
      configuracaoCom({
        [VARIAVEIS_DE_AMBIENTE.grausTelaCheia]: '45',
        [VARIAVEIS_DE_AMBIENTE.sensibilidade]: '20',
      }),
      TELA_1080P,
    );

    assert.equal(resolverAjustes(giro.ajustes).sensYPixelsPorGrau, 24);
    assert.deepEqual(giro.avisos, [
      'sensibilidade=20 px/grau ignorada: grausTelaCheia=45/45° vence quando os dois vêm (tela 1920×1080)',
    ]);
  });

  it('graus que dão px/grau acima do teto do giro: o pipeline satura, e o aviso diz o número', () => {
    const giro = ajustesDaConfiguracao(
      configuracaoCom({
        [VARIAVEIS_DE_AMBIENTE.grausTelaCheia]: '5',
        [VARIAVEIS_DE_AMBIENTE.grausTelaCheiaY]: '25',
      }),
      TELA_1080P,
    );

    assert.equal(resolverAjustes(giro.ajustes).sensXPixelsPorGrau, 200, 'o pipeline satura no teto');
    assert.deepEqual(giro.avisos, [
      '5° para 1920 px na horizontal dão 384 px/grau, fora da faixa do giro (1 a 200): vale 200 px/grau',
    ]);
  });
});

describe('montarPipeline — os ajustes da configuração chegam ao pipeline e os avisos ao log', () => {
  it('as oito chaves, pela variável de ambiente, até o pipeline montado', () => {
    const configuracao = configuracaoCom({
      [VARIAVEIS_DE_AMBIENTE.orientacao]: 'apontador',
      [VARIAVEIS_DE_AMBIENTE.zonaMorta]: '2',
      [VARIAVEIS_DE_AMBIENTE.suavizacao]: '0.25',
      [VARIAVEIS_DE_AMBIENTE.grausTelaCheia]: '45',
      [VARIAVEIS_DE_AMBIENTE.grausTelaCheiaY]: '25',
      [VARIAVEIS_DE_AMBIENTE.inverterX]: 'nao',
      [VARIAVEIS_DE_AMBIENTE.inverterY]: 'sim',
    });
    const { registrador, linhas } = registradorQueGuarda();

    const montagem = montarPipeline(
      'ensaio',
      criarBackendDubla(),
      registrador,
      ajustesDaConfiguracao(configuracao, TELA_1080P),
    );

    assert.ok(montagem);
    const { ajustes } = montagem.pipeline;
    assert.equal(ajustes.orientacao, 'apontador');
    assert.equal(ajustes.zonaMortaGrausPorS, 2);
    assert.equal(ajustes.suavizacao, 0.25);
    assert.equal(ajustes.sensXPixelsPorGrau, 1920 / 45);
    assert.equal(ajustes.sensYPixelsPorGrau, 43.2);
    assert.equal(ajustes.inverterX, false);
    assert.equal(ajustes.inverterY, true);

    // A linha de partida mostra os valores efetivos — é a que se lê para conferir o pedido.
    const pronto = linhas.find((linha) => linha.includes('pipeline de movimento pronto')) ?? '';
    assert.match(pronto, /orientacao=apontador sens=42\.67\/43\.2 px\/grau zonaMorta=2 °\/s suavizacao=0\.25/);
    assert.match(pronto, /inverter=false\/true/);
    assert.equal(linhas.filter((linha) => linha.includes('AVISO')).length, 0, 'nada descartado');

    // A sensibilidade sozinha também chega (a outra porta de entrada do px/grau).
    const soSensibilidade = montarPipeline(
      'ensaio',
      undefined,
      registradorMudo(),
      ajustesDaConfiguracao(configuracaoCom({ [VARIAVEIS_DE_AMBIENTE.sensibilidade]: '20' })),
    );
    assert.equal(soSensibilidade?.pipeline.ajustes.sensXPixelsPorGrau, 20);
    assert.equal(soSensibilidade?.pipeline.ajustes.sensYPixelsPorGrau, 20);
  });

  it('o aviso de graus sem tela sai no log da partida, como AVISO', () => {
    const { registrador, linhas } = registradorQueGuarda();
    const giro = ajustesDaConfiguracao(
      configuracaoCom({ [VARIAVEIS_DE_AMBIENTE.grausTelaCheia]: '45' }),
      criarBackendDubla({ semTela: true }).tamanhoDaTela(),
    );

    montarPipeline('ensaio', undefined, registrador, giro);

    const avisos = linhas.filter((linha) => linha.includes('AVISO'));
    assert.equal(avisos.length, 1);
    assert.match(avisos[0] ?? '', /grausTelaCheia=45\/45° pedido, mas o tamanho da tela é desconhecido/);
  });

  it('com o movimento desligado não há pipeline, e ajuste de giro não vira aviso', () => {
    const { registrador, linhas } = registradorQueGuarda();
    const giro = ajustesDaConfiguracao(configuracaoCom({ [VARIAVEIS_DE_AMBIENTE.grausTelaCheia]: '45' }));

    assert.equal(montarPipeline('desligado', undefined, registrador, giro), undefined);
    assert.deepEqual(linhas, []);
  });
});

describe('backend de entrada na partida', () => {
  it('sistema sem backend não derruba o servidor — ele sobe sem injetar nada', async () => {
    const encerramento = principal({
      argumentos: [],
      criarRepositorio: criarRepositorioTemporario,
      criarBackend: () => {
        throw new ErroDeSaida('não existe backend de entrada para "sonho"');
      },
      carga: cargaDeTeste(),
    });

    assert.ok(encerramento, 'o transporte e a página de diagnóstico continuam valendo');
    await encerramento.encerrar('teste');
  });

  it('--teste-mouse sem backend é recusa de partida, não silêncio', () => {
    const saidaOriginal = process.exitCode;
    const antes = contarTemporizadoresAtivos();
    try {
      const encerramento = principal({
        argumentos: [OPCAO_TESTE_DE_MOUSE],
        criarRepositorio: criarRepositorioTemporario,
        criarBackend: () => {
          throw new ErroDeSaida('não existe backend de entrada para "sonho"');
        },
        carga: cargaDeTeste(),
      });

      assert.equal(encerramento, undefined);
      assert.equal(process.exitCode, 1);
      assert.equal(contarTemporizadoresAtivos(), antes, 'nem âncora ficou para trás');
    } finally {
      process.exitCode = saidaOriginal;
    }
  });

  it('Ctrl+C durante a contagem regressiva do --teste-mouse cancela antes de tocar no cursor', async () => {
    const { criarBackend, dubla } = comDubla();
    const posicaoAntes = dubla.lerPosicaoDoMouse();
    const encerramento = principal({
      argumentos: [OPCAO_TESTE_DE_MOUSE],
      criarBackend,
      criarRepositorio: criarRepositorioTemporario,
      carga: cargaDeTeste(),
    });
    assert.ok(encerramento);

    // Encerrar aqui é o Ctrl+C dado logo depois do aviso — o gesto ainda está na contagem.
    // A tarefa registrada **aguarda** o gesto se desfazer antes de o processo poder sair.
    await encerramento.encerrar('teste');

    assert.equal(dubla.eventos.length, 0, 'nenhum evento foi injetado');
    assert.deepEqual(dubla.lerPosicaoDoMouse(), posicaoAntes);
    assert.equal(dubla.pressionados(), 0);
  });
});

describe('a suíte não depende de porta fixa (ATI-030)', () => {
  it('a porta da configuração não decide onde o teste abre: tomada, o teste sobe ao lado', async () => {
    // O cenário do achado, sem tocar na 8765 de ninguém: uma porta qualquer ocupada (é o `npm run
    // dev` de quem está trabalhando) e o ambiente apontando para ela. A porta efêmera da carga de
    // teste vence o ambiente, e o servidor sobe numa porta livre em vez de colidir.
    const ocupada = await ocuparPortaEfemera();
    let servidor: ServidorDoTeste | undefined;
    try {
      servidor = await subirServidor(
        { criarBackend: comDubla().criarBackend, argumentos: [], criarRepositorio: criarRepositorioTemporario },
        { [VARIAVEIS_DE_AMBIENTE.porta]: String(ocupada.porta) },
      );

      assert.notEqual(servidor.porta, ocupada.porta);
      assert.ok(servidor.porta > 0, 'o sistema deu uma porta de verdade');
    } finally {
      await servidor?.encerramento.encerrar('teste');
      await ocupada.liberar();
    }
  });

  it('porta ocupada vira mensagem própria, com o número — nunca um "test failed" mudo', async () => {
    // A rede de segurança para o dia em que alguém precisar de porta fixa de novo: a falha diz o
    // que é. A porta aqui é efêmera e é deste teste — ele mesmo a ocupa antes de pedir.
    const ocupada = await ocuparPortaEfemera();
    const saidaOriginal = process.exitCode;
    try {
      await assert.rejects(
        subirServidor(
          { criarBackend: comDubla().criarBackend, argumentos: [], criarRepositorio: criarRepositorioTemporario },
          {},
          ocupada.porta,
        ),
        (erro: unknown) => {
          assert.ok(erro instanceof Error);
          assert.match(erro.message, new RegExp(`^porta ${ocupada.porta} ocupada, encerre o servidor`));
          return true;
        },
      );
    } finally {
      // O `principal()` marca saída 1 quando a porta não abre — é o certo para o programa, e é o
      // que o runner relataria como falha deste arquivo se ficasse marcado depois do teste.
      process.exitCode = saidaOriginal;
      await ocupada.liberar();
    }
  });
});

describe('os comandos ligados na partida (ATI-009)', () => {
  it('centralizar chega pelo fio e, no modo padrão, NÃO mexe no cursor', async () => {
    // O caminho inteiro do produto: `principal()` de verdade, WebSocket de verdade, quadro `cmd`
    // de verdade — e a configuração de fábrica, que é `movimento=ensaio`. A asserção que mais
    // importa aqui é a negativa: com o padrão, um toque no botão do celular **não** tira o cursor
    // da mão de quem está usando a máquina.
    const { criarBackend, dubla } = comDubla();
    const posicaoAntes = dubla.lerPosicaoDoMouse();
    let servidor: ServidorDoTeste | undefined;
    let socket: WebSocket | undefined;
    try {
      // Porta efêmera (ATI-030): a 8765 pode estar com um servidor de verdade nesta máquina, e uma
      // porta fixa qualquer colidiria com a suíte de outro agente rodando ao mesmo tempo.
      servidor = await subirServidor({ criarBackend, argumentos: [], criarRepositorio: criarRepositorioTemporario });

      socket = new WebSocket(`ws://127.0.0.1:${servidor.porta}`);
      const recebidas: Record<string, unknown>[] = [];
      socket.on('message', (dados: Buffer, ehBinario: boolean) => {
        if (ehBinario) return;
        recebidas.push(JSON.parse(dados.toString('utf8')) as Record<string, unknown>);
      });
      await once(socket, 'open');

      socket.send(
        JSON.stringify({
          t: 'hello',
          v: 1,
          aparelho: { id: 'teste-ati009', nome: 'Teste', so: 'android', versaoSo: '14', modelo: 'x' },
          capacidades: ['giroscopio'],
          taxaHzDesejada: 100,
        }),
      );
      await esperarMensagem(recebidas, 'welcome');

      socket.send(JSON.stringify({ t: 'cmd', comando: 'centralizar' }));
      const resposta = await esperarMensagem(recebidas, 'cmd-ok');

      assert.equal(resposta['comando'], 'centralizar');
      const resultado = resposta['resultado'] as Record<string, unknown>;
      assert.equal(resultado['cursor'], 'ensaio', 'o padrão não move o cursor de verdade');
      assert.equal(typeof resultado['x'], 'number');
      assert.deepEqual(dubla.lerPosicaoDoMouse(), posicaoAntes, 'o cursor ficou onde estava');
      assert.equal(
        dubla.eventos.filter((evento) => evento.tipo === 'posicionar').length,
        0,
        'nenhum posicionamento foi injetado',
      );
    } finally {
      socket?.close();
      await servidor?.encerramento.encerrar('teste');
    }
  });

  it('o arquivo de bias é injetável: `npm test` não escreve no dados-locais desta máquina', () => {
    // A ATI-009 é a primeira do projeto a criar estado persistente em disco, e a regra que vale
    // para o cursor vale igual para o arquivo de dados. Sem este ponto de injeção, a garantia de
    // que o teste não grava no arquivo de verdade era incidental (bias zero, nada mudou); com
    // ele, é estrutural — e este teste prova o caminho que **grava**.
    const caminho = join(pastaTemporaria, 'bias-injetado.json');
    assert.notEqual(caminho, CAMINHO_PADRAO, 'o alvo do teste não pode ser o arquivo da máquina');

    const { dubla } = comDubla();
    const pipeline = criarPipelineDeMovimento({ destino: dubla });
    const comandos = montarComandos(
      CONFIGURACAO_PADRAO,
      pipeline,
      dubla,
      false,
      registradorMudo(),
      () => criarRepositorioDeBias({ caminho }),
    );

    // Bias mudado durante a sessão (é o que a recalibração automática faz) e sessão fechada: o
    // caminho que grava, exercitado de propósito.
    pipeline.definirBias(0.004, -0.001, 0.002);
    comandos.aoEncerrarSessao(criarSessaoFalsa('aparelho-do-teste'));

    const gravado = readFileSync(caminho, 'utf8');
    assert.match(gravado, /aparelho-do-teste/);
    assert.equal(comandos.contadores.biasGravados, 1);
  });
});

/* ============================================== o mapeador de ações ligado na partida (ATI-010) */

/** Espera uma condição com teto — nenhum teste fica pendurado. */
async function esperarAte(condicao: () => boolean, oQue: string, limiteMs = 3000): Promise<void> {
  const comeco = Date.now();
  while (!condicao()) {
    if (Date.now() - comeco >= limiteMs) throw new Error(`tempo esgotado esperando ${oQue}`);
    await new Promise<void>((resolver) => {
      const relogio = setTimeout(resolver, 5);
      relogio.unref();
    });
  }
}

/**
 * Sobe o `principal()` de verdade em porta efêmera, com a dubla no lugar do backend, e entrega
 * um socket já com o handshake feito.
 *
 * Porta efêmera (ATI-030) porque a 8765 pode estar ocupada por um servidor de verdade nesta
 * máquina — é exatamente o caso quando alguém está testando com o celular na mão — e porque as
 * portas fixas que estavam aqui (8801 a 8811) colidiam com a suíte de outro agente rodando ao
 * mesmo tempo.
 */
async function comServidorDeVerdade(
  movimento: string,
  corpo: (
    socket: WebSocket,
    dubla: BackendDubla,
    recebidas: Record<string, unknown>[],
    /** O Ctrl+C, na mão: `encerrar()` é o mesmo caminho que o SIGINT dispara. */
    encerramento: ControleDeEncerramento,
  ) => Promise<void>,
): Promise<void> {
  const { criarBackend, dubla } = comDubla();
  let encerramento: ControleDeEncerramento | undefined;
  let socket: WebSocket | undefined;
  try {
    const servidor = await subirServidor(
      { criarBackend, argumentos: [], criarRepositorio: criarRepositorioTemporario },
      { [VARIAVEIS_DE_AMBIENTE.movimento]: movimento },
    );
    encerramento = servidor.encerramento;

    socket = new WebSocket(`ws://127.0.0.1:${servidor.porta}`);
    const recebidas: Record<string, unknown>[] = [];
    socket.on('message', (dados: Buffer, ehBinario: boolean) => {
      if (ehBinario) return;
      recebidas.push(JSON.parse(dados.toString('utf8')) as Record<string, unknown>);
    });
    await once(socket, 'open');
    socket.send(
      JSON.stringify({
        t: 'hello',
        v: 1,
        aparelho: { id: 'teste-ati010', nome: 'Teste', so: 'android', versaoSo: '14', modelo: 'x' },
        capacidades: ['giroscopio', 'toque'],
        taxaHzDesejada: 100,
      }),
    );
    await esperarMensagem(recebidas, 'welcome');

    await corpo(socket, dubla, recebidas, encerramento);
  } finally {
    socket?.close();
    await encerramento?.encerrar('teste');
  }
}

describe('montarMapeadorDeAcoes — o toque clica ou não clica', () => {
  it('sem pedir nada, o destino é o ensaio: o toque NÃO clica na máquina', () => {
    const dubla = criarBackendDubla();

    const montagem = montarMapeadorDeAcoes(dubla, false, registradorMudo());

    assert.equal(montagem.mapeador.destino.nome, 'ensaio');
    assert.notEqual(montagem.mapeador.destino, dubla);
    assert.ok(montagem.ensaio, 'o ensaio é quem conta o que teria acontecido');
  });

  it('com o cursor de verdade, o destino é o backend — o clique acontece', () => {
    const dubla = criarBackendDubla();

    const montagem = montarMapeadorDeAcoes(dubla, true, registradorMudo());

    assert.equal(montagem.mapeador.destino, dubla, 'é o backend, sem intermediário');
    assert.equal(montagem.ensaio, undefined);
  });

  it('sem backend nenhum, o BOTÃO ainda tem para onde ir (e vira contador)', () => {
    const montagem = montarMapeadorDeAcoes(undefined, true, registradorMudo());

    assert.equal(montagem.mapeador.destino.nome, 'ensaio');
    assert.ok(montagem.ensaio);
  });

  it('a tabela em vigor é a do perfil Mouse básico', () => {
    const montagem = montarMapeadorDeAcoes(criarBackendDubla(), false, registradorMudo());

    assert.equal(montagem.mapeador.tabela, TABELA_MOUSE_BASICO);
  });
});

describe('o BOTÃO chegando pelo fio, com o servidor de verdade de pé', () => {
  it('no modo padrão o toque atravessa o servidor inteiro e NÃO clica', async () => {
    // A asserção que mais importa desta atividade é a negativa. Um clique injetado acontece onde
    // o cursor estiver, e ali pode ter um botão de verdade — "excluir", "enviar", "confirmar".
    // Com a configuração de fábrica (`movimento=ensaio`), um toque no celular não pode apertar
    // nada na máquina de quem está trabalhando.
    await comServidorDeVerdade('ensaio', async (socket, dubla, recebidas) => {
      const codificador = criarCodificador();
      socket.send(copiar(codificador.botao(1, 1, true)), { binary: true });
      socket.send(copiar(codificador.botao(2, 1, false)), { binary: true });

      // Barreira determinística: quadro de texto e quadro binário do mesmo socket chegam em
      // ordem, então o `cmd-ok` do centralizar prova que os dois BOTÃO já foram tratados.
      socket.send(JSON.stringify({ t: 'cmd', comando: 'centralizar' }));
      await esperarMensagem(recebidas, 'cmd-ok');

      assert.deepEqual(
        dubla.eventos.filter((evento) => evento.tipo === 'botao'),
        [],
        'nenhum clique foi injetado na máquina',
      );
      assert.equal(dubla.pressionados(), 0);
    });
  });

  it('com movimento=sistema o toque vira clique de verdade — aperto e soltura separados', async () => {
    // "De verdade" aqui é a dubla: `npm test` não clica em máquina nenhuma. O que este cenário
    // prova é a fiação — que a chave `sistema` liga o BOTÃO do fio no backend de entrada.
    await comServidorDeVerdade('sistema', async (socket, dubla) => {
      const codificador = criarCodificador();

      socket.send(copiar(codificador.botao(1, 1, true)), { binary: true });
      await esperarAte(() => dubla.pressionados() === 1, 'o aperto chegar ao backend');

      socket.send(copiar(codificador.botao(2, 1, false)), { binary: true });
      await esperarAte(() => dubla.pressionados() === 0, 'a soltura chegar ao backend');

      assert.deepEqual(dubla.eventos, [
        { tipo: 'botao', botao: 'esquerdo', pressionado: true },
        { tipo: 'botao', botao: 'esquerdo', pressionado: false },
      ]);
    });
  });

  it('cabo arrancado com o botão apertado: o fim de sessão solta, e o processo sai limpo', async () => {
    await comServidorDeVerdade('sistema', async (socket, dubla) => {
      const codificador = criarCodificador();
      socket.send(copiar(codificador.botao(1, 1, true)), { binary: true });
      await esperarAte(() => dubla.pressionados() === 1, 'o aperto chegar ao backend');

      // O cabo arrancado, do ponto de vista do servidor: o socket morre e o "soltou" nunca vem.
      socket.close();

      await esperarAte(() => dubla.pressionados() === 0, 'o servidor soltar o botão sozinho');
      assert.equal(dubla.contadores.soltasDeSeguranca, 1);
    });
  });

  it('Ctrl+C com a sessão viva e o botão apertado: o servidor solta antes de sair', async () => {
    // O cenário do cabo arrancado fecha o socket **antes** de encerrar; este aqui é o Ctrl+C
    // legítimo: o celular continua conectado, o dedo continua no botão, e quem manda parar é
    // quem está no teclado do PC. Sem o caminho de soltura, o processo sairia deixando o botão
    // apertado no Windows inteiro — e ninguém teria mais a quem pedir para soltar.
    await comServidorDeVerdade('sistema', async (socket, dubla, _recebidas, encerramento) => {
      const codificador = criarCodificador();
      socket.send(copiar(codificador.botao(1, 1, true)), { binary: true });
      await esperarAte(() => dubla.pressionados() === 1, 'o aperto chegar ao backend');
      assert.equal(socket.readyState, WebSocket.OPEN, 'a sessão tem de estar viva no Ctrl+C');

      await encerramento.encerrar('Ctrl+C');

      assert.equal(dubla.pressionados(), 0, 'saiu sem deixar botão apertado');
      // Um: o fim de sessão soltou (o transporte fecha e cada sessão encerra), e a soltura do
      // backend, que vem logo depois na ordem inversa do registro, não tinha mais nada a soltar.
      // Dois caminhos, um botão — e é assim que se prova que o segundo é idempotente.
      assert.equal(dubla.contadores.soltasDeSeguranca, 1);
      const ultimo = dubla.eventos[dubla.eventos.length - 1];
      assert.deepEqual(ultimo, { tipo: 'botao', botao: 'esquerdo', pressionado: false });
    });
  });

  it('SCROLL do fio vira roda; e no modo padrão não roda nada', async () => {
    await comServidorDeVerdade('sistema', async (socket, dubla) => {
      const codificador = criarCodificador();
      socket.send(copiar(codificador.scroll(1, -1, 0)), { binary: true });

      await esperarAte(
        () => dubla.eventos.some((evento) => evento.tipo === 'scroll'),
        'o entalhe chegar à roda',
      );
      assert.deepEqual(
        dubla.eventos.filter((evento) => evento.tipo === 'scroll'),
        [{ tipo: 'scroll', vertical: -1, horizontal: 0 }],
      );
    });

    await comServidorDeVerdade('ensaio', async (socket, dubla, recebidas) => {
      const codificador = criarCodificador();
      socket.send(copiar(codificador.scroll(1, -1, 0)), { binary: true });
      socket.send(JSON.stringify({ t: 'cmd', comando: 'centralizar' }));
      await esperarMensagem(recebidas, 'cmd-ok');

      assert.deepEqual(dubla.eventos.filter((evento) => evento.tipo === 'scroll'), []);
    });
  });
});

/* ============================================ o resumo de cada sessão, ponta a ponta (ATI-028) */

/**
 * Uma conexão inteira contra o servidor de verdade: handshake, `amostras` MOVIMENTO, `cliques`
 * apertos e solturas, barreira e queda do socket. Devolve os pixels X que a dubla recebeu **nela**.
 *
 * A barreira é a de sempre deste arquivo: quadro de texto e quadro binário do mesmo socket chegam
 * em ordem, então o `cmd-ok` do `centralizar` prova que tudo o que veio antes já foi tratado. O
 * `centralizar` também reinicia o pipeline, mas isso não muda nenhum número do resumo.
 */
async function passarSessaoPeloFio(
  porta: number,
  dubla: BackendDubla,
  amostras: number,
  cliques: number,
): Promise<number> {
  const socket = new WebSocket(`ws://127.0.0.1:${porta}`);
  const recebidas: Record<string, unknown>[] = [];
  socket.on('message', (dados: Buffer, ehBinario: boolean) => {
    if (ehBinario) return;
    recebidas.push(JSON.parse(dados.toString('utf8')) as Record<string, unknown>);
  });
  try {
    await once(socket, 'open');
    socket.send(
      JSON.stringify({
        t: 'hello',
        v: 1,
        aparelho: { id: 'teste-ati028', nome: 'Teste', so: 'android', versaoSo: '14', modelo: 'x' },
        capacidades: ['giroscopio', 'toque'],
        taxaHzDesejada: 100,
      }),
    );
    await esperarMensagem(recebidas, 'welcome');

    const eventosAntes = dubla.eventos.length;
    const codificador = criarCodificador();
    let seq = 0;
    for (let indice = 0; indice < amostras; indice += 1) {
      seq += 1;
      // 90 °/s em y: o cursor anda para a esquerda em retrato, com o pipeline de fábrica.
      const bytes = codificador.movimento(seq, 60_000 + seq * 10, 10, 0, 90 * (Math.PI / 180), 0);
      socket.send(copiar(bytes), { binary: true });
    }
    for (let indice = 0; indice < cliques; indice += 1) {
      seq += 1;
      socket.send(copiar(codificador.botao(seq, CONTROLES_DO_MOUSE_BASICO.esquerdo, true)), { binary: true });
      seq += 1;
      socket.send(copiar(codificador.botao(seq, CONTROLES_DO_MOUSE_BASICO.esquerdo, false)), { binary: true });
    }
    socket.send(JSON.stringify({ t: 'cmd', comando: 'centralizar' }));
    await esperarMensagem(recebidas, 'cmd-ok');
    return somarPixelsX(dubla.eventos.slice(eventosAntes));
  } finally {
    socket.close();
  }
}

describe('o resumo de cada sessão, com o servidor de verdade de pé (ATI-028)', () => {
  it('duas conexões seguidas: a segunda relata só o que foi dela, e o Ctrl+C traz o total', async () => {
    // O mesmo roteiro que expôs o defeito no log da ATI-008 — servidor de verdade, duas sessões
    // em sequência —, agora com tamanhos diferentes para a soma não passar por coincidência. A
    // testemunha dos pixels é a dubla (`movimento=sistema` contra ela: `npm test` não mexe no
    // cursor de ninguém), e não o próprio pipeline.
    const { criarBackend, dubla } = comDubla();
    const linhas: string[] = [];
    const servidor = await subirServidor(
      {
        criarBackend,
        argumentos: [],
        criarRepositorio: criarRepositorioTemporario,
        destinoDoLog: (linha) => {
          linhas.push(linha);
        },
      },
      { [VARIAVEIS_DE_AMBIENTE.movimento]: 'sistema', [VARIAVEIS_DE_AMBIENTE.nivelLog]: 'info' },
    );
    const resumos = (): string[] =>
      linhas.filter((linha) => linha.includes('pipeline de movimento — resumo da sessão'));

    let pixelsDaPrimeira: number;
    let pixelsDaSegunda: number;
    try {
      pixelsDaPrimeira = await passarSessaoPeloFio(servidor.porta, dubla, 100, 2);
      await esperarAte(() => resumos().length === 1, 'o resumo da primeira sessão');
      pixelsDaSegunda = await passarSessaoPeloFio(servidor.porta, dubla, 40, 1);
      await esperarAte(() => resumos().length === 2, 'o resumo da segunda sessão');
    } finally {
      await servidor.encerramento.encerrar('teste');
    }

    const [primeiro, segundo] = resumos();
    assert.equal(campoDoLog(primeiro, 'amostras'), '100');
    assert.equal(campoDoLog(primeiro, 'pixelsX'), String(pixelsDaPrimeira));
    assert.equal(campoDoLog(segundo, 'amostras'), '40', 'antes: 140, a soma das duas sessões');
    assert.equal(
      campoDoLog(segundo, 'pixelsX'),
      String(pixelsDaSegunda),
      'o resumo da segunda bate com os pixels que saíram nela',
    );
    assert.ok(pixelsDaSegunda < 0, 'a segunda sessão moveu o cursor de verdade (na dubla)');

    const resumosDasAcoes = linhas.filter((linha) => linha.includes('ações — resumo da sessão'));
    assert.equal(resumosDasAcoes.length, 2);
    assert.match(resumosDasAcoes[0] ?? '', /apertos=2 solturas=2 /);
    assert.match(resumosDasAcoes[1] ?? '', /apertos=1 solturas=1 /);

    // O total do processo continua existindo — numa linha própria, com o nome do que é.
    const [total] = linhas.filter((linha) => linha.includes('pipeline de movimento — total da execução'));
    assert.equal(campoDoLog(total, 'sessoes'), '2');
    assert.equal(campoDoLog(total, 'amostras'), '140');
    assert.equal(campoDoLog(total, 'pixelsX'), String(pixelsDaPrimeira + pixelsDaSegunda));
    const [totalDasAcoes] = linhas.filter((linha) => linha.includes('ações — total da execução'));
    assert.match(totalDasAcoes ?? '', /apertos=3 solturas=3 /);
  });
});
