/**
 * O bias medido, guardado **por aparelho**, para não calibrar de novo a cada conexão (ATI-009).
 *
 * Calibrar é um ritual: apoiar o aparelho, tocar em sincronizar, esperar um segundo sem mexer.
 * Pedir isso toda vez que o cabo é reconectado transformaria o passo mais chato do produto em
 * rotina. O bias de um sensor específico é estável o bastante entre sessões para valer a pena
 * guardá-lo — e o que ele tem de deriva térmica quem corrige é a recalibração automática
 * (`recalibracao.ts`), não uma calibração manual repetida.
 *
 * A chave é o `aparelho.id` do `hello`: um identificador aleatório gerado na primeira execução do
 * app e guardado lá (PROTOCOLO.md, seção 3.1). **Não é IMEI, número de série nem nada da pessoa**,
 * e é por isso que ele pode ir para um arquivo sem virar assunto de privacidade.
 *
 * ## Duas regras deste arquivo
 *
 * 1. **Arquivo corrompido não derruba o servidor.** JSON quebrado, versão desconhecida, número que
 *    virou texto, bias absurdo: tudo vira contador e aviso, e a sessão segue com bias zero. Quem
 *    está com o celular na mão não pode perder o servidor porque um arquivo de cache se estragou.
 * 2. **A gravação é atômica.** Escreve num arquivo ao lado e renomeia por cima. Sem isso, um
 *    Ctrl+C no meio da escrita deixaria um JSON truncado — que é justamente o defeito da regra 1,
 *    produzido por nós mesmos.
 *
 * O arquivo mora em `server/dados-locais/`, que está no `.gitignore` (regra 6 do CLAUDE.md: nada
 * de dado local versionado).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Registrador } from '../log.js';
import { FAIXAS_DO_GIRO } from './ajustes.js';
import type { LeituraDeBias } from './calibracao.js';

/** Versão do formato do arquivo. Versão diferente = arquivo de outro esquema, ignorado inteiro. */
export const VERSAO_DO_ARQUIVO = 1;

/** Caminho padrão: `server/dados-locais/bias.json`, rodando pelo fonte ou pelo `dist/`. */
export const CAMINHO_PADRAO = fileURLToPath(new URL('../../dados-locais/bias.json', import.meta.url));

/**
 * Quantos aparelhos ficam guardados.
 *
 * A v1 é um aparelho por vez, mas o `id` nasce de novo a cada instalação limpa do app (e a cada
 * `localStorage` apagado no navegador de diagnóstico). Sem teto, o arquivo cresceria para sempre
 * com identificadores que ninguém vai usar de novo; com teto, some primeiro o mais antigo.
 */
export const MAXIMO_DE_APARELHOS = 32;

/** Maior tamanho aceito para um `id` de aparelho — o do `hello` tem 12 caracteres. */
const TAMANHO_MAXIMO_DO_ID = 128;

/** Uma entrada do arquivo. */
export interface BiasGuardado extends LeituraDeBias {
  /**
   * Quantas amostras produziram a calibração de origem.
   *
   * Fica em 0 quando nunca houve calibração manual — é o caso do bias que nasceu só do ajuste
   * automático. A regravação de fim de sessão **mantém** o número da calibração original, porque
   * o bias ajustado descende dela.
   */
  readonly amostras: number;
  /** Quando foi gravado, em ISO 8601 — serve para o log e para decidir quem sai pelo teto. */
  readonly gravadoEm: string;
}

/** Diagnóstico do repositório. Objeto mutável reaproveitado. */
export interface ContadoresDoRepositorio {
  /** Quantas vezes o arquivo foi lido do disco (uma por execução, no caminho normal). */
  leituras: number;
  /** Leituras em que o arquivo existia e estava imprestável (JSON quebrado, versão outra). */
  leiturasComDefeito: number;
  /** Entradas descartadas por conteúdo inválido (número que não é número, bias fora da faixa). */
  entradasIgnoradas: number;
  /** Gravações concluídas. */
  gravacoes: number;
  /** Gravações que falharam (disco cheio, pasta somente leitura). */
  gravacoesComErro: number;
}

export function criarContadoresDoRepositorio(): ContadoresDoRepositorio {
  return {
    leituras: 0,
    leiturasComDefeito: 0,
    entradasIgnoradas: 0,
    gravacoes: 0,
    gravacoesComErro: 0,
  };
}

export interface RepositorioDeBias {
  readonly caminho: string;
  readonly contadores: ContadoresDoRepositorio;
  /** O bias guardado deste aparelho, ou `undefined`. Nunca lança. */
  ler(idAparelho: string): BiasGuardado | undefined;
  /** Guarda o bias deste aparelho. Devolve `false` quando não deu para gravar. Nunca lança. */
  gravar(idAparelho: string, bias: LeituraDeBias, amostras: number): boolean;
  /** Ids guardados, do mais antigo para o mais novo. Para teste e diagnóstico. */
  aparelhos(): readonly string[];
}

export interface OpcoesDoRepositorio {
  /** Caminho do arquivo. O padrão é {@link CAMINHO_PADRAO}. */
  readonly caminho?: string | undefined;
  readonly registrador?: Registrador | undefined;
  readonly maximoDeAparelhos?: number | undefined;
}

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/** Número finito dentro da faixa de bias declarada em `ajustes.ts`; qualquer outra coisa é `undefined`. */
function biasValido(valor: unknown): number | undefined {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return undefined;
  if (valor < FAIXAS_DO_GIRO.bias.minimo || valor > FAIXAS_DO_GIRO.bias.maximo) return undefined;
  return valor;
}

function ehIdAceitavel(id: string): boolean {
  return id !== '' && id.length <= TAMANHO_MAXIMO_DO_ID;
}

export function criarRepositorioDeBias(opcoes: OpcoesDoRepositorio = {}): RepositorioDeBias {
  const caminho = opcoes.caminho ?? CAMINHO_PADRAO;
  const registrador = opcoes.registrador;
  const maximoDeAparelhos = Math.max(1, Math.trunc(opcoes.maximoDeAparelhos ?? MAXIMO_DE_APARELHOS));
  const contadores = criarContadoresDoRepositorio();

  /**
   * Ordem de inserção = ordem de gravação, e é ela que decide quem sai quando o teto estoura
   * (`Map` preserva a ordem de inserção; regravar um id existente o mantém na posição antiga,
   * então a regravação é feita com `delete` antes do `set`).
   */
  const guardados = new Map<string, BiasGuardado>();
  let carregado = false;

  /** Lê o arquivo inteiro uma vez. Toda falha vira contador e aviso — nunca exceção. */
  function carregar(): void {
    if (carregado) return;
    carregado = true;
    contadores.leituras += 1;

    let conteudo: string;
    try {
      conteudo = readFileSync(caminho, 'utf8');
    } catch (erro) {
      const codigo = (erro as NodeJS.ErrnoException).code;
      // Arquivo ainda não existe é o normal na primeira execução, e não é defeito de ninguém.
      if (codigo !== 'ENOENT') {
        contadores.leiturasComDefeito += 1;
        registrador?.aviso('não consegui ler o bias guardado; sigo sem ele', { caminho, erro });
      }
      return;
    }

    let bruto: unknown;
    try {
      bruto = JSON.parse(conteudo) as unknown;
    } catch (erro) {
      contadores.leiturasComDefeito += 1;
      registrador?.aviso('o arquivo de bias não é um JSON válido; sigo sem ele', { caminho, erro });
      return;
    }

    if (!ehObjeto(bruto) || bruto['versao'] !== VERSAO_DO_ARQUIVO || !ehObjeto(bruto['aparelhos'])) {
      contadores.leiturasComDefeito += 1;
      registrador?.aviso('o arquivo de bias tem outro formato; sigo sem ele', {
        caminho,
        versaoEsperada: VERSAO_DO_ARQUIVO,
      });
      return;
    }

    for (const [id, entrada] of Object.entries(bruto['aparelhos'])) {
      if (!ehIdAceitavel(id) || !ehObjeto(entrada)) {
        contadores.entradasIgnoradas += 1;
        continue;
      }
      const gx = biasValido(entrada['gx']);
      const gy = biasValido(entrada['gy']);
      const gz = biasValido(entrada['gz']);
      if (gx === undefined || gy === undefined || gz === undefined) {
        contadores.entradasIgnoradas += 1;
        continue;
      }
      const amostras = typeof entrada['amostras'] === 'number' && Number.isFinite(entrada['amostras'])
        ? Math.trunc(entrada['amostras'])
        : 0;
      const gravadoEm = typeof entrada['gravadoEm'] === 'string' ? entrada['gravadoEm'] : '';
      guardados.set(id, { gx, gy, gz, amostras, gravadoEm });
    }

    if (guardados.size > 0) {
      registrador?.depuracao('bias guardado carregado', { caminho, aparelhos: guardados.size });
    }
  }

  function gravarArquivo(): boolean {
    const aparelhos: Record<string, BiasGuardado> = {};
    for (const [id, entrada] of guardados) aparelhos[id] = entrada;
    const texto = `${JSON.stringify({ versao: VERSAO_DO_ARQUIVO, aparelhos }, undefined, 2)}\n`;

    const temporario = `${caminho}.tmp`;
    try {
      mkdirSync(dirname(caminho), { recursive: true });
      // Escreve ao lado e renomeia por cima: `rename` é atômico no mesmo volume, então nunca
      // existe um instante em que o arquivo de verdade está pela metade.
      writeFileSync(temporario, texto, 'utf8');
      renameSync(temporario, caminho);
      contadores.gravacoes += 1;
      return true;
    } catch (erro) {
      contadores.gravacoesComErro += 1;
      registrador?.aviso('não consegui gravar o bias; ele vale só nesta sessão', { caminho, erro });
      return false;
    }
  }

  return {
    caminho,
    contadores,

    ler(idAparelho) {
      if (!ehIdAceitavel(idAparelho)) return undefined;
      carregar();
      return guardados.get(idAparelho);
    },

    gravar(idAparelho, bias, amostras) {
      if (!ehIdAceitavel(idAparelho)) return false;
      const gx = biasValido(bias.gx);
      const gy = biasValido(bias.gy);
      const gz = biasValido(bias.gz);
      // Bias imprestável não vai para o disco: guardá-lo faria a sessão seguinte começar com um
      // valor que o próprio módulo recusaria ao ler de volta.
      if (gx === undefined || gy === undefined || gz === undefined) return false;

      carregar();
      // `delete` antes do `set` para a entrada regravada ir para o fim da fila: quem foi gravado
      // agora é o mais recente, e é o mais antigo que sai quando o teto estoura.
      guardados.delete(idAparelho);
      guardados.set(idAparelho, {
        gx,
        gy,
        gz,
        amostras: Number.isFinite(amostras) ? Math.trunc(amostras) : 0,
        gravadoEm: new Date().toISOString(),
      });
      while (guardados.size > maximoDeAparelhos) {
        const maisAntigo = guardados.keys().next();
        if (maisAntigo.done === true) break;
        guardados.delete(maisAntigo.value);
      }

      return gravarArquivo();
    },

    aparelhos() {
      carregar();
      return [...guardados.keys()];
    },
  };
}
