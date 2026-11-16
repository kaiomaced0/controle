/**
 * O bias guardado por aparelho (ATI-009): ele atravessa reconexões, e **arquivo estragado não
 * derruba o servidor**.
 *
 * A segunda metade é a que este arquivo mais vigia. Um cache de bias é a última coisa do mundo
 * pela qual alguém pode perder a sessão do celular que está na mão — então JSON quebrado, versão
 * de outro esquema, número que virou texto e bias absurdo têm de virar contador e aviso, nunca
 * exceção.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  MAXIMO_DE_APARELHOS,
  VERSAO_DO_ARQUIVO,
  criarRepositorioDeBias,
} from './bias-guardado.js';

const pastaTemporaria = mkdtempSync(join(tmpdir(), 'controle-bias-'));
let proximo = 0;

after(() => {
  rmSync(pastaTemporaria, { recursive: true, force: true });
});

/** Um caminho novo a cada uso: nenhum teste enxerga o arquivo do outro. */
function caminhoNovo(nome = 'bias.json'): string {
  proximo += 1;
  return join(pastaTemporaria, `r${proximo}`, nome);
}

describe('bias guardado — o caminho normal', () => {
  it('grava e devolve o bias do mesmo aparelho', () => {
    const caminho = caminhoNovo();
    const repositorio = criarRepositorioDeBias({ caminho });

    assert.equal(repositorio.ler('a1b2c3'), undefined, 'aparelho novo não tem bias guardado');
    assert.equal(repositorio.gravar('a1b2c3', { gx: 0.0031, gy: -0.0007, gz: 0.0012 }, 120), true);

    const lido = repositorio.ler('a1b2c3');
    assert.equal(lido?.gx, 0.0031);
    assert.equal(lido?.gy, -0.0007);
    assert.equal(lido?.gz, 0.0012);
    assert.equal(lido?.amostras, 120);
    assert.match(lido?.gravadoEm ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(repositorio.contadores.gravacoes, 1);
  });

  it('o bias sobrevive ao processo: outra instância lê o mesmo arquivo', () => {
    // É este o critério de aceite "bias persiste entre reconexões do mesmo aparelho": a segunda
    // instância é o servidor de amanhã, sem nenhuma memória da primeira.
    const caminho = caminhoNovo();
    criarRepositorioDeBias({ caminho }).gravar('pixel-7', { gx: 0.004, gy: 0.001, gz: -0.002 }, 120);

    const outro = criarRepositorioDeBias({ caminho });

    assert.deepEqual(outro.ler('pixel-7'), {
      gx: 0.004,
      gy: 0.001,
      gz: -0.002,
      amostras: 120,
      gravadoEm: outro.ler('pixel-7')?.gravadoEm ?? '',
    });
    assert.equal(outro.ler('outro-aparelho'), undefined, 'cada aparelho tem o seu');
  });

  it('cria a pasta que ainda não existe e não deixa arquivo temporário para trás', () => {
    const caminho = caminhoNovo();
    const repositorio = criarRepositorioDeBias({ caminho });

    assert.equal(repositorio.gravar('novo', { gx: 0.001, gy: 0, gz: 0 }, 90), true);

    assert.equal(existsSync(caminho), true);
    assert.equal(existsSync(`${caminho}.tmp`), false, 'a gravação atômica limpa o arquivo do meio');
    const conteudo = JSON.parse(readFileSync(caminho, 'utf8')) as Record<string, unknown>;
    assert.equal(conteudo['versao'], VERSAO_DO_ARQUIVO);
  });

  it('guarda no máximo o teto de aparelhos, e quem sai é o mais antigo', () => {
    const caminho = caminhoNovo();
    const repositorio = criarRepositorioDeBias({ caminho, maximoDeAparelhos: 3 });

    for (const id of ['um', 'dois', 'tres']) {
      repositorio.gravar(id, { gx: 0.001, gy: 0, gz: 0 }, 60);
    }
    // Regravar o mais antigo o leva para o fim da fila: quem foi usado agora não é o velho.
    repositorio.gravar('um', { gx: 0.002, gy: 0, gz: 0 }, 60);
    repositorio.gravar('quatro', { gx: 0.001, gy: 0, gz: 0 }, 60);

    assert.deepEqual(repositorio.aparelhos(), ['tres', 'um', 'quatro']);
    assert.equal(repositorio.ler('dois'), undefined, 'o mais antigo saiu quando o teto estourou');
    assert.equal(repositorio.ler('um')?.gx, 0.002);
  });

  it('o teto de fábrica é declarado, não improvisado', () => {
    assert.equal(MAXIMO_DE_APARELHOS, 32);
  });
});

describe('bias guardado — arquivo estragado não derruba nada', () => {
  it('JSON quebrado vira contador e leitura vazia', () => {
    const caminho = caminhoNovo();
    // A primeira gravação é quem cria a pasta; depois dela o arquivo é estragado à mão.
    criarRepositorioDeBias({ caminho }).gravar('qualquer', { gx: 0.001, gy: 0, gz: 0 }, 60);
    writeFileSync(caminho, '{"versao":1,"aparelhos":{ isso não é json', 'utf8');

    const outro = criarRepositorioDeBias({ caminho });

    assert.equal(outro.ler('qualquer'), undefined);
    assert.equal(outro.contadores.leiturasComDefeito, 1);
  });

  it('arquivo de outra versão é ignorado inteiro', () => {
    const caminho = caminhoNovo();
    criarRepositorioDeBias({ caminho }).gravar('x', { gx: 0.001, gy: 0, gz: 0 }, 60);
    writeFileSync(caminho, JSON.stringify({ versao: 99, aparelhos: { x: { gx: 1, gy: 1, gz: 1 } } }), 'utf8');

    const repositorio = criarRepositorioDeBias({ caminho });

    assert.equal(repositorio.ler('x'), undefined);
    assert.equal(repositorio.contadores.leiturasComDefeito, 1);
  });

  it('entrada com número imprestável ou bias absurdo é descartada, e as boas ficam', () => {
    const caminho = caminhoNovo();
    criarRepositorioDeBias({ caminho }).gravar('semente', { gx: 0.001, gy: 0, gz: 0 }, 60);
    writeFileSync(
      caminho,
      JSON.stringify({
        versao: VERSAO_DO_ARQUIVO,
        aparelhos: {
          bom: { gx: 0.003, gy: -0.001, gz: 0.002, amostras: 120, gravadoEm: '2026-08-23T00:00:00.000Z' },
          textoNoLugarDeNumero: { gx: '0.003', gy: 0, gz: 0 },
          foraDaFaixa: { gx: 42, gy: 0, gz: 0 },
          naoEObjeto: 7,
        },
      }),
      'utf8',
    );

    const repositorio = criarRepositorioDeBias({ caminho });

    assert.equal(repositorio.ler('bom')?.gx, 0.003);
    assert.equal(repositorio.ler('textoNoLugarDeNumero'), undefined);
    assert.equal(repositorio.ler('foraDaFaixa'), undefined, '42 rad/s não é bias de sensor nenhum');
    assert.equal(repositorio.ler('naoEObjeto'), undefined);
    assert.equal(repositorio.contadores.entradasIgnoradas, 3);
    assert.equal(repositorio.contadores.leiturasComDefeito, 0, 'o arquivo em si estava bem-formado');
  });

  it('bias imprestável não vai para o disco', () => {
    const caminho = caminhoNovo();
    const repositorio = criarRepositorioDeBias({ caminho });

    assert.equal(repositorio.gravar('x', { gx: Number.NaN, gy: 0, gz: 0 }, 60), false);
    assert.equal(repositorio.gravar('x', { gx: 5, gy: 0, gz: 0 }, 60), false, 'fora da faixa de bias');
    assert.equal(repositorio.gravar('', { gx: 0.001, gy: 0, gz: 0 }, 60), false, 'id vazio não é id');
    assert.equal(repositorio.contadores.gravacoes, 0);
    assert.equal(existsSync(caminho), false, 'nem o arquivo chegou a nascer');
  });

  it('pasta impossível vira contador, não exceção', () => {
    // O "diretório" é um arquivo: `mkdir` falha com ENOTDIR, que é o que uma pasta somente
    // leitura produziria na máquina de quem usa.
    const arquivoNoLugarDaPasta = join(pastaTemporaria, 'nao-sou-pasta');
    writeFileSync(arquivoNoLugarDaPasta, 'x', 'utf8');
    const repositorio = criarRepositorioDeBias({
      caminho: join(arquivoNoLugarDaPasta, 'dentro', 'bias.json'),
    });

    assert.equal(repositorio.gravar('x', { gx: 0.001, gy: 0, gz: 0 }, 60), false);
    assert.equal(repositorio.contadores.gravacoesComErro, 1);
    // E a sessão segue: ler continua funcionando (e devolvendo nada).
    assert.equal(repositorio.ler('x')?.gx, 0.001, 'o valor vale nesta sessão, só não foi ao disco');
  });
});
