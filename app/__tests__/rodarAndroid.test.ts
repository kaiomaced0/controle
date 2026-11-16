/**
 * @format
 *
 * Peças puras do `scripts/rodar-android.js` (ATI-024): o que decide em qual aparelho instalar,
 * de onde vem o adb e com que JDK o Gradle roda. O resto do script é efeito (adb, Gradle, Metro)
 * e foi verificado com o aparelho de verdade — ver docs/plano-acao/entregas/ATI-024-v1.md.
 */

import {
  ATIVIDADE,
  CHAVES_DO_GRADLE,
  ambienteComJdk,
  escolherAparelho,
  lerAparelhos,
  lerArgumentos,
  lerArquiteturas,
  lerSdkDir,
} from '../scripts/rodar-android';

describe('lerArgumentos', () => {
  it('sem nada, usa os padrões do modo cabo', () => {
    expect(lerArgumentos([])).toEqual({
      aparelho: '',
      javaHome: '',
      semCompilar: false,
      todasAsArquiteturas: false,
      semMetro: false,
      portaDoServidor: 8765,
      ajuda: false,
    });
  });

  it('lê as opções com e sem valor', () => {
    const opcoes = lerArgumentos([
      '--aparelho',
      'RQ8N209ND8Z',
      '--java-home',
      'C:\\Program Files\\Java\\jdk-18.0.2',
      '--sem-compilar',
      '--todas-as-arquiteturas',
      '--sem-metro',
      '--porta-do-servidor',
      '8770',
    ]);
    expect(opcoes).toMatchObject({
      aparelho: 'RQ8N209ND8Z',
      javaHome: 'C:\\Program Files\\Java\\jdk-18.0.2',
      semCompilar: true,
      todasAsArquiteturas: true,
      semMetro: true,
      portaDoServidor: 8770,
    });
  });

  it('recusa opção desconhecida, valor faltando e porta fora da faixa', () => {
    expect(() => lerArgumentos(['--depressa'])).toThrow(/desconhecida/);
    expect(() => lerArgumentos(['--aparelho'])).toThrow(/precisa de um valor/);
    expect(() => lerArgumentos(['--aparelho', '--sem-metro'])).toThrow(
      /precisa de um valor/,
    );
    expect(() => lerArgumentos(['--porta-do-servidor', '0'])).toThrow(
      /inválida/,
    );
    expect(() => lerArgumentos(['--porta-do-servidor', '8765.5'])).toThrow(
      /inválida/,
    );
  });
});

describe('lerSdkDir', () => {
  it('aceita barra normal, que é o que o local.properties desta máquina usa', () => {
    expect(lerSdkDir('sdk.dir=D:/Android/Sdk\n')).toBe('D:/Android/Sdk');
  });

  it('desfaz o escape de .properties bem formado', () => {
    expect(
      lerSdkDir('## comentário\r\nsdk.dir=D\\:\\\\Android\\\\Sdk\r\n'),
    ).toBe('D:\\Android\\Sdk');
  });

  it('reproduz o erro da ATI-001: barra simples some, como no Java', () => {
    expect(lerSdkDir('sdk.dir=D\\:\\Android\\Sdk')).toBe('D:AndroidSdk');
  });

  it('devolve null sem sdk.dir', () => {
    expect(lerSdkDir('ndk.dir=D:/Android/Ndk\n')).toBeNull();
  });
});

describe('lerAparelhos e escolherAparelho', () => {
  const SAIDA_REAL = 'List of devices attached\r\nRQ8N209ND8Z\tdevice\r\n\r\n';

  it('lê a saída real do adb devices com o S20', () => {
    expect(lerAparelhos(SAIDA_REAL)).toEqual([
      { serial: 'RQ8N209ND8Z', estado: 'device' },
    ]);
  });

  it('ignora as linhas do daemon do adb subindo', () => {
    const saida =
      '* daemon not running; starting now at tcp:5037\n' +
      '* daemon started successfully\n' +
      'List of devices attached\n' +
      'emulator-5554\toffline\n';
    expect(lerAparelhos(saida)).toEqual([
      { serial: 'emulator-5554', estado: 'offline' },
    ]);
  });

  it('com um aparelho pronto, escolhe ele sem precisar de serial', () => {
    expect(escolherAparelho(lerAparelhos(SAIDA_REAL), '')).toEqual({
      serial: 'RQ8N209ND8Z',
    });
  });

  it('nenhum aparelho: explica o que conferir', () => {
    expect(escolherAparelho([], '').erro).toMatch(/Depuração USB/);
  });

  it('dois aparelhos sem serial: não adivinha', () => {
    const resultado = escolherAparelho(
      [
        { serial: 'A', estado: 'device' },
        { serial: 'B', estado: 'device' },
      ],
      '',
    );
    expect(resultado.erro).toMatch(/--aparelho/);
    expect(resultado.serial).toBeUndefined();
  });

  it('dois aparelhos com serial: usa o pedido', () => {
    expect(
      escolherAparelho(
        [
          { serial: 'A', estado: 'device' },
          { serial: 'B', estado: 'device' },
        ],
        'B',
      ),
    ).toEqual({ serial: 'B' });
  });

  it('serial pedido que não está conectado', () => {
    expect(
      escolherAparelho([{ serial: 'A', estado: 'device' }], 'Z').erro,
    ).toMatch(/não aparece/);
  });

  it('não autorizado: manda aceitar o aviso na tela', () => {
    expect(
      escolherAparelho([{ serial: 'A', estado: 'unauthorized' }], '').erro,
    ).toMatch(/Permitir depuração USB/);
  });
});

describe('ambienteComJdk', () => {
  it('põe o JDK na frente do Path existente, sem criar um PATH duplicado', () => {
    const ambiente = ambienteComJdk(
      { Path: 'C:\\Windows', OUTRA: 'x' },
      'C:\\jdk-18',
    );
    expect(ambiente.JAVA_HOME).toBe('C:\\jdk-18');
    expect(ambiente.Path?.startsWith('C:\\jdk-18')).toBe(true);
    expect(ambiente.Path?.endsWith('C:\\Windows')).toBe(true);
    expect(
      Object.keys(ambiente).filter(c => c.toUpperCase() === 'PATH'),
    ).toEqual(['Path']);
    expect(ambiente.OUTRA).toBe('x');
  });

  it('sem PATH nenhum, cria um só com o JDK', () => {
    const ambiente = ambienteComJdk({}, '/opt/jdk-18');
    expect(ambiente.PATH).toMatch(/jdk-18/);
  });
});

describe('constantes que precisam bater com o projeto', () => {
  it('a activity é a do AndroidManifest e do MainActivity.kt', () => {
    expect(ATIVIDADE).toBe('com.nortedata.controle/.MainActivity');
  });

  it('as chaves do Gradle são as registradas na ATI-024', () => {
    expect(CHAVES_DO_GRADLE).toEqual([
      '-Preact.internal.disableJavaVersionAlignment=true',
      '-Pkotlin.jvm.target.validation.mode=warning',
    ]);
  });
});

describe('lerArquiteturas', () => {
  it('lê a lista no formato do gradle.properties do projeto', () => {
    const propriedades =
      '# comentário\nandroid.useAndroidX=true\n' +
      'reactNativeArchitectures=armeabi-v7a,arm64-v8a,x86,x86_64\nnewArchEnabled=true\n';
    expect(lerArquiteturas(propriedades)).toEqual([
      'armeabi-v7a',
      'arm64-v8a',
      'x86',
      'x86_64',
    ]);
  });

  it('tolera espaços e fim de linha CRLF', () => {
    expect(
      lerArquiteturas('reactNativeArchitectures = arm64-v8a , x86_64 \r\n'),
    ).toEqual(['arm64-v8a', 'x86_64']);
  });

  it('sem a chave, lista vazia — e o script recusa compilar', () => {
    expect(lerArquiteturas('hermesEnabled=true\n')).toEqual([]);
  });
});
