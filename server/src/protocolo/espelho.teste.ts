/**
 * Guarda automática do espelho servidor ⇄ app.
 *
 * O codec existe escrito duas vezes de propósito (o app não compartilha build com o servidor
 * na v1). O risco dessa duplicação é sempre o mesmo: alguém corrige um offset de um lado só,
 * e a divergência só aparece quando o cursor anda errado no PC de alguém.
 *
 * Este teste lê `app/src/transporte/protocolo.ts` **como texto** e confere que as constantes
 * declaradas lá são exatamente as daqui. Não é elegante, mas é o único jeito de amarrar dois
 * pacotes que não se importam — e é barato, roda em milissegundos.
 *
 * O que ele NÃO cobre: a lógica de leitura/escrita. Disso cuidam os vetores de bytes fixos,
 * que existem idênticos em `binario.teste.ts` e em `app/__tests__/protocolo.test.ts`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  CODIGOS_DE_AVISO,
  CODIGOS_DE_ERRO,
  COMANDOS,
  ESPACOS_DE_GIRO,
  SISTEMAS_DE_APARELHO,
  TRANSPORTES,
  VERSAO_PROTOCOLO,
} from './sessao.js';
import { criarDecodificador } from './binario.js';
import {
  ESTADO_PRESSIONADO,
  FLAG_ACELEROMETRO,
  FLAG_GATILHO_GIRO,
  FLAG_PRIMEIRA_APOS_RETOMAR,
  PADROES_HAPTICOS,
  RESULTADO_DECODIFICACAO,
  SEQ_MAXIMO,
  TAMANHO_BOTAO,
  TAMANHO_EIXO,
  TAMANHO_HAPTICO,
  TAMANHO_MAXIMO_PACOTE,
  TAMANHO_MOVIMENTO,
  TAMANHO_MOVIMENTO_COM_ACELEROMETRO,
  TAMANHO_RUMBLE,
  TAMANHO_SCROLL,
  TIPO_BOTAO,
  TIPO_EIXO,
  TIPO_HAPTICO,
  TIPO_MOVIMENTO,
  TIPO_RUMBLE,
  TIPO_SCROLL,
} from './tipos.js';

const CAMINHO_DO_ESPELHO = fileURLToPath(
  new URL('../../../app/src/transporte/protocolo.ts', import.meta.url),
);
const CAMINHO_DO_BINARIO = fileURLToPath(new URL('./binario.ts', import.meta.url));
const CAMINHO_DO_PROTOCOLO = fileURLToPath(
  new URL('../../../docs/PROTOCOLO.md', import.meta.url),
);

const espelho = readFileSync(CAMINHO_DO_ESPELHO, 'utf8');
const binario = readFileSync(CAMINHO_DO_BINARIO, 'utf8');
const protocolo = readFileSync(CAMINHO_DO_PROTOCOLO, 'utf8');

/** Resolve um literal numérico do espelho (`0x81`, `0b0000_0001`, `24`) ou um apelido. */
function avaliar(expressao: string): number {
  const texto = expressao.trim();
  if (/^0x[0-9a-f]+$/i.test(texto)) return Number.parseInt(texto.slice(2), 16);
  if (/^0b[01_]+$/.test(texto)) return Number.parseInt(texto.slice(2).replace(/_/g, ''), 2);
  if (/^\d+$/.test(texto)) return Number(texto);
  if (/^[A-Z][A-Z0-9_]*$/.test(texto)) return numeroDoEspelho(texto);
  throw new Error(`expressão não reconhecida no espelho: ${texto}`);
}

/** Valor de `export const NOME = ...;` no arquivo do app. */
function numeroDoEspelho(nome: string): number {
  const achado = new RegExp(`^export const ${nome} = ([^;\\n]+);$`, 'm').exec(espelho);
  if (achado === null) throw new Error(`o app não declara a constante ${nome}`);
  return avaliar(achado[1] ?? '');
}

/** Itens de `export const NOME = [...] as const;` no arquivo do app. */
function listaDoEspelho(nome: string): string[] {
  const achado = new RegExp(`export const ${nome} = \\[([\\s\\S]*?)\\] as const;`).exec(espelho);
  if (achado === null) throw new Error(`o app não declara a lista ${nome}`);
  const corpo = achado[1] ?? '';
  return [...corpo.matchAll(/'([^']*)'/g)].map((item) => item[1] ?? '');
}

/** Pares de `export const NOME = Object.freeze({...} as const);` no arquivo do app. */
function mapaDoEspelho(nome: string): Record<string, number> {
  const achado = new RegExp(
    `export const ${nome} = Object\\.freeze\\(\\{([\\s\\S]*?)\\} as const\\);`,
  ).exec(espelho);
  if (achado === null) throw new Error(`o app não declara o mapa ${nome}`);
  const corpo = achado[1] ?? '';
  const pares: Record<string, number> = {};
  for (const item of corpo.matchAll(/(\w+):\s*(\d+),/g)) {
    pares[item[1] ?? ''] = Number(item[2]);
  }
  return pares;
}

describe('o app espelha as constantes do protocolo', () => {
  it('códigos de tipo', () => {
    assert.equal(numeroDoEspelho('TIPO_MOVIMENTO'), TIPO_MOVIMENTO);
    assert.equal(numeroDoEspelho('TIPO_BOTAO'), TIPO_BOTAO);
    assert.equal(numeroDoEspelho('TIPO_EIXO'), TIPO_EIXO);
    assert.equal(numeroDoEspelho('TIPO_SCROLL'), TIPO_SCROLL);
    assert.equal(numeroDoEspelho('TIPO_RUMBLE'), TIPO_RUMBLE);
    assert.equal(numeroDoEspelho('TIPO_HAPTICO'), TIPO_HAPTICO);
  });

  it('tamanhos de pacote', () => {
    assert.equal(numeroDoEspelho('TAMANHO_MOVIMENTO'), TAMANHO_MOVIMENTO);
    assert.equal(
      numeroDoEspelho('TAMANHO_MOVIMENTO_COM_ACELEROMETRO'),
      TAMANHO_MOVIMENTO_COM_ACELEROMETRO,
    );
    assert.equal(numeroDoEspelho('TAMANHO_BOTAO'), TAMANHO_BOTAO);
    assert.equal(numeroDoEspelho('TAMANHO_EIXO'), TAMANHO_EIXO);
    assert.equal(numeroDoEspelho('TAMANHO_SCROLL'), TAMANHO_SCROLL);
    assert.equal(numeroDoEspelho('TAMANHO_RUMBLE'), TAMANHO_RUMBLE);
    assert.equal(numeroDoEspelho('TAMANHO_HAPTICO'), TAMANHO_HAPTICO);
    assert.equal(numeroDoEspelho('TAMANHO_MAXIMO_PACOTE'), TAMANHO_MAXIMO_PACOTE);
  });

  it('bits de flags e limite de seq', () => {
    assert.equal(numeroDoEspelho('FLAG_ACELEROMETRO'), FLAG_ACELEROMETRO);
    assert.equal(numeroDoEspelho('FLAG_GATILHO_GIRO'), FLAG_GATILHO_GIRO);
    assert.equal(numeroDoEspelho('FLAG_PRIMEIRA_APOS_RETOMAR'), FLAG_PRIMEIRA_APOS_RETOMAR);
    assert.equal(numeroDoEspelho('SEQ_MAXIMO'), SEQ_MAXIMO);
    assert.equal(numeroDoEspelho('ESTADO_PRESSIONADO'), ESTADO_PRESSIONADO);
  });

  it('versão do protocolo', () => {
    assert.equal(numeroDoEspelho('VERSAO_PROTOCOLO'), VERSAO_PROTOCOLO);
  });

  it('padrões hápticos e códigos de resultado', () => {
    assert.deepEqual(mapaDoEspelho('PADROES_HAPTICOS'), { ...PADROES_HAPTICOS });
    assert.deepEqual(mapaDoEspelho('RESULTADO_DECODIFICACAO'), { ...RESULTADO_DECODIFICACAO });
  });

  it('listas de valores das mensagens de sessão', () => {
    assert.deepEqual(listaDoEspelho('CODIGOS_DE_ERRO'), [...CODIGOS_DE_ERRO]);
    assert.deepEqual(listaDoEspelho('COMANDOS'), [...COMANDOS]);
    assert.deepEqual(listaDoEspelho('SISTEMAS_DE_APARELHO'), [...SISTEMAS_DE_APARELHO]);
    assert.deepEqual(listaDoEspelho('TRANSPORTES'), [...TRANSPORTES]);
    assert.deepEqual(listaDoEspelho('ESPACOS_DE_GIRO'), [...ESPACOS_DE_GIRO]);
    assert.deepEqual(listaDoEspelho('CODIGOS_DE_AVISO'), [...CODIGOS_DE_AVISO]);
  });

  it('cada código de aviso está na tabela do PROTOCOLO.md (seção 3.8)', () => {
    // Código de aviso que o documento não cita é aviso que quem escrever um cliente novo não sabe
    // que existe — e o quadro de texto é estrito: código desconhecido é recusa.
    for (const codigo of CODIGOS_DE_AVISO) {
      assert.ok(protocolo.includes(`\`${codigo}\``), `o PROTOCOLO.md não cita o aviso \`${codigo}\``);
    }
  });
});

describe('os contadores usam os nomes da tabela da seção 7 do PROTOCOLO.md', () => {
  /** Campos de `export type ContadoresDoCodec = { ... };` no arquivo do app. */
  function contadoresDoEspelho(): string[] {
    const achado = /export type ContadoresDoCodec = \{([\s\S]*?)\n\};/.exec(espelho);
    if (achado === null) throw new Error('o app não declara ContadoresDoCodec');
    return [...(achado[1] ?? '').matchAll(/^ {2}(\w+): number;$/gm)].map((item) => item[1] ?? '');
  }

  const nomes = Object.keys(criarDecodificador().contadores);

  it('cada contador do servidor aparece na tabela do documento', () => {
    // O documento é a fonte da verdade; obrigar a telemetria da ATI-005 a traduzir nome é
    // divergência barata de evitar hoje e cara de descobrir depois.
    for (const nome of nomes) {
      assert.ok(
        protocolo.includes(`\`${nome}\``),
        `o PROTOCOLO.md não cita o contador \`${nome}\` na seção 7`,
      );
    }
  });

  it('o app declara exatamente os mesmos contadores', () => {
    assert.deepEqual(contadoresDoEspelho(), nomes);
  });
});

describe('little-endian é explícito nos dois lados', () => {
  /** Toda linha com acesso multibyte precisa citar `LITTLE_ENDIAN` — u8 não tem ordem. */
  function linhasSemEndianness(fonte: string): string[] {
    return fonte
      .split('\n')
      .filter((linha) => /\.(get|set)(Uint16|Uint32|Float32)\(/.test(linha))
      .filter((linha) => !linha.includes('LITTLE_ENDIAN'));
  }

  it('o servidor não deixa nenhum acesso multibyte sem endianness', () => {
    assert.deepEqual(linhasSemEndianness(binario), []);
    assert.ok(binario.includes('const LITTLE_ENDIAN = true;'));
  });

  it('o app não deixa nenhum acesso multibyte sem endianness', () => {
    assert.deepEqual(linhasSemEndianness(espelho), []);
    assert.ok(espelho.includes('const LITTLE_ENDIAN = true;'));
  });
});
