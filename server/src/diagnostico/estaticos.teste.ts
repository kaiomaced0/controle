/**
 * Teste da página de diagnóstico (ATI-025), com servidor de verdade em porta efêmera.
 *
 * A pergunta que este arquivo responde não é "a rota devolve 200". É: **o JS que sai pelo fio é o
 * mesmo codec do servidor?** Sem isso a página seria uma terceira implementação do formato
 * binário, escondida onde ninguém olha, e o dia em que ela divergisse o diagnóstico passaria a
 * mentir sobre o que existe para medir.
 *
 * A prova é feita em cadeia, sem escrever um quarto conjunto de vetores de bytes:
 *
 * 1. o JS servido é **baixado, gravado e importado** como módulo de verdade;
 * 2. o codificador dele é comparado byte a byte com o do servidor, chamada por chamada;
 * 3. o codificador do servidor já está preso aos vetores fixos do PROTOCOLO.md por
 *    `protocolo/binario.teste.ts` — e é isso que fecha a corrente até o documento;
 * 4. por fim os bytes do codec servido entram no transporte real e são contados lá dentro.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Agent, get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { criarRegistrador } from '../log.js';
import {
  RESULTADO_DECODIFICACAO,
  TIPO_BOTAO,
  TIPO_HAPTICO,
  TIPO_MOVIMENTO,
  VERSAO_PROTOCOLO,
  criarCodificador,
  criarDecodificador,
} from '../protocolo/indice.js';
import {
  criarServidorDeTransporte,
  type ServidorDeTransporte,
  type SessaoDeTransporte,
} from '../transporte/indice.js';
import {
  MODULOS_DO_CODEC,
  PREFIXO_DO_CODEC,
  ROTA_DA_PAGINA,
  ROTA_DO_SCRIPT,
  criarAtendenteDeDiagnostico,
  ehEnderecoLocal,
  montarModuloDoCodec,
  rotaDe,
  type ModuloDoCodec,
} from './estaticos.js';
import { enviarHaptico } from './vibracao.js';

/** Nenhum teste pode ficar pendurado esperando quadro que não vem. */
const LIMITE_DE_ESPERA_MS = 4000;

const registradorMudo = criarRegistrador('erro', 'teste', () => {
  // De propósito vazio: a saída do teste é a asserção, não o log.
});

/** O mesmo formato do módulo local — é exatamente isso que o teste quer conferir. */
type ModuloDoProtocolo = typeof import('../protocolo/indice.js');

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

/* ============================================================ servidor de teste com a rota */

let servidor: ServidorDeTransporte;
let base: string;
let sessaoAberta: SessaoDeTransporte | undefined;

before(async () => {
  servidor = criarServidorDeTransporte({
    host: '127.0.0.1',
    porta: 0,
    registrador: registradorMudo,
    atenderHttp: criarAtendenteDeDiagnostico({ registrador: registradorMudo }),
    aoAbrirSessao: (sessao) => {
      sessaoAberta = sessao;
    },
  });
  const endereco = await comLimite(servidor.ouvir(), 'a porta abrir');
  base = `http://127.0.0.1:${endereco.porta}`;
});

after(async () => {
  await servidor.fechar('teste encerrando');
});

/* ============================================================================ rotas HTTP */

describe('rota /diagnostico', () => {
  it('serve a página com status 200 e tipo de conteúdo de HTML', async () => {
    const resposta = await fetch(`${base}${ROTA_DA_PAGINA}`);
    const corpo = await resposta.text();

    assert.equal(resposta.status, 200);
    assert.equal(resposta.headers.get('content-type'), 'text/html; charset=utf-8');
    // Ferramenta de bancada não pode ser servida de um cache de navegador: a dúvida "estou vendo
    // a página nova ou a de antes do conserto?" é a mais cara que existe num diagnóstico.
    assert.equal(resposta.headers.get('cache-control'), 'no-store');
    assert.match(corpo, /^<!doctype html>/i);
    assert.match(corpo, /<html lang="pt-BR">/);
    assert.match(corpo, /<\/html>\s*$/);
  });

  it('a barra no fim leva ao mesmo lugar', async () => {
    const resposta = await fetch(`${base}${ROTA_DA_PAGINA}/`);

    assert.equal(resposta.status, 200);
    assert.equal(resposta.headers.get('content-type'), 'text/html; charset=utf-8');
    await resposta.text();
  });

  it('serve o script da página como módulo JavaScript', async () => {
    const resposta = await fetch(`${base}${ROTA_DO_SCRIPT}`);
    const corpo = await resposta.text();

    assert.equal(resposta.status, 200);
    assert.equal(resposta.headers.get('content-type'), 'text/javascript; charset=utf-8');
    // O script importa o codec do servidor — se algum dia ele passar a declarar o formato por
    // conta própria, esta linha some e o teste cai.
    assert.match(corpo, /from '\.\/protocolo\/indice\.js'/);
  });

  it('o HTML aponta para o script servido e tem todos os id que o script procura', () => {
    const pasta = new URL('.', import.meta.url);
    const html = readFileSync(new URL('pagina.html', pasta), 'utf8');
    const script = readFileSync(new URL('pagina.js', pasta), 'utf8');

    assert.match(html, new RegExp(`<script type="module" src="${ROTA_DO_SCRIPT}"`));

    // `getElementById` que não acha nada devolve `null` em silêncio, e o painel só deixaria de
    // atualizar um número no meio do teste — com o celular na mão, isso viraria "o servidor não
    // está recebendo". Aqui um id trocado é falha de teste, não mistério de bancada.
    const procurados = [...script.matchAll(/elemento\('([^']+)'\)/g)].map((achado) => achado[1]);
    assert.ok(procurados.length >= 10, 'o script deveria procurar vários elementos');
    for (const id of procurados) {
      assert.ok(html.includes(`id="${id}"`), `a página não tem o elemento id="${id}"`);
    }
  });

  it('rota inexistente dentro de /diagnostico é 404, e fora dela continua sendo o 426 do transporte', async () => {
    const dentro = await fetch(`${base}/diagnostico/nao-existe.js`);
    await dentro.text();
    const fora = await fetch(`${base}/qualquer-outra-coisa`);
    await fora.text();

    assert.equal(dentro.status, 404);
    assert.equal(fora.status, 426);
  });

  it('não serve arquivo fora da lista branca, nem com travessia codificada', async () => {
    const caminhos = [
      `${PREFIXO_DO_CODEC}..%2f..%2fconfig.js`,
      `${PREFIXO_DO_CODEC}%2e%2e/config.js`,
      `${PREFIXO_DO_CODEC}config.js`,
      `${PREFIXO_DO_CODEC}indice.ts`,
    ];

    for (const caminho of caminhos) {
      const resposta = await fetch(`${base}${caminho}`);
      await resposta.text();
      assert.equal(resposta.status, 404, `${caminho} deveria ser 404`);
    }
  });

  it('método diferente de GET/HEAD é recusado com 405', async () => {
    const resposta = await fetch(`${base}${ROTA_DA_PAGINA}`, { method: 'POST' });
    await resposta.text();

    assert.equal(resposta.status, 405);
  });

  it('toda resposta da rota declara a Permissions-Policy dos sensores (ATI-031)', async () => {
    // Defesa declarativa, e não conserto medido (ver o comentário em `estaticos.ts`): o que se
    // prende aqui é que ela continua saindo pelo fio, em toda resposta da rota — inclusive as de
    // erro, porque o cabeçalho é montado num lugar só.
    const pedidos: ReadonlyArray<readonly [string, RequestInit | undefined, number]> = [
      [ROTA_DA_PAGINA, undefined, 200],
      [ROTA_DO_SCRIPT, undefined, 200],
      [`${PREFIXO_DO_CODEC}indice.js`, undefined, 200],
      ['/diagnostico/nao-existe.js', undefined, 404],
      [ROTA_DA_PAGINA, { method: 'POST' }, 405],
    ];

    for (const [rota, opcoes, status] of pedidos) {
      const resposta = await fetch(`${base}${rota}`, opcoes);
      await resposta.text();
      assert.equal(resposta.status, status, `${rota}`);
      assert.equal(
        resposta.headers.get('permissions-policy'),
        'accelerometer=(self), gyroscope=(self)',
        `${rota} (${status}) sem a Permissions-Policy`,
      );
    }
  });

  it('só atende quem está na própria máquina', () => {
    // O servidor escutar em `127.0.0.1` é configuração e muda com uma variável de ambiente; a
    // página ser coisa de localhost é promessa da ATI-025. Esta checagem é o que faz a segunda
    // não depender da primeira.
    assert.equal(ehEnderecoLocal('127.0.0.1'), true);
    assert.equal(ehEnderecoLocal('127.0.0.53'), true);
    assert.equal(ehEnderecoLocal('::1'), true);
    assert.equal(ehEnderecoLocal('::ffff:127.0.0.1'), true);
    assert.equal(ehEnderecoLocal('192.168.0.10'), false);
    assert.equal(ehEnderecoLocal('::ffff:192.168.0.10'), false);
    assert.equal(ehEnderecoLocal(''), false);
    assert.equal(ehEnderecoLocal(undefined), false);
  });

  it('rotaDe descarta query e fragmento e normaliza a barra do fim', () => {
    assert.equal(rotaDe('/diagnostico?x=1'), '/diagnostico');
    assert.equal(rotaDe('/diagnostico/#topo'), '/diagnostico');
    assert.equal(rotaDe('/'), '/');
    assert.equal(rotaDe(undefined), '/');
  });
});

/* ============================================== o codec servido é o codec do servidor */

/**
 * Grava os módulos num diretório temporário e importa o `indice.js` como módulo de verdade.
 *
 * O `package.json` com `type: module` é obrigatório: sem ele o Node leria `.js` como CommonJS e
 * o `import` do próprio módulo falharia — o que não teria nada a ver com o codec.
 */
async function importarCodec(
  pegar: (nome: ModuloDoCodec) => Promise<string> | string,
): Promise<{ modulo: ModuloDoProtocolo; apagar: () => void }> {
  const pasta = mkdtempSync(join(tmpdir(), 'controle-codec-'));
  writeFileSync(join(pasta, 'package.json'), '{"type":"module"}', 'utf8');
  for (const nome of MODULOS_DO_CODEC) {
    writeFileSync(join(pasta, `${nome}.js`), await pegar(nome), 'utf8');
  }
  const modulo = (await import(pathToFileURL(join(pasta, 'indice.js')).href)) as ModuloDoProtocolo;
  return {
    modulo,
    apagar: () => {
      rmSync(pasta, { recursive: true, force: true });
    },
  };
}

/** Bate o codificador servido contra o do servidor, chamada por chamada. */
function conferirCodificadores(servido: ModuloDoProtocolo): void {
  const daPagina = servido.criarCodificador();
  const doServidor = criarCodificador();
  const paraHex = (bytes: Uint8Array): string =>
    Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  const casos: ReadonlyArray<[string, Uint8Array, Uint8Array]> = [
    [
      'movimento',
      daPagina.movimento(258, 66051, 10, 0.5, -0.25, 0, 0b10),
      doServidor.movimento(258, 66051, 10, 0.5, -0.25, 0, 0b10),
    ],
    [
      'movimento com acelerômetro',
      daPagina.movimentoComAcelerometro(65535, 0xffffffff, 9.75, -1.5, 2.25, -0.0625, 0, -9.5, 9.75, 0b100),
      doServidor.movimentoComAcelerometro(65535, 0xffffffff, 9.75, -1.5, 2.25, -0.0625, 0, -9.5, 9.75, 0b100),
    ],
    ['botão', daPagina.botao(1000, 513, true, 255), doServidor.botao(1000, 513, true, 255)],
    ['botão solto', daPagina.botao(1001, 513, false, 0), doServidor.botao(1001, 513, false, 0)],
    ['eixo', daPagina.eixo(2, 7, -1, 0.75), doServidor.eixo(2, 7, -1, 0.75)],
    ['scroll', daPagina.scroll(65535, -3.5, 1), doServidor.scroll(65535, -3.5, 1)],
    ['rumble', daPagina.rumble(200, 32, 250), doServidor.rumble(200, 32, 250)],
    ['háptico', daPagina.haptico(2, 128), doServidor.haptico(2, 128)],
  ];

  for (const [nome, daPaginaBytes, doServidorBytes] of casos) {
    assert.equal(paraHex(daPaginaBytes), paraHex(doServidorBytes), `${nome} divergiu`);
  }

  // As constantes também: tamanho e tipo errados não apareceriam na comparação acima se os dois
  // lados errassem junto — mas aqui o lado do servidor é o que os vetores fixos já prendem.
  assert.equal(servido.TAMANHO_MOVIMENTO, 24);
  assert.equal(servido.TAMANHO_MOVIMENTO_COM_ACELEROMETRO, 36);
  assert.equal(servido.TAMANHO_BOTAO, 8);
  assert.equal(servido.TIPO_MOVIMENTO, TIPO_MOVIMENTO);
  assert.equal(servido.TIPO_HAPTICO, TIPO_HAPTICO);
  assert.equal(servido.VERSAO_PROTOCOLO, VERSAO_PROTOCOLO);
}

describe('o codec servido ao navegador', () => {
  it('produz exatamente os mesmos bytes do codec do servidor (JS baixado do fio)', async () => {
    const { modulo, apagar } = await importarCodec(async (nome) => {
      const resposta = await fetch(`${base}${PREFIXO_DO_CODEC}${nome}.js`);
      assert.equal(resposta.status, 200);
      assert.equal(resposta.headers.get('content-type'), 'text/javascript; charset=utf-8');
      return resposta.text();
    });

    try {
      conferirCodificadores(modulo);

      // E o decodificador do servidor lê o que a página escreve, campo por campo.
      const decodificador = criarDecodificador();
      const daPagina = modulo.criarCodificador();
      const resultado = decodificador.decodificar(daPagina.movimento(7, 1234, 16.6, 1, -2, 3));

      assert.equal(resultado, RESULTADO_DECODIFICACAO.OK);
      assert.equal(decodificador.saida.tipo, TIPO_MOVIMENTO);
      assert.equal(decodificador.saida.seq, 7);
      assert.equal(decodificador.saida.gx, 1);
      assert.equal(decodificador.saida.gy, -2);
      assert.equal(decodificador.saida.gz, 3);
    } finally {
      apagar();
    }
  });

  it('o caminho transpilado do fonte dá o mesmo resultado do compilado', async () => {
    // `preferirCompilado = false` força a transpilação com a API do TypeScript, mesmo com o
    // `dist/` em dia — sem isso, este caminho só seria exercitado por acaso.
    const { modulo, apagar } = await importarCodec(
      (nome) => montarModuloDoCodec(nome, false).corpo,
    );

    try {
      conferirCodificadores(modulo);
    } finally {
      apagar();
    }
  });

  it('declara de onde veio o JS: compilado quando o dist/ está em dia', () => {
    const doFonte = montarModuloDoCodec('binario', false);
    assert.equal(doFonte.origem, 'transpilado');
    // O `dist/` pode não existir num clone recém-baixado; o que não pode é a origem mentir.
    const automatico = montarModuloDoCodec('binario');
    assert.ok(automatico.origem === 'compilado' || automatico.origem === 'transpilado');
  });

  it('o codec é neutro: nada de Buffer nem node: no que vai para o navegador', async () => {
    // Comentário fora antes de olhar: o codec **fala** de `Buffer` na explicação de por que a
    // `DataView` é reaproveitada, e prosa não vai para o navegador. O que não pode existir é o
    // uso — no navegador não há `Buffer`, `require` nem `node:`, e um deles no meio do arquivo
    // faria a página quebrar na carga, sem erro que ajude quem está com o celular na mão.
    const semComentarios = (js: string): string =>
      js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    for (const nome of MODULOS_DO_CODEC) {
      const resposta = await fetch(`${base}${PREFIXO_DO_CODEC}${nome}.js`);
      const corpo = semComentarios(await resposta.text());
      assert.doesNotMatch(corpo, /\brequire\(/, `${nome} traz require()`);
      assert.doesNotMatch(corpo, /from ['"]node:/, `${nome} importa de node:`);
      assert.doesNotMatch(corpo, /\bBuffer\b/, `${nome} usa Buffer`);
      assert.doesNotMatch(corpo, /\bprocess\./, `${nome} usa process`);
    }
  });
});

/* ============================================ os bytes da página entram no transporte real */

describe('a página falando com o transporte de verdade', () => {
  it('faz o handshake, manda MOVIMENTO e BOTÃO com o codec servido e recebe HÁPTICO', async () => {
    const { modulo, apagar } = await importarCodec((nome) => montarModuloDoCodec(nome).corpo);

    const endereco = servidor.endereco();
    assert.ok(endereco !== undefined);
    const socket = new WebSocket(`ws://127.0.0.1:${endereco.porta}`);
    socket.binaryType = 'nodebuffer';

    const textos: Array<Record<string, unknown>> = [];
    const binarios: Uint8Array[] = [];
    socket.on('message', (dados: Buffer, ehBinario: boolean) => {
      if (ehBinario) binarios.push(new Uint8Array(dados));
      else textos.push(JSON.parse(dados.toString('utf8')) as Record<string, unknown>);
    });

    try {
      await comLimite(
        new Promise<void>((resolver, rejeitar) => {
          socket.once('open', () => {
            resolver();
          });
          socket.once('error', rejeitar);
        }),
        'a conexão abrir',
      );

      // O `hello` é o mesmo que `pagina.js` monta (PROTOCOLO.md, seção 3.1).
      socket.send(
        JSON.stringify({
          t: 'hello',
          v: modulo.VERSAO_PROTOCOLO,
          aparelho: {
            id: 'diagnostico-teste',
            nome: 'Navegador de diagnostico',
            so: 'android',
            versaoSo: '14',
            modelo: 'Chrome/126',
          },
          capacidades: ['giroscopio', 'toque', 'haptico'],
          taxaHzDesejada: 100,
        }),
      );

      await comLimite(
        new Promise<void>((resolver) => {
          const olhar = setInterval(() => {
            if (textos.some((quadro) => quadro['t'] === 'welcome')) {
              clearInterval(olhar);
              resolver();
            }
          }, 10);
          olhar.unref();
        }),
        'o welcome',
      );

      const daPagina = modulo.criarCodificador();
      socket.send(daPagina.movimento(1, 1000, 16.6, 0.5, -0.25, 0), { binary: true });
      socket.send(daPagina.movimento(2, 1016, 16.6, 0.5, -0.25, 0), { binary: true });
      socket.send(daPagina.botao(3, 2, true, 255).slice(), { binary: true });
      socket.send(daPagina.botao(4, 2, false, 0).slice(), { binary: true });

      await comLimite(
        new Promise<void>((resolver) => {
          const olhar = setInterval(() => {
            const medidas = sessaoAberta?.instantaneo().medidas;
            if (medidas !== undefined && medidas.pacotesRecebidos >= 4) {
              clearInterval(olhar);
              resolver();
            }
          }, 10);
          olhar.unref();
        }),
        'os quatro pacotes chegarem',
      );

      const medidas = sessaoAberta?.instantaneo().medidas;
      assert.equal(medidas?.descartados, 0);
      assert.equal(medidas?.foraDeOrdem, 0);

      // Sentido contrário: o PC dispara a vibração e a página recebe um HÁPTICO legível pelo
      // decodificador dela — é o pedaço do ciclo que não depende do motor do aparelho.
      assert.equal(enviarHaptico(sessaoAberta, 'click'), true);
      await comLimite(
        new Promise<void>((resolver) => {
          const olhar = setInterval(() => {
            if (binarios.length > 0) {
              clearInterval(olhar);
              resolver();
            }
          }, 10);
          olhar.unref();
        }),
        'o pacote de vibração',
      );

      const decodificadorDaPagina = modulo.criarDecodificador();
      const primeiro = binarios[0];
      assert.ok(primeiro !== undefined);
      assert.equal(primeiro.byteLength, 4);
      assert.equal(
        decodificadorDaPagina.decodificar(primeiro),
        modulo.RESULTADO_DECODIFICACAO.OK,
      );
      assert.equal(decodificadorDaPagina.saida.tipo, modulo.TIPO_HAPTICO);
      assert.equal(decodificadorDaPagina.saida.padrao, modulo.PADROES_HAPTICOS.click);
      assert.equal(modulo.nomeDoPadraoHaptico(decodificadorDaPagina.saida.padrao), 'click');

      // Pacote de BOTÃO contado do lado do servidor: é o critério "botão da página aparece nos
      // contadores" reproduzido sem aparelho.
      const decodificadorDoServidor = criarDecodificador();
      decodificadorDoServidor.decodificar(daPagina.botao(5, 2, false, 0));
      assert.equal(decodificadorDoServidor.saida.tipo, TIPO_BOTAO);
      assert.equal(decodificadorDoServidor.saida.pressionado, false);
    } finally {
      socket.close();
      apagar();
    }
  });
});

/* ===================================================== o 426 de quem não pediu upgrade */

/** Resposta crua, sem o filtro de cabeçalhos do `fetch` — aqui o assunto é cabeçalho. */
function pegarCru(
  url: string,
  agente: Agent,
): Promise<{ status: number; cabecalhos: Map<string, string>; corpo: string }> {
  return new Promise((resolver, rejeitar) => {
    const pedido = get(url, { agent: agente }, (resposta) => {
      let corpo = '';
      resposta.setEncoding('utf8');
      resposta.on('data', (parte: string) => {
        corpo += parte;
      });
      resposta.on('end', () => {
        const cabecalhos = new Map<string, string>();
        for (let i = 0; i < resposta.rawHeaders.length; i += 2) {
          const nome = (resposta.rawHeaders[i] ?? '').toLowerCase();
          // `date` muda a cada segundo: é a única diferença que não diz nada.
          if (nome === 'date') continue;
          cabecalhos.set(nome, resposta.rawHeaders[i + 1] ?? '');
        }
        resolver({ status: resposta.statusCode ?? 0, cabecalhos, corpo });
      });
    });
    pedido.on('error', rejeitar);
  });
}

describe('quem bate na porta sem pedir upgrade', () => {
  it('recebe o mesmo 426 que o servidor HTTP interno do ws dava antes da ATI-025', async () => {
    // A promessa da entrega é que trocar o servidor HTTP não muda nada para quem já dependia do
    // comportamento antigo (curl na porta, sonda de porta ocupada). Provar isso exige comparar
    // com a coisa real, e não com uma cópia da lembrança do que ela respondia: aqui sobe um
    // `WebSocketServer` com porta própria (que é quando o `ws` cria o servidor HTTP dele) e as
    // duas respostas são comparadas cabeçalho por cabeçalho.
    const doWs = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const agente = new Agent({ keepAlive: true });

    try {
      await comLimite(
        new Promise<void>((resolver, rejeitar) => {
          doWs.once('listening', () => {
            resolver();
          });
          doWs.once('error', rejeitar);
        }),
        'o servidor de referência abrir',
      );

      const enderecoDoWs = doWs.address();
      assert.ok(enderecoDoWs !== null && typeof enderecoDoWs !== 'string');

      const referencia = await pegarCru(`http://127.0.0.1:${enderecoDoWs.port}/`, agente);
      const nosso = await pegarCru(`${base}/`, agente);

      assert.equal(nosso.status, 426);
      assert.equal(nosso.status, referencia.status);
      assert.equal(nosso.corpo, referencia.corpo);
      assert.deepEqual([...nosso.cabecalhos].sort(), [...referencia.cabecalhos].sort());
    } finally {
      agente.destroy();
      await new Promise<void>((resolver) => {
        doWs.close(() => {
          resolver();
        });
      });
    }
  });
});

/* ================================================================= a pasta dos estáticos */

describe('resolução da pasta de estáticos', () => {
  it('o mesmo caminho relativo acerta rodando pelo fonte e pelo build', () => {
    // A regra vale porque `src/diagnostico/` e `dist/diagnostico/` estão à mesma distância da
    // raiz do pacote: `../../src/diagnostico/` cai no fonte a partir dos dois.
    const doFonte = fileURLToPath(new URL('../../src/diagnostico/pagina.html', import.meta.url));
    const doBuild = fileURLToPath(
      new URL('../../src/diagnostico/pagina.html', pathToFileURL(join(process.cwd(), 'dist/diagnostico/estaticos.js'))),
    );

    assert.equal(doFonte, doBuild);
    assert.doesNotThrow(() => readFileSync(doFonte, 'utf8'));
  });
});
