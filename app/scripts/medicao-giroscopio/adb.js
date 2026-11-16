/**
 * Acesso ao adb para o roteiro de medição: onde ele está e como chamá-lo.
 *
 * Procura na mesma ordem do `scripts/rodar-android.js` (ATI-024): o `sdk.dir` do
 * `android/local.properties`, depois `ANDROID_HOME`/`ANDROID_SDK_ROOT`, e por fim o `adb` do PATH.
 * A variável `ADB` passa por cima de tudo, para quem precisar apontar outro.
 */

const {Buffer} = require('node:buffer');
const {spawn} = require('node:child_process');
const {existsSync, readFileSync} = require('node:fs');
const {join} = require('node:path');

const {lerSdkDir} = require('../rodar-android');

const PASTA_ANDROID = join(__dirname, '..', '..', 'android');

function acharAdb(ambiente = process.env) {
  if (typeof ambiente.ADB === 'string' && ambiente.ADB !== '') {
    return ambiente.ADB;
  }
  const raizes = [];
  const localProperties = join(PASTA_ANDROID, 'local.properties');
  if (existsSync(localProperties)) {
    const sdk = lerSdkDir(readFileSync(localProperties, 'utf8'));
    if (sdk !== null) {
      raizes.push(sdk);
    }
  }
  for (const variavel of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const valor = ambiente[variavel];
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
  return 'adb';
}

/**
 * Roda um comando do adb e devolve código, saída e erro — nunca rejeita: quem chama decide o que
 * uma falha significa. `serial` vazio fala com o único aparelho conectado.
 */
function executarAdb(adb, serial, argumentos, {binario = false} = {}) {
  const completos = serial ? ['-s', serial, ...argumentos] : argumentos;
  return new Promise(resolver => {
    const filho = spawn(adb, completos, {windowsHide: true});
    const pedacos = [];
    const erros = [];
    filho.stdout.on('data', pedaco => pedacos.push(pedaco));
    filho.stderr.on('data', pedaco => erros.push(pedaco));
    filho.on('error', erro =>
      resolver({codigo: -1, saida: binario ? Buffer.alloc(0) : '', erro: String(erro.message)}),
    );
    filho.on('close', codigo => {
      const saida = Buffer.concat(pedacos);
      resolver({
        codigo: codigo ?? -1,
        saida: binario ? saida : saida.toString('utf8'),
        erro: Buffer.concat(erros).toString('utf8'),
      });
    });
  });
}

module.exports = {acharAdb, executarAdb};
