/**
 * Teste do log.
 *
 * O que realmente importa aqui é o **filtro de nível**: é ele que torna aplicável a regra 2
 * do CLAUDE.md ("zero log por pacote no caminho quente"). A partir da ATI-006 o código de
 * 100 Hz consulta `habilitado()` e conta com o descarte por severidade para não pagar nada;
 * uma regressão silenciosa na comparação devolveria escrita em stderr para dentro do
 * caminho quente. Por isso o filtro é testado nos dois sentidos — o que sai e o que **não**
 * sai — para todas as combinações de nível.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { criarRegistrador, ehNivelLog, NIVEIS_LOG, type NivelLog } from './log.js';

/** Registrador que guarda as linhas em vez de escrever em stderr. */
function registradorDeTeste(
  nivel: NivelLog,
  escopo = '',
): { registrador: ReturnType<typeof criarRegistrador>; linhas: string[] } {
  const linhas: string[] = [];
  const registrador = criarRegistrador(nivel, escopo, (linha) => {
    linhas.push(linha);
  });
  return { registrador, linhas };
}

/** Chama o método correspondente ao nível, sem `any` e sem `switch`. */
function emitir(
  registrador: ReturnType<typeof criarRegistrador>,
  nivel: NivelLog,
  mensagem: string,
): void {
  registrador[nivel](mensagem);
}

/** Severidade esperada, escrita à mão de propósito: se o módulo mudar, o teste discorda. */
const ORDEM_ESPERADA: readonly NivelLog[] = ['erro', 'aviso', 'info', 'depuracao'];

describe('filtro de nível', () => {
  it('a lista de níveis é a esperada, do mais grave para o mais verboso', () => {
    assert.deepEqual([...NIVEIS_LOG], [...ORDEM_ESPERADA]);
  });

  it('deixa passar o que é igual ou mais grave e descarta o resto', () => {
    for (const nivelDoRegistrador of ORDEM_ESPERADA) {
      for (const nivelDaLinha of ORDEM_ESPERADA) {
        const { registrador, linhas } = registradorDeTeste(nivelDoRegistrador);
        emitir(registrador, nivelDaLinha, 'mensagem');

        const deveriaSair =
          ORDEM_ESPERADA.indexOf(nivelDaLinha) <= ORDEM_ESPERADA.indexOf(nivelDoRegistrador);
        assert.equal(
          linhas.length,
          deveriaSair ? 1 : 0,
          `registrador ${nivelDoRegistrador} + linha ${nivelDaLinha}`,
        );
      }
    }
  });

  it('um registrador "info" não escreve NADA em depuracao (é o caminho quente)', () => {
    const { registrador, linhas } = registradorDeTeste('info');

    registrador.depuracao('pacote recebido', { seq: 1234 });
    registrador.depuracao('pacote recebido', { seq: 1235 });

    assert.deepEqual(linhas, [], 'nenhuma escrita, nem parcial');
  });

  it('um registrador "erro" descarta aviso, info e depuracao', () => {
    const { registrador, linhas } = registradorDeTeste('erro');

    registrador.aviso('a');
    registrador.info('b');
    registrador.depuracao('c');
    assert.deepEqual(linhas, []);

    registrador.erro('d');
    assert.equal(linhas.length, 1);
  });

  it('guarda o nível e o escopo com que foi criado', () => {
    const { registrador } = registradorDeTeste('aviso', 'transporte');
    assert.equal(registrador.nivel, 'aviso');
    assert.equal(registrador.escopo, 'transporte');
  });
});

describe('habilitado', () => {
  it('responde exatamente o que o filtro faz, para toda combinação', () => {
    for (const nivelDoRegistrador of ORDEM_ESPERADA) {
      for (const nivelConsultado of ORDEM_ESPERADA) {
        const { registrador, linhas } = registradorDeTeste(nivelDoRegistrador);
        const resposta = registrador.habilitado(nivelConsultado);
        emitir(registrador, nivelConsultado, 'mensagem');

        assert.equal(
          resposta,
          linhas.length === 1,
          `habilitado(${nivelConsultado}) mentiu num registrador ${nivelDoRegistrador}`,
        );
      }
    }
  });

  it('permite pular o trabalho caro antes de montar a mensagem', () => {
    const { registrador, linhas } = registradorDeTeste('info');
    let montou = 0;

    if (registrador.habilitado('depuracao')) {
      montou += 1;
      registrador.depuracao('resumo caro');
    }

    assert.equal(montou, 0, 'nem chegou a montar a mensagem');
    assert.deepEqual(linhas, []);
  });
});

describe('formato da linha', () => {
  it('carimbo ISO, rótulo, escopo entre colchetes e mensagem, uma linha só', () => {
    const { registrador, linhas } = registradorDeTeste('info', 'servidor');

    registrador.info('servidor Controle iniciando');

    assert.equal(linhas.length, 1);
    const linha = linhas[0] ?? '';
    assert.match(
      linha,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO {2}\[servidor\] servidor Controle iniciando\n$/,
    );
  });

  it('sem escopo, não sobra colchete vazio nem espaço duplo', () => {
    const { registrador, linhas } = registradorDeTeste('info');

    registrador.info('sem escopo');

    assert.equal(linhas[0]?.includes('['), false);
    assert.match(linhas[0] ?? '', / INFO {2}sem escopo\n$/);
  });

  it('cada nível tem seu rótulo de largura fixa', () => {
    const rotulos: Record<NivelLog, string> = {
      erro: 'ERRO ',
      aviso: 'AVISO',
      info: 'INFO ',
      depuracao: 'DEBUG',
    };

    for (const nivel of ORDEM_ESPERADA) {
      const { registrador, linhas } = registradorDeTeste('depuracao');
      emitir(registrador, nivel, 'x');
      assert.equal(linhas[0]?.includes(` ${rotulos[nivel]} x\n`), true, nivel);
    }
  });

  it('uma chamada é uma linha, sempre terminada em \\n', () => {
    const { registrador, linhas } = registradorDeTeste('depuracao', 'x');

    registrador.erro('a');
    registrador.depuracao('b', { c: 1 });

    assert.equal(linhas.length, 2);
    for (const linha of linhas) {
      assert.equal(linha.endsWith('\n'), true);
      assert.equal(linha.slice(0, -1).includes('\n'), false, 'nada de quebra no meio');
    }
  });
});

describe('formatação de chave=valor', () => {
  /** Devolve só o trecho de dados da linha (o que vem depois da mensagem). */
  function dadosDaLinha(dados: Readonly<Record<string, unknown>>): string {
    const { registrador, linhas } = registradorDeTeste('depuracao');
    registrador.info('msg', dados);
    const linha = (linhas[0] ?? '').replace(/\n$/, '');
    return linha.slice(linha.indexOf(' msg ') + ' msg '.length);
  }

  it('texto sem espaço vai cru; com espaço ou aspas, vai entre aspas', () => {
    assert.equal(dadosDaLinha({ host: '127.0.0.1' }), 'host=127.0.0.1');
    assert.equal(dadosDaLinha({ motivo: 'sessão substituída' }), 'motivo="sessão substituída"');
    assert.equal(dadosDaLinha({ eco: 'diz "oi"' }), 'eco="diz \\"oi\\""');
    assert.equal(dadosDaLinha({ vazio: '' }), 'vazio=');
  });

  it('número, booleano e bigint saem como o valor', () => {
    assert.equal(dadosDaLinha({ porta: 8765 }), 'porta=8765');
    assert.equal(dadosDaLinha({ taxa: 99.5 }), 'taxa=99.5');
    assert.equal(dadosDaLinha({ ativo: true }), 'ativo=true');
    assert.equal(dadosDaLinha({ bytes: 10n }), 'bytes=10');
  });

  it('null e undefined aparecem, em vez de sumir da linha', () => {
    assert.equal(dadosDaLinha({ token: null }), 'token=null');
    assert.equal(dadosDaLinha({ token: undefined }), 'token=undefined');
  });

  it('Error vira "Nome: mensagem" entre aspas, sem despejar a pilha', () => {
    const erro = new TypeError('porta ocupada');
    const saida = dadosDaLinha({ erro });

    assert.equal(saida, 'erro="TypeError: porta ocupada"');
    assert.equal(saida.includes('at '), false, 'sem stack trace na linha');
  });

  it('objeto e vetor viram JSON', () => {
    assert.equal(dadosDaLinha({ gyro: { sensX: 35 } }), 'gyro={"sensX":35}');
    assert.equal(dadosDaLinha({ bias: [1, 2] }), 'bias=[1,2]');
  });

  it('valor que o JSON não dá conta não derruba o log', () => {
    const ciclico: Record<string, unknown> = { nome: 'sessao' };
    ciclico['eu'] = ciclico;

    assert.equal(dadosDaLinha({ sessao: ciclico }), 'sessao=[object não serializável]');
    assert.equal(
      dadosDaLinha({
        callback: () => undefined,
      }),
      'callback=[function]',
    );
  });

  it('mantém a ordem das chaves e aceita várias de uma vez', () => {
    assert.equal(
      dadosDaLinha({ versao: '0.1.0', node: '22.13.1', pid: 42 }),
      'versao=0.1.0 node=22.13.1 pid=42',
    );
  });

  it('sem dados, a linha termina na mensagem', () => {
    const { registrador, linhas } = registradorDeTeste('info');
    registrador.info('só a mensagem');
    assert.match(linhas[0] ?? '', /só a mensagem\n$/);
  });
});

describe('comEscopo', () => {
  it('troca o escopo e preserva nível e destino', () => {
    const { registrador, linhas } = registradorDeTeste('aviso', 'servidor');

    const filho = registrador.comEscopo('transporte');
    filho.aviso('conexão instável');

    assert.equal(filho.nivel, 'aviso');
    assert.equal(filho.escopo, 'transporte');
    assert.equal(linhas.length, 1, 'escreveu no mesmo destino do pai');
    assert.match(linhas[0] ?? '', /\[transporte\] conexão instável\n$/);
  });

  it('o filho herda o filtro do pai (depuracao continua descartada)', () => {
    const { registrador, linhas } = registradorDeTeste('info', 'servidor');

    const filho = registrador.comEscopo('movimento');
    filho.depuracao('amostra');

    assert.deepEqual(linhas, []);
    assert.equal(filho.habilitado('depuracao'), false);
  });

  it('não mexe no escopo do pai', () => {
    const { registrador, linhas } = registradorDeTeste('info', 'servidor');

    registrador.comEscopo('perfis');
    registrador.info('ainda sou o pai');

    assert.match(linhas[0] ?? '', /\[servidor\]/);
  });
});

describe('ehNivelLog', () => {
  it('aceita os quatro níveis e recusa o resto', () => {
    for (const nivel of ORDEM_ESPERADA) assert.equal(ehNivelLog(nivel), true, nivel);

    for (const invalido of ['gritando', 'INFO', 'debug', '', ' info', 42, null, undefined, {}]) {
      assert.equal(ehNivelLog(invalido), false, JSON.stringify(invalido) ?? 'undefined');
    }
  });
});
