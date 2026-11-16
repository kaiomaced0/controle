/**
 * A tela de envio: mostra o endereço em uso e o estado da conexão, o botão liga e desliga o
 * envio, e sair da tela com o envio ligado **desliga o sensor nativo** (regra 5 do CLAUDE.md —
 * envio de pé sem ninguém olhando é 100 pacotes por segundo e bateria queimando).
 *
 * Não abre socket nenhum — a conexão do app só conecta quando alguém pede.
 *
 * @format
 */

import React from 'react';
import {NativeModules} from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import {situacaoDoGiroscopio} from '../src/sensores/giroscopio';
import {TelaTelemetria} from '../src/telas/TelaTelemetria';
import {esquecerConexaoDoApp} from '../src/transporte/conexaoDoApp';

function textoDe(no: ReactTestRenderer.ReactTestInstance): string {
  return no.children
    .map(filho => (typeof filho === 'string' ? filho : textoDe(filho)))
    .join('');
}

/** Quantas vezes o nativo foi mandado desligar. Sem contador não há como afirmar que desligou. */
let paradasDoSensor = 0;

beforeEach(() => {
  esquecerConexaoDoApp();
  paradasDoSensor = 0;
  NativeModules.Giroscopio = {
    iniciar: () =>
      Promise.resolve({
        nome: 'giroscópio de teste',
        fornecedor: 'norte',
        taxaHzSolicitada: 100,
        periodoUs: 10000,
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
});

test('mostra o endereço em uso e o estado da conexão', async () => {
  let arvore: ReactTestRenderer.ReactTestRenderer | null = null;
  await ReactTestRenderer.act(() => {
    arvore = ReactTestRenderer.create(<TelaTelemetria />);
  });
  const raiz = arvore!.root;

  expect(textoDe(raiz.findByProps({testID: 'endereco-em-uso'}))).toContain(
    'ws://127.0.0.1:8765',
  );
  // Sem ninguém ter chamado `conectar()`, o estado honesto é "desconectado".
  expect(textoDe(raiz.findByProps({testID: 'estado-da-conexao'}))).toContain(
    'desconectado',
  );

  await ReactTestRenderer.act(() => {
    arvore!.unmount();
  });
});

test('o botão alterna entre enviar e parar, e parar já desliga o sensor', async () => {
  let arvore: ReactTestRenderer.ReactTestRenderer | null = null;
  await ReactTestRenderer.act(() => {
    arvore = ReactTestRenderer.create(<TelaTelemetria />);
  });
  const botao = arvore!.root.findByProps({testID: 'botao-envio'});

  expect(textoDe(botao)).toContain('Enviar giroscópio');
  expect(paradasDoSensor).toBe(0);

  // `act` assíncrono: a partida do sensor é uma promessa, e o `aoIniciar` dela cai em `setState`
  // depois do clique — fora do `act` síncrono isso vira aviso do React e teste instável.
  await ReactTestRenderer.act(async () => {
    botao.props.onPress();
    await Promise.resolve();
  });
  expect(
    textoDe(arvore!.root.findByProps({testID: 'botao-envio'})),
  ).toContain('Parar envio');
  expect(situacaoDoGiroscopio().estado).toBe('ligado');

  await ReactTestRenderer.act(async () => {
    arvore!.root.findByProps({testID: 'botao-envio'}).props.onPress();
    await Promise.resolve();
  });
  expect(
    textoDe(arvore!.root.findByProps({testID: 'botao-envio'})),
  ).toContain('Enviar giroscópio');
  // Apertar "Parar" não é só trocar o texto do botão: o sensor nativo tem de cair junto.
  expect(paradasDoSensor).toBe(1);
  expect(situacaoDoGiroscopio()).toMatchObject({estado: 'parado', assinantes: 0});

  await ReactTestRenderer.act(() => {
    arvore!.unmount();
  });
  // Desmontar com o envio já desligado não pode mandar desligar de novo.
  expect(paradasDoSensor).toBe(1);
});

test('desmontar com o envio ligado desliga o sensor nativo', async () => {
  let arvore: ReactTestRenderer.ReactTestRenderer | null = null;
  await ReactTestRenderer.act(() => {
    arvore = ReactTestRenderer.create(<TelaTelemetria />);
  });

  await ReactTestRenderer.act(async () => {
    arvore!.root.findByProps({testID: 'botao-envio'}).props.onPress();
    await Promise.resolve();
  });
  // A garantia só vale se o sensor estiver mesmo ligado na hora de desmontar — sem isto o teste
  // passaria verificando o caminho fácil, que é o defeito que a revisão da rodada 1 apontou.
  expect(situacaoDoGiroscopio()).toMatchObject({estado: 'ligado', assinantes: 1});
  expect(paradasDoSensor).toBe(0);

  await ReactTestRenderer.act(() => {
    arvore!.unmount();
  });

  expect(paradasDoSensor).toBe(1);
  expect(situacaoDoGiroscopio()).toMatchObject({estado: 'parado', assinantes: 0});
});
