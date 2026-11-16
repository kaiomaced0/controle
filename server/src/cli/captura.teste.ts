/**
 * Teste do formato de captura: o que o servidor grava tem de voltar **igual** no simulador.
 *
 * Se a ida e a volta não forem exatas, um teste que reproduz captura mede outra coisa e ninguém
 * fica sabendo — é o pior defeito possível numa ferramenta de verificação.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  FLAG_ACELEROMETRO,
  TIPO_BOTAO,
  TIPO_MOVIMENTO,
  criarPacoteDecodificado,
} from '../protocolo/indice.js';
import {
  CABECALHO_DE_CAPTURA,
  ErroDeCaptura,
  criarGravadorDeCaptura,
  formatarAmostraDeCaptura,
  interpretarLinhaDeCaptura,
  lerCaptura,
  type AmostraDeCaptura,
} from './captura.js';

const pastaTemporaria = mkdtempSync(join(tmpdir(), 'controle-captura-'));

after(() => {
  rmSync(pastaTemporaria, { recursive: true, force: true });
});

function caminhoDeTeste(nome: string): string {
  return join(pastaTemporaria, nome);
}

/** Pacote decodificado de mentira, no formato que o servidor entrega ao gravador. */
function pacoteDeMovimento(valores: Partial<AmostraDeCaptura>) {
  const pacote = criarPacoteDecodificado();
  pacote.tipo = TIPO_MOVIMENTO;
  pacote.seq = valores.seq ?? 0;
  pacote.flags = valores.flags ?? 0;
  pacote.tDispositivoMs = valores.tDispositivoMs ?? 0;
  pacote.dtMs = valores.dtMs ?? 0;
  pacote.gx = valores.gx ?? 0;
  pacote.gy = valores.gy ?? 0;
  pacote.gz = valores.gz ?? 0;
  pacote.temAcelerometro = (pacote.flags & FLAG_ACELEROMETRO) !== 0;
  pacote.ax = valores.ax ?? 0;
  pacote.ay = valores.ay ?? 0;
  pacote.az = valores.az ?? 0;
  return pacote;
}

describe('formato de captura', () => {
  it('formata e relê a mesma amostra, com sinal, NaN e infinito preservados', () => {
    const amostra: AmostraDeCaptura = {
      seq: 65535,
      flags: 4,
      tDispositivoMs: 4294967295,
      dtMs: 9.99999,
      gx: -0.00312345678,
      gy: Number.NaN,
      gz: Number.POSITIVE_INFINITY,
      temAcelerometro: false,
      ax: 0,
      ay: 0,
      az: 0,
    };

    const linha = formatarAmostraDeCaptura(amostra);
    const lida = interpretarLinhaDeCaptura(linha);

    assert.equal(lida.tipo, 'amostra');
    if (lida.tipo !== 'amostra') return;
    assert.equal(lida.amostra.seq, amostra.seq);
    assert.equal(lida.amostra.tDispositivoMs, amostra.tDispositivoMs);
    assert.equal(lida.amostra.dtMs, amostra.dtMs);
    assert.equal(lida.amostra.gx, amostra.gx, 'o valor volta com todos os dígitos que importam');
    assert.ok(Number.isNaN(lida.amostra.gy));
    assert.equal(lida.amostra.gz, Number.POSITIVE_INFINITY);
  });

  it('sobrevive ao zero negativo, que String() jogaria fora', () => {
    const linha = formatarAmostraDeCaptura({
      seq: 1,
      flags: 0,
      tDispositivoMs: 10,
      dtMs: 10,
      gx: -0,
      gy: 0,
      gz: 0,
      temAcelerometro: false,
      ax: 0,
      ay: 0,
      az: 0,
    });
    const lida = interpretarLinhaDeCaptura(linha);
    assert.equal(lida.tipo, 'amostra');
    if (lida.tipo !== 'amostra') return;
    assert.ok(Object.is(lida.amostra.gx, -0));
  });

  it('trata comentário e linha em branco como ignoradas', () => {
    assert.equal(interpretarLinhaDeCaptura('   ').tipo, 'ignorada');
    assert.equal(interpretarLinhaDeCaptura('# qualquer coisa').tipo, 'ignorada');
  });

  it('recusa linha com número de campos errado e campo que não é número', () => {
    assert.equal(interpretarLinhaDeCaptura('1 0 10 10 0.1').tipo, 'invalida');
    assert.equal(interpretarLinhaDeCaptura('1 0 10 10 0.1 oi 0.3').tipo, 'invalida');
  });

  it('exige ax/ay/az exatamente quando o bit0 de flags está ligado', () => {
    // bit0 ligado e só 7 campos: o pacote no fio teria 36 bytes e a captura só descreve 24.
    assert.equal(interpretarLinhaDeCaptura('1 1 10 10 0.1 0.2 0.3').tipo, 'invalida');
    // bit0 desligado e 10 campos: o contrário do mesmo defeito.
    assert.equal(interpretarLinhaDeCaptura('1 0 10 10 0.1 0.2 0.3 0 0 9.8').tipo, 'invalida');
    assert.equal(interpretarLinhaDeCaptura('1 1 10 10 0.1 0.2 0.3 0 0 9.8').tipo, 'amostra');
  });
});

describe('gravador de captura', () => {
  it('grava cabeçalho, descarrega em bloco e relê o que gravou', () => {
    const caminho = caminhoDeTeste('sessao.captura');
    const gravador = criarGravadorDeCaptura({
      caminho,
      capacidade: 4,
      cabecalho: ['origem=teste taxaHz=100'],
    });

    for (let indice = 0; indice < 10; indice += 1) {
      gravador.registrar(
        pacoteDeMovimento({
          seq: indice,
          flags: indice === 0 ? 4 : 0,
          tDispositivoMs: 60000 + indice * 10,
          dtMs: indice === 0 ? 0 : 10,
          gx: indice * 0.001,
          gy: -indice * 0.002,
          gz: 0.0005,
        }),
      );
    }
    gravador.fechar();

    const conteudo = readFileSync(caminho, 'utf8');
    assert.ok(conteudo.startsWith(CABECALHO_DE_CAPTURA), 'a primeira linha identifica o formato');
    assert.match(conteudo, /# origem=teste taxaHz=100/);

    const captura = lerCaptura(caminho);
    assert.equal(captura.amostras.length, 10);
    assert.equal(gravador.amostrasGravadas, 10);
    assert.equal(captura.amostras[0]?.dtMs, 0);
    assert.equal(captura.amostras[0]?.flags, 4);
    assert.equal(captura.amostras[9]?.seq, 9);
    assert.equal(captura.amostras[9]?.tDispositivoMs, 60090);
    assert.equal(captura.amostras[9]?.gy, -0.018);
  });

  it('ignora pacote que não é MOVIMENTO — captura é de sensor, não de botão', () => {
    const caminho = caminhoDeTeste('so-movimento.captura');
    const gravador = criarGravadorDeCaptura({ caminho });
    const botao = criarPacoteDecodificado();
    botao.tipo = TIPO_BOTAO;
    botao.seq = 1;
    botao.pressionado = true;

    gravador.registrar(botao);
    gravador.registrar(pacoteDeMovimento({ seq: 2, dtMs: 10, gx: 0.1 }));
    gravador.fechar();

    const captura = lerCaptura(caminho);
    assert.equal(captura.amostras.length, 1);
    assert.equal(captura.amostras[0]?.seq, 2);
  });

  it('não sobrescreve captura que já existe — nem uma linha dela', () => {
    const caminho = caminhoDeTeste('preciosa.captura');
    const original = `${CABECALHO_DE_CAPTURA}\n# sessão do aparelho de ontem\n1 0 10 10 0.1 0.2 0.3\n`;
    writeFileSync(caminho, original, 'utf8');

    // Sessão de aparelho real não se repete: sobrescrever é perder o dado que a gravação existe
    // para guardar. Tem de falhar **antes** de abrir, e não truncar e reclamar depois.
    assert.throws(
      () => criarGravadorDeCaptura({ caminho }),
      (erro: unknown) => erro instanceof ErroDeCaptura && erro.message.includes('já existe'),
    );
    assert.equal(readFileSync(caminho, 'utf8'), original, 'o arquivo ficou intacto');
    assert.equal(lerCaptura(caminho).amostras.length, 1);
  });

  it('fechar duas vezes não estoura', () => {
    const caminho = caminhoDeTeste('fecha-duas-vezes.captura');
    const gravador = criarGravadorDeCaptura({ caminho });
    gravador.registrar(pacoteDeMovimento({ seq: 1, dtMs: 10 }));
    gravador.fechar();
    gravador.fechar();
    assert.equal(lerCaptura(caminho).amostras.length, 1);
  });
});

describe('leitura de captura', () => {
  it('recusa arquivo sem o cabeçalho do formato', () => {
    const caminho = caminhoDeTeste('sem-cabecalho.captura');
    const gravador = criarGravadorDeCaptura({ caminho });
    gravador.fechar();
    // Reescreve sem o cabeçalho, à mão.
    const outro = caminhoDeTeste('cru.txt');
    const conteudo = '1 0 10 10 0.1 0.2 0.3\n';
    writeFileSync(outro, conteudo, 'utf8');

    assert.throws(() => lerCaptura(outro), ErroDeCaptura);
  });

  it('aponta a linha defeituosa em vez de descartar em silêncio', () => {
    const caminho = caminhoDeTeste('defeituosa.captura');
    writeFileSync(caminho, `${CABECALHO_DE_CAPTURA}\n1 0 10 10 0.1 0.2 0.3\nlixo aqui\n`, 'utf8');

    assert.throws(
      () => lerCaptura(caminho),
      (erro: unknown) => erro instanceof ErroDeCaptura && erro.message.includes(':3'),
    );
  });

  it('recusa captura vazia — reproduzir nada não é reproduzir', () => {
    const caminho = caminhoDeTeste('vazia.captura');
    writeFileSync(caminho, `${CABECALHO_DE_CAPTURA}\n# só cabeçalho\n`);
    assert.throws(() => lerCaptura(caminho), ErroDeCaptura);
  });

  it('recusa arquivo que não existe', () => {
    assert.throws(() => lerCaptura(caminhoDeTeste('nao-existe.captura')), ErroDeCaptura);
  });
});

