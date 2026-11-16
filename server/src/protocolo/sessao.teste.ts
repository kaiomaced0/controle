/**
 * Teste das mensagens JSON de sessão (PROTOCOLO.md, seção 3).
 *
 * Duas coisas importam aqui, e nenhuma é "o JSON.stringify funciona":
 *
 * 1. **Ida e volta**: o que sai do servidor volta idêntico ao ser lido — inclusive os campos
 *    opcionais, que o protocolo quer **ausentes** no fio quando não têm valor, nunca `null`.
 * 2. **Recusa sem exceção**: quadro de texto quebrado é o caminho por onde um aparelho
 *    estranho (ou um bug do app) derrubaria o processo do servidor. Aqui ele vira recusa
 *    tipada com `PROTOCOLO_INVALIDO`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CODIGOS_DE_AVISO,
  CODIGOS_DE_ERRO,
  COMANDOS,
  VERSAO_PROTOCOLO,
  interpretarMensagemDeTexto,
  serializarMensagemDeTexto,
  type MensagemDeTexto,
} from './sessao.js';

/** Serializa, lê de volta e devolve a mensagem — a viagem completa do quadro de texto. */
function idaEVolta(mensagem: MensagemDeTexto): MensagemDeTexto {
  const resultado = interpretarMensagemDeTexto(serializarMensagemDeTexto(mensagem));
  assert.equal(resultado.ok, true, `recusada: ${resultado.ok ? '' : resultado.motivo}`);
  if (!resultado.ok) throw new Error('inalcançável');
  return resultado.mensagem;
}

describe('ida e volta das mensagens de sessão', () => {
  it('hello completo', () => {
    const original: MensagemDeTexto = {
      t: 'hello',
      v: VERSAO_PROTOCOLO,
      aparelho: {
        id: 'a1b2c3d4e5f6',
        nome: 'Pixel 7',
        so: 'android',
        versaoSo: '14',
        modelo: 'GVU6C',
      },
      capacidades: ['giroscopio', 'acelerometro', 'haptico', 'toque'],
      taxaHzDesejada: 100,
      token: 'token-de-teste',
      codigoPareamento: '482913',
    };
    assert.deepEqual(idaEVolta(original), original);
  });

  it('hello sem token nem código de pareamento (primeira conexão)', () => {
    const lido = idaEVolta({
      t: 'hello',
      v: 1,
      aparelho: { id: 'x', nome: 'y', so: 'ios', versaoSo: '17', modelo: 'iPhone' },
      capacidades: [],
      taxaHzDesejada: 60,
    });
    assert.equal(lido.t, 'hello');
    if (lido.t !== 'hello') return;
    assert.equal(lido.token, undefined);
    assert.equal(lido.codigoPareamento, undefined);
    assert.equal(lido.aparelho.so, 'ios');
  });

  it('campo opcional vazio não aparece no fio (ausente, não null)', () => {
    const texto = serializarMensagemDeTexto({
      t: 'erro',
      codigo: 'TOKEN_INVALIDO',
      mensagem: undefined,
    });
    assert.equal(texto, '{"t":"erro","codigo":"TOKEN_INVALIDO"}');
  });

  it('welcome com perfil e lista de perfis', () => {
    const original: MensagemDeTexto = {
      t: 'welcome',
      v: 1,
      servidor: { nome: 'PC-KAIO', versao: '0.1.0', so: 'windows' },
      sessao: { id: 's-17', taxaHz: 100, transporte: 'usb' },
      tela: { largura: 2560, altura: 1440 },
      perfilAtivo: { id: 'mouse-basico', nome: 'Mouse básico', versao: 1 },
      perfis: [{ id: 'mouse-basico', nome: 'Mouse básico' }],
      token: 'emitido-agora',
    };
    assert.deepEqual(idaEVolta(original), original);
  });

  it('erro com todos os códigos da tabela 3.3', () => {
    for (const codigo of CODIGOS_DE_ERRO) {
      const lido = idaEVolta({ t: 'erro', codigo, mensagem: 'detalhe' });
      assert.equal(lido.t, 'erro');
      if (lido.t !== 'erro') continue;
      assert.equal(lido.codigo, codigo);
    }
  });

  it('config e config-ok com os ajustes de giro', () => {
    const gyro = {
      sensX: 35,
      sensY: 35,
      deadzone: 0.35,
      suavizacao: 0.15,
      inverterX: false,
      inverterY: true,
      espaco: 'local',
    } as const;
    assert.deepEqual(idaEVolta({ t: 'config', gyro }), { t: 'config', gyro });
    assert.deepEqual(idaEVolta({ t: 'config-ok', gyro }), { t: 'config-ok', gyro });
  });

  it('cmd com todos os comandos da seção 3.5', () => {
    for (const comando of COMANDOS) {
      const perfilId = comando === 'trocar-perfil' ? 'gamepad' : undefined;
      const lido = idaEVolta({ t: 'cmd', comando, perfilId });
      assert.equal(lido.t, 'cmd');
      if (lido.t !== 'cmd') continue;
      assert.equal(lido.comando, comando);
      assert.equal(lido.perfilId, perfilId);
    }
  });

  it('cmd-ok carrega o resultado da calibração', () => {
    const original: MensagemDeTexto = {
      t: 'cmd-ok',
      comando: 'calibrar-fim',
      resultado: { bias: [0.0031, -0.0007, 0.0012], amostras: 120 },
    };
    assert.deepEqual(idaEVolta(original), original);
  });

  it('cmd-erro carrega o motivo da recusa', () => {
    const original: MensagemDeTexto = {
      t: 'cmd-erro',
      comando: 'calibrar-fim',
      motivo: 'aparelho se moveu durante a coleta',
    };
    assert.deepEqual(idaEVolta(original), original);
  });

  it('ping e pong preservam n e os carimbos de tempo', () => {
    const ping: MensagemDeTexto = { t: 'ping', n: 42, tServidorMs: 1712345678901 };
    assert.deepEqual(idaEVolta(ping), ping);

    const pong: MensagemDeTexto = {
      t: 'pong',
      n: 42,
      tServidorMs: 1712345678901,
      tDispositivoMs: 84213,
    };
    assert.deepEqual(idaEVolta(pong), pong);
  });

  it('aviso aceso com o texto, e apagado sem texto (seção 3.8)', () => {
    const aceso: MensagemDeTexto = {
      t: 'aviso',
      codigo: 'BIAS_ALTO',
      ativo: true,
      mensagem: 'bias alto detectado (2,0 °/s) — use sincronizar',
    };
    assert.deepEqual(idaEVolta(aceso), aceso);

    // Apagado não precisa de texto, e o campo ausente não vira `null` no fio.
    const apagado: MensagemDeTexto = { t: 'aviso', codigo: 'BIAS_ALTO', ativo: false };
    assert.equal(serializarMensagemDeTexto(apagado), '{"t":"aviso","codigo":"BIAS_ALTO","ativo":false}');
    assert.deepEqual(idaEVolta(apagado), { ...apagado, mensagem: undefined });
  });

  it('todos os códigos de aviso da lista fechada passam', () => {
    for (const codigo of CODIGOS_DE_AVISO) {
      const lido = idaEVolta({ t: 'aviso', codigo, ativo: false });
      assert.equal(lido.t === 'aviso' ? lido.codigo : undefined, codigo);
    }
  });

  it('bye com e sem motivo', () => {
    assert.deepEqual(idaEVolta({ t: 'bye', motivo: 'usuário encerrou' }), {
      t: 'bye',
      motivo: 'usuário encerrou',
    });
    const lido = idaEVolta({ t: 'bye' });
    assert.equal(lido.t, 'bye');
  });
});

describe('quadro de texto defeituoso vira recusa, nunca exceção', () => {
  const quadrosRuins: readonly [string, string][] = [
    ['JSON quebrado', '{"t":"hello"'],
    ['JSON vazio', ''],
    ['texto solto', 'olá'],
    ['lista no lugar de objeto', '[1,2,3]'],
    ['nulo', 'null'],
    ['número solto', '7'],
    ['sem campo t', '{"v":1}'],
    ['t não textual', '{"t":3}'],
    ['t desconhecido', '{"t":"handshake"}'],
    ['hello sem v', '{"t":"hello","aparelho":{},"capacidades":[],"taxaHzDesejada":100}'],
    [
      'hello com so inválido',
      '{"t":"hello","v":1,"aparelho":{"id":"a","nome":"b","so":"symbian",' +
        '"versaoSo":"1","modelo":"m"},"capacidades":[],"taxaHzDesejada":100}',
    ],
    [
      'hello com capacidade não textual',
      '{"t":"hello","v":1,"aparelho":{"id":"a","nome":"b","so":"android",' +
        '"versaoSo":"1","modelo":"m"},"capacidades":[1],"taxaHzDesejada":100}',
    ],
    ['erro com código inventado', '{"t":"erro","codigo":"DEU_RUIM"}'],
    ['config sem gyro', '{"t":"config"}'],
    ['cmd com comando inventado', '{"t":"cmd","comando":"explodir"}'],
    ['trocar-perfil sem perfilId', '{"t":"cmd","comando":"trocar-perfil"}'],
    ['cmd-erro sem motivo', '{"t":"cmd-erro","comando":"pausar"}'],
    ['ping sem n', '{"t":"ping","tServidorMs":1}'],
    ['pong sem tDispositivoMs', '{"t":"pong","n":1,"tServidorMs":2}'],
    ['welcome sem sessao', '{"t":"welcome","v":1,"servidor":{"nome":"a","versao":"b","so":"c"}}'],
    ['número não finito escrito à mão', '{"t":"ping","n":1e999,"tServidorMs":1}'],
    ['aviso com código inventado', '{"t":"aviso","codigo":"BATERIA_FRACA","ativo":true,"mensagem":"x"}'],
    ['aviso sem ativo', '{"t":"aviso","codigo":"BIAS_ALTO","mensagem":"x"}'],
    ['aviso com ativo textual', '{"t":"aviso","codigo":"BIAS_ALTO","ativo":"sim","mensagem":"x"}'],
    ['aviso aceso sem texto para mostrar', '{"t":"aviso","codigo":"BIAS_ALTO","ativo":true}'],
  ];

  for (const [nome, quadro] of quadrosRuins) {
    it(`recusa: ${nome}`, () => {
      const resultado = interpretarMensagemDeTexto(quadro);
      assert.equal(resultado.ok, false, `deveria recusar: ${quadro}`);
      if (resultado.ok) return;
      assert.equal(resultado.codigo, 'PROTOCOLO_INVALIDO');
      assert.ok(resultado.motivo.length > 0, 'a recusa precisa dizer o motivo');
    });
  }

  it('campo extra desconhecido não impede a leitura (só é ignorado)', () => {
    const resultado = interpretarMensagemDeTexto(
      '{"t":"ping","n":1,"tServidorMs":2,"campoDoFuturo":true}',
    );
    assert.equal(resultado.ok, true);
    if (!resultado.ok) return;
    assert.deepEqual(resultado.mensagem, { t: 'ping', n: 1, tServidorMs: 2 });
  });
});

/* ======================================== campo OPCIONAL presente e inválido é recusa */

describe('campo opcional presente e inválido é recusado, não tratado como ausente', () => {
  /**
   * Este bloco existe porque "ausente" e "presente e imprestável" são coisas diferentes, e
   * confundir as duas produz o pior tipo de defeito: o silencioso. A pessoa mexe num ajuste no
   * celular, o servidor responde `config-ok` — e o ajuste não existe. Nenhum erro, nenhum log,
   * nenhum contador. A seção 3 do PROTOCOLO.md manda recusar; aqui está a prova de que recusa.
   */
  const opcionaisRuins: readonly [string, string][] = [
    // --- os quatro casos de `config`, que é a mensagem que o usuário mexe de verdade
    ['config: espaco fora do conjunto declarado', '{"t":"config","gyro":{"espaco":"mundial"}}'],
    ['config: sensX textual', '{"t":"config","gyro":{"sensX":"35"}}'],
    ['config: deadzone Infinity via 1e999', '{"t":"config","gyro":{"deadzone":1e999}}'],
    ['config: inverterY textual', '{"t":"config","gyro":{"inverterY":"sim"}}'],
    // --- e os mesmos buracos nas demais mensagens
    ['config: suavizacao NaN por texto', '{"t":"config","gyro":{"suavizacao":"0.15"}}'],
    ['config: sensY nulo (opcional vazio vai omitido, nunca null)', '{"t":"config","gyro":{"sensY":null}}'],
    ['config: inverterX numérico', '{"t":"config","gyro":{"inverterX":1}}'],
    ['config-ok: espaco fora do conjunto', '{"t":"config-ok","gyro":{"espaco":"global"}}'],
    ['config: gyro não é objeto', '{"t":"config","gyro":[]}'],
    ['erro: mensagem numérica', '{"t":"erro","codigo":"TOKEN_INVALIDO","mensagem":42}'],
    ['cmd-ok: resultado textual', '{"t":"cmd-ok","comando":"pausar","resultado":"tudo certo"}'],
    ['cmd: perfilId numérico', '{"t":"cmd","comando":"trocar-perfil","perfilId":7}'],
    [
      'hello: token numérico',
      '{"t":"hello","v":1,"aparelho":{"id":"a","nome":"b","so":"android",' +
        '"versaoSo":"1","modelo":"m"},"capacidades":[],"taxaHzDesejada":100,"token":123}',
    ],
    [
      'hello: codigoPareamento numérico',
      '{"t":"hello","v":1,"aparelho":{"id":"a","nome":"b","so":"android",' +
        '"versaoSo":"1","modelo":"m"},"capacidades":[],"taxaHzDesejada":100,' +
        '"codigoPareamento":482913}',
    ],
    ['bye: motivo numérico', '{"t":"bye","motivo":7}'],
    ['aviso: mensagem numérica', '{"t":"aviso","codigo":"BIAS_ALTO","ativo":false,"mensagem":7}'],
    ['ping: tServidorMs Infinity', '{"t":"ping","n":1,"tServidorMs":1e999}'],
    ['pong: tDispositivoMs textual', '{"t":"pong","n":1,"tServidorMs":2,"tDispositivoMs":"84213"}'],
    [
      'welcome: token numérico',
      '{"t":"welcome","v":1,"servidor":{"nome":"a","versao":"b","so":"c"},' +
        '"sessao":{"id":"s","taxaHz":100,"transporte":"usb"},"tela":{"largura":1,"altura":1},' +
        '"perfilAtivo":{},"perfis":[],"token":9}',
    ],
  ];

  for (const [nome, quadro] of opcionaisRuins) {
    it(`recusa: ${nome}`, () => {
      const resultado = interpretarMensagemDeTexto(quadro);
      assert.equal(resultado.ok, false, `deveria recusar: ${quadro}`);
      if (resultado.ok) return;
      assert.equal(resultado.codigo, 'PROTOCOLO_INVALIDO');
      assert.ok(resultado.motivo.length > 0, 'a recusa precisa dizer o motivo');
    });
  }

  it('campo opcional simplesmente ausente continua válido', () => {
    // O contrário do teste acima: recusar o ausente quebraria `config` parcial, que é o caso
    // normal (o app manda só o que o usuário mexeu).
    const resultado = interpretarMensagemDeTexto('{"t":"config","gyro":{"sensX":35}}');
    assert.equal(resultado.ok, true);
    if (!resultado.ok) return;
    assert.deepEqual(resultado.mensagem, {
      t: 'config',
      gyro: {
        sensX: 35,
        sensY: undefined,
        deadzone: undefined,
        suavizacao: undefined,
        inverterX: undefined,
        inverterY: undefined,
        espaco: undefined,
      },
    });
  });

  it('gyro vazio é aceito (nada foi ajustado ainda)', () => {
    assert.equal(interpretarMensagemDeTexto('{"t":"config","gyro":{}}').ok, true);
  });

  it('os dois valores de `espaco` da lista fechada passam', () => {
    for (const espaco of ['local', 'mundo']) {
      const resultado = interpretarMensagemDeTexto(
        `{"t":"config","gyro":{"espaco":"${espaco}"}}`,
      );
      assert.equal(resultado.ok, true, espaco);
      if (!resultado.ok || resultado.mensagem.t !== 'config') continue;
      assert.equal(resultado.mensagem.gyro.espaco, espaco);
    }
  });
});
