/**
 * Captura de sessão — gravar em arquivo o que o aparelho mandou, para reproduzir depois.
 *
 * É o que transforma "aconteceu um tranco estranho no meu Pixel" em caso de teste: o servidor
 * grava a sessão real (uma amostra por linha), e o simulador reproduz o arquivo quantas vezes
 * for preciso, sem aparelho nenhum na mesa (ATI-023).
 *
 * ## Formato (`controle-captura v1`)
 *
 * Texto puro, UTF-8, uma amostra de MOVIMENTO por linha, campos separados por **um espaço**:
 *
 * ```
 * # controle-captura v1
 * # gravadoEm=2026-08-20T18:00:00.000Z taxaHz=100
 * # campos: seq flags tDispositivoMs dtMs gx gy gz [ax ay az]
 * 0 4 60000 0 0.0031 -0.0007 0.0012
 * 1 0 60010 10 0.00312 -0.00068 0.00119
 * ```
 *
 * - Linha começando com `#` é comentário; linha em branco é ignorada.
 * - São **7 campos** sem acelerômetro e **10 campos** com ele; quem manda é o bit0 de `flags`
 *   (`FLAG_ACELEROMETRO`), exatamente como no fio (PROTOCOLO.md, seção 4.1) — o arquivo não
 *   inventa um segundo jeito de dizer a mesma coisa.
 * - Número vai com até 9 dígitos significativos: é o que garante ida e volta exata de um `f32`
 *   (o campo do fio) sem encher o arquivo de casas que só existem por causa do binário.
 * - `NaN`, `Infinity` e `-Infinity` são gravados por extenso e voltam como são: a seção 4.0
 *   (regra 7) do PROTOCOLO.md deixa esses valores passarem crus, e uma captura que os
 *   arredondasse perderia justamente o defeito que se quer reproduzir.
 * - **Gravar nunca sobrescreve**: apontar a gravação para um arquivo que já existe é erro, não
 *   truncamento silencioso (ver `criarGravadorDeCaptura`).
 *
 * ⚠️ CAMINHO QUENTE em `registrar()`: ela roda uma vez por pacote, 100 vezes por segundo. Só
 * escreve números num `Float64Array` já alocado. A formatação em texto e a escrita em disco
 * acontecem em bloco, no descarregamento (regra 2 do CLAUDE.md).
 */

import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { FLAG_ACELEROMETRO, TIPO_MOVIMENTO, type PacoteDecodificado } from '../protocolo/indice.js';

/** Primeira linha de todo arquivo de captura — é por ela que se reconhece o formato. */
export const CABECALHO_DE_CAPTURA = '# controle-captura v1';

/** Linha de comentário que documenta a ordem dos campos dentro do próprio arquivo. */
export const LINHA_DE_CAMPOS = '# campos: seq flags tDispositivoMs dtMs gx gy gz [ax ay az]';

/** Campos guardados por amostra no buffer do gravador. */
const CAMPOS_POR_AMOSTRA = 10;

/** Quantas amostras ficam em memória antes de uma escrita em disco. A 100 Hz, ~5 s. */
export const CAPACIDADE_PADRAO_DO_GRAVADOR = 512;

/** Uma amostra de MOVIMENTO lida de um arquivo de captura. */
export interface AmostraDeCaptura {
  readonly seq: number;
  readonly flags: number;
  readonly tDispositivoMs: number;
  readonly dtMs: number;
  readonly gx: number;
  readonly gy: number;
  readonly gz: number;
  /** `flags & FLAG_ACELEROMETRO`, já resolvido — mesma regra do codec. */
  readonly temAcelerometro: boolean;
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
}

/** Arquivo de captura que não dá para usar. Nunca acontece no caminho quente. */
export class ErroDeCaptura extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroDeCaptura';
  }
}

/**
 * Número no texto do arquivo.
 *
 * `toPrecision(9)` porque 9 dígitos significativos é o mínimo que faz um `float32` voltar
 * idêntico; o `Number()` por fora corta o zero à direita que a notação deixa (`0.100000000`).
 */
function formatarNumero(valor: number): string {
  if (Number.isNaN(valor)) return 'NaN';
  if (valor === Number.POSITIVE_INFINITY) return 'Infinity';
  if (valor === Number.NEGATIVE_INFINITY) return '-Infinity';
  // `String(-0)` devolve "0" e o sinal sumiria; a captura preserva o que veio no fio.
  if (Object.is(valor, -0)) return '-0';
  if (Number.isInteger(valor)) return String(valor);
  return String(Number(valor.toPrecision(9)));
}

/** Uma linha de arquivo, já classificada. */
export type LinhaDeCaptura =
  | { readonly tipo: 'ignorada' }
  | { readonly tipo: 'amostra'; readonly amostra: AmostraDeCaptura }
  | { readonly tipo: 'invalida'; readonly motivo: string };

function lerNumero(campo: string): number | undefined {
  if (campo === 'NaN') return Number.NaN;
  const valor = Number(campo);
  // `Number('')` é 0 e `Number('oi')` é NaN: só o literal "NaN" acima tem direito de ser NaN.
  if (Number.isNaN(valor)) return undefined;
  return valor;
}

/** Lê uma linha do formato. Comentário e linha em branco são `ignorada`, não erro. */
export function interpretarLinhaDeCaptura(linha: string): LinhaDeCaptura {
  const limpa = linha.trim();
  if (limpa === '' || limpa.startsWith('#')) return { tipo: 'ignorada' };

  const campos = limpa.split(/\s+/);
  if (campos.length !== 7 && campos.length !== 10) {
    return {
      tipo: 'invalida',
      motivo: `esperava 7 ou 10 campos, encontrei ${campos.length}`,
    };
  }

  const numeros: number[] = [];
  for (const campo of campos) {
    const valor = lerNumero(campo);
    if (valor === undefined) return { tipo: 'invalida', motivo: `"${campo}" não é número` };
    numeros.push(valor);
  }

  const flags = numeros[1] ?? 0;
  const temAcelerometro = (flags & FLAG_ACELEROMETRO) !== 0;
  if (temAcelerometro && campos.length !== 10) {
    return { tipo: 'invalida', motivo: 'bit0 de flags ligado exige os campos ax ay az' };
  }
  if (!temAcelerometro && campos.length !== 7) {
    return { tipo: 'invalida', motivo: 'ax/ay/az presentes exigem o bit0 de flags ligado' };
  }

  return {
    tipo: 'amostra',
    amostra: {
      seq: numeros[0] ?? 0,
      flags,
      tDispositivoMs: numeros[2] ?? 0,
      dtMs: numeros[3] ?? 0,
      gx: numeros[4] ?? 0,
      gy: numeros[5] ?? 0,
      gz: numeros[6] ?? 0,
      temAcelerometro,
      ax: numeros[7] ?? 0,
      ay: numeros[8] ?? 0,
      az: numeros[9] ?? 0,
    },
  };
}

/** Monta a linha de texto de uma amostra, no formato documentado no topo deste arquivo. */
export function formatarAmostraDeCaptura(amostra: AmostraDeCaptura): string {
  const comuns =
    `${formatarNumero(amostra.seq)} ${formatarNumero(amostra.flags)} ` +
    `${formatarNumero(amostra.tDispositivoMs)} ${formatarNumero(amostra.dtMs)} ` +
    `${formatarNumero(amostra.gx)} ${formatarNumero(amostra.gy)} ${formatarNumero(amostra.gz)}`;
  if (!amostra.temAcelerometro) return comuns;
  return (
    `${comuns} ${formatarNumero(amostra.ax)} ` +
    `${formatarNumero(amostra.ay)} ${formatarNumero(amostra.az)}`
  );
}

/** Conteúdo de um arquivo de captura já lido. */
export interface Captura {
  readonly caminho: string;
  /** Linhas de comentário do topo, na ordem, sem o `#`. Servem de contexto para quem lê. */
  readonly cabecalho: readonly string[];
  readonly amostras: readonly AmostraDeCaptura[];
}

/**
 * Lê um arquivo de captura inteiro.
 *
 * Linha defeituosa é **erro com número de linha**, não descarte silencioso: uma captura pela
 * metade produziria um teste que passa medindo menos movimento do que o gravado.
 *
 * @throws {ErroDeCaptura} arquivo ausente, cabeçalho errado, linha malformada ou zero amostras.
 */
export function lerCaptura(caminho: string): Captura {
  let conteudo: string;
  try {
    conteudo = readFileSync(caminho, 'utf8');
  } catch (erro) {
    throw new ErroDeCaptura(`não consegui ler a captura ${caminho}: ${(erro as Error).message}`);
  }

  const linhas = conteudo.split(/\r?\n/);
  if ((linhas[0] ?? '').trim() !== CABECALHO_DE_CAPTURA) {
    throw new ErroDeCaptura(
      `${caminho} não parece uma captura: a primeira linha precisa ser "${CABECALHO_DE_CAPTURA}"`,
    );
  }

  const cabecalho: string[] = [];
  const amostras: AmostraDeCaptura[] = [];
  for (let indice = 0; indice < linhas.length; indice += 1) {
    const linha = linhas[indice] ?? '';
    const limpa = linha.trim();
    if (limpa.startsWith('#')) {
      cabecalho.push(limpa.slice(1).trim());
      continue;
    }
    const lida = interpretarLinhaDeCaptura(linha);
    if (lida.tipo === 'ignorada') continue;
    if (lida.tipo === 'invalida') {
      throw new ErroDeCaptura(`${caminho}:${indice + 1} — ${lida.motivo}`);
    }
    amostras.push(lida.amostra);
  }

  if (amostras.length === 0) {
    throw new ErroDeCaptura(`${caminho} não tem nenhuma amostra para reproduzir`);
  }

  return { caminho, cabecalho, amostras };
}

export interface OpcoesDoGravador {
  /** Caminho do arquivo. A pasta é criada se não existir. */
  readonly caminho: string;
  /** Amostras em memória antes de cada escrita. */
  readonly capacidade?: number | undefined;
  /** Linhas extras de comentário no topo (sem o `#`), para contexto da captura. */
  readonly cabecalho?: readonly string[] | undefined;
}

export interface GravadorDeCaptura {
  readonly caminho: string;
  /** Quantas amostras já foram aceitas (contando as que ainda estão no buffer). */
  readonly amostrasGravadas: number;
  /** ⚠️ Caminho quente. Guarda a amostra; ignora pacote que não seja MOVIMENTO. */
  registrar(pacote: PacoteDecodificado): void;
  /** Escreve em disco o que está no buffer. Chamada em bloco, nunca por pacote. */
  descarregar(): void;
  /** Descarrega e fecha o arquivo. Idempotente — é o caminho de soltura do encerramento. */
  fechar(): void;
}

/**
 * Abre o arquivo e devolve o gravador.
 *
 * O arquivo é aberto **na criação**, e não no primeiro pacote: se o caminho estiver errado
 * (pasta sem permissão, disco cheio), o servidor precisa saber disso na partida, e não depois
 * de uma sessão inteira de gravação perdida.
 *
 * **Arquivo existente não é sobrescrito** (`wx`, e não `w`). Uma captura é sessão de aparelho
 * real: irreprodutível por definição. Trocar `w` por `wx` custa uma mensagem de erro a quem
 * repetiu o comando; deixar `w` custa a captura de ontem a quem reiniciou o servidor, errou a
 * porta ou rodou duas vezes com a mesma variável — e sem aviso nenhum.
 *
 * @throws {ErroDeCaptura} arquivo já existe.
 * @throws erro do sistema de arquivos nos demais casos (pasta sem permissão, disco cheio).
 */
export function criarGravadorDeCaptura(opcoes: OpcoesDoGravador): GravadorDeCaptura {
  const capacidade = Math.max(1, Math.trunc(opcoes.capacidade ?? CAPACIDADE_PADRAO_DO_GRAVADOR));
  const buffer = new Float64Array(capacidade * CAMPOS_POR_AMOSTRA);
  let noBuffer = 0;
  let total = 0;
  let fechado = false;

  mkdirSync(dirname(opcoes.caminho), { recursive: true });
  let descritor: number;
  try {
    descritor = openSync(opcoes.caminho, 'wx');
  } catch (erro) {
    if ((erro as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ErroDeCaptura(
        `${opcoes.caminho} já existe e uma captura nunca é sobrescrita (sessão de aparelho não ` +
          'se repete). Escolha outro caminho, ou apague o arquivo se ele não serve mais.',
      );
    }
    throw erro;
  }

  const topo = [CABECALHO_DE_CAPTURA];
  for (const linha of opcoes.cabecalho ?? []) topo.push(`# ${linha}`);
  topo.push(LINHA_DE_CAMPOS);
  writeSync(descritor, `${topo.join('\n')}\n`);

  function descarregar(): void {
    if (fechado || noBuffer === 0) return;
    const linhas: string[] = [];
    for (let indice = 0; indice < noBuffer; indice += 1) {
      const base = indice * CAMPOS_POR_AMOSTRA;
      const flags = buffer[base + 1] ?? 0;
      linhas.push(
        formatarAmostraDeCaptura({
          seq: buffer[base] ?? 0,
          flags,
          tDispositivoMs: buffer[base + 2] ?? 0,
          dtMs: buffer[base + 3] ?? 0,
          gx: buffer[base + 4] ?? 0,
          gy: buffer[base + 5] ?? 0,
          gz: buffer[base + 6] ?? 0,
          temAcelerometro: (flags & FLAG_ACELEROMETRO) !== 0,
          ax: buffer[base + 7] ?? 0,
          ay: buffer[base + 8] ?? 0,
          az: buffer[base + 9] ?? 0,
        }),
      );
    }
    // Escreve antes de zerar o buffer: se a escrita falhar (disco cheio), as amostras
    // continuam lá para a próxima tentativa, em vez de sumirem como se tivessem sido gravadas.
    writeSync(descritor, `${linhas.join('\n')}\n`);
    noBuffer = 0;
  }

  return {
    caminho: opcoes.caminho,
    get amostrasGravadas() {
      return total;
    },

    registrar(pacote) {
      if (fechado || pacote.tipo !== TIPO_MOVIMENTO) return;
      const base = noBuffer * CAMPOS_POR_AMOSTRA;
      buffer[base] = pacote.seq;
      buffer[base + 1] = pacote.flags;
      buffer[base + 2] = pacote.tDispositivoMs;
      buffer[base + 3] = pacote.dtMs;
      buffer[base + 4] = pacote.gx;
      buffer[base + 5] = pacote.gy;
      buffer[base + 6] = pacote.gz;
      buffer[base + 7] = pacote.ax;
      buffer[base + 8] = pacote.ay;
      buffer[base + 9] = pacote.az;
      noBuffer += 1;
      total += 1;
      if (noBuffer === capacidade) descarregar();
    },

    descarregar,

    fechar() {
      if (fechado) return;
      descarregar();
      fechado = true;
      closeSync(descritor);
    },
  };
}
