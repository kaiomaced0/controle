/**
 * Página de diagnóstico servida na **mesma porta** do WebSocket (ATI-025).
 *
 * Para que serve: com o build Android impedido nesta máquina (ATI-024), o navegador do celular é
 * o único cliente com giroscópio de verdade que dá para colocar de pé hoje. Esta rota entrega a
 * página; quem fala o protocolo é o próprio codec do servidor, servido para o navegador.
 *
 * ## Por que o codec vem daqui, e não de uma cópia
 *
 * Já existem **duas** implementações do formato binário (servidor e app), vigiadas por
 * `espelho.teste.ts` e pelos vetores de bytes fixos. Uma terceira cópia, escrita à mão dentro de
 * um HTML, seria a que ninguém vigia — e o dia em que ela divergisse, o diagnóstico passaria a
 * mentir justamente sobre o que existe para medir. Então o navegador **importa o mesmo código**:
 *
 * 1. `dist/protocolo/*.js`, quando o build existe e não está mais velho que o fonte;
 * 2. senão, `src/protocolo/*.ts` transpilado na hora com a API do TypeScript, com cache em
 *    memória.
 *
 * A comparação de data importa: `npm run dev` roda pelo fonte com `tsx` e não atualiza o `dist/`,
 * então um `dist/` de ontem serviria um codec velho sem avisar ninguém. Com a checagem, o que sai
 * pelo fio **nunca é mais antigo que o fonte**.
 *
 * Isso só é possível porque `protocolo/` é neutro: `DataView`, `JSON` e nada de `Buffer` nem
 * `node:*` (conferido em `estaticos.teste.ts`, que importa o JS servido e roda o codec).
 *
 * ## O que esta rota não é
 *
 * Não é servidor de arquivos: não existe caminho vindo da requisição virando caminho de disco. As
 * rotas são uma tabela fechada, e o nome do módulo do codec passa por lista branca — com isso não
 * há travessia de diretório possível, nem com `..`, nem com `%2e%2e`.
 */

import { readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type * as ApiDoTypeScript from 'typescript';
import type { Registrador } from '../log.js';

/** Caminho da página no navegador do celular. */
export const ROTA_DA_PAGINA = '/diagnostico';
/** Prefixo das rotas de módulo do codec. */
export const PREFIXO_DO_CODEC = '/diagnostico/protocolo/';
/** Rota do script da página. */
export const ROTA_DO_SCRIPT = '/diagnostico/pagina.js';

/**
 * Módulos do codec que o navegador pode pedir — **lista branca**, não busca em disco.
 *
 * São os três arquivos de `src/protocolo/` mais o `indice`, que é o que a página importa.
 */
export const MODULOS_DO_CODEC = ['indice', 'tipos', 'binario', 'sessao'] as const;
export type ModuloDoCodec = (typeof MODULOS_DO_CODEC)[number];

/** De onde saiu o JS do codec que foi para o navegador. */
export type OrigemDoCodec = 'compilado' | 'transpilado';

/** Um arquivo pronto para ir ao fio, já com o tipo declarado. */
export interface ArquivoServido {
  readonly corpo: string;
  readonly tipo: string;
  /** Só nos módulos do codec: de onde o JS veio. */
  readonly origem?: OrigemDoCodec;
}

/** Falha ao montar um arquivo da página — vira `503` com texto acionável, nunca exceção no fio. */
export class ErroDoDiagnostico extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroDoDiagnostico';
  }
}

/**
 * Pasta dos estáticos da página, resolvida a partir **deste** módulo.
 *
 * O mesmo caminho relativo acerta o alvo rodando pelo fonte e rodando pelo build:
 * `src/diagnostico/` + `../../src/diagnostico/` = `src/diagnostico/`, e
 * `dist/diagnostico/` + `../../src/diagnostico/` = `src/diagnostico/`. Uma regra só, sem
 * tentativa e erro — e sem precisar copiar `.html` para o `dist/` no build (o `tsc` não copiaria).
 */
const PASTA_DOS_ESTATICOS = new URL('../../src/diagnostico/', import.meta.url);
/** `dist/protocolo/` — o codec já compilado, quando o `npm run build` tiver rodado. */
const PASTA_DO_CODEC_COMPILADO = new URL('../../dist/protocolo/', import.meta.url);
/** `src/protocolo/` — a fonte da verdade do formato binário. */
const PASTA_DO_CODEC_FONTE = new URL('../../src/protocolo/', import.meta.url);

const TIPO_HTML = 'text/html; charset=utf-8';
const TIPO_JS = 'text/javascript; charset=utf-8';

const exigirDoNode = createRequire(import.meta.url);

/** `undefined` = ainda não tentei; `null` = tentei e o pacote não está instalado. */
let apiDoTypeScript: typeof ApiDoTypeScript | null | undefined;

/**
 * Carrega a API do TypeScript **sem** `import` estático.
 *
 * `typescript` é dependência de desenvolvimento: numa instalação `--omit=dev` ela não existe, e um
 * `import` no topo faria o servidor inteiro deixar de subir por causa de uma rota de diagnóstico.
 * Aqui a ausência vira uma mensagem dizendo o que fazer (`npm run build`).
 */
function carregarTypeScript(): typeof ApiDoTypeScript | null {
  if (apiDoTypeScript !== undefined) return apiDoTypeScript;
  try {
    apiDoTypeScript = exigirDoNode('typescript') as typeof ApiDoTypeScript;
  } catch {
    apiDoTypeScript = null;
  }
  return apiDoTypeScript;
}

/** Data de modificação, ou `undefined` quando o arquivo não existe. */
function modificadoEm(arquivo: URL): number | undefined {
  try {
    return statSync(arquivo).mtimeMs;
  } catch {
    return undefined;
  }
}

function ler(arquivo: URL): string {
  try {
    return readFileSync(arquivo, 'utf8');
  } catch (erro) {
    throw new ErroDoDiagnostico(
      `não consegui ler ${fileURLToPath(arquivo)}: ${(erro as Error).message}`,
    );
  }
}

/**
 * Transpila um módulo do codec para o navegador.
 *
 * `transpileModule` é tradução arquivo a arquivo, sem verificação de tipos — é exatamente o que se
 * quer aqui, porque quem verifica tipo é o `npm run typecheck`, e uma rota de diagnóstico não pode
 * ficar cara. Os especificadores relativos já terminam em `.js` no fonte (`./tipos.js`), que é o
 * que o navegador precisa: o mesmo texto serve de caminho de rota.
 */
function transpilar(nome: ModuloDoCodec, fonte: string): string {
  const ts = carregarTypeScript();
  if (ts === null) {
    throw new ErroDoDiagnostico(
      'o codec do navegador precisa de dist/protocolo/ compilado ou do pacote typescript ' +
        'instalado; rode `npm run build` no server/ e recarregue a página',
    );
  }
  const resultado = ts.transpileModule(fonte, {
    fileName: `${nome}.ts`,
    compilerOptions: {
      // ESM puro e alvo moderno: o destino é o navegador do celular, não o Node.
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      // O codec não usa decorator nem enum const; nada aqui muda semântica de execução.
      isolatedModules: true,
      removeComments: false,
    },
  });
  return resultado.outputText;
}

/**
 * Monta o JS de um módulo do codec, preferindo o compilado quando ele está em dia.
 *
 * "Em dia" é `dist` não ser mais antigo que `src`. Sem essa comparação, quem roda `npm run dev`
 * (que não recompila nada) serviria para o celular o codec de um build antigo — e o diagnóstico
 * passaria a medir uma versão do formato que já não é a do servidor.
 */
export function montarModuloDoCodec(
  nome: ModuloDoCodec,
  /**
   * `false` ignora o `dist/` e transpila o fonte.
   *
   * Existe para o teste conseguir exercitar **os dois caminhos** na mesma máquina: sem isto, só
   * daria para provar o que estivesse compilado na hora, e o outro caminho ficaria por conta da
   * sorte de alguém ter esquecido de rodar `npm run build`.
   */
  preferirCompilado = true,
): ArquivoServido {
  const compilado = new URL(`${nome}.js`, PASTA_DO_CODEC_COMPILADO);
  const fonte = new URL(`${nome}.ts`, PASTA_DO_CODEC_FONTE);

  const dataDoCompilado = preferirCompilado ? modificadoEm(compilado) : undefined;
  const dataDaFonte = modificadoEm(fonte);

  if (dataDoCompilado !== undefined && (dataDaFonte === undefined || dataDoCompilado >= dataDaFonte)) {
    return { corpo: ler(compilado), tipo: TIPO_JS, origem: 'compilado' };
  }

  if (dataDaFonte === undefined) {
    throw new ErroDoDiagnostico(
      `não achei o módulo "${nome}" do codec nem em dist/protocolo/ nem em src/protocolo/`,
    );
  }
  return { corpo: transpilar(nome, ler(fonte)), tipo: TIPO_JS, origem: 'transpilado' };
}

/** Monta um estático da própria página (HTML ou JS do cliente). */
export function montarEstatico(nome: 'pagina.html' | 'pagina.js'): ArquivoServido {
  return {
    corpo: ler(new URL(nome, PASTA_DOS_ESTATICOS)),
    tipo: nome.endsWith('.html') ? TIPO_HTML : TIPO_JS,
  };
}

/** Caminho da requisição sem query nem fragmento, e sem barra no fim (exceto a raiz). */
export function rotaDe(url: string | undefined): string {
  if (url === undefined || url === '') return '/';
  const corte = url.search(/[?#]/);
  const caminho = corte === -1 ? url : url.slice(0, corte);
  if (caminho.length > 1 && caminho.endsWith('/')) return caminho.slice(0, -1);
  return caminho;
}

/** Resolve a rota para o arquivo que ela serve, ou `undefined` se a rota não é do diagnóstico. */
export function resolverRota(rota: string): (() => ArquivoServido) | undefined {
  if (rota === ROTA_DA_PAGINA) return () => montarEstatico('pagina.html');
  if (rota === ROTA_DO_SCRIPT) return () => montarEstatico('pagina.js');

  if (rota.startsWith(PREFIXO_DO_CODEC)) {
    const arquivo = rota.slice(PREFIXO_DO_CODEC.length);
    if (!arquivo.endsWith('.js')) return undefined;
    const nome = arquivo.slice(0, -'.js'.length);
    // Lista branca: nome fora dela não vira caminho de disco nenhum.
    if (!(MODULOS_DO_CODEC as readonly string[]).includes(nome)) return undefined;
    return () => montarModuloDoCodec(nome as ModuloDoCodec);
  }

  return undefined;
}

/**
 * Endereço de quem pediu é o próprio PC?
 *
 * A ATI-025 promete que a página é coisa de `localhost` (o celular chega por `adb reverse`, que
 * é o cabo). O servidor já escuta só em `127.0.0.1`, mas isso é **configuração** — muda com uma
 * variável de ambiente. Esta checagem transforma a promessa em regra: mesmo que alguém abra o
 * servidor para a rede (ATI-013), a página de diagnóstico continua sendo só de quem está na
 * máquina. IPv6 mapeado (`::ffff:127.0.0.1`) conta, porque é assim que o Windows costuma
 * apresentar uma conexão IPv4 num socket duplo.
 */
export function ehEnderecoLocal(endereco: string | undefined): boolean {
  if (endereco === undefined || endereco === '') return false;
  if (endereco === '::1') return true;
  const semPrefixo = endereco.startsWith('::ffff:') ? endereco.slice('::ffff:'.length) : endereco;
  return semPrefixo === 'localhost' || semPrefixo.startsWith('127.');
}

export interface OpcoesDoAtendente {
  /** Log de partida e de falha. Sem ele, a rota funciona calada. */
  readonly registrador?: Registrador | undefined;
  /**
   * Guarda o que já foi montado. O padrão é um cache próprio por atendente.
   *
   * Existe cache porque transpilar custa dezenas de milissegundos e ler disco bloqueia o mesmo
   * event loop que carrega 100 Hz de sensor: uma recarga de página no meio da medição não pode
   * cobrar isso do fluxo. Em compensação, **editar a página exige reiniciar o servidor** — o que
   * é o trato normal aqui, já que o servidor também roda pelo fonte.
   */
  readonly cache?: Map<string, ArquivoServido>;
}

/**
 * Atendente HTTP da página de diagnóstico.
 *
 * Devolve `true` quando a resposta é dele (inclusive `404` e `503` dentro de `/diagnostico`), e
 * `false` quando a rota não lhe pertence — aí quem responde é o transporte, com o `426` de sempre.
 */
export function criarAtendenteDeDiagnostico(
  opcoes: OpcoesDoAtendente = {},
): (requisicao: IncomingMessage, resposta: ServerResponse) => boolean {
  const registrador = opcoes.registrador;
  const cache = opcoes.cache ?? new Map<string, ArquivoServido>();

  function responder(resposta: ServerResponse, status: number, tipo: string, corpo: string, comCorpo: boolean): void {
    resposta.writeHead(status, {
      'Content-Type': tipo,
      'Content-Length': String(Buffer.byteLength(corpo, 'utf8')),
      // Ferramenta de diagnóstico servida de `localhost`: cache de navegador aqui só produziria
      // a dúvida mais cara possível — "estou vendo a página nova ou a de antes do conserto?".
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // Defesa declarativa (ATI-031), não conserto medido: a allowlist padrão de `accelerometer` e
      // `gyroscope` já é `self`, e para a página de topo servida desta mesma origem o cabeçalho
      // não muda nada hoje. Ele deixa escrito que a página **quer** os sensores, caso algum
      // navegador passe a restringir por padrão. Não substitui a permissão do usuário: o sensor
      // bloqueado em "Sensores de movimento" do Chrome do Android continua bloqueado, e quem
      // diz isso na tela é o vigia da `pagina.js`. Preso por teste em `estaticos.teste.ts`.
      'Permissions-Policy': 'accelerometer=(self), gyroscope=(self)',
    });
    resposta.end(comCorpo ? corpo : undefined);
  }

  return (requisicao, resposta) => {
    const rota = rotaDe(requisicao.url);
    if (rota !== ROTA_DA_PAGINA && !rota.startsWith(`${ROTA_DA_PAGINA}/`)) return false;

    if (!ehEnderecoLocal(requisicao.socket.remoteAddress)) {
      registrador?.aviso('pedido de diagnóstico recusado: não veio da máquina', {
        rota,
        origem: requisicao.socket.remoteAddress ?? '—',
      });
      responder(resposta, 403, 'text/plain; charset=utf-8', 'a página de diagnóstico é só de localhost', true);
      return true;
    }

    const metodo = requisicao.method ?? 'GET';
    if (metodo !== 'GET' && metodo !== 'HEAD') {
      responder(resposta, 405, 'text/plain; charset=utf-8', 'apenas GET', true);
      return true;
    }

    const montar = resolverRota(rota);
    if (montar === undefined) {
      responder(resposta, 404, 'text/plain; charset=utf-8', `não existe ${rota}`, metodo === 'GET');
      return true;
    }

    let arquivo = cache.get(rota);
    if (arquivo === undefined) {
      try {
        arquivo = montar();
      } catch (erro) {
        const mensagem = erro instanceof ErroDoDiagnostico ? erro.message : String(erro);
        registrador?.erro('não consegui montar a página de diagnóstico', { rota, erro });
        responder(resposta, 503, 'text/plain; charset=utf-8', mensagem, metodo === 'GET');
        return true;
      }
      cache.set(rota, arquivo);
      if (arquivo.origem !== undefined) {
        registrador?.info('codec do navegador pronto', { rota, origem: arquivo.origem });
      }
    }

    responder(resposta, 200, arquivo.tipo, arquivo.corpo, metodo === 'GET');
    return true;
  };
}
