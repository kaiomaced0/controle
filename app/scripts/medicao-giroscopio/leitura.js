/**
 * Peças puras do roteiro de medição da ATI-003: ler a tela (XML do `uiautomator dump`), ler as
 * capturas que o app escreve no logcat, contar as conexões do app no `dumpsys sensorservice`, medir
 * a cadência do HAL e aplicar a regra de decisão do critério 4.
 *
 * Nada aqui fala com o adb nem mexe em arquivo: `__tests__/medicaoGiroscopio.test.ts` exercita tudo
 * sem aparelho, inclusive a ida e a volta da captura (a tela escreve, `lerCapturas` lê).
 */

const {
  PACOTE,
  ROTULOS_DA_JANELA,
  ROTULOS_DO_ACUMULADO,
  TEXTOS,
} = require('./textos-da-tela');

/** Os mesmos de `src/sensores/acumuladoDaMedicao.ts`; o teste cobra que não divirjam. */
const LIMIAR_TAXA_HZ = 90;
const LIMIAR_PONTE_MS = 30;

/**
 * Regra do critério 4, com número (regra 7 do projeto):
 * - cobertura: a fase precisa ter ao menos 90 % das janelas que a duração dela comporta, senão o
 *   veredito é "inconclusivo" — um acumulado curto demais não decide nada, nem para aprovar;
 * - taxa: nenhuma janela contada abaixo de `LIMIAR_TAXA_HZ`;
 * - ponte: no máximo 5 % das janelas contadas com atraso acima de `LIMIAR_PONTE_MS` (3 em 60).
 */
const COBERTURA_MINIMA = 0.9;
const PROPORCAO_MAXIMA_DE_JANELAS_COM_PONTE = 0.05;

// ------------------------------------------------------------------------------------------------
// Tela (uiautomator)
// ------------------------------------------------------------------------------------------------

function desescaparXml(texto) {
  return texto
    .replace(/&#x([0-9a-f]+);/gi, (_, hexa) => String.fromCodePoint(parseInt(hexa, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Textos visíveis, na ordem do documento, com o centro de cada um. O `uiautomator dump` deixa de
 * fora o que está fora da área visível — texto que não aparece aqui não pode ser tocado nem lido.
 */
function lerTextosDaInterface(xml) {
  const textos = [];
  const reNo = /<node\b([^>]*?)\/?>/g;
  let no;
  while ((no = reNo.exec(xml)) !== null) {
    const atributos = {};
    const reAtributo = /([\w:-]+)="([^"]*)"/g;
    let atributo;
    while ((atributo = reAtributo.exec(no[1])) !== null) {
      atributos[atributo[1]] = atributo[2];
    }
    const texto = desescaparXml(atributos.text ?? '');
    const limites = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(atributos.bounds ?? '');
    if (texto === '' || limites === null) {
      continue;
    }
    const [x1, y1, x2, y2] = limites.slice(1).map(Number);
    textos.push({
      texto,
      idDeRecurso: atributos['resource-id'] ?? '',
      x: Math.round((x1 + x2) / 2),
      y: Math.round((y1 + y2) / 2),
    });
  }
  return textos;
}

/** "100.6" -> 100.6; "—", vazio ou lixo -> null (nunca NaN escondido numa média). */
function paraNumero(texto) {
  if (typeof texto !== 'string' || texto.trim() === '' || texto.trim() === '—') {
    return null;
  }
  const valor = Number(texto.trim());
  return Number.isFinite(valor) ? valor : null;
}

function acharTexto(textos, exato) {
  return textos.find(t => t.texto === exato) ?? null;
}

function acharTextoQueComeca(textos, prefixo) {
  return textos.find(t => t.texto.startsWith(prefixo)) ?? null;
}

/** Valor que a tela mostra logo depois do rótulo (cartão e par do acumulado: rótulo, valor). */
function valorDepoisDoRotulo(textos, rotulo) {
  const posicao = textos.findIndex(t => t.texto === rotulo);
  if (posicao < 0 || posicao + 1 >= textos.length) {
    return null;
  }
  return paraNumero(textos[posicao + 1].texto);
}

/** A grade da janela corrente: os seis números do último segundo. */
function lerJanelaDaTela(textos) {
  const janela = {};
  for (const [chave, rotulo] of Object.entries(ROTULOS_DA_JANELA)) {
    janela[chave] = valorDepoisDoRotulo(textos, rotulo);
  }
  return janela;
}

/** O acumulado desde o início da medição, como a tela mostra agora; `null` se não estiver visível. */
function lerAcumuladoDaTela(textos) {
  const cabecalho = acharTextoQueComeca(textos, TEXTOS.cabecalhoDoAcumulado);
  if (cabecalho === null) {
    return null;
  }
  const alvo = /alvo (\d+) Hz/.exec(cabecalho.texto);
  const acumulado = {taxaAlvoHz: alvo === null ? null : Number(alvo[1])};
  for (const [chave, rotulo] of Object.entries(ROTULOS_DO_ACUMULADO)) {
    acumulado[chave] = valorDepoisDoRotulo(textos, rotulo);
  }
  return acumulado;
}

// ------------------------------------------------------------------------------------------------
// Capturas no logcat
// ------------------------------------------------------------------------------------------------

/** `-v time` e `-v threadtime`, que são os dois formatos que o roteiro e uma pessoa costumam usar. */
const RE_LINHA_JS_TIME = /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s+[VDIWEF]\/ReactNativeJS\(\s*\d+\):\s?(.*)$/;
const RE_LINHA_JS_THREADTIME =
  /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s+\d+\s+\d+\s+[VDIWEF]\s+ReactNativeJS\s*:\s?(.*)$/;

/** Linhas que pertencem a um bloco de captura, além da primeira ("aparelho: ..."). */
const PREFIXOS_DA_CAPTURA = [
  'sensor:',
  'alvo:',
  'taxa(JS):',
  'dt médio:',
  'maior atraso na ponte:',
  'acumulado:',
  'acumulado taxa:',
  'acumulado dt:',
];

function linhasDoJs(logcat) {
  const linhas = [];
  for (const crua of logcat.split(/\r?\n/)) {
    const m = RE_LINHA_JS_TIME.exec(crua) ?? RE_LINHA_JS_THREADTIME.exec(crua);
    if (m !== null) {
      linhas.push({hora: m[1], texto: m[2].trimEnd()});
    }
  }
  return linhas;
}

function numeroDe(re, texto) {
  if (texto === undefined) {
    return null;
  }
  const m = re.exec(texto);
  return m === null ? null : paraNumero(m[1]);
}

/**
 * Lê o texto de uma captura (o que `montarCaptura` da TelaGiroscopio monta) em números.
 * Aceita a captura antiga, de seis linhas, sem acumulado: aí `acumulado` vem `null`.
 */
function lerTextoDeCaptura(texto, hora = null) {
  const linhas = texto.split(/\r?\n/);
  const linha = prefixo => linhas.find(l => l.startsWith(prefixo));
  const primeira = linhas[0] ?? '';
  const alvo = linha('alvo:');
  const linhaAcumulado = linha('acumulado:');
  const linhaTaxa = linha('acumulado taxa:');
  const linhaDt = linha('acumulado dt:');

  const temAcumulado =
    linhaAcumulado !== undefined && /contadas \d+/.test(linhaAcumulado);

  return {
    hora,
    aparelho: primeira.replace(/^aparelho:\s*/, ''),
    build: (/(build (?:debug|release)\b.*)$/.exec(primeira) ?? [])[1] ?? null,
    alvoHz: numeroDe(/^alvo: (\d+) Hz/, alvo),
    condicao: (/condição: (.+?)\s*(?:·|$)/.exec(alvo ?? '') ?? [])[1] ?? null,
    janela: {
      taxaHz: numeroDe(/taxa\(JS\): ([\d.]+) Hz/, linha('taxa(JS):')),
      amostras: numeroDe(/amostras: (\d+)/, linha('taxa(JS):')),
      dtMedioMs: numeroDe(/dt médio: ([\d.]+) ms/, linha('dt médio:')),
      dtDesvioMs: numeroDe(/dt desvio: ([\d.]+) ms/, linha('dt médio:')),
      dtMaximoMs: numeroDe(/dt máximo: ([\d.]+) ms/, linha('dt médio:')),
      intervaloJsMaximoMs: numeroDe(
        /maior atraso na ponte: ([\d.]+) ms/,
        linha('maior atraso na ponte:'),
      ),
    },
    acumulado: temAcumulado
      ? {
          taxaAlvoHz: numeroDe(/alvo (\d+) Hz/, linhaAcumulado),
          janelasContadas: numeroDe(/contadas (\d+)/, linhaAcumulado),
          janelasDePartida: numeroDe(/descartadas na partida (\d+)/, linhaAcumulado),
          janelasAbaixoDoLimiarDeTaxa: numeroDe(/abaixo de \d+ Hz (\d+)/, linhaAcumulado),
          janelasComPonteAcimaDoLimiar: numeroDe(/ponte > \d+ ms (\d+)/, linhaAcumulado),
          taxaMediaHz: numeroDe(/média (\S+) Hz/, linhaTaxa),
          piorTaxaHz: numeroDe(/pior (\S+) Hz/, linhaTaxa),
          dtMedioMs: numeroDe(/médio (\S+) ms/, linhaDt),
          dtDesvioMs: numeroDe(/desvio (\S+) ms/, linhaDt),
          maiorDtMs: numeroDe(/· maior (\S+) ms/, linhaDt),
          maiorAtrasoNaPonteMs: numeroDe(/maior na ponte (\S+) ms/, linhaDt),
        }
      : null,
  };
}

/** Todas as capturas do logcat, na ordem em que saíram. */
function lerCapturas(logcat) {
  const capturas = [];
  let atual = null;
  const fechar = () => {
    if (atual !== null) {
      capturas.push(lerTextoDeCaptura(atual.linhas.join('\n'), atual.hora));
      atual = null;
    }
  };
  for (const {hora, texto} of linhasDoJs(logcat)) {
    if (texto.startsWith('aparelho:')) {
      fechar();
      atual = {hora, linhas: [texto]};
    } else if (atual !== null && PREFIXOS_DA_CAPTURA.some(p => texto.startsWith(p))) {
      atual.linhas.push(texto);
    } else {
      fechar();
    }
  }
  fechar();
  return capturas;
}

/** A mesma janela capturada duas vezes (dois toques no mesmo segundo) conta uma vez só. */
function janelasDistintas(capturas) {
  const chave = c => JSON.stringify([c.alvoHz, c.janela]);
  return capturas.filter((c, i) => i === 0 || chave(c) !== chave(capturas[i - 1]));
}

/** Estatística de uma série de janelas (o trecho com toque de captura a cada 1 s). */
function resumirJanelas(janelas) {
  const validas = janelas.filter(j => j.taxaHz !== null);
  if (validas.length === 0) {
    return null;
  }
  const taxas = validas.map(j => j.taxaHz);
  const pontes = validas.map(j => j.intervaloJsMaximoMs ?? 0);
  const media = v => v.reduce((a, b) => a + b, 0) / v.length;
  return {
    janelas: validas.length,
    taxaMediaHz: media(taxas),
    piorTaxaHz: Math.min(...taxas),
    melhorTaxaHz: Math.max(...taxas),
    janelasAbaixoDoLimiarDeTaxa: taxas.filter(t => t < LIMIAR_TAXA_HZ).length,
    maiorAtrasoNaPonteMs: Math.max(...pontes),
    medianaDaPonteMs: mediana(pontes),
    janelasComPonteAcimaDoLimiar: pontes.filter(p => p > LIMIAR_PONTE_MS).length,
    maiorDtMs: Math.max(...validas.map(j => j.dtMaximoMs ?? 0)),
  };
}

function mediana(valores) {
  const ordenados = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(ordenados.length / 2);
  return ordenados.length % 2 === 1
    ? ordenados[meio]
    : (ordenados[meio - 1] + ordenados[meio]) / 2;
}

// ------------------------------------------------------------------------------------------------
// dumpsys sensorservice
// ------------------------------------------------------------------------------------------------

/**
 * Conexões ativas do app no serviço de sensores — a prova, do lado do Android, de que o listener
 * existe ou não existe. E os últimos registros do app ("+" registrou, "-" desregistrou).
 */
function lerConexoesDoApp(dumpsys, pacote = PACOTE) {
  const linhas = dumpsys.split(/\r?\n/);
  const inicio = linhas.findIndex(l => /\d+ active connections/.test(l));
  const fim = linhas.findIndex((l, i) => i > inicio && /direct connections/.test(l));
  const bloco = inicio >= 0 ? linhas.slice(inicio, fim > inicio ? fim : undefined) : [];
  const conexoes = [];
  bloco.forEach((linha, i) => {
    if (linha.includes(pacote)) {
      conexoes.push({
        conexao: linha.trim().split(' |')[0],
        sensor: (bloco[i + 1] ?? '').trim().split(' |')[0],
      });
    }
  });

  // Formato do S20 (Android 13), conferido no dumpsys salvo na rodada 4:
  // "10-14 13:18:25.583 + 0x00000002 pid=27684 uid=10331 package=... samplingPeriod=10000us ..."
  // (o pid e o uid vêm alinhados com espaço: "pid= 3086 uid= 1000").
  const registros = [];
  const reRegistro =
    /(\d\d:\d\d:\d\d(?:\.\d+)?)\s+([+-])\s+(0x[0-9a-fA-F]+)\s+pid=\s*(\d+)\s+uid=\s*(\d+)\s+package=(\S+)(?:\s+samplingPeriod=(\d+)us)?/;
  for (const linha of linhas) {
    const m = reRegistro.exec(linha);
    if (m !== null && m[6].startsWith(pacote)) {
      registros.push({
        hora: m[1],
        operacao: m[2] === '+' ? 'registrou' : 'desregistrou',
        sensor: m[3],
        periodoUs: m[7] === undefined ? null : Number(m[7]),
      });
    }
  }

  return {
    cabecalho: inicio >= 0 ? linhas[inicio].trim() : null,
    ativas: conexoes.length,
    conexoes,
    registros,
  };
}

/** Cadência do HAL: os "last N events" do giroscópio que o próprio sensorservice guarda. */
function lerCadenciaDoHal(dumpsys) {
  const linhas = dumpsys.split(/\r?\n/);
  // O S20 lista também "Gyroscope sensor UnCalibrated" e "Interrupt Gyroscope Sensor"; o que o app
  // registra é o TYPE_GYROSCOPE ("LSM6DSO Gyroscope Sensor").
  const inicio = linhas.findIndex(
    l => /Gyroscope[^:]*: last \d+ events/.test(l) && !/Uncalibrated|Interrupt/i.test(l),
  );
  if (inicio < 0) {
    return null;
  }
  const carimbos = [];
  for (let i = inicio + 1; i < linhas.length; i += 1) {
    const m = /\(ts=([\d.]+), wall=([^)]+)\)/.exec(linhas[i]);
    if (m === null) {
      break;
    }
    carimbos.push({segundos: Number(m[1]), parede: m[2]});
  }
  if (carimbos.length < 3) {
    return {sensor: linhas[inicio].split(':')[0].trim(), eventos: carimbos.length};
  }
  const dts = [];
  for (let i = 1; i < carimbos.length; i += 1) {
    dts.push((carimbos[i].segundos - carimbos[i - 1].segundos) * 1000);
  }
  const media = dts.reduce((a, b) => a + b, 0) / dts.length;
  const desvio = Math.sqrt(dts.reduce((a, b) => a + (b - media) ** 2, 0) / dts.length);
  return {
    sensor: linhas[inicio].split(':')[0].trim(),
    eventos: carimbos.length,
    de: carimbos[0].parede,
    ate: carimbos[carimbos.length - 1].parede,
    dtMedioMs: media,
    dtDesvioMs: desvio,
    dtMaximoMs: Math.max(...dts),
    taxaHz: 1000 / media,
  };
}

/** `adb reverse --list`: "<serial> tcp:8765 tcp:8770" -> {'tcp:8765': 'tcp:8770'}. */
function lerReversos(saida) {
  const reversos = {};
  for (const linha of saida.split(/\r?\n/)) {
    const m = /(tcp:\d+)\s+(tcp:\d+)\s*$/.exec(linha.trim());
    if (m !== null) {
      reversos[m[1]] = m[2];
    }
  }
  return reversos;
}

// ------------------------------------------------------------------------------------------------
// Regra de decisão (critério 4)
// ------------------------------------------------------------------------------------------------

/**
 * Aplica a regra a uma fase sem instrumento. `segundos` é o tempo entre o início da medição e a
 * captura final: é ele que diz quantas janelas a fase comporta.
 */
function avaliarFase(acumulado, segundos) {
  if (acumulado === null || acumulado === undefined) {
    return {veredito: 'inconclusivo', motivos: ['a fase não tem acumulado (captura final ausente)']};
  }
  const contadas = acumulado.janelasContadas ?? 0;
  const minimoDeJanelas = Math.floor(Math.max(0, segundos - 1) * COBERTURA_MINIMA);
  const limiteDeJanelasComPonte = Math.floor(contadas * PROPORCAO_MAXIMA_DE_JANELAS_COM_PONTE);
  const base = {janelasContadas: contadas, minimoDeJanelas, limiteDeJanelasComPonte};

  if (contadas < minimoDeJanelas || contadas === 0) {
    return {
      ...base,
      veredito: 'inconclusivo',
      motivos: [
        `cobertura insuficiente: ${contadas} janelas contadas em ${segundos.toFixed(1)} s ` +
          `(mínimo ${minimoDeJanelas})`,
      ],
    };
  }

  const motivos = [];
  const abaixo = acumulado.janelasAbaixoDoLimiarDeTaxa ?? 0;
  const comPonte = acumulado.janelasComPonteAcimaDoLimiar ?? 0;
  if (abaixo > 0) {
    motivos.push(`${abaixo} de ${contadas} janelas abaixo de ${LIMIAR_TAXA_HZ} Hz`);
  }
  if (comPonte > limiteDeJanelasComPonte) {
    motivos.push(
      `${comPonte} de ${contadas} janelas com ponte acima de ${LIMIAR_PONTE_MS} ms ` +
        `(máximo ${limiteDeJanelasComPonte})`,
    );
  }
  return {...base, veredito: motivos.length === 0 ? 'passa' : 'falha', motivos};
}

/**
 * Onde mora o envio, a partir da fase de 100 Hz (a taxa do envio) e do build em que ela saiu.
 * O debug é o pior caso da ponte: passar nele basta; falhar nele não basta para migrar
 * (resposta ao parecer r4, item 2 b/c) — antes, a mesma série num build release.
 */
function decidirEnvio(avaliacao100Hz, build) {
  const release = typeof build === 'string' && build.startsWith('build release');
  if (avaliacao100Hz.veredito === 'passa') {
    return {
      decisao: 'seguir em JS',
      porque: `a 100 Hz, ${avaliacao100Hz.janelasContadas} janelas contadas passaram na regra` +
        (release ? ' (build release)' : ' no build debug, que é o pior caso da ponte'),
    };
  }
  if (avaliacao100Hz.veredito === 'falha' && release) {
    return {
      decisao: 'abrir ATI de módulo nativo para o envio',
      porque: avaliacao100Hz.motivos.join('; '),
    };
  }
  if (avaliacao100Hz.veredito === 'falha') {
    return {
      decisao: 'sem decisão: repetir a série num build release',
      porque: `falhou no debug (${avaliacao100Hz.motivos.join('; ')}); a regra pede o release antes de migrar`,
    };
  }
  return {decisao: 'sem decisão', porque: avaliacao100Hz.motivos.join('; ')};
}

module.exports = {
  COBERTURA_MINIMA,
  LIMIAR_PONTE_MS,
  LIMIAR_TAXA_HZ,
  PROPORCAO_MAXIMA_DE_JANELAS_COM_PONTE,
  acharTexto,
  acharTextoQueComeca,
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
  lerTextoDeCaptura,
  lerTextosDaInterface,
  paraNumero,
  resumirJanelas,
};
