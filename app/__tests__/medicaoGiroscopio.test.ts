/**
 * Peças puras do roteiro de medição da ATI-003 (`scripts/medicao-giroscopio/`): leitura da tela, do
 * logcat e do `dumpsys sensorservice`, e a regra de decisão do critério 4.
 *
 * Os trechos de `dumpsys` abaixo são do próprio S20+ (SM-G985F), salvos na rodada 4 — o formato que
 * o roteiro vai encontrar, e não um formato imaginado. O XML do `uiautomator` segue o formato do
 * dump do Android, com os textos da tela de medição.
 *
 * @format
 */

import {
  LIMIAR_PONTE_MS as LIMIAR_PONTE_DO_APP,
  LIMIAR_TAXA_HZ as LIMIAR_TAXA_DO_APP,
} from '../src/sensores/acumuladoDaMedicao';
import {
  LIMIAR_PONTE_MS,
  LIMIAR_TAXA_HZ,
  avaliarFase,
  decidirEnvio,
  desescaparXml,
  janelasDistintas,
  lerAcumuladoDaTela,
  lerCadenciaDoHal,
  lerCapturas,
  lerConexoesDoApp,
  lerJanelaDaTela,
  lerReversos,
  lerTextosDaInterface,
  paraNumero,
  resumirJanelas,
} from '../scripts/medicao-giroscopio/leitura';
import {lerArgumentos, nomeDaPasta} from '../scripts/medicao-giroscopio/medir';
import {lerArgumentos as lerArgumentosDaEspera} from '../scripts/medicao-giroscopio/esperar-aparelho';

function no(texto: string, x1: number, y1: number, x2: number, y2: number): string {
  return (
    `<node index="0" text="${texto}" resource-id="" class="android.widget.TextView" ` +
    `package="com.nortedata.controle" content-desc="" checkable="false" checked="false" ` +
    `clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" ` +
    `long-clickable="false" password="false" selected="false" bounds="[${x1},${y1}][${x2},${y2}]" />`
  );
}

const XML_DA_TELA =
  "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">" +
  '<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.nortedata.controle" bounds="[0,0][1080,2400]">' +
  no('Telemetria do giroscópio', 45, 380, 600, 440) +
  no('build debug (__DEV__ ligado)', 45, 520, 500, 560) +
  no('Taxa (JS)', 80, 870, 300, 900) +
  no('99.0', 80, 905, 300, 960) +
  no('Hz', 80, 965, 300, 990) +
  no('Maior atraso na ponte', 760, 1140, 1000, 1200) +
  no('41.20', 760, 1210, 1000, 1260) +
  no('ms', 760, 1265, 1000, 1290) +
  no('Acumulado desde o início · alvo 100 Hz', 45, 1350, 700, 1390) +
  no('Janelas contadas', 60, 1410, 400, 1440) +
  no('57', 450, 1410, 520, 1440) +
  no('Descartadas na partida', 560, 1410, 900, 1440) +
  no('1', 960, 1410, 1000, 1440) +
  no('Janelas &lt; 90 Hz', 60, 1450, 400, 1480) +
  no('0', 450, 1450, 520, 1480) +
  no('Janelas ponte &gt; 30 ms', 60, 1530, 400, 1560) +
  no('2', 450, 1530, 520, 1560) +
  no('dt desvio (ms)', 560, 1570, 900, 1600) +
  no('—', 960, 1570, 1000, 1600) +
  '</node></hierarchy>';

/** Um bloco de captura como a TelaGiroscopio escreve (ver também a ida e volta no teste da tela). */
function captura(alvo: number, taxa: string, ponte: string, contadas: number): string[] {
  return [
    'aparelho: samsung SM-G985F · Android 13 (API 33) · build debug (__DEV__ ligado)',
    'sensor: LSM6DSO Gyroscope Sensor (STM) · período pedido 10000 µs · mínimo do sensor 2500 µs',
    `alvo: ${alvo} Hz · condição: parado · janela: 1000 ms`,
    `taxa(JS): ${taxa} Hz · amostras: 100`,
    'dt médio: 10.00 ms · dt desvio: 0.01 ms · dt máximo: 10.04 ms',
    `maior atraso na ponte: ${ponte} ms`,
    `acumulado: alvo ${alvo} Hz · contadas ${contadas} · descartadas na partida 1 · abaixo de 90 Hz 0 · ponte > 30 ms 2`,
    'acumulado taxa: média 99.97 Hz · pior 97.0 Hz',
    'acumulado dt: médio 10.000 ms · desvio 0.004 ms · maior 10.05 ms · maior na ponte 58.63 ms',
  ];
}

const comoLogcatTime = (linhas: string[], hora = '10-14 15:00:01.250') =>
  linhas.map(l => `${hora} I/ReactNativeJS(27684): ${l}`);

// Trechos reais do `dumpsys sensorservice` do S20+ (rodada 4, 13:18).
const DUMPSYS_COM_O_APP = [
  'LSM6DSO Gyroscope Sensor: last 50 events',
  '\t 1 (ts=4661.374538357, wall=10-14 13:18:28.855) -0.43677, -0.23350, -0.07613, ',
  '\t 2 (ts=4661.384538357, wall=10-14 13:18:28.863) -0.43982, -0.20418, -0.08041, ',
  '\t 3 (ts=4661.394538357, wall=10-14 13:18:28.876) -0.42028, -0.10217, -0.09201, ',
  '\t 4 (ts=4661.404538357, wall=10-14 13:18:28.883) -0.37874, 0.00901, -0.09446, ',
  '\t 5 (ts=4661.414538357, wall=10-14 13:18:28.894) -0.29749, 0.09331, -0.08407, ',
  'LPS22H Barometer Sensor: last 50 events',
  '\t 1 (ts=485.493301148, wall=10-14 12:08:52.982) 981.17, 0.00, 0.00, ',
  'Sensor Privacy: disabled',
  '2 active connections',
  'Connection Number: 0 ',
  '\tOperating Mode: NORMAL ',
  '\t hbzh | WakeLockRefCount 0 | uid 10231 | cache size 0 | max cache size 0',
  '\t SAMSUNG Significant Motion Sensor 0x0000000f | status: active | pending flush events 0 ',
  'Connection Number: 1 ',
  '\tOperating Mode: NORMAL ',
  '\t com.nortedata.controle.GiroscopioModule | WakeLockRefCount 0 | uid 10331 | cache size 0 | max cache size 0',
  '\t LSM6DSO Gyroscope Sensor 0x00000002 | status: active | pending flush events 0 ',
  '0 direct connections',
  'Previous Registrations:',
  '10-14 13:19:04.087 - 0x00000029 pid= 3086 uid= 1000 package=com.sec.android.sdhms.thermal.overheatcontrol.OverheatSensorChecker$TypeSensorManager$1 [ TMD4910 Uncalibrated lux Sensor ] ',
  '10-14 13:18:31.303 - 0x00000001 pid=27684 uid=10331 package=com.facebook.react.common.ShakeDetector [ LSM6DSO Acceleration Sensor ] ',
  '10-14 13:18:29.343 - 0x00000002 pid=27684 uid=10331 package=com.nortedata.controle.GiroscopioModule [ LSM6DSO Gyroscope Sensor ] ',
  '10-14 13:18:25.583 + 0x00000002 pid=27684 uid=10331 package=com.nortedata.controle.GiroscopioModule samplingPeriod=10000us batchingPeriod=0us [ LSM6DSO Gyroscope Sensor ] ',
].join('\n');

describe('limiares', () => {
  it('o roteiro e o app usam os mesmos limiares', () => {
    expect(LIMIAR_TAXA_HZ).toBe(LIMIAR_TAXA_DO_APP);
    expect(LIMIAR_PONTE_MS).toBe(LIMIAR_PONTE_DO_APP);
  });
});

describe('leitura da tela (uiautomator)', () => {
  it('desfaz o escape do XML, inclusive < e > dos rótulos', () => {
    expect(desescaparXml('Janelas &lt; 90 Hz &amp; &quot;x&quot; &#233; &#xe9;')).toBe(
      'Janelas < 90 Hz & "x" é é',
    );
  });

  it('lê os textos visíveis na ordem, com o centro de cada um', () => {
    const textos = lerTextosDaInterface(XML_DA_TELA);
    expect(textos[0]).toEqual({
      texto: 'Telemetria do giroscópio',
      idDeRecurso: '',
      x: 323,
      y: 410,
    });
    // O nó raiz, sem texto, não entra.
    expect(textos.map(t => t.texto)).not.toContain('');
  });

  it('lê a janela corrente e o acumulado pelos rótulos; "—" vira null, nunca NaN', () => {
    const textos = lerTextosDaInterface(XML_DA_TELA);
    expect(lerJanelaDaTela(textos)).toEqual({
      taxaHz: 99,
      amostras: null,
      dtMedioMs: null,
      dtDesvioMs: null,
      dtMaximoMs: null,
      intervaloJsMaximoMs: 41.2,
    });
    expect(lerAcumuladoDaTela(textos)).toMatchObject({
      taxaAlvoHz: 100,
      janelasContadas: 57,
      janelasDePartida: 1,
      janelasAbaixoDoLimiarDeTaxa: 0,
      janelasComPonteAcimaDoLimiar: 2,
      dtDesvioMs: null,
      piorTaxaHz: null, // rótulo fora da tela: não lido
    });
  });

  it('sem o cabeçalho do acumulado na tela, não inventa acumulado', () => {
    expect(lerAcumuladoDaTela([{texto: 'Taxa (JS)', idDeRecurso: '', x: 0, y: 0}])).toBeNull();
  });

  it('paraNumero só aceita número de verdade', () => {
    expect(paraNumero('100.6')).toBe(100.6);
    expect(paraNumero('—')).toBeNull();
    expect(paraNumero('')).toBeNull();
    expect(paraNumero('abc')).toBeNull();
  });
});

describe('capturas no logcat', () => {
  it('lê blocos no formato -v time, ignorando o que não é captura', () => {
    const logcat = [
      '--------- beginning of main',
      '10-14 15:00:00.100 D/SensorManager(27684): registerListener :: 2, LSM6DSO Gyroscope Sensor, 10000, 0, ',
      ...comoLogcatTime(captura(100, '100.0', '12.40', 57)),
      '10-14 15:00:01.300 I/ReactNativeJS(27684): outra mensagem qualquer',
      ...comoLogcatTime(captura(200, '199.0', '8.10', 58), '10-14 15:01:05.000'),
    ].join('\r\n');

    const lidas = lerCapturas(logcat);
    expect(lidas).toHaveLength(2);
    expect(lidas[0]).toMatchObject({
      hora: '10-14 15:00:01.250',
      build: 'build debug (__DEV__ ligado)',
      alvoHz: 100,
      condicao: 'parado',
      janela: {taxaHz: 100, amostras: 100, dtMedioMs: 10, dtDesvioMs: 0.01, dtMaximoMs: 10.04, intervaloJsMaximoMs: 12.4},
      acumulado: {
        taxaAlvoHz: 100,
        janelasContadas: 57,
        janelasDePartida: 1,
        janelasAbaixoDoLimiarDeTaxa: 0,
        janelasComPonteAcimaDoLimiar: 2,
        taxaMediaHz: 99.97,
        piorTaxaHz: 97,
        dtMedioMs: 10,
        dtDesvioMs: 0.004,
        maiorDtMs: 10.05,
        maiorAtrasoNaPonteMs: 58.63,
      },
    });
    expect(lidas[1].alvoHz).toBe(200);
  });

  it('lê também o formato -v threadtime', () => {
    const logcat = captura(100, '98.5', '20.00', 10)
      .map(l => `10-14 15:00:01.250 27684 27720 I ReactNativeJS: ${l}`)
      .join('\n');
    expect(lerCapturas(logcat)[0].janela.taxaHz).toBe(98.5);
  });

  it('captura antiga, sem acumulado, vem com acumulado null', () => {
    const antiga = comoLogcatTime(captura(100, '100.6', '58.63', 1).slice(0, 6)).join('\n');
    expect(lerCapturas(antiga)[0].acumulado).toBeNull();
  });

  it('a mesma janela capturada duas vezes conta uma vez', () => {
    const logcat = [
      ...comoLogcatTime(captura(100, '100.0', '12.40', 5)),
      ...comoLogcatTime(captura(100, '100.0', '12.40', 5)),
      ...comoLogcatTime(captura(100, '88.0', '35.00', 6)),
    ].join('\n');
    const distintas = janelasDistintas(lerCapturas(logcat));
    expect(distintas).toHaveLength(2);
    expect(
      resumirJanelas(distintas.map((c: {janela: object}) => c.janela)),
    ).toMatchObject({
      janelas: 2,
      taxaMediaHz: 94,
      piorTaxaHz: 88,
      janelasAbaixoDoLimiarDeTaxa: 1,
      maiorAtrasoNaPonteMs: 35,
      janelasComPonteAcimaDoLimiar: 1,
    });
  });
});

describe('dumpsys sensorservice', () => {
  it('conta a conexão do app e lê os registros com milissegundos e pid alinhado', () => {
    const lido = lerConexoesDoApp(DUMPSYS_COM_O_APP);
    expect(lido.cabecalho).toBe('2 active connections');
    expect(lido.ativas).toBe(1);
    expect(lido.conexoes[0].sensor).toBe('LSM6DSO Gyroscope Sensor 0x00000002');
    expect(lido.registros).toEqual([
      {hora: '13:18:29.343', operacao: 'desregistrou', sensor: '0x00000002', periodoUs: null},
      {hora: '13:18:25.583', operacao: 'registrou', sensor: '0x00000002', periodoUs: 10000},
    ]);
  });

  it('sem o app nas conexões ativas, conta zero', () => {
    const semOApp = DUMPSYS_COM_O_APP.replace(/\t com\.nortedata[^\n]*\n/, '');
    expect(lerConexoesDoApp(semOApp).ativas).toBe(0);
  });

  it('mede a cadência do HAL pelos carimbos do próprio sensorservice', () => {
    const hal = lerCadenciaDoHal(DUMPSYS_COM_O_APP);
    expect(hal).toMatchObject({sensor: 'LSM6DSO Gyroscope Sensor', eventos: 5});
    expect(hal!.dtMedioMs).toBeCloseTo(10, 6);
    expect(hal!.taxaHz).toBeCloseTo(100, 4);
  });

  it('lê o adb reverse --list', () => {
    expect(lerReversos('RQ8N209ND8Z tcp:8081 tcp:8081\nRQ8N209ND8Z tcp:8765 tcp:8770\n')).toEqual({
      'tcp:8081': 'tcp:8081',
      'tcp:8765': 'tcp:8770',
    });
  });
});

describe('regra do critério 4', () => {
  const acumulado = (contadas: number, abaixo: number, comPonte: number) => ({
    taxaAlvoHz: 100,
    janelasContadas: contadas,
    janelasDePartida: 1,
    janelasAbaixoDoLimiarDeTaxa: abaixo,
    janelasComPonteAcimaDoLimiar: comPonte,
  });

  it('passa com cobertura, nenhuma janela abaixo de 90 Hz e ponte dentro do limite', () => {
    const avaliacao = avaliarFase(acumulado(62, 0, 3), 63.5);
    expect(avaliacao).toMatchObject({
      veredito: 'passa',
      janelasContadas: 62,
      minimoDeJanelas: 56,
      limiteDeJanelasComPonte: 3,
    });
  });

  it('uma janela abaixo de 90 Hz já reprova', () => {
    expect(avaliarFase(acumulado(62, 1, 0), 63.5)).toMatchObject({
      veredito: 'falha',
      motivos: ['1 de 62 janelas abaixo de 90 Hz'],
    });
  });

  it('ponte acima de 30 ms em mais de 5 % das janelas reprova', () => {
    expect(avaliarFase(acumulado(62, 0, 4), 63.5).veredito).toBe('falha');
  });

  it('cobertura curta não decide nada, nem para aprovar', () => {
    // 20 janelas numa fase de 63 s: era o caso das leituras avulsas da rodada 5.
    expect(avaliarFase(acumulado(20, 0, 0), 63.5)).toMatchObject({
      veredito: 'inconclusivo',
    });
    expect(avaliarFase(null, 63.5).veredito).toBe('inconclusivo');
  });

  it('decide o envio pela fase de 100 Hz e pelo build', () => {
    const passa = avaliarFase(acumulado(62, 0, 0), 63.5);
    const falha = avaliarFase(acumulado(62, 2, 0), 63.5);
    expect(decidirEnvio(passa, 'build debug (__DEV__ ligado)').decisao).toBe('seguir em JS');
    expect(decidirEnvio(falha, 'build debug (__DEV__ ligado)').decisao).toBe(
      'sem decisão: repetir a série num build release',
    );
    expect(decidirEnvio(falha, 'build release (__DEV__ desligado)').decisao).toBe(
      'abrir ATI de módulo nativo para o envio',
    );
    expect(decidirEnvio(avaliarFase(null, 60), 'build debug').decisao).toBe('sem decisão');
  });
});

describe('linha de comando', () => {
  it('medir: padrões e a porta exclusiva do roteiro', () => {
    expect(lerArgumentos([])).toEqual({
      aparelho: '',
      saida: '',
      portaDoServidor: 8770,
      duracaoS: 60,
      ajuda: false,
    });
    expect(
      lerArgumentos(['--aparelho', 'RQ8N209ND8Z', '--porta-do-servidor', '8765', '--duracao', '90']),
    ).toMatchObject({aparelho: 'RQ8N209ND8Z', portaDoServidor: 8765, duracaoS: 90});
  });

  it('medir: recusa o que não faz sentido', () => {
    expect(() => lerArgumentos(['--duracao', '10'])).toThrow('duração inválida: 10');
    expect(() => lerArgumentos(['--porta-do-servidor'])).toThrow('precisa de um valor');
    expect(() => lerArgumentos(['--mover-cursor'])).toThrow('opção desconhecida');
  });

  it('medir: a pasta de saída tem nome de data e hora', () => {
    expect(nomeDaPasta(new Date(2026, 9, 14, 15, 2, 3))).toBe('2026-10-14_15-02-03');
  });

  it('esperar-aparelho: minutos e serial', () => {
    expect(lerArgumentosDaEspera([])).toEqual({minutos: 15, aparelho: 'RQ8N209ND8Z'});
    expect(lerArgumentosDaEspera(['20', '--aparelho', 'X1'])).toEqual({minutos: 20, aparelho: 'X1'});
  });
});
