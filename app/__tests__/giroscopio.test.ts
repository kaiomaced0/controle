/**
 * Testa o contrato do lado JS: assinar liga o sensor, cancelar desliga, e nenhuma amostra chega
 * depois do cancelamento (é o que "não vazar listener ao trocar de tela" quer dizer aqui).
 *
 * O módulo nativo é substituído por um dublê; o transporte do evento é o `RCTDeviceEventEmitter`
 * de verdade, que é JavaScript puro e roda no jest sem aparelho.
 *
 * @format
 */

import type {AmostraGiroscopio} from '../src/sensores/giroscopio';

const NOME_DO_EVENTO = 'controleGiroscopioAmostra';
const NOME_DO_EVENTO_FALHA = 'controleGiroscopioFalha';

type ModuloDoGiroscopio = typeof import('../src/sensores/giroscopio');
type ReactNativeDeTeste = typeof import('react-native');

type DubleNativo = {
  iniciadoCom: number[];
  paradas: number;
  /** Ordem das chamadas ao nativo, que é a ordem em que a fila da ponte as executa. */
  chamadas: string[];
  falharAoIniciar: boolean;
  iniciar(taxaHz: number): Promise<unknown>;
  parar(): void;
  addListener(nomeEvento: string): void;
  removeListeners(quantidade: number): void;
};

function criarDuble(): DubleNativo {
  return {
    iniciadoCom: [],
    paradas: 0,
    chamadas: [],
    falharAoIniciar: false,
    iniciar(taxaHz: number) {
      this.iniciadoCom.push(taxaHz);
      this.chamadas.push(`iniciar:${taxaHz}`);
      return this.falharAoIniciar
        ? Promise.reject(new Error('SEM_GIROSCOPIO'))
        : Promise.resolve({
            nome: 'giroscópio de teste',
            fornecedor: 'norte',
            taxaHzSolicitada: taxaHz,
            periodoUs: Math.round(1_000_000 / taxaHz),
            periodoMinimoUs: 2500,
            resolucaoRadS: 0.0001,
          });
    },
    parar() {
      this.paradas += 1;
      this.chamadas.push('parar');
    },
    addListener() {
      // O contrato do NativeEventEmitter exige o método; a contagem não interessa ao teste.
    },
    removeListeners() {
      // Idem.
    },
  };
}

function amostra(dtMs: number): AmostraGiroscopio {
  return {gx: 0.1, gy: -0.2, gz: 0.3, tDispositivoMs: 1000, dtMs};
}

let duble: DubleNativo;
let DeviceEventEmitter: ReactNativeDeTeste['DeviceEventEmitter'];
let NativeModules: ReactNativeDeTeste['NativeModules'];
let assinarGiroscopio: ModuloDoGiroscopio['assinarGiroscopio'];
let giroscopioDisponivel: ModuloDoGiroscopio['giroscopioDisponivel'];
let situacaoDoGiroscopio: ModuloDoGiroscopio['situacaoDoGiroscopio'];

/**
 * `giroscopio.ts` guarda estado de módulo (assinantes, estado da partida, escuta de falha) porque o
 * listener nativo é um só para o app inteiro. Sem zerar o registro de módulos a cada teste esse
 * estado atravessa de um para o outro, e um teste que esqueça de cancelar contamina os seguintes em
 * silêncio. `react-native` é recarregado junto de propósito: o `DeviceEventEmitter` é um singleton
 * de módulo, e o teste precisa emitir exatamente no mesmo em que a ponte escuta.
 */
function carregarModulosLimpos(): void {
  jest.resetModules();
  const reactNative: ReactNativeDeTeste = require('react-native');
  DeviceEventEmitter = reactNative.DeviceEventEmitter;
  NativeModules = reactNative.NativeModules;

  duble = criarDuble();
  NativeModules.Giroscopio = duble;

  const giroscopio: ModuloDoGiroscopio = require('../src/sensores/giroscopio');
  assinarGiroscopio = giroscopio.assinarGiroscopio;
  giroscopioDisponivel = giroscopio.giroscopioDisponivel;
  situacaoDoGiroscopio = giroscopio.situacaoDoGiroscopio;
}

function esperarEstadoZerado(): void {
  const situacao = situacaoDoGiroscopio();
  expect(situacao.estado).toBe('parado');
  expect(situacao.assinantes).toBe(0);
  expect(situacao.erro).toBeNull();
}

beforeEach(() => {
  carregarModulosLimpos();
  // Cobrado aqui, e não num teste vizinho: vale para todo teste, em qualquer ordem de execução
  // (`--randomize`, `test.only`, teste novo inserido no meio).
  esperarEstadoZerado();
});

afterEach(() => {
  delete NativeModules.Giroscopio;
});

test('recarregar os módulos zera o estado que um teste deixou sujo', () => {
  // Assina e **não** cancela de propósito: é a sujeira que o `beforeEach` precisa limpar.
  assinarGiroscopio({taxaHz: 100, aoReceber: () => {}});
  expect(situacaoDoGiroscopio().assinantes).toBe(1);
  expect(situacaoDoGiroscopio().estado).toBe('pendente');

  // O mesmo procedimento do `beforeEach`, dentro do próprio caso: a prova não depende de qual
  // teste roda depois deste.
  carregarModulosLimpos();
  esperarEstadoZerado();
});

test('reconhece a presença e a ausência do módulo nativo', () => {
  expect(giroscopioDisponivel()).toBe(true);
  delete NativeModules.Giroscopio;
  expect(giroscopioDisponivel()).toBe(false);
});

test('assina, entrega amostras e para o sensor ao cancelar', async () => {
  const recebidas: AmostraGiroscopio[] = [];
  const assinatura = assinarGiroscopio({
    taxaHz: 100,
    aoReceber: a => recebidas.push(a),
  });

  await Promise.resolve();
  expect(duble.iniciadoCom).toEqual([100]);

  DeviceEventEmitter.emit(NOME_DO_EVENTO, amostra(10));
  DeviceEventEmitter.emit(NOME_DO_EVENTO, amostra(11));
  expect(recebidas).toHaveLength(2);
  expect(recebidas[1].dtMs).toBe(11);

  assinatura.cancelar();
  expect(duble.paradas).toBe(1);

  // Depois de cancelar, nenhuma amostra pode mais chegar: é isso que "não vazar" significa.
  DeviceEventEmitter.emit(NOME_DO_EVENTO, amostra(12));
  expect(recebidas).toHaveLength(2);
});

test('cancelar duas vezes não desliga o sensor duas vezes', async () => {
  const assinatura = assinarGiroscopio({taxaHz: 100, aoReceber: () => {}});
  await Promise.resolve();

  assinatura.cancelar();
  assinatura.cancelar();

  expect(duble.paradas).toBe(1);
});

test('com dois assinantes, o sensor só para quando o último cancela', async () => {
  const primeira = assinarGiroscopio({taxaHz: 100, aoReceber: () => {}});
  const segunda = assinarGiroscopio({taxaHz: 100, aoReceber: () => {}});
  await Promise.resolve();

  // Um listener nativo só: a segunda assinatura não pode registrar o sensor de novo.
  expect(duble.iniciadoCom).toEqual([100]);

  primeira.cancelar();
  expect(duble.paradas).toBe(0);

  segunda.cancelar();
  expect(duble.paradas).toBe(1);
});

test('falha ao iniciar solta a assinatura e avisa com erro legível', async () => {
  duble.falharAoIniciar = true;
  const recebidas: AmostraGiroscopio[] = [];
  let falha: Error | null = null;

  assinarGiroscopio({
    taxaHz: 100,
    aoReceber: a => recebidas.push(a),
    aoFalhar: erro => {
      falha = erro;
    },
  });

  await Promise.resolve();
  await Promise.resolve();

  expect(falha).not.toBeNull();
  expect((falha as unknown as Error).message).toContain('SEM_GIROSCOPIO');

  DeviceEventEmitter.emit(NOME_DO_EVENTO, amostra(10));
  expect(recebidas).toHaveLength(0);
});

test('falha ao iniciar avisa todos os assinantes vivos e não trava a próxima assinatura', async () => {
  duble.falharAoIniciar = true;
  const avisados: string[] = [];
  const recebidas: AmostraGiroscopio[] = [];

  assinarGiroscopio({
    taxaHz: 100,
    aoReceber: a => recebidas.push(a),
    aoFalhar: erro => avisados.push(`a:${erro.message}`),
  });
  assinarGiroscopio({
    taxaHz: 100,
    aoReceber: a => recebidas.push(a),
    aoFalhar: erro => avisados.push(`b:${erro.message}`),
  });

  await Promise.resolve();
  await Promise.resolve();

  // Uma tentativa de partida só, mas os dois assinantes ficam sabendo que ela falhou.
  expect(duble.iniciadoCom).toEqual([100]);
  expect(avisados).toEqual(['a:SEM_GIROSCOPIO', 'b:SEM_GIROSCOPIO']);
  expect(situacaoDoGiroscopio().estado).toBe('falhou');
  expect(situacaoDoGiroscopio().assinantes).toBe(0);
  // A falha manda desligar uma vez, por garantia (com o registro recusado, é inofensivo no nativo).
  expect(duble.paradas).toBe(1);

  // Ninguém ficou pendurado esperando amostra que nunca vem.
  DeviceEventEmitter.emit(NOME_DO_EVENTO, amostra(10));
  expect(recebidas).toHaveLength(0);

  // E a contagem não travou: a assinatura seguinte volta a ligar o sensor.
  duble.falharAoIniciar = false;
  const terceira = assinarGiroscopio({
    taxaHz: 50,
    aoReceber: a => recebidas.push(a),
  });
  await Promise.resolve();

  expect(duble.iniciadoCom).toEqual([100, 50]);
  DeviceEventEmitter.emit(NOME_DO_EVENTO, amostra(20));
  expect(recebidas).toHaveLength(1);

  terceira.cancelar();
  expect(duble.paradas).toBe(2);
});

test('cancelar antes de a partida terminar desliga o sensor no desfecho dela', async () => {
  const assinatura = assinarGiroscopio({taxaHz: 100, aoReceber: () => {}});
  assinatura.cancelar();

  // A promessa de `iniciar` ainda não resolveu: não há o que desligar neste instante.
  expect(duble.paradas).toBe(0);

  await Promise.resolve();
  await Promise.resolve();

  // Ao resolver, ninguém mais quer amostra — o sensor que chegou a ligar é desligado.
  expect(duble.paradas).toBe(1);
  expect(situacaoDoGiroscopio().estado).toBe('parado');
});

test('quem assina com o sensor já ligado recebe a descrição do sensor', async () => {
  const primeira = assinarGiroscopio({taxaHz: 100, aoReceber: () => {}});
  await Promise.resolve();

  let descricoes = 0;
  const segunda = assinarGiroscopio({
    taxaHz: 200,
    aoReceber: () => {},
    aoIniciar: () => {
      descricoes += 1;
    },
  });
  await Promise.resolve();

  expect(descricoes).toBe(1);
  // Um listener nativo só: a taxa de quem chegou depois não reregistra o sensor.
  expect(duble.iniciadoCom).toEqual([100]);

  primeira.cancelar();
  segunda.cancelar();
  expect(duble.paradas).toBe(1);
});

test('falha avisada pelo nativo derruba a medição como se `iniciar` tivesse rejeitado', async () => {
  const recebidas: AmostraGiroscopio[] = [];
  const avisados: string[] = [];

  assinarGiroscopio({
    taxaHz: 100,
    aoReceber: a => recebidas.push(a),
    aoFalhar: erro => avisados.push(`a:${erro.message}`),
  });
  assinarGiroscopio({
    taxaHz: 100,
    aoReceber: a => recebidas.push(a),
    aoFalhar: erro => avisados.push(`b:${erro.message}`),
  });
  await Promise.resolve();

  DeviceEventEmitter.emit(NOME_DO_EVENTO, amostra(10));
  expect(recebidas).toHaveLength(2);

  // É o que o `onHostResume` emite quando o religar depois do segundo plano é recusado.
  DeviceEventEmitter.emit(NOME_DO_EVENTO_FALHA, {
    codigo: 'REGISTRO_RECUSADO',
    mensagem: 'O sistema recusou religar o giroscópio.',
  });

  // Todos os assinantes vivos ficam sabendo, e ninguém sobra pendurado esperando amostra.
  const esperado = 'REGISTRO_RECUSADO: O sistema recusou religar o giroscópio.';
  expect(avisados).toEqual([`a:${esperado}`, `b:${esperado}`]);
  expect(situacaoDoGiroscopio().estado).toBe('falhou');
  expect(situacaoDoGiroscopio().assinantes).toBe(0);
  expect(duble.paradas).toBe(1);

  DeviceEventEmitter.emit(NOME_DO_EVENTO, amostra(11));
  expect(recebidas).toHaveLength(2);
});

test('depois da falha avisada pelo nativo, a assinatura seguinte religa o sensor', async () => {
  const primeira = assinarGiroscopio({taxaHz: 100, aoReceber: () => {}});
  await Promise.resolve();

  DeviceEventEmitter.emit(NOME_DO_EVENTO_FALHA, {
    codigo: 'REGISTRO_RECUSADO',
    mensagem: 'recusado',
  });
  expect(duble.paradas).toBe(1);

  // A assinatura já morreu com a falha: cancelar depois não pode desligar sensor de mais ninguém.
  primeira.cancelar();
  expect(duble.paradas).toBe(1);

  const recebidas: AmostraGiroscopio[] = [];
  const segunda = assinarGiroscopio({
    taxaHz: 50,
    aoReceber: a => recebidas.push(a),
  });
  await Promise.resolve();

  expect(duble.iniciadoCom).toEqual([100, 50]);
  DeviceEventEmitter.emit(NOME_DO_EVENTO, amostra(20));
  expect(recebidas).toHaveLength(1);

  segunda.cancelar();
  expect(duble.paradas).toBe(2);
});

test('falha do nativo durante partida reiniciada desliga o sensor que o desfecho descartado ligou', async () => {
  // O encadeamento da sugestão 1 da r3: partida pendente reiniciada por troca de taxa, e o religar
  // do segundo plano recusado no meio. Os dois `iniciar()` chegam a registrar o sensor no nativo,
  // mas o desfecho deles é descartado por `tentativaDePartida`. Sem o `parar()` da falha, o sensor
  // ficaria registrado com zero consumidores no JS.
  const primeira = assinarGiroscopio({taxaHz: 100, aoReceber: () => {}});
  primeira.cancelar();
  let falha: Error | null = null;
  assinarGiroscopio({
    taxaHz: 200,
    aoReceber: () => {},
    aoFalhar: erro => {
      falha = erro;
    },
  });
  expect(duble.iniciadoCom).toEqual([100, 200]);

  DeviceEventEmitter.emit(NOME_DO_EVENTO_FALHA, {
    codigo: 'REGISTRO_RECUSADO',
    mensagem: 'recusado',
  });

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(falha).not.toBeNull();
  expect(situacaoDoGiroscopio().estado).toBe('falhou');
  expect(situacaoDoGiroscopio().assinantes).toBe(0);
  // O que importa: depois do último `iniciar`, houve um `parar` — o sensor não ficou preso.
  expect(duble.chamadas).toEqual(['iniciar:100', 'iniciar:200', 'parar']);
});

test('o desligamento da falha vem antes do aviso: quem assina de novo no aviso fica ligado', async () => {
  duble.falharAoIniciar = true;
  let novaAssinatura: {cancelar(): void} | null = null;

  assinarGiroscopio({
    taxaHz: 100,
    aoReceber: () => {},
    aoFalhar: () => {
      // A tela poderia tentar de novo na hora. O `iniciar()` desta tentativa precisa sair
      // **depois** do `parar()` da falha, senão a falha desligaria a tentativa nova.
      duble.falharAoIniciar = false;
      novaAssinatura = assinarGiroscopio({taxaHz: 50, aoReceber: () => {}});
    },
  });

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(duble.chamadas).toEqual(['iniciar:100', 'parar', 'iniciar:50']);
  expect(situacaoDoGiroscopio().estado).toBe('ligado');
  expect(novaAssinatura).not.toBeNull();
});

test('falha do nativo com corpo fora do formato vira mensagem legível', async () => {
  const avisados: string[] = [];
  assinarGiroscopio({
    taxaHz: 100,
    aoReceber: () => {},
    aoFalhar: erro => avisados.push(erro.message),
  });
  await Promise.resolve();

  // O `RCTDeviceEventEmitter` é global: um corpo sem `codigo`/`mensagem` não pode virar
  // "undefined: undefined" na tela.
  DeviceEventEmitter.emit(NOME_DO_EVENTO_FALHA, {});

  expect(avisados).toHaveLength(1);
  expect(avisados[0]).toMatch(/^FALHA_DESCONHECIDA: /);
  expect(avisados[0]).not.toContain('undefined');
  expect(situacaoDoGiroscopio().estado).toBe('falhou');
  expect(duble.paradas).toBe(1);
});

test('assinar com outra taxa durante a partida pendente reinicia o sensor na taxa nova', async () => {
  // Sequência real da tela: tocar em "Iniciar medição" a 100 Hz e trocar para 200 Hz antes de a
  // promessa nativa resolver. Sem reiniciar, mediria a 100 Hz com a tela mostrando alvo de 200.
  const primeira = assinarGiroscopio({taxaHz: 100, aoReceber: () => {}});
  primeira.cancelar();

  let periodoInformadoUs = 0;
  const segunda = assinarGiroscopio({
    taxaHz: 200,
    aoReceber: () => {},
    aoIniciar: info => {
      periodoInformadoUs = info.periodoUs;
    },
  });

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(duble.iniciadoCom).toEqual([100, 200]);
  expect(periodoInformadoUs).toBe(5000);
  expect(situacaoDoGiroscopio().estado).toBe('ligado');

  segunda.cancelar();
});

test('sem módulo nativo, avisa em vez de estourar', () => {
  delete NativeModules.Giroscopio;
  let falha: Error | null = null;

  const assinatura = assinarGiroscopio({
    taxaHz: 100,
    aoReceber: () => {},
    aoFalhar: erro => {
      falha = erro;
    },
  });
  assinatura.cancelar();

  expect(falha).not.toBeNull();
  expect((falha as unknown as Error).message).toContain('Giroscopio');
});
