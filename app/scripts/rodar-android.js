#!/usr/bin/env node
/**
 * Compila, instala e abre o app Controle num Android pelo cabo USB — um comando só (ATI-024).
 *
 * Em ordem: monta o JDK que passa no bloqueio desta máquina, compila o APK de depuração, instala
 * no aparelho, encaminha as portas 8081 (Metro) e 8765 (servidor) pelo cabo, sobe o Metro neste
 * mesmo terminal e abre o app. Ctrl+C encerra o Metro.
 *
 * Por que existe em vez de `npx react-native run-android`: nesta máquina o controle de aplicações
 * barra o `Selector.open()` do Java em quase todo JDK instalado, e o 18.0.2 é o que passa. O
 * run-android chama o Gradle com o JDK do ambiente e sem as duas chaves de `CHAVES_DO_GRADLE`, e
 * não encaminha a porta do servidor — sozinho, ele não chega ao app aberto e conectado.
 *
 * Em máquina sem o bloqueio, o caminho oficial (JDK 17 + run-android) continua valendo: este
 * script só muda o que vai na linha de comando do Gradle, nunca o projeto.
 *
 * Uso, de dentro de `app/`:
 *   npm run android:cabo
 *   npm run android:cabo -- --sem-compilar --sem-metro
 *   node scripts/rodar-android.js --ajuda
 *
 * Sem dependência externa de propósito, como o `server/scripts/adb-reverse.mjs`: é ferramenta de
 * bancada e precisa rodar antes de qualquer coisa estar configurada.
 */

const { spawn, spawnSync } = require('node:child_process');
const { existsSync, readFileSync, statSync } = require('node:fs');
const { get: getHttp } = require('node:http');
const { connect } = require('node:net');
const { delimiter, join } = require('node:path');

const PACOTE = 'com.nortedata.controle';
const ATIVIDADE = `${PACOTE}/.MainActivity`;
const PORTA_METRO = 8081;
/** Lado do celular: é o endereço fixo do app (`URL_PADRAO` em src/transporte/conexao.ts). */
const PORTA_SERVIDOR_NO_CELULAR = 8765;
const JDK_PADRAO_WINDOWS = 'C:\\Program Files\\Java\\jdk-18.0.2';
const PRAZO_DO_METRO_MS = 90000;
/** Quanto esperar depois do `am start` antes de conferir se o processo do app ainda está vivo. */
const ESPERA_ANTES_DE_CONFERIR_MS = 5000;

/**
 * As duas chaves que fazem o build passar nesta máquina (ATI-024, "Resolvido em 2026-10-13"):
 * - o React Native força toolchain Java 17, e o worker daemon que o Gradle abre no JDK 17 é
 *   barrado; esta chave oficial desliga a exigência e o javac roda no próprio daemon (JDK 18);
 * - o Kotlin reclama da diferença de alvo entre javac e kotlinc que sobra disso; vira aviso.
 */
const CHAVES_DO_GRADLE = [
  '-Preact.internal.disableJavaVersionAlignment=true',
  '-Pkotlin.jvm.target.validation.mode=warning',
];

const AJUDA = `Uso: node scripts/rodar-android.js [opções]

  --aparelho <serial>       qual aparelho usar (obrigatório só com mais de um conectado)
  --java-home <pasta>       JDK do Gradle (padrão: CONTROLE_JAVA_HOME ou ${JDK_PADRAO_WINDOWS})
  --sem-compilar            pula o Gradle e instala o APK que já existe
  --todas-as-arquiteturas   compila as 4 ABIs (padrão: só a do aparelho, como --active-arch-only)
  --sem-metro               não sobe o Metro (use se ele já roda em outro terminal)
  --porta-do-servidor <n>   porta do servidor NO PC para onde vai o 8765 do celular (padrão 8765)
  --ajuda                   mostra esta ajuda`;

// ------------------------------------------------------------------------------------------------
// Peças puras (testadas em __tests__/rodarAndroid.test.ts)
// ------------------------------------------------------------------------------------------------

/** Lê a linha de comando. Lança `Error` com mensagem legível quando algo não faz sentido. */
function lerArgumentos(argumentos) {
  const opcoes = {
    aparelho: '',
    javaHome: '',
    semCompilar: false,
    todasAsArquiteturas: false,
    semMetro: false,
    portaDoServidor: PORTA_SERVIDOR_NO_CELULAR,
    ajuda: false,
  };
  const valorDe = (indice, nome) => {
    const valor = argumentos[indice + 1];
    if (valor === undefined || valor.startsWith('--')) {
      throw new Error(`a opção ${nome} precisa de um valor`);
    }
    return valor;
  };

  for (let indice = 0; indice < argumentos.length; indice += 1) {
    const argumento = argumentos[indice];
    switch (argumento) {
      case '--aparelho':
        opcoes.aparelho = valorDe(indice, argumento);
        indice += 1;
        break;
      case '--java-home':
        opcoes.javaHome = valorDe(indice, argumento);
        indice += 1;
        break;
      case '--porta-do-servidor': {
        const bruto = valorDe(indice, argumento);
        const porta = Number(bruto);
        if (!Number.isInteger(porta) || porta < 1 || porta > 65535) {
          throw new Error(
            `porta do servidor inválida: ${bruto} (inteiro de 1 a 65535)`,
          );
        }
        opcoes.portaDoServidor = porta;
        indice += 1;
        break;
      }
      case '--sem-compilar':
        opcoes.semCompilar = true;
        break;
      case '--todas-as-arquiteturas':
        opcoes.todasAsArquiteturas = true;
        break;
      case '--sem-metro':
        opcoes.semMetro = true;
        break;
      case '--ajuda':
      case '-h':
      case '--help':
        opcoes.ajuda = true;
        break;
      default:
        throw new Error(`opção desconhecida: ${argumento}`);
    }
  }
  return opcoes;
}

/**
 * Tira o `sdk.dir` de um `local.properties`.
 *
 * Em `.properties` a barra invertida é escape: `D\:\\Android\\Sdk` quer dizer `D:\Android\Sdk`, e
 * `D\:\Android\Sdk` (sem dobrar) vira `D:AndroidSdk` — foi o erro da ATI-001 que esta atividade
 * desfez. Aqui só se desfaz o escape bem formado; o resto fica como está.
 */
function lerSdkDir(conteudo) {
  for (const linha of conteudo.split(/\r?\n/)) {
    const achado = /^\s*sdk\.dir\s*[=:]\s*(.+?)\s*$/.exec(linha);
    if (achado !== null) {
      return achado[1].replace(/\\(.)/g, '$1');
    }
  }
  return null;
}

/**
 * As ABIs que o projeto compila, tiradas de `reactNativeArchitectures` no gradle.properties.
 *
 * Lidas do arquivo, e não copiadas para cá: se alguém tirar uma ABI de lá, o script não pode
 * continuar pedindo ao Gradle uma arquitetura que o projeto não compila.
 */
function lerArquiteturas(conteudo) {
  const achado = /^\s*reactNativeArchitectures\s*=\s*(.+?)\s*$/m.exec(conteudo);
  if (achado === null) {
    return [];
  }
  return achado[1]
    .split(',')
    .map(abi => abi.trim())
    .filter(abi => abi !== '');
}

/** Lê a saída de `adb devices`: uma linha `<serial>\t<estado>` por aparelho, depois do cabeçalho. */
function lerAparelhos(saida) {
  const aparelhos = [];
  for (const linha of saida.split(/\r?\n/)) {
    const texto = linha.trim();
    if (
      texto === '' ||
      texto.startsWith('List of devices') ||
      texto.startsWith('*')
    ) {
      continue;
    }
    const [serial, estado] = texto.split(/\s+/);
    if (serial !== undefined && estado !== undefined) {
      aparelhos.push({ serial, estado });
    }
  }
  return aparelhos;
}

/** Explica, para gente, por que um aparelho não serve. `null` quando ele serve. */
function explicarEstado(serial, estado) {
  switch (estado) {
    case 'device':
      return null;
    case 'unauthorized':
      return `o aparelho ${serial} ainda não autorizou este PC: aceite o aviso "Permitir depuração USB?" na tela dele e rode de novo.`;
    case 'offline':
      return `o aparelho ${serial} está offline: reconecte o cabo (ou rode "adb kill-server").`;
    default:
      return `o aparelho ${serial} está no estado "${estado}", que não serve para instalar.`;
  }
}

/**
 * Escolhe o aparelho. Devolve `{serial}` ou `{erro}` — nunca adivinha quando há mais de um, porque
 * instalar no aparelho errado é pior do que pedir o serial.
 */
function escolherAparelho(aparelhos, pedido) {
  if (aparelhos.length === 0) {
    return {
      erro:
        'nenhum aparelho visível pelo adb. Confira: cabo de dados (não só de carga), ' +
        '"Depuração USB" ligada nas opções do desenvolvedor e o aviso "Permitir depuração USB?" aceito.',
    };
  }
  const vistos = aparelhos.map(({ serial, estado }) => `${serial} (${estado})`);
  let escolhido;
  if (pedido !== '') {
    escolhido = aparelhos.find(({ serial }) => serial === pedido);
    if (escolhido === undefined) {
      return {
        erro: `o aparelho ${pedido} não aparece no adb. Vistos: ${vistos.join(
          ', ',
        )}`,
      };
    }
  } else if (aparelhos.length > 1) {
    return {
      erro: `há ${
        aparelhos.length
      } aparelhos conectados; escolha um com --aparelho <serial>: ${vistos.join(
        ', ',
      )}`,
    };
  } else {
    escolhido = aparelhos[0];
  }
  const problema = explicarEstado(escolhido.serial, escolhido.estado);
  return problema === null ? { serial: escolhido.serial } : { erro: problema };
}

/**
 * Monta o ambiente do Gradle com o JDK escolhido na frente do PATH.
 *
 * No Windows a variável costuma se chamar `Path`; criar um `PATH` ao lado dela deixaria duas
 * entradas com o mesmo nome no filho, e qual vale passa a depender de ordenação. Por isso a chave
 * existente é reaproveitada.
 */
function ambienteComJdk(ambiente, javaHome) {
  const novo = { ...ambiente, JAVA_HOME: javaHome };
  const chaveDoPath =
    Object.keys(novo).find(chave => chave.toUpperCase() === 'PATH') ?? 'PATH';
  const atual = novo[chaveDoPath] ?? '';
  novo[chaveDoPath] =
    join(javaHome, 'bin') + (atual === '' ? '' : delimiter + atual);
  return novo;
}

// ------------------------------------------------------------------------------------------------
// Efeitos
// ------------------------------------------------------------------------------------------------

const raizDoApp = join(__dirname, '..');
const pastaAndroid = join(raizDoApp, 'android');
const caminhoDoApk = join(
  pastaAndroid,
  'app',
  'build',
  'outputs',
  'apk',
  'debug',
  'app-debug.apk',
);

/** Metro que ESTE script subiu; é o único processo que ele encerra. */
let metro;

function passo(texto) {
  console.log(`\n==> ${texto}`);
}

function aviso(texto) {
  console.log(`  ! ${texto}`);
}

function falhar(texto) {
  console.error(`\nERRO: ${texto}`);
  encerrarMetro();
  process.exit(1);
}

function encerrarMetro() {
  if (metro !== undefined && metro.exitCode === null && !metro.killed) {
    metro.kill();
  }
}

/** Roda e devolve `{codigo, saida}` com stdout e stderr juntos; nunca lança. */
function rodar(comando, argumentos) {
  const resultado = spawnSync(comando, argumentos, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (resultado.error !== undefined) {
    return { codigo: -1, saida: resultado.error.message };
  }
  return {
    codigo: resultado.status ?? -1,
    saida: `${resultado.stdout ?? ''}${resultado.stderr ?? ''}`.trim(),
  };
}

function acharAdb() {
  const raizes = [];
  // O local.properties é o que o Gradle usa; o adb vindo do mesmo SDK mantém os dois de acordo.
  const localProperties = join(pastaAndroid, 'local.properties');
  if (existsSync(localProperties)) {
    const sdk = lerSdkDir(readFileSync(localProperties, 'utf8'));
    if (sdk !== null) {
      raizes.push(sdk);
    }
  }
  for (const variavel of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const valor = process.env[variavel];
    if (typeof valor === 'string' && valor !== '') {
      raizes.push(valor);
    }
  }
  const executavel = process.platform === 'win32' ? 'adb.exe' : 'adb';
  for (const raiz of raizes) {
    const candidato = join(raiz, 'platform-tools', executavel);
    if (existsSync(candidato)) {
      return candidato;
    }
  }
  return null;
}

/** Porta aberta no PC? Conexão TCP crua com prazo curto. */
function portaAberta(porta) {
  return new Promise(resolver => {
    const socket = connect({ host: '127.0.0.1', port: porta });
    const terminar = aberta => {
      socket.destroy();
      resolver(aberta);
    };
    socket.setTimeout(500, () => terminar(false));
    socket.once('connect', () => terminar(true));
    socket.once('error', () => terminar(false));
  });
}

/** O Metro responde `packager-status:running` em /status — o mesmo teste que o app faz ao abrir. */
function metroRespondendo() {
  return new Promise(resolver => {
    const pedido = getHttp(
      { host: '127.0.0.1', port: PORTA_METRO, path: '/status', timeout: 2000 },
      resposta => {
        let corpo = '';
        resposta.setEncoding('utf8');
        resposta.on('data', pedaco => {
          corpo += pedaco;
        });
        resposta.on('end', () =>
          resolver(corpo.includes('packager-status:running')),
        );
      },
    );
    pedido.on('timeout', () => pedido.destroy());
    pedido.on('error', () => resolver(false));
  });
}

const esperar = ms => new Promise(resolver => setTimeout(resolver, ms));

async function principal() {
  let opcoes;
  try {
    opcoes = lerArgumentos(process.argv.slice(2));
  } catch (erro) {
    console.error(`${erro.message}\n\n${AJUDA}`);
    process.exit(1);
  }
  if (opcoes.ajuda) {
    console.log(AJUDA);
    return;
  }

  // Ctrl+C chega ao Metro também (mesmo console); aqui só se garante que ele não fica órfão.
  process.on('SIGINT', () => {
    encerrarMetro();
    process.exit(130);
  });

  // 1. Ferramentas -------------------------------------------------------------------------------
  passo('Ferramentas');
  const javaHome =
    opcoes.javaHome ||
    process.env.CONTROLE_JAVA_HOME ||
    (process.platform === 'win32'
      ? JDK_PADRAO_WINDOWS
      : process.env.JAVA_HOME ?? '');
  const java = join(
    javaHome,
    'bin',
    process.platform === 'win32' ? 'java.exe' : 'java',
  );
  if (!opcoes.semCompilar && !existsSync(java)) {
    falhar(
      `não achei o JDK em "${javaHome}". Nesta máquina o Gradle só passa no bloqueio com o ` +
        'JDK 18.0.2; aponte outro com --java-home ou com a variável CONTROLE_JAVA_HOME.',
    );
  }
  console.log(
    `  JDK: ${opcoes.semCompilar ? '(não usado: --sem-compilar)' : javaHome}`,
  );

  const adb = acharAdb();
  if (adb === null) {
    falhar(
      'não achei o adb: nem sdk.dir em android/local.properties, nem ANDROID_HOME/ANDROID_SDK_ROOT ' +
        'apontando para um SDK com platform-tools. Exemplo de local.properties: sdk.dir=D:/Android/Sdk',
    );
  }
  console.log(`  adb: ${adb}`);

  // 2. Aparelho ----------------------------------------------------------------------------------
  passo('Aparelho');
  const lista = rodar(adb, ['devices']);
  if (lista.codigo !== 0) {
    falhar(`o "adb devices" falhou: ${lista.saida}`);
  }
  const escolha = escolherAparelho(lerAparelhos(lista.saida), opcoes.aparelho);
  if (escolha.erro !== undefined) {
    falhar(escolha.erro);
  }
  const { serial } = escolha;
  const noAparelho = argumentos => rodar(adb, ['-s', serial, ...argumentos]);
  const propriedade = nome => noAparelho(['shell', 'getprop', nome]).saida;
  const abi = propriedade('ro.product.cpu.abi');
  console.log(
    `  ${serial} — ${propriedade('ro.product.model')}, Android ${propriedade(
      'ro.build.version.release',
    )}, ABI ${abi}`,
  );

  // 3. Compilar ----------------------------------------------------------------------------------
  if (opcoes.semCompilar) {
    passo('Compilação pulada (--sem-compilar)');
  } else {
    const argumentosDoGradle = ['assembleDebug', ...CHAVES_DO_GRADLE];
    const abisDoProjeto = lerArquiteturas(
      readFileSync(join(pastaAndroid, 'gradle.properties'), 'utf8'),
    );
    if (!abisDoProjeto.includes(abi)) {
      // Nem com as quatro ABIs adiantaria: o APK sairia sem biblioteca nativa para este aparelho.
      falhar(
        `a ABI "${abi}" do aparelho não está em reactNativeArchitectures ` +
          `(android/gradle.properties: ${abisDoProjeto.join(', ')}).`,
      );
    }
    if (!opcoes.todasAsArquiteturas) {
      argumentosDoGradle.push(`-PreactNativeArchitectures=${abi}`);
    }
    passo(`Compilando: gradlew ${argumentosDoGradle.join(' ')}`);
    console.log(
      '  (a primeira vez leva alguns minutos; as seguintes, bem menos)',
    );

    // No Windows o wrapper é um .bat, e o Node só abre .bat por meio do shell. As chaves são
    // constantes deste arquivo e a ABI só passa se for idêntica a uma das do gradle.properties:
    // nada arbitrário chega ao shell. O `.\` é obrigatório: com `NoDefaultCurrentDirectoryInExePath`
    // no ambiente (comum em terminal de ferramenta), o cmd não procura executável na pasta atual.
    const windows = process.platform === 'win32';
    const gradle = spawnSync(
      windows
        ? ['.\\gradlew.bat', ...argumentosDoGradle].join(' ')
        : './gradlew',
      windows ? [] : argumentosDoGradle,
      {
        cwd: pastaAndroid,
        stdio: 'inherit',
        shell: windows,
        env: ambienteComJdk(process.env, javaHome),
      },
    );
    if (gradle.status !== 0) {
      falhar(
        `o Gradle falhou (código ${
          gradle.status ?? gradle.error?.message
        }). Se a mensagem for ` +
          '"Unable to establish loopback connection", o JDK em uso está sendo barrado — veja ' +
          'docs/plano-acao/atividade/ATI-024.md.',
      );
    }
  }

  if (!existsSync(caminhoDoApk)) {
    falhar(`não há APK em "${caminhoDoApk}". Rode sem --sem-compilar.`);
  }

  // 4. Instalar ----------------------------------------------------------------------------------
  const megabytes = (statSync(caminhoDoApk).size / (1024 * 1024)).toFixed(1);
  passo(`Instalando app-debug.apk (${megabytes} MB)`);
  const instalacao = noAparelho(['install', '-r', caminhoDoApk]);
  if (instalacao.codigo !== 0 || !instalacao.saida.includes('Success')) {
    falhar(`o "adb install" falhou: ${instalacao.saida}`);
  }
  console.log('  instalado.');

  // 5. Portas pelo cabo --------------------------------------------------------------------------
  passo('Encaminhando portas pelo cabo (adb reverse)');
  const encaminhamentos = [
    { celular: PORTA_METRO, pc: PORTA_METRO, papel: 'Metro' },
    {
      celular: PORTA_SERVIDOR_NO_CELULAR,
      pc: opcoes.portaDoServidor,
      papel: 'servidor',
    },
  ];
  for (const { celular, pc, papel } of encaminhamentos) {
    const resultado = noAparelho(['reverse', `tcp:${celular}`, `tcp:${pc}`]);
    if (resultado.codigo !== 0) {
      falhar(`o "adb reverse" da porta ${celular} falhou: ${resultado.saida}`);
    }
    console.log(
      `  celular 127.0.0.1:${celular} -> PC 127.0.0.1:${pc} (${papel})`,
    );
  }
  if (!(await portaAberta(opcoes.portaDoServidor))) {
    aviso(
      `nada escutando na porta ${opcoes.portaDoServidor} deste PC: o app abre, mas fica tentando ` +
        'conectar. Em outro terminal: cd server; npm run dev',
    );
  }

  // 6. Metro -------------------------------------------------------------------------------------
  if (await metroRespondendo()) {
    passo(`Metro já está rodando na porta ${PORTA_METRO} — vou usar esse`);
  } else if (await portaAberta(PORTA_METRO)) {
    falhar(
      `a porta ${PORTA_METRO} está ocupada por algo que não responde como Metro. ` +
        'Feche o que estiver nela e rode de novo.',
    );
  } else if (opcoes.semMetro) {
    aviso(
      'Metro fora do ar e --sem-metro pedido: o app vai abrir na tela vermelha de ' +
        '"sem servidor de desenvolvimento".',
    );
  } else {
    passo('Subindo o Metro neste terminal');
    // O CLI direto (e não `npm start`): o processo guardado aqui precisa ser o próprio Metro, e
    // não um invólucro do npm — é ele que tem de morrer quando este script acabar.
    metro = spawn(
      process.execPath,
      [join('node_modules', 'react-native', 'cli.js'), 'start'],
      { cwd: raizDoApp, stdio: 'inherit' },
    );
    const limite = Date.now() + PRAZO_DO_METRO_MS;
    while (!(await metroRespondendo())) {
      if (metro.exitCode !== null) {
        falhar(
          `o Metro encerrou ao subir (código ${metro.exitCode}); a saída dele está acima.`,
        );
      }
      if (Date.now() > limite) {
        falhar(
          `o Metro não respondeu em ${
            PRAZO_DO_METRO_MS / 1000
          } s em http://127.0.0.1:${PORTA_METRO}/status.`,
        );
      }
      await esperar(500);
    }
    console.log(`  Metro de pé (PID ${metro.pid}).`);
  }

  // 7. Abrir o app -------------------------------------------------------------------------------
  passo(`Abrindo ${ATIVIDADE}`);
  const abertura = noAparelho(['shell', 'am', 'start', '-n', ATIVIDADE]);
  // O `am start` devolve 0 mesmo quando não acha a activity; o erro vem escrito na saída.
  if (abertura.codigo !== 0 || /^Error/m.test(abertura.saida)) {
    falhar(`não consegui abrir o app: ${abertura.saida}`);
  }
  console.log('  aberto.');

  // Com a tela bloqueada o Android abre a activity por trás do bloqueio: o app está lá, mas
  // ninguém vê — e a primeira suspeita seria o build.
  if (
    /isKeyguardShowing=true/.test(
      noAparelho(['shell', 'dumpsys', 'window']).saida,
    )
  ) {
    aviso('a tela do celular está bloqueada: desbloqueie para ver o app.');
  }

  // Um app que morre ao abrir some sem aviso nenhum no PC; conferir o processo pega o caso.
  await esperar(ESPERA_ANTES_DE_CONFERIR_MS);
  if (noAparelho(['shell', 'pidof', PACOTE]).saida === '') {
    aviso(
      `o processo do app não está vivo ${
        ESPERA_ANTES_DE_CONFERIR_MS / 1000
      } s depois de abrir. Veja o motivo com: ` +
        'adb logcat -d -s AndroidRuntime:E ReactNativeJS:V ReactNative:V',
    );
  }

  if (metro === undefined) {
    console.log('\nPronto.');
    return;
  }
  console.log(
    '\nPronto. O Metro segue rodando neste terminal — Ctrl+C encerra.',
  );
  console.log(
    '  Salvar um arquivo do app recarrega sozinho (Fast Refresh). Recarga completa: agite o celular > Reload.',
  );
  metro.on('exit', codigo => process.exit(codigo ?? 0));
}

module.exports = {
  ATIVIDADE,
  CHAVES_DO_GRADLE,
  PACOTE,
  ambienteComJdk,
  escolherAparelho,
  explicarEstado,
  lerAparelhos,
  lerArgumentos,
  lerArquiteturas,
  lerSdkDir,
};

// Rodar só quando chamado como programa: o teste importa as peças puras sem disparar nada.
if (require.main === module) {
  principal().catch(erro => falhar(erro?.stack ?? String(erro)));
}
