/**
 * A tela de medição da ATI-003 do ponto de vista de quem a lê de fora: o roteiro de medição
 * (`scripts/medicao-giroscopio/`), um print ou uma pessoa.
 *
 * - A linha do build está na tela e na primeira linha da captura (parecer r5, sugestão 5): é a
 *   condição de partida do roteiro.
 * - O acumulado conta toda janela fechada (parecer r5, importante 3) e vai na captura num formato
 *   que o leitor do roteiro (`lerCapturas`) lê de volta, passando pelo formato do logcat.
 * - Todo texto que o roteiro procura (`textos-da-tela.js`) existe nas telas: renomear de um lado só
 *   quebra aqui, e não no aparelho.
 *
 * @format
 */

import React from 'react';
import {DeviceEventEmitter, NativeModules, Text} from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import App from '../App';
import {situacaoDoGiroscopio} from '../src/sensores/giroscopio';
import {TelaGiroscopio} from '../src/telas/TelaGiroscopio';
import {TelaTelemetria} from '../src/telas/TelaTelemetria';
import {esquecerConexaoDoApp} from '../src/transporte/conexaoDoApp';
import {
  lerCapturas,
  lerTextoDeCaptura,
} from '../scripts/medicao-giroscopio/leitura';
import {
  ROTULOS_DA_JANELA,
  ROTULOS_DO_ACUMULADO,
  TEXTOS,
} from '../scripts/medicao-giroscopio/textos-da-tela';

/** O mesmo relógio que `src/sensores/relogio.ts` usa; o preset do RN o define no jest. */
declare const performance: {now(): number};

// Sem as medidas da tela (que só o nativo dá), o SafeAreaProvider de verdade não desenha nada no
// jest; o mock da própria biblioteca dá medidas fixas e deixa o App aparecer com as abas.
jest.mock('react-native-safe-area-context', () =>
  require('react-native-safe-area-context/jest/mock').default,
);

type Instancia = ReactTestRenderer.ReactTestInstance;

function textoDe(no: Instancia): string {
  return no.children
    .map(filho =>
      typeof filho === 'string' || typeof filho === 'number'
        ? String(filho)
        : textoDe(filho),
    )
    .join('');
}

function textosDaTela(raiz: Instancia): string[] {
  return raiz.findAllByType(Text).map(textoDe);
}

function textoPorId(raiz: Instancia, testID: string): string {
  return textoDe(raiz.findByProps({testID}));
}

/** Aperta o elemento tocável cujo texto é exatamente `texto`. */
async function apertar(raiz: Instancia, texto: string): Promise<void> {
  const alvo = raiz.findAll(
    no => typeof no.props.onPress === 'function' && textoDe(no) === texto,
  )[0];
  if (alvo === undefined) {
    throw new Error(`nada tocável com o texto "${texto}"`);
  }
  await ReactTestRenderer.act(async () => {
    alvo.props.onPress();
    await Promise.resolve();
  });
}

let paradasDoSensor = 0;
let saidaDoConsole: string[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  // O preset do RN prende `performance.now` ao `Date.now` real; a tela mede com ele, então ele
  // passa a seguir o relógio falso.
  jest.spyOn(performance, 'now').mockImplementation(() => Date.now());
  saidaDoConsole = [];
  jest.spyOn(console, 'log').mockImplementation((texto: unknown) => {
    saidaDoConsole.push(String(texto));
  });
  esquecerConexaoDoApp();
  paradasDoSensor = 0;
  NativeModules.Giroscopio = {
    iniciar: (taxaHz: number) =>
      Promise.resolve({
        nome: 'giroscópio de teste',
        fornecedor: 'norte',
        taxaHzSolicitada: taxaHz,
        periodoUs: Math.round(1_000_000 / taxaHz),
        periodoMinimoUs: 2500,
        resolucaoRadS: 0.0001,
      }),
    parar: () => {
      paradasDoSensor += 1;
    },
    addListener: () => {},
    removeListeners: () => {},
  };
});

afterEach(() => {
  delete NativeModules.Giroscopio;
  esquecerConexaoDoApp();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

/**
 * Uma janela de 1 s no relógio falso: `amostras` amostras a cada 10 ms e, se sobrar, silêncio até
 * o fim do segundo. O relógio da janela da tela dispara no último passo.
 */
function passarJanela(amostras: number): void {
  ReactTestRenderer.act(() => {
    for (let i = 0; i < amostras; i += 1) {
      DeviceEventEmitter.emit('controleGiroscopioAmostra', {
        gx: 0.1,
        gy: -0.2,
        gz: 0.3,
        tDispositivoMs: Date.now(),
        dtMs: 10,
      });
      jest.advanceTimersByTime(10);
    }
    if (amostras < 100) {
      jest.advanceTimersByTime((100 - amostras) * 10);
    }
  });
}

test('a linha do build está na tela e abre a captura', async () => {
  let arvore: ReactTestRenderer.ReactTestRenderer | null = null;
  await ReactTestRenderer.act(() => {
    arvore = ReactTestRenderer.create(<TelaGiroscopio />);
  });
  const raiz = arvore!.root;

  // No jest o `__DEV__` é verdadeiro, como no app servido pelo Metro.
  expect(textoPorId(raiz, 'descricao-build')).toBe(
    'build debug (__DEV__ ligado)',
  );
  expect(textoPorId(raiz, 'descricao-build').startsWith(TEXTOS.prefixoDoBuild)).toBe(true);

  await apertar(raiz, TEXTOS.iniciarMedicao);
  passarJanela(100);
  await apertar(raiz, TEXTOS.capturarLeitura);

  const primeiraLinha = textoPorId(raiz, 'texto-captura').split('\n')[0];
  expect(primeiraLinha.endsWith(' · build debug (__DEV__ ligado)')).toBe(true);
  expect(lerTextoDeCaptura(textoPorId(raiz, 'texto-captura')).build).toBe(
    'build debug (__DEV__ ligado)',
  );

  await ReactTestRenderer.act(() => {
    arvore!.unmount();
  });
});

test('o acumulado conta toda janela fechada e vai inteiro na captura', async () => {
  let arvore: ReactTestRenderer.ReactTestRenderer | null = null;
  await ReactTestRenderer.act(() => {
    arvore = ReactTestRenderer.create(<TelaGiroscopio />);
  });
  const raiz = arvore!.root;

  expect(textoPorId(raiz, 'cabecalho-acumulado')).toBe('Acumulado desde o início');
  expect(textoPorId(raiz, 'acumulado-janelasContadas')).toBe('—');

  await apertar(raiz, TEXTOS.iniciarMedicao);
  passarJanela(100); // partida: começou antes da primeira amostra
  passarJanela(100); // 100 Hz
  passarJanela(80); // 80 Hz e 200 ms de silêncio no fim
  passarJanela(100); // 100 Hz, mas a primeira chegada veio 210 ms depois da anterior

  expect(textoPorId(raiz, 'cabecalho-acumulado')).toBe(
    'Acumulado desde o início · alvo 100 Hz',
  );
  const naTela = {
    janelasContadas: textoPorId(raiz, 'acumulado-janelasContadas'),
    janelasDePartida: textoPorId(raiz, 'acumulado-janelasDePartida'),
    janelasAbaixoDoLimiarDeTaxa: textoPorId(raiz, 'acumulado-janelasAbaixoDoLimiarDeTaxa'),
    piorTaxaHz: textoPorId(raiz, 'acumulado-piorTaxaHz'),
    taxaMediaHz: textoPorId(raiz, 'acumulado-taxaMediaHz'),
    maiorAtrasoNaPonteMs: textoPorId(raiz, 'acumulado-maiorAtrasoNaPonteMs'),
    janelasComPonteAcimaDoLimiar: textoPorId(raiz, 'acumulado-janelasComPonteAcimaDoLimiar'),
    maiorDtMs: textoPorId(raiz, 'acumulado-maiorDtMs'),
    dtMedioMs: textoPorId(raiz, 'acumulado-dtMedioMs'),
    dtDesvioMs: textoPorId(raiz, 'acumulado-dtDesvioMs'),
  };
  expect(naTela).toEqual({
    janelasContadas: '3',
    janelasDePartida: '1',
    janelasAbaixoDoLimiarDeTaxa: '1',
    piorTaxaHz: '80.0',
    taxaMediaHz: '93.33',
    maiorAtrasoNaPonteMs: '210.00',
    janelasComPonteAcimaDoLimiar: '1',
    maiorDtMs: '10.00',
    dtMedioMs: '10.000',
    dtDesvioMs: '0.000',
  });
  // A grade da janela corrente, ao lado, só sabe do último segundo (100 Hz): a queda a 80 Hz de
  // duas janelas atrás já sumiu dela — e é exatamente o que o acumulado guarda.
  const textos = textosDaTela(raiz);
  expect(textos[textos.indexOf(ROTULOS_DA_JANELA.taxaHz) + 1]).toBe('100.0');

  await apertar(raiz, TEXTOS.capturarLeitura);
  const captura = textoPorId(raiz, 'texto-captura');
  expect(saidaDoConsole).toEqual([captura]);

  // Ida e volta pelo formato do logcat (`adb logcat -v time`), que é por onde o roteiro lê.
  const logcat = captura
    .split('\n')
    .map(linha => `10-14 15:00:00.000 I/ReactNativeJS(12345): ${linha}`)
    .join('\r\n');
  const lidas = lerCapturas(logcat);
  expect(lidas).toHaveLength(1);
  expect(lidas[0].alvoHz).toBe(100);
  expect(lidas[0].janela).toEqual({
    taxaHz: 100,
    amostras: 100,
    dtMedioMs: 10,
    dtDesvioMs: 0,
    dtMaximoMs: 10,
    intervaloJsMaximoMs: 210,
  });
  expect(lidas[0].acumulado).toEqual({
    taxaAlvoHz: 100,
    janelasContadas: 3,
    janelasDePartida: 1,
    janelasAbaixoDoLimiarDeTaxa: 1,
    janelasComPonteAcimaDoLimiar: 1,
    taxaMediaHz: 93.33,
    piorTaxaHz: 80,
    dtMedioMs: 10,
    dtDesvioMs: 0,
    maiorDtMs: 10,
    maiorAtrasoNaPonteMs: 210,
  });

  // Trocar de taxa recomeça o acumulado: o de 100 Hz não vira o de 200 Hz.
  await apertar(raiz, TEXTOS.taxa200);
  passarJanela(100);
  expect(textoPorId(raiz, 'cabecalho-acumulado')).toBe(
    'Acumulado desde o início · alvo 200 Hz',
  );
  expect(textoPorId(raiz, 'acumulado-janelasContadas')).toBe('0');
  expect(textoPorId(raiz, 'acumulado-janelasDePartida')).toBe('1');

  await ReactTestRenderer.act(() => {
    arvore!.unmount();
  });
  expect(situacaoDoGiroscopio()).toMatchObject({estado: 'parado', assinantes: 0});
  expect(paradasDoSensor).toBeGreaterThan(0);
});

test('todo texto que o roteiro de medição procura existe nas telas', async () => {
  let arvore: ReactTestRenderer.ReactTestRenderer | null = null;
  await ReactTestRenderer.act(() => {
    arvore = ReactTestRenderer.create(<App />);
  });
  const raiz = arvore!.root;
  const textos = textosDaTela(raiz);

  for (const exato of [
    TEXTOS.abaMedicao,
    TEXTOS.abaEnvio,
    TEXTOS.titulo,
    TEXTOS.taxa100,
    TEXTOS.taxa200,
    TEXTOS.condicaoParado,
    TEXTOS.iniciarMedicao,
    TEXTOS.capturarLeitura,
    ...Object.values(ROTULOS_DA_JANELA),
    ...Object.values(ROTULOS_DO_ACUMULADO),
  ]) {
    expect(textos).toContain(exato);
  }
  for (const prefixo of [TEXTOS.prefixoDoBuild, TEXTOS.cabecalhoDoAcumulado]) {
    expect(textos.some(t => t.startsWith(prefixo))).toBe(true);
  }
  // Cada rótulo do acumulado tem o valor com a chave de `ResumoAcumulado` logo depois dele.
  for (const [chave, rotulo] of Object.entries(ROTULOS_DO_ACUMULADO)) {
    const valor = raiz.findByProps({testID: `acumulado-${chave}`});
    expect(textos[textos.indexOf(rotulo) + 1]).toBe(textoDe(valor));
  }

  await apertar(raiz, TEXTOS.iniciarMedicao);
  expect(textosDaTela(raiz)).toContain(TEXTOS.pararMedicao);
  await apertar(raiz, TEXTOS.pararMedicao);

  await ReactTestRenderer.act(() => {
    arvore!.unmount();
  });

  let envio: ReactTestRenderer.ReactTestRenderer | null = null;
  await ReactTestRenderer.act(() => {
    envio = ReactTestRenderer.create(<TelaTelemetria />);
  });
  expect(textosDaTela(envio!.root)).toContain(TEXTOS.enviarGiroscopio);
  await apertar(envio!.root, TEXTOS.enviarGiroscopio);
  expect(textosDaTela(envio!.root)).toContain(TEXTOS.pararEnvio);
  await apertar(envio!.root, TEXTOS.pararEnvio);
  await ReactTestRenderer.act(() => {
    envio!.unmount();
  });
});
