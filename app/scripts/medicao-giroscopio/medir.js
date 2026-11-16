#!/usr/bin/env node
/**
 * Roteiro de medição da ATI-003 no aparelho: taxa e jitter do giroscópio nativo como o JS os vê,
 * fase a fase, e as provas dos critérios 1 e 2 pelo `dumpsys sensorservice`.
 *
 * Uso, de dentro de `app/`, com o aparelho no cabo, desbloqueado e o app aberto na aba Medição
 * (tela no topo, sem rolar):
 *   1. Metro:     npm start                                        (porta 8081)
 *   2. Servidor:  cd ../server && CONTROLE_PORTA=8770 npm run dev  (só a fase de envio usa)
 *   3. Medir:     node scripts/medicao-giroscopio/medir.js [opções]
 *   4. Analisar:  node scripts/medicao-giroscopio/analisar.js [pasta]
 *
 * Opções:
 *   --aparelho <serial>        obrigatório só com mais de um aparelho no adb
 *   --saida <pasta>            padrão: <tmp>/controle-medicao-giroscopio/<data-hora> (fora do repo)
 *   --porta-do-servidor <n>    porta NO PC para onde vai o 8765 do celular (padrão 8770)
 *   --duracao <s>              duração das fases A e C (padrão 60)
 *
 * Fases (tudo com o aparelho "parado"; quem mede é a tela do app, não este roteiro):
 *   A  100 Hz por `duracao` s, sem instrumento na linha de JS. Toque num texto sem ação a cada 8 s
 *      só para a tela não apagar; prints e leitura da tela em 3 momentos (5 s, 30 s, fim - 4 s).
 *      No fim, um toque em "Capturar leitura": a captura traz o ACUMULADO da fase inteira.
 *   B  100 Hz por 30 s, medição reiniciada, com toque em "Capturar leitura" a cada 1 s: a série
 *      janela a janela no logcat, e o custo do instrumento (comparar com A).
 *   C  200 Hz por `duracao` s, como A.
 *   D  critério 2: `KEYCODE_HOME`, 10 s em segundo plano, `am start`; conexões do app no
 *      sensorservice antes, durante e depois, prints e a tela de volta medindo.
 *   E  critério 1: troca para a aba Envio com a medição ligada (a tela de medição desmonta) e
 *      conexões do app antes e depois; liga e desliga o envio; volta à Medição.
 *
 * Por que o número sai do acumulado (parecer r5 da ATI-003, importante 3): a tela mostra só a janela
 * corrente, e ler a tela de fora enxerga uma janela em cada tantas — a regra "nenhuma janela abaixo
 * de 90 Hz" contada só sobre as vistas puxa o resultado para aprovar. O acumulado conta toda janela
 * fechada desde o início da medição e diz de quantas janelas cada número saiu; ele é lido uma vez,
 * no fim da fase, pela captura no logcat (e conferido com a tela).
 *
 * Limites, de propósito:
 * - Só toca DENTRO do app: antes de cada toque, no mesmo `adb shell`, confere que o foco é o app;
 *   se não for, aborta sem tocar. Nunca desbloqueia, não muda configuração do aparelho, não abre
 *   outro app. O único `am start` é o do próprio app. O PC não é tocado (cursor fica de fora).
 * - Prints por `exec-out screencap` (nada fica gravado no aparelho); o XML do `uiautomator` é
 *   apagado do aparelho logo depois de lido.
 * - O `adb reverse` da 8765 é devolvido ao que era no fim, inclusive com Ctrl+C.
 *
 * Os textos da tela que este roteiro procura estão em `textos-da-tela.js` (com a origem de cada um).
 */

const {spawn} = require('node:child_process');
const {appendFileSync, createWriteStream, mkdirSync, writeFileSync} = require('node:fs');
const {connect} = require('node:net');
const {tmpdir} = require('node:os');
const {join} = require('node:path');

const {escolherAparelho, lerAparelhos} = require('../rodar-android');
const {acharAdb, executarAdb} = require('./adb');
const leitura = require('./leitura');
const {ATIVIDADE, PACOTE, ROTULOS_DO_ACUMULADO, TEXTOS} = require('./textos-da-tela');

const PORTA_METRO = 8081;
/** Lado do celular: o endereço é fixo no app (`URL_PADRAO` em src/transporte/conexao.ts). */
const PORTA_DO_APP = 8765;
/** Lado do PC: porta exclusiva do roteiro, para não disputar a 8765 com outro servidor. */
const PORTA_DO_SERVIDOR_PADRAO = 8770;
const DURACAO_PADRAO_S = 60;
const DURACAO_COM_CAPTURA_MS = 30000;
const PRAZO_DESBLOQUEIO_MS = 15 * 60 * 1000;
const INTERVALO_DO_TOQUE_NEUTRO_MS = 8000;
const PRAZO_DA_CAPTURA_MS = 6000;
const PASTA_BASE = join(tmpdir(), 'controle-medicao-giroscopio');

const AJUDA = `Uso: node scripts/medicao-giroscopio/medir.js [opções]

  --aparelho <serial>       obrigatório só com mais de um aparelho no adb
  --saida <pasta>           onde gravar (padrão: ${PASTA_BASE}/<data-hora>)
  --porta-do-servidor <n>   porta do servidor NO PC para onde vai o ${PORTA_DO_APP} do celular (padrão ${PORTA_DO_SERVIDOR_PADRAO})
  --duracao <s>             duração das fases A e C, em segundos (padrão ${DURACAO_PADRAO_S})
  --ajuda                   mostra esta ajuda`;

// ------------------------------------------------------------------------------------------------
// Peças puras (testadas em __tests__/medicaoGiroscopio.test.ts)
// ------------------------------------------------------------------------------------------------

function lerArgumentos(argumentos) {
  const opcoes = {
    aparelho: '',
    saida: '',
    portaDoServidor: PORTA_DO_SERVIDOR_PADRAO,
    duracaoS: DURACAO_PADRAO_S,
    ajuda: false,
  };
  const valorDe = (indice, nome) => {
    const valor = argumentos[indice + 1];
    if (valor === undefined || valor.startsWith('--')) {
      throw new Error(`a opção ${nome} precisa de um valor`);
    }
    return valor;
  };
  const inteiroEntre = (bruto, nome, minimo, maximo) => {
    const valor = Number(bruto);
    if (!Number.isInteger(valor) || valor < minimo || valor > maximo) {
      throw new Error(`${nome}: ${bruto} (inteiro de ${minimo} a ${maximo})`);
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
      case '--saida':
        opcoes.saida = valorDe(indice, argumento);
        indice += 1;
        break;
      case '--porta-do-servidor':
        opcoes.portaDoServidor = inteiroEntre(valorDe(indice, argumento), 'porta inválida', 1, 65535);
        indice += 1;
        break;
      case '--duracao':
        // Abaixo de 35 s os três momentos (5 s, 30 s, fim - 4 s) saem de ordem.
        opcoes.duracaoS = inteiroEntre(valorDe(indice, argumento), 'duração inválida', 35, 600);
        indice += 1;
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

/** Nome de pasta a partir da hora local: 2026-10-14_15-02-33. */
function nomeDaPasta(data) {
  const dois = n => String(n).padStart(2, '0');
  return (
    `${data.getFullYear()}-${dois(data.getMonth() + 1)}-${dois(data.getDate())}_` +
    `${dois(data.getHours())}-${dois(data.getMinutes())}-${dois(data.getSeconds())}`
  );
}

// ------------------------------------------------------------------------------------------------
// Efeitos
// ------------------------------------------------------------------------------------------------

class Abortar extends Error {}

const esperar = ms => new Promise(resolver => setTimeout(resolver, ms));

function portaAberta(porta) {
  return new Promise(resolver => {
    const soquete = connect({host: '127.0.0.1', port: porta});
    const fim = aberta => {
      soquete.destroy();
      resolver(aberta);
    };
    soquete.setTimeout(1500, () => fim(false));
    soquete.once('connect', () => fim(true));
    soquete.once('error', () => fim(false));
  });
}

class Sessao {
  constructor(adb, serial, saida) {
    this.adb = adb;
    this.serial = serial;
    this.saida = saida;
    this.t0 = Date.now();
    this.logcat = '';
    this.processoDoLogcat = null;
    this.resumo = {
      versaoDoRoteiro: 'ATI-003 rodada 6',
      inicio: new Date().toISOString(),
      aparelho: serial,
      fases: {},
      conexoes: {},
      ocorrencias: [],
    };
  }

  registrar(...partes) {
    const linha = `${new Date().toISOString()} +${((Date.now() - this.t0) / 1000).toFixed(1)}s ${partes.join(' ')}`;
    console.log(linha);
    appendFileSync(join(this.saida, 'medir.log'), linha + '\n');
  }

  ocorrencia(texto) {
    this.resumo.ocorrencias.push(texto);
    this.registrar('OCORRÊNCIA:', texto);
  }

  chamarAdb(argumentos, opcoes) {
    return executarAdb(this.adb, this.serial, argumentos, opcoes);
  }

  salvarResumo() {
    writeFileSync(join(this.saida, 'resumo.json'), JSON.stringify(this.resumo, null, 2));
  }

  async estadoDaTela() {
    const {saida} = await this.chamarAdb([
      'shell',
      "dumpsys window | grep -E 'mCurrentFocus|isKeyguardShowing'; dumpsys power | grep -E 'mWakefulness='",
    ]);
    return {
      bloqueado: /isKeyguardShowing=true/.test(saida),
      acordado: /mWakefulness=Awake/.test(saida),
      foco: ((/mCurrentFocus=(.*)/.exec(saida) ?? [])[1] ?? '?').trim(),
    };
  }

  /** Espera alguém desbloquear com o app em foco. Desbloqueado no launcher, abre o próprio app. */
  async esperarDesbloqueio() {
    let ultimo = '';
    const inicio = Date.now();
    while (Date.now() - inicio < PRAZO_DESBLOQUEIO_MS) {
      const estado = await this.estadoDaTela();
      const resumo = `bloqueado=${estado.bloqueado} acordado=${estado.acordado} foco=${estado.foco}`;
      if (resumo !== ultimo) {
        this.registrar('tela:', resumo);
        ultimo = resumo;
      }
      if (!estado.bloqueado && estado.acordado) {
        if (estado.foco.includes(PACOTE)) {
          await esperar(2000);
          const confirmacao = await this.estadoDaTela();
          if (!confirmacao.bloqueado && confirmacao.acordado && confirmacao.foco.includes(PACOTE)) {
            this.registrar('desbloqueado com o app em foco');
            return true;
          }
          continue;
        }
        if (estado.foco.toLowerCase().includes('launcher')) {
          this.registrar('desbloqueado na tela inicial: abrindo o app');
          await this.chamarAdb(['shell', 'am', 'start', '-n', ATIVIDADE]);
          await esperar(3000);
          continue;
        }
      }
      await esperar(3000);
    }
    return false;
  }

  /** Textos visíveis na tela. Guarda o XML com `nome`, se vier. */
  async lerInterface(nome = null, tentativas = 3) {
    for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
      const {saida} = await this.chamarAdb([
        'shell',
        'uiautomator dump /sdcard/controle-ui.xml >/dev/null 2>&1; cat /sdcard/controle-ui.xml; rm -f /sdcard/controle-ui.xml',
      ]);
      if (saida.includes('<hierarchy')) {
        if (nome !== null) {
          writeFileSync(join(this.saida, `ui-${nome}.xml`), saida);
        }
        return {textos: leitura.lerTextosDaInterface(saida)};
      }
      this.registrar(`uiautomator falhou (tentativa ${tentativa}):`, saida.slice(0, 120).replace(/\s+/g, ' '));
      await esperar(800);
    }
    return null;
  }

  /** Toca no ponto só se o foco do aparelho for o app; senão aborta tudo. */
  async tocar(ponto, rotulo) {
    if (!ponto) {
      throw new Abortar(`sem coordenada para "${rotulo}"`);
    }
    const {saida} = await this.chamarAdb([
      'shell',
      `if dumpsys window displays | grep -q 'mCurrentFocus.*${PACOTE}'; then input tap ${ponto.x} ${ponto.y}; echo TOQUE; else echo FORA; fi`,
    ]);
    if (!saida.includes('TOQUE')) {
      throw new Abortar(`foco fora do app ao tocar "${rotulo}"`);
    }
  }

  /**
   * Toca no texto como ele está na tela agora: confere que o botão diz o que se espera. Se a tela
   * foi lida e o texto não está lá, o app não está no estado que o roteiro supõe (o botão de
   * medição alterna entre iniciar e parar) — tocar assim mesmo faria o contrário do pedido, então
   * aborta. Só quando a leitura da tela em si falha é que vale o ponto guardado na preparação: os
   * botões não mudam de lugar.
   */
  async tocarTexto(texto, pontoDeReserva) {
    const ui = await this.lerInterface(null, 2);
    if (ui !== null) {
      const achado = leitura.acharTexto(ui.textos, texto);
      if (achado === null) {
        throw new Abortar(`"${texto}" não está na tela: o app não está no estado esperado`);
      }
      await this.tocar(achado, texto);
      return;
    }
    if (pontoDeReserva === undefined) {
      throw new Abortar(`a tela não foi lida e não há ponto guardado para "${texto}"`);
    }
    this.registrar(`a tela não foi lida; tocando "${texto}" no ponto da preparação`);
    await this.tocar(pontoDeReserva, texto);
  }

  async print(nome) {
    const r = await this.chamarAdb(['exec-out', 'screencap', '-p'], {binario: true});
    writeFileSync(join(this.saida, `${nome}.png`), r.saida);
    this.registrar('print', `${nome}.png`, `${r.saida.length} bytes`);
  }

  /** Conexões do app no sensorservice (e a cadência do HAL), guardadas sob `nome`. */
  async sensores(nome) {
    const r = await this.chamarAdb(['shell', 'dumpsys', 'sensorservice']);
    writeFileSync(join(this.saida, `sensorservice-${nome}.txt`), r.saida);
    const conexoes = leitura.lerConexoesDoApp(r.saida);
    const hal = leitura.lerCadenciaDoHal(r.saida);
    this.resumo.conexoes[nome] = {
      ativas: conexoes.ativas,
      conexoes: conexoes.conexoes,
      ultimosRegistros: conexoes.registros.slice(0, 3),
      hal,
    };
    const ultimo = conexoes.registros[0];
    this.registrar(
      `sensorservice ${nome}: conexões do app = ${conexoes.ativas}`,
      ultimo ? `| último registro: ${ultimo.hora} ${ultimo.operacao} ${ultimo.periodoUs ?? ''}` : '',
    );
    return conexoes;
  }

  iniciarLogcat() {
    const filho = spawn(
      this.adb,
      ['-s', this.serial, 'logcat', '-v', 'time', '-T', '1', '-s',
        'ReactNativeJS:V', 'ReactNative:V', 'Giroscopio:V', 'SensorManager:D', 'AndroidRuntime:E'],
      {windowsHide: true},
    );
    filho.stdout.setEncoding('utf8');
    const arquivo = createWriteStream(join(this.saida, 'logcat.txt'));
    filho.stdout.on('data', pedaco => {
      this.logcat += pedaco;
      arquivo.write(pedaco);
    });
    this.processoDoLogcat = filho;
  }

  encerrarLogcat() {
    this.processoDoLogcat?.kill();
    this.processoDoLogcat = null;
  }

  quantasCapturas() {
    return leitura.lerCapturas(this.logcat).length;
  }

  /** Espera a captura que o toque acabou de pedir aparecer no logcat. */
  async esperarCapturaNova(antes) {
    const inicio = Date.now();
    while (Date.now() - inicio < PRAZO_DA_CAPTURA_MS) {
      const capturas = leitura.lerCapturas(this.logcat);
      // A captura só está inteira quando a linha seguinte ao bloco já chegou ou o bloco tem o
      // acumulado completo; esperar um pouco depois de vê-la evita ler meio bloco.
      if (capturas.length > antes && capturas[capturas.length - 1].acumulado !== null) {
        await esperar(300);
        return leitura.lerCapturas(this.logcat).slice(-1)[0];
      }
      await esperar(250);
    }
    return null;
  }

  /** Uma fase sem instrumento: só o toque neutro (tela acesa), prints e leituras nos momentos. */
  async faseSemInstrumento(fase, duracaoMs, pontoNeutro) {
    const inicio = Date.now();
    const momentos = [5000, 30000, duracaoMs - 4000];
    const registros = [];
    let proximoToque = inicio + INTERVALO_DO_TOQUE_NEUTRO_MS;
    while (Date.now() - inicio < duracaoMs) {
      if (Date.now() >= proximoToque) {
        await this.tocar(pontoNeutro, 'texto sem ação');
        proximoToque += INTERVALO_DO_TOQUE_NEUTRO_MS;
      }
      if (momentos.length > 0 && Date.now() - inicio >= momentos[0]) {
        const emMs = momentos.shift();
        const nome = `${fase}-t${String(Math.round(emMs / 1000)).padStart(2, '0')}s`;
        await this.print(nome);
        const ui = await this.lerInterface(nome);
        registros.push({
          segundos: Number(((Date.now() - inicio) / 1000).toFixed(1)),
          print: `${nome}.png`,
          janela: ui === null ? null : leitura.lerJanelaDaTela(ui.textos),
          acumulado: ui === null ? null : leitura.lerAcumuladoDaTela(ui.textos),
        });
        this.registrar(`${fase} momento ${nome}:`, JSON.stringify(registros[registros.length - 1].janela));
      }
      const alvos = [proximoToque, inicio + duracaoMs];
      if (momentos.length > 0) {
        alvos.push(inicio + momentos[0]);
      }
      await esperar(Math.max(50, Math.min(...alvos) - Date.now()));
    }
    return registros;
  }

  /**
   * Fim de fase: um toque em "Capturar leitura" e a captura lida do logcat (com o acumulado da fase
   * inteira), conferida com o que a tela mostra no mesmo instante.
   */
  async capturarNoFim(fase, inicioDaMedicao, pontoDeCaptura, alvoHz) {
    const antes = this.quantasCapturas();
    const instante = Date.now();
    await this.tocar(pontoDeCaptura, TEXTOS.capturarLeitura);
    const captura = await this.esperarCapturaNova(antes);
    const ui = await this.lerInterface(`${fase}-fim`);
    await this.print(`${fase}-fim`);
    const segundos = (instante - inicioDaMedicao) / 1000;
    const daTela = ui === null ? null : leitura.lerAcumuladoDaTela(ui.textos);

    if (captura === null) {
      this.ocorrencia(`${fase}: a captura final não apareceu no logcat em ${PRAZO_DA_CAPTURA_MS} ms`);
    } else if (captura.acumulado?.taxaAlvoHz !== alvoHz) {
      this.ocorrencia(`${fase}: a captura final é de ${captura.acumulado?.taxaAlvoHz} Hz, e não de ${alvoHz} Hz`);
    }
    const acumulado = captura?.acumulado ?? daTela;
    const avaliacao = leitura.avaliarFase(acumulado, segundos);
    this.registrar(
      `${fase} FIM: ${segundos.toFixed(1)} s desde o início da medição | acumulado (${captura ? 'logcat' : 'tela'}):`,
      JSON.stringify(acumulado),
      `| ${avaliacao.veredito}`,
      avaliacao.motivos.join('; '),
    );
    return {
      segundosDesdeOInicio: Number(segundos.toFixed(1)),
      fonteDoAcumulado: captura ? 'logcat' : daTela ? 'tela' : 'nenhuma',
      captura,
      acumuladoNaTela: daTela,
      janelaNaTela: ui === null ? null : leitura.lerJanelaDaTela(ui.textos),
      avaliacao,
    };
  }

  /** Trecho de comparação: toque em "Capturar leitura" a cada 1 s (o instrumento da rodada 4). */
  async faseComCaptura(fase, duracaoMs, pontoDeCaptura) {
    const capturasDe = this.quantasCapturas();
    const inicio = Date.now();
    let toques = 0;
    while (Date.now() - inicio < duracaoMs) {
      const falta = inicio + toques * 1000 - Date.now();
      if (falta > 0) {
        await esperar(falta);
      }
      await this.tocar(pontoDeCaptura, TEXTOS.capturarLeitura);
      toques += 1;
    }
    await esperar(1500);
    const capturasAte = this.quantasCapturas();
    this.registrar(`${fase}: ${toques} toques, ${capturasAte - capturasDe} capturas no logcat`);
    return {toques, capturasDe, capturasAte};
  }
}

async function principal() {
  let opcoes;
  try {
    opcoes = lerArgumentos(process.argv.slice(2));
  } catch (erro) {
    console.error(`${erro.message}\n\n${AJUDA}`);
    process.exitCode = 1;
    return;
  }
  if (opcoes.ajuda) {
    console.log(AJUDA);
    return;
  }

  const adb = acharAdb();
  const aparelhos = lerAparelhos((await executarAdb(adb, '', ['devices'])).saida);
  const escolha = escolherAparelho(aparelhos, opcoes.aparelho);
  if (escolha.erro) {
    console.error(`medir: ${escolha.erro}`);
    process.exitCode = 1;
    return;
  }
  const saida = opcoes.saida || join(PASTA_BASE, nomeDaPasta(new Date()));
  mkdirSync(saida, {recursive: true});
  const s = new Sessao(adb, escolha.serial, saida);
  s.registrar(`aparelho ${escolha.serial}; saída em ${saida}`);

  // O 8765 do celular volta a apontar para onde apontava antes — inclusive com Ctrl+C.
  const reversosAntes = leitura.lerReversos((await s.chamarAdb(['reverse', '--list'])).saida);
  const devolverReverso = async () => {
    const anterior = reversosAntes[`tcp:${PORTA_DO_APP}`];
    const r = anterior
      ? await s.chamarAdb(['reverse', `tcp:${PORTA_DO_APP}`, anterior])
      : await s.chamarAdb(['reverse', '--remove', `tcp:${PORTA_DO_APP}`]);
    s.registrar(`adb reverse tcp:${PORTA_DO_APP} devolvido para ${anterior ?? '(nenhum)'}:`, r.codigo);
  };
  let encerrando = false;
  process.once('SIGINT', () => {
    if (encerrando) {
      return;
    }
    encerrando = true;
    s.registrar('Ctrl+C: encerrando');
    s.encerrarLogcat();
    s.salvarResumo();
    devolverReverso().finally(() => process.exit(130));
  });

  try {
    const propriedades = await s.chamarAdb([
      'shell',
      'getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.version.sdk',
    ]);
    s.resumo.propriedades = propriedades.saida.trim().split(/\r?\n/);

    s.registrar('esperando o aparelho desbloqueado com o app em foco (até 15 min)');
    if (!(await s.esperarDesbloqueio())) {
      throw new Abortar('PRAZO ESGOTADO: o aparelho não foi desbloqueado com o app em foco');
    }

    for (const [celular, pc] of [[PORTA_METRO, PORTA_METRO], [PORTA_DO_APP, opcoes.portaDoServidor]]) {
      const r = await s.chamarAdb(['reverse', `tcp:${celular}`, `tcp:${pc}`]);
      s.registrar(`adb reverse tcp:${celular} -> tcp:${pc}:`, r.codigo, r.erro.trim());
    }
    if (!(await portaAberta(PORTA_METRO))) {
      throw new Abortar(`o Metro não responde na ${PORTA_METRO}: rode "npm start" em app/ e recarregue o app`);
    }
    s.resumo.servidorNoPc = (await portaAberta(opcoes.portaDoServidor))
      ? `ouvindo na ${opcoes.portaDoServidor}`
      : `nada na ${opcoes.portaDoServidor} (a fase de envio liga o sensor do mesmo jeito)`;
    s.registrar('servidor no PC:', s.resumo.servidorNoPc);

    s.iniciarLogcat();
    await esperar(1500);

    // --- Preparação ------------------------------------------------------------------------------
    let ui = await s.lerInterface('00-inicial');
    if (ui === null) {
      throw new Abortar('o uiautomator não devolveu a tela');
    }
    const aba = leitura.acharTexto(ui.textos, TEXTOS.abaMedicao);
    if (aba !== null) {
      await s.tocar(aba, TEXTOS.abaMedicao);
      await esperar(800);
      ui = (await s.lerInterface('00-medicao')) ?? ui;
    }
    if (leitura.acharTexto(ui.textos, TEXTOS.pararMedicao) !== null) {
      s.registrar('a medição já estava ligada; parando para começar do zero');
      await s.tocar(leitura.acharTexto(ui.textos, TEXTOS.pararMedicao), TEXTOS.pararMedicao);
      await esperar(1000);
      ui = (await s.lerInterface('00-parado')) ?? ui;
    }
    const build = leitura.acharTextoQueComeca(ui.textos, TEXTOS.prefixoDoBuild);
    if (build === null || leitura.acharTextoQueComeca(ui.textos, TEXTOS.cabecalhoDoAcumulado) === null) {
      throw new Abortar(
        'a linha "build ..." ou o "Acumulado" não estão na tela: o app não carregou o JS desta ' +
          'versão (recarregue com o Metro de pé) ou a tela está rolada (volte ao topo)',
      );
    }
    s.resumo.build = build.texto;
    s.registrar('BUILD na tela:', build.texto);

    const P = {};
    for (const [chave, texto] of Object.entries({
      abaMedicao: TEXTOS.abaMedicao,
      abaEnvio: TEXTOS.abaEnvio,
      taxa100: TEXTOS.taxa100,
      taxa200: TEXTOS.taxa200,
      parado: TEXTOS.condicaoParado,
      botaoDeMedicao: TEXTOS.iniciarMedicao,
      capturar: TEXTOS.capturarLeitura,
    })) {
      P[chave] = leitura.acharTexto(ui.textos, texto);
    }
    const faltando = Object.entries(P).filter(([, ponto]) => ponto === null).map(([chave]) => chave);
    if (faltando.length > 0) {
      throw new Abortar(`fora da tela: ${faltando.join(', ')} (a tela está rolada?)`);
    }
    // Texto sem ação para manter a tela acesa: o título, ou o cabeçalho do acumulado.
    const pontoNeutro =
      leitura.acharTexto(ui.textos, TEXTOS.titulo) ??
      leitura.acharTextoQueComeca(ui.textos, TEXTOS.cabecalhoDoAcumulado);
    const rotulosForaDaTela = Object.entries(ROTULOS_DO_ACUMULADO)
      .filter(([, rotulo]) => leitura.acharTexto(ui.textos, rotulo) === null)
      .map(([chave]) => chave);
    if (rotulosForaDaTela.length > 0) {
      s.ocorrencia(
        `rótulos do acumulado fora da tela: ${rotulosForaDaTela.join(', ')} ` +
          '(o número sai da captura no logcat do mesmo jeito)',
      );
    }
    s.registrar('textos na tela:', ui.textos.map(t => t.texto).join(' | '));
    await s.print('00-inicial');

    await s.tocar(P.taxa100, TEXTOS.taxa100);
    await esperar(300);
    await s.tocar(P.parado, TEXTOS.condicaoParado);
    await esperar(300);
    await s.sensores('00-antes-de-iniciar');

    // --- A: 100 Hz, sem instrumento ---------------------------------------------------------------
    await s.tocarTexto(TEXTOS.iniciarMedicao, P.botaoDeMedicao);
    const inicioA = Date.now();
    s.registrar('A: medição iniciada a 100 Hz');
    await esperar(2500);
    await s.sensores('01-100hz-ligado');
    const momentosA = await s.faseSemInstrumento('A-100hz', opcoes.duracaoS * 1000, pontoNeutro);
    s.resumo.fases['A-100hz'] = {
      momentos: momentosA,
      ...(await s.capturarNoFim('A-100hz', inicioA, P.capturar, 100)),
    };
    await s.sensores('02-100hz-fim');
    s.salvarResumo();

    // --- B: 100 Hz, medição reiniciada, com toque de captura a cada 1 s -----------------------------
    await s.tocarTexto(TEXTOS.pararMedicao, P.botaoDeMedicao);
    await esperar(1200);
    await s.tocarTexto(TEXTOS.iniciarMedicao, P.botaoDeMedicao);
    const inicioB = Date.now();
    s.registrar('B: medição reiniciada a 100 Hz');
    await esperar(1500);
    const trechoB = await s.faseComCaptura('B-100hz-captura', DURACAO_COM_CAPTURA_MS, P.capturar);
    const ultimaDeB = leitura.lerCapturas(s.logcat).slice(trechoB.capturasDe, trechoB.capturasAte).slice(-1)[0];
    s.resumo.fases['B-100hz-captura'] = {
      ...trechoB,
      segundosDesdeOInicio: Number(((Date.now() - inicioB) / 1000).toFixed(1)),
      acumuladoFinal: ultimaDeB?.acumulado ?? null,
    };
    await s.print('B-100hz-captura-fim');
    s.salvarResumo();

    // --- C: 200 Hz, sem instrumento ---------------------------------------------------------------
    await s.tocarTexto(TEXTOS.taxa200, P.taxa200);
    const inicioC = Date.now();
    s.registrar('C: taxa trocada para 200 Hz (a medição e o acumulado recomeçam)');
    await esperar(2500);
    await s.sensores('03-200hz-ligado');
    const momentosC = await s.faseSemInstrumento('C-200hz', opcoes.duracaoS * 1000, pontoNeutro);
    s.resumo.fases['C-200hz'] = {
      momentos: momentosC,
      ...(await s.capturarNoFim('C-200hz', inicioC, P.capturar, 200)),
    };
    await s.sensores('04-200hz-fim');
    s.salvarResumo();

    // --- D: critério 2, segundo plano e volta -------------------------------------------------------
    await s.tocarTexto(TEXTOS.taxa100, P.taxa100);
    s.registrar('D: de volta a 100 Hz');
    await esperar(4000);
    await s.print('D-antes-do-home');
    const antes = await s.sensores('05-antes-do-home');
    const home = await s.chamarAdb(['shell', 'input', 'keyevent', 'KEYCODE_HOME']);
    const instanteHome = Date.now();
    s.registrar('D: KEYCODE_HOME enviado', home.codigo);
    await esperar(3000);
    const durante = await s.sensores('06-em-segundo-plano');
    await s.print('D-em-segundo-plano');
    await esperar(Math.max(0, 10000 - (Date.now() - instanteHome)));
    const volta = await s.chamarAdb(['shell', 'am', 'start', '-n', ATIVIDADE]);
    s.registrar('D: am start:', volta.saida.trim().replace(/\s+/g, ' '));
    await esperar(3000);
    const depois = await s.sensores('07-depois-de-voltar');
    await esperar(2500);
    const uiDepois = await s.lerInterface('D-depois-de-voltar');
    await s.print('D-depois-de-voltar');
    s.resumo.criterio2 = {
      conexoesAntes: antes.ativas,
      conexoesEmSegundoPlano: durante.ativas,
      conexoesDepois: depois.ativas,
      botaoDepois:
        uiDepois === null
          ? null
          : leitura.acharTexto(uiDepois.textos, TEXTOS.pararMedicao)
            ? TEXTOS.pararMedicao
            : TEXTOS.iniciarMedicao,
      janelaDepois: uiDepois === null ? null : leitura.lerJanelaDaTela(uiDepois.textos),
    };
    s.registrar('CRITÉRIO 2:', JSON.stringify(s.resumo.criterio2));
    s.salvarResumo();

    // --- E: critério 1, troca de aba com a medição ligada --------------------------------------------
    const medindo = await s.sensores('08-medindo-antes-da-troca');
    await s.tocarTexto(TEXTOS.abaEnvio, P.abaEnvio);
    s.registrar('E: aba Envio (a medição estava ligada)');
    await esperar(2000);
    const naEnvio = await s.sensores('09-na-aba-envio');
    await s.print('E-aba-envio');
    const uiEnvio = await s.lerInterface('E-aba-envio');
    let envio = null;
    const botaoDeEnvio = uiEnvio === null ? null : leitura.acharTexto(uiEnvio.textos, TEXTOS.enviarGiroscopio);
    if (botaoDeEnvio !== null) {
      await s.tocar(botaoDeEnvio, TEXTOS.enviarGiroscopio);
      await esperar(2500);
      const ligado = await s.sensores('10-envio-ligado');
      await s.print('E-envio-ligado');
      await s.tocarTexto(TEXTOS.pararEnvio, botaoDeEnvio);
      await esperar(2000);
      const parado = await s.sensores('11-envio-parado');
      envio = {conexoesComEnvioLigado: ligado.ativas, conexoesDepoisDeParar: parado.ativas};
    } else {
      s.ocorrencia('E: botão "Enviar giroscópio" não lido na aba Envio; trecho do envio pulado');
    }
    await s.tocarTexto(TEXTOS.abaMedicao, P.abaMedicao);
    await esperar(2000);
    const naVolta = await s.sensores('12-volta-a-medicao');
    await s.print('E-volta-a-medicao');
    s.resumo.criterio1 = {
      conexoesMedindo: medindo.ativas,
      conexoesNaAbaEnvio: naEnvio.ativas,
      envio,
      conexoesDeVoltaAMedicao: naVolta.ativas,
    };
    s.registrar('CRITÉRIO 1:', JSON.stringify(s.resumo.criterio1));
    s.registrar('FIM');
  } catch (erro) {
    s.ocorrencia(`${erro instanceof Abortar ? 'ABORTADO' : 'ERRO'}: ${erro.stack ?? erro.message}`);
    process.exitCode = 1;
  } finally {
    await esperar(1500);
    s.encerrarLogcat();
    if (!encerrando) {
      await devolverReverso();
    }
    s.resumo.fim = new Date().toISOString();
    s.salvarResumo();
    s.registrar(`resumo em ${join(saida, 'resumo.json')}; agora: node scripts/medicao-giroscopio/analisar.js "${saida}"`);
  }
}

module.exports = {PASTA_BASE, PORTA_DO_SERVIDOR_PADRAO, lerArgumentos, nomeDaPasta};

if (require.main === module) {
  principal();
}
