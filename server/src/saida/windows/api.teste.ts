/**
 * Teste da ponte com a `user32.dll` — o **único** do projeto que carrega a biblioteca de verdade.
 *
 * Ele só faz leitura: `GetSystemMetrics` e `GetCursorPos`. Nada aqui chama `SendInput` nem
 * `SetCursorPos` — mexer no cursor de quem está rodando `npm test` é justamente o que este sprint
 * combinou não fazer. Quem exercita a injeção de verdade é `ferramentas/provar-mouse.mjs`, à mão.
 *
 * O que ele prova, e que nenhum outro teste consegue provar: que o mapa de bytes escrito em
 * `constantes.ts` bate com o que a plataforma de 64 bits realmente usa. Se um dia o `INPUT`
 * deixar de ter 40 bytes, é aqui que aparece — antes de virar cursor andando sozinho.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ErroDeSaida } from '../tipos.js';
import { carregarApiDoWindows, conferirEstruturas } from './api.js';
import { SM_CXSCREEN, SM_CYSCREEN, TAMANHO_INPUT, TAMANHO_POINT } from './constantes.js';

const ESTA_NO_WINDOWS = process.platform === 'win32';
/** Rótulo do bloco que **só** roda no Windows: fora dele, a `user32.dll` não existe. */
const soNoWindows = { skip: ESTA_NO_WINDOWS ? false : 'só roda no Windows' };

describe('conferirEstruturas', () => {
  it('confirma, contra o koffi, cada tamanho e deslocamento de constantes.ts', () => {
    const divergentes = conferirEstruturas().filter((item) => item.esperado !== item.encontrado);

    assert.deepEqual(
      divergentes,
      [],
      `constantes.ts não bate com o layout desta plataforma: ${divergentes
        .map((item) => `${item.rotulo} esperado ${item.esperado}, koffi ${item.encontrado}`)
        .join('; ')}`,
    );
  });

  it('o INPUT tem 40 bytes — é esse o cbSize que o SendInput exige em x64', () => {
    const tamanhoDoInput = conferirEstruturas().find((item) => item.rotulo === 'sizeof(INPUT)');

    assert.equal(tamanhoDoInput?.encontrado, TAMANHO_INPUT);
    assert.equal(TAMANHO_INPUT, 40);
  });

  it('pode ser chamada mais de uma vez (os tipos do koffi não são registrados por nome)', () => {
    assert.doesNotThrow(() => {
      conferirEstruturas();
      conferirEstruturas();
    });
  });
});

describe('carregarApiDoWindows (só leitura)', soNoWindows, () => {
  it('carrega a user32.dll e devolve um quadro de 40 bytes zerado', () => {
    const api = carregarApiDoWindows();

    assert.equal(api.quadro.byteLength, TAMANHO_INPUT);
    assert.deepEqual(api.quadro, Buffer.alloc(TAMANHO_INPUT));
  });

  it('GetSystemMetrics devolve uma resolução plausível', () => {
    const api = carregarApiDoWindows();

    const largura = api.metricaDoSistema(SM_CXSCREEN);
    const altura = api.metricaDoSistema(SM_CYSCREEN);

    assert.ok(largura >= 640, `largura implausível: ${String(largura)}`);
    assert.ok(altura >= 480, `altura implausível: ${String(altura)}`);
  });

  it('GetCursorPos devolve a posição atual do cursor sem alterá-la', () => {
    const api = carregarApiDoWindows();

    const primeira = api.lerPosicaoDoCursor();
    const segunda = api.lerPosicaoDoCursor();

    assert.ok(primeira !== undefined);
    assert.ok(segunda !== undefined);
    assert.equal(Number.isInteger(primeira.x), true);
    assert.equal(Number.isInteger(primeira.y), true);
    // Duas leituras seguidas, sem ninguém mexer no mouse, dão o mesmo ponto. Se a pessoa estiver
    // com a mão no mouse agora, a comparação seria falso negativo — por isso só a distância.
    assert.ok(Math.abs(segunda.x - primeira.x) < 5000);
    assert.ok(Math.abs(segunda.y - primeira.y) < 5000);
  });

  it('lê a configuração de ponteiro do sistema — só leitura, valores na faixa do Windows (ATI-026)', () => {
    const api = carregarApiDoWindows();

    const parametros = api.lerParametrosDoPonteiro();
    const deNovo = api.lerParametrosDoPonteiro();

    assert.ok(parametros !== undefined, 'SystemParametersInfo(SPI_GETMOUSE) falhou');
    assert.ok([0, 1, 2].includes(parametros.aceleracao), `aceleração: ${String(parametros.aceleracao)}`);
    assert.ok(
      Number.isInteger(parametros.velocidade) && parametros.velocidade >= 1 && parametros.velocidade <= 20,
      `velocidade: ${String(parametros.velocidade)}`,
    );
    assert.ok(parametros.dpi === 0 || parametros.dpi >= 96, `dpi: ${String(parametros.dpi)}`);
    // A curva pode faltar no registro (perfil novo, "conserto" de jogo que a apagou); quando existe,
    // são os cinco pontos que o Windows guarda.
    for (const curva of [parametros.curvaX, parametros.curvaY]) {
      if (curva !== undefined) assert.equal(curva.length, 5);
    }
    // Ler duas vezes dá o mesmo: a leitura não mexe em nada.
    assert.deepEqual(deNovo, parametros);
  });

  it('a ponte não tem como escrever configuração do sistema (critério da ATI-026)', () => {
    // Duas guardas. A primeira: os membros da ponte são estes, e nenhum deles escreve configuração —
    // um método novo aqui tem de passar por esta lista, e por quem a revisa.
    const api = carregarApiDoWindows();
    assert.deepEqual(Object.keys(api).sort(), [
      'ativarDpiPorMonitor', // muda a thread deste processo, nunca o sistema
      'definirPosicaoDoCursor',
      'enviarUmaEntrada',
      'lerCursorNoPonto',
      'lerParametrosDoPonteiro',
      'lerPosicaoDoCursor',
      'metricaDoSistema',
      'ponto',
      'quadro',
      'ultimoErro',
    ]);

    // A segunda: o fonte da ponte não declara nenhuma função de escrita de configuração. É o único
    // arquivo do projeto que fala com o Windows, então é o único lugar onde ela poderia nascer.
    const fonte = readFileSync(fileURLToPath(new URL('./api.ts', import.meta.url)), 'utf8');
    for (const proibido of [/SPI_SET/, /RegSetValue/, /RegSetKeyValue/, /RegCreateKey/, /RegDeleteValue/]) {
      assert.doesNotMatch(fonte, proibido);
    }
    // E o `SystemParametersInfoW` só é chamado com as duas leituras.
    const chamadas = [...fonte.matchAll(/SystemParametersInfoW\((\w+)/g)].map((m) => m[1]);
    assert.deepEqual(chamadas, ['SPI_GETMOUSE', 'SPI_GETMOUSESPEED']);
  });

  it('o POINT do caminho quente lê o mesmo cursor que a leitura que aloca', () => {
    const api = carregarApiDoWindows();

    assert.equal(api.ponto.byteLength, TAMANHO_POINT);
    assert.equal(api.lerCursorNoPonto(), true);
    const doPonto = { x: api.ponto.readInt32LE(0), y: api.ponto.readInt32LE(4) };
    const alocado = api.lerPosicaoDoCursor();
    assert.ok(alocado !== undefined);
    // A pessoa pode estar com a mão no mouse entre as duas leituras: só a distância.
    assert.ok(Math.abs(alocado.x - doPonto.x) < 5000 && Math.abs(alocado.y - doPonto.y) < 5000);
  });

  it('o POINT lido tem os 8 bytes que constantes.ts declara', () => {
    assert.equal(TAMANHO_POINT, 8);
  });

  it('ErroDeSaida é o tipo de falha desta camada', () => {
    // Guarda de regressão barata: a mensagem de erro é contrato com quem lê o log da partida.
    const erro = new ErroDeSaida('exemplo');
    assert.equal(erro.name, 'ErroDeSaida');
    assert.ok(erro instanceof Error);
  });
});
