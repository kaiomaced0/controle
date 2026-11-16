/**
 * O envio do giroscópio: um MOVIMENTO por amostra, `seq` que anda, retomada anunciada e sensor
 * solto ao parar. O sensor entra por dublê (a opção `assinar`), então nada aqui depende do
 * módulo nativo nem de aparelho.
 *
 * @format
 */

import {
  iniciarEnvioDeMovimento,
  type EnvioDeMovimento,
} from '../src/transporte/envioDeMovimento';
import {
  FLAG_PRIMEIRA_APOS_RETOMAR,
  RESULTADO_DECODIFICACAO,
  TAMANHO_MOVIMENTO,
  TIPO_MOVIMENTO,
  criarDecodificador,
} from '../src/transporte/protocolo';
import type {
  AmostraGiroscopio,
  AssinaturaGiroscopio,
  OpcoesDeAssinatura,
} from '../src/sensores/giroscopio';
import type {Conexao} from '../src/transporte/conexao';

type PacoteVisto = {
  tipo: number;
  seq: number;
  flags: number;
  dtMs: number;
  gx: number;
  gy: number;
  gz: number;
  tamanho: number;
};

/** Conexão de mentira: guarda o que foi enviado e decide se aceita. */
function criarConexaoFalsa(aceitar = true) {
  const decodificador = criarDecodificador();
  const vistos: PacoteVisto[] = [];
  const buffers: Uint8Array[] = [];
  const estado = {aceitar};

  const conexao = {
    url: 'ws://127.0.0.1:8765',
    situacao: () => {
      throw new Error('não usado no teste');
    },
    assinar: () => () => {},
    conectar: () => {},
    desconectar: () => {},
    enviarTexto: () => false,
    contadores: () => decodificador.contadores,
    enviarBinario(pacote: Uint8Array) {
      if (!estado.aceitar) {
        return false;
      }
      buffers.push(pacote);
      const resultado = decodificador.decodificar(pacote);
      expect(resultado).toBe(RESULTADO_DECODIFICACAO.OK);
      const saida = decodificador.saida;
      vistos.push({
        tipo: saida.tipo,
        seq: saida.seq,
        flags: saida.flags,
        dtMs: saida.dtMs,
        gx: saida.gx,
        gy: saida.gy,
        gz: saida.gz,
        tamanho: saida.tamanho,
      });
      return true;
    },
  } as unknown as Conexao;

  return {conexao, vistos, buffers, estado};
}

/** Sensor de mentira: o teste manda a amostra na hora que quiser. */
function criarSensorFalso() {
  const controle = {
    emitir: (_amostra: AmostraGiroscopio) => {},
    cancelamentos: 0,
    assinaturas: 0,
    taxaPedida: 0,
  };

  const assinar = (opcoes: OpcoesDeAssinatura): AssinaturaGiroscopio => {
    controle.assinaturas += 1;
    controle.taxaPedida = opcoes.taxaHz;
    controle.emitir = opcoes.aoReceber;
    return {
      cancelar() {
        controle.cancelamentos += 1;
        controle.emitir = () => {};
      },
    };
  };

  return {assinar, controle};
}

function amostra(
  dtMs: number,
  gx = 0.1,
  gy = -0.2,
  gz = 0.3,
): AmostraGiroscopio {
  return {gx, gy, gz, tDispositivoMs: 60000 + dtMs, dtMs};
}

let envio: EnvioDeMovimento | null = null;

afterEach(() => {
  envio?.parar();
  envio = null;
});

test('empacota cada amostra como MOVIMENTO de 24 bytes, com os valores crus do sensor', () => {
  const {conexao, vistos} = criarConexaoFalsa();
  const sensor = criarSensorFalso();

  envio = iniciarEnvioDeMovimento({conexao, assinar: sensor.assinar});
  sensor.controle.emitir(amostra(0));
  sensor.controle.emitir(amostra(10, 1.5, -0.25, 0.5));

  expect(sensor.controle.taxaPedida).toBe(100);
  expect(vistos).toHaveLength(2);
  expect(vistos[0].tipo).toBe(TIPO_MOVIMENTO);
  expect(vistos[0].tamanho).toBe(TAMANHO_MOVIMENTO);
  // f32 no fio: 1.5, -0.25 e 0.5 são exatos em binário, então a ida e volta bate na igualdade.
  expect(vistos[1].gx).toBe(1.5);
  expect(vistos[1].gy).toBe(-0.25);
  expect(vistos[1].gz).toBe(0.5);
  expect(vistos[1].dtMs).toBe(10);
});

test('o seq começa em 0 e anda de um em um', () => {
  const {conexao, vistos} = criarConexaoFalsa();
  const sensor = criarSensorFalso();

  envio = iniciarEnvioDeMovimento({conexao, assinar: sensor.assinar});
  sensor.controle.emitir(amostra(0));
  sensor.controle.emitir(amostra(10));
  sensor.controle.emitir(amostra(10));

  expect(vistos.map(p => p.seq)).toEqual([0, 1, 2]);
  expect(envio.contadores.ultimoSeq).toBe(2);
});

test('a primeira amostra se anuncia com o bit de retomada; a seguinte, não', () => {
  const {conexao, vistos} = criarConexaoFalsa();
  const sensor = criarSensorFalso();

  envio = iniciarEnvioDeMovimento({conexao, assinar: sensor.assinar});
  sensor.controle.emitir(amostra(0));
  sensor.controle.emitir(amostra(10));

  expect(vistos[0].flags).toBe(FLAG_PRIMEIRA_APOS_RETOMAR);
  expect(vistos[1].flags).toBe(0);
});

test('pacote recusado conta em recusados e faz o próximo anunciar a retomada', () => {
  const {conexao, vistos, estado} = criarConexaoFalsa();
  const sensor = criarSensorFalso();

  envio = iniciarEnvioDeMovimento({conexao, assinar: sensor.assinar});
  sensor.controle.emitir(amostra(0));
  sensor.controle.emitir(amostra(10));

  // Canal caiu: nada mais é aceito.
  estado.aceitar = false;
  sensor.controle.emitir(amostra(10));
  sensor.controle.emitir(amostra(10));

  // Canal voltou.
  estado.aceitar = true;
  sensor.controle.emitir(amostra(10));

  expect(envio.contadores.amostras).toBe(5);
  expect(envio.contadores.enviados).toBe(3);
  expect(envio.contadores.recusados).toBe(2);
  expect(envio.contadores.bytes).toBe(3 * TAMANHO_MOVIMENTO);
  // O `seq` não volta atrás: os pacotes perdidos gastaram número, e é assim que o servidor
  // enxerga o buraco.
  expect(vistos.map(p => p.seq)).toEqual([0, 1, 4]);
  // O primeiro pacote que passa depois do buraco avisa que o `dt` não vale contra o passado.
  expect(vistos[2].flags).toBe(FLAG_PRIMEIRA_APOS_RETOMAR);
});

test('não aloca por amostra: o buffer do codificador é sempre o mesmo', () => {
  const {conexao, buffers} = criarConexaoFalsa();
  const sensor = criarSensorFalso();

  envio = iniciarEnvioDeMovimento({conexao, assinar: sensor.assinar});
  sensor.controle.emitir(amostra(0));
  sensor.controle.emitir(amostra(10));

  expect(buffers[0]).toBe(buffers[1]);
});

test('avisa a interface a cada amostra, dizendo se ela saiu', () => {
  const {conexao, estado} = criarConexaoFalsa();
  const sensor = criarSensorFalso();
  const avisos: boolean[] = [];

  envio = iniciarEnvioDeMovimento({
    conexao,
    assinar: sensor.assinar,
    aoReceberAmostra: (_amostra, enviada) => avisos.push(enviada),
  });
  sensor.controle.emitir(amostra(0));
  estado.aceitar = false;
  sensor.controle.emitir(amostra(10));

  expect(avisos).toEqual([true, false]);
});

test('parar solta o sensor e nada mais sai depois disso', () => {
  const {conexao, vistos} = criarConexaoFalsa();
  const sensor = criarSensorFalso();

  const ligado = iniciarEnvioDeMovimento({conexao, assinar: sensor.assinar});
  sensor.controle.emitir(amostra(0));
  ligado.parar();
  sensor.controle.emitir(amostra(10));

  expect(sensor.controle.cancelamentos).toBe(1);
  expect(vistos).toHaveLength(1);
});
