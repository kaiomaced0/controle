#!/usr/bin/env node
/**
 * Lê o que o `medir.js` gravou e escreve o relatório da medição da ATI-003: os números de cada fase,
 * de quantas janelas eles saíram, a regra do critério 4 aplicada e as provas dos critérios 1 e 2.
 *
 * Uso, de dentro de `app/`:
 *   node scripts/medicao-giroscopio/analisar.js [pasta]
 *
 * Sem pasta, usa a medição mais recente em `<tmp>/controle-medicao-giroscopio/`. O relatório sai no
 * terminal e em `<pasta>/analise.txt`.
 *
 * O número que decide sai do ACUMULADO da captura final de cada fase (todas as janelas fechadas
 * desde o início da medição), nunca de leituras avulsas da tela: as leituras dos três momentos são
 * só o que os prints mostram, e o relatório as rotula assim.
 */

const {existsSync, readFileSync, readdirSync, statSync, writeFileSync} = require('node:fs');
const {join} = require('node:path');

const leitura = require('./leitura');
const {PASTA_BASE} = require('./medir');

const f = (valor, casas = 2) =>
  typeof valor === 'number' && Number.isFinite(valor) ? valor.toFixed(casas) : '—';

function pastaMaisRecente() {
  if (!existsSync(PASTA_BASE)) {
    return null;
  }
  const pastas = readdirSync(PASTA_BASE)
    .map(nome => join(PASTA_BASE, nome))
    .filter(caminho => statSync(caminho).isDirectory() && existsSync(join(caminho, 'resumo.json')))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return pastas[0] ?? null;
}

function descreverAcumulado(a) {
  if (!a) {
    return ['    (sem acumulado)'];
  }
  return [
    `    alvo ${a.taxaAlvoHz} Hz · ${a.janelasContadas} janelas contadas · ${a.janelasDePartida} descartada(s) na partida`,
    `    taxa(JS): média ${f(a.taxaMediaHz)} Hz · pior janela ${f(a.piorTaxaHz, 1)} Hz · ` +
      `janelas < ${leitura.LIMIAR_TAXA_HZ} Hz: ${a.janelasAbaixoDoLimiarDeTaxa} de ${a.janelasContadas}`,
    `    dt (sensor): médio ${f(a.dtMedioMs, 3)} ms · desvio ${f(a.dtDesvioMs, 3)} ms · maior ${f(a.maiorDtMs)} ms`,
    `    ponte (JS): maior atraso ${f(a.maiorAtrasoNaPonteMs)} ms · ` +
      `janelas > ${leitura.LIMIAR_PONTE_MS} ms: ${a.janelasComPonteAcimaDoLimiar} de ${a.janelasContadas}`,
  ];
}

function descreverJanela(j) {
  if (!j) {
    return '(tela não lida)';
  }
  return (
    `${f(j.taxaHz, 1)} Hz · ${j.amostras ?? '—'} amostras · dt ${f(j.dtMedioMs)} ± ${f(j.dtDesvioMs)} ms · ` +
    `dt máx ${f(j.dtMaximoMs)} ms · ponte ${f(j.intervaloJsMaximoMs)} ms`
  );
}

function analisar(pasta) {
  const resumo = JSON.parse(readFileSync(join(pasta, 'resumo.json'), 'utf8'));
  const logcat = existsSync(join(pasta, 'logcat.txt')) ? readFileSync(join(pasta, 'logcat.txt'), 'utf8') : '';
  const capturas = leitura.lerCapturas(logcat);
  const saida = [];
  const escrever = (...linhas) => saida.push(...linhas);

  escrever(
    `Medição ATI-003 — ${pasta}`,
    `aparelho: ${resumo.aparelho} (${(resumo.propriedades ?? []).join(' · ')}) · ${resumo.build ?? 'build não lido'}`,
    `de ${resumo.inicio} a ${resumo.fim ?? '(não terminou)'} · servidor no PC: ${resumo.servidorNoPc ?? '—'}`,
  );
  if ((resumo.ocorrencias ?? []).length > 0) {
    escrever('', 'Ocorrências:', ...resumo.ocorrencias.map(o => `  - ${o.split('\n')[0]}`));
  }

  for (const nome of ['A-100hz', 'C-200hz']) {
    const fase = resumo.fases?.[nome];
    escrever('', `== ${nome} (sem instrumento) ==`);
    if (!fase) {
      escrever('  fase não executada');
      continue;
    }
    escrever(
      `  acumulado da fase inteira (${fase.fonteDoAcumulado}), ${fase.segundosDesdeOInicio} s desde o início da medição:`,
      ...descreverAcumulado(fase.captura?.acumulado ?? fase.acumuladoNaTela),
    );
    const daTela = fase.acumuladoNaTela;
    const doLogcat = fase.captura?.acumulado;
    if (daTela && doLogcat) {
      const diferenca = Math.abs((daTela.janelasContadas ?? 0) - (doLogcat.janelasContadas ?? 0));
      escrever(
        `  conferência tela × logcat: ${daTela.janelasContadas} × ${doLogcat.janelasContadas} janelas contadas ` +
          (diferenca <= 1 ? '(ok: até 1 janela de diferença entre o toque e a leitura)' : '(DIVERGEM)'),
      );
    }
    escrever(
      `  regra: ${fase.avaliacao.veredito.toUpperCase()}` +
        ` (mínimo ${fase.avaliacao.minimoDeJanelas ?? '—'} janelas; até ${fase.avaliacao.limiteDeJanelasComPonte ?? '—'} com ponte > ${leitura.LIMIAR_PONTE_MS} ms)`,
      ...fase.avaliacao.motivos.map(m => `    - ${m}`),
      '  momentos (o que os prints mostram — janela corrente, não decide nada):',
      ...(fase.momentos ?? []).map(m => `    +${m.segundos}s ${m.print}: ${descreverJanela(m.janela)}`),
    );
  }

  const b = resumo.fases?.['B-100hz-captura'];
  escrever('', '== B-100hz-captura (COM toque de captura a cada 1 s: série completa e custo do instrumento) ==');
  if (b) {
    const doTrecho = leitura.janelasDistintas(capturas.slice(b.capturasDe, b.capturasAte));
    const estatistica = leitura.resumirJanelas(doTrecho.map(c => c.janela));
    escrever(
      `  ${b.toques} toques · ${doTrecho.length} janelas distintas no logcat`,
      estatistica
        ? `  série: taxa média ${f(estatistica.taxaMediaHz)} Hz · pior ${f(estatistica.piorTaxaHz, 1)} · melhor ${f(estatistica.melhorTaxaHz, 1)} · ` +
            `janelas < ${leitura.LIMIAR_TAXA_HZ} Hz: ${estatistica.janelasAbaixoDoLimiarDeTaxa} · ponte máx ${f(estatistica.maiorAtrasoNaPonteMs)} ms · ` +
            `mediana ${f(estatistica.medianaDaPonteMs)} ms · janelas > ${leitura.LIMIAR_PONTE_MS} ms: ${estatistica.janelasComPonteAcimaDoLimiar}`
        : '  série: nenhuma janela no logcat',
      '  acumulado no fim do trecho:',
      ...descreverAcumulado(b.acumuladoFinal),
      '  janela a janela:',
      ...doTrecho.map(c => `    ${c.hora} | ${descreverJanela(c.janela)}`),
    );
  } else {
    escrever('  fase não executada');
  }

  escrever('', '== HAL (dumpsys sensorservice: últimos eventos do giroscópio) ==');
  for (const [nome, dados] of Object.entries(resumo.conexoes ?? {})) {
    const h = dados.hal;
    escrever(
      `  ${nome}: conexões do app ${dados.ativas} · ` +
        (h && h.dtMedioMs !== undefined
          ? `${h.eventos} eventos, dt ${f(h.dtMedioMs, 3)} ± ${f(h.dtDesvioMs, 4)} ms (máx ${f(h.dtMaximoMs, 3)}), ${f(h.taxaHz, 1)} Hz`
          : 'cadência do HAL não lida'),
    );
  }

  escrever('', '== Critério 2 (segundo plano) ==');
  if (resumo.criterio2) {
    const c = resumo.criterio2;
    const ok = c.conexoesAntes >= 1 && c.conexoesEmSegundoPlano === 0 && c.conexoesDepois >= 1;
    escrever(
      `  conexões do app: antes ${c.conexoesAntes} · em segundo plano ${c.conexoesEmSegundoPlano} · depois ${c.conexoesDepois} -> ${ok ? 'DESLIGOU E RELIGOU' : 'NÃO CONFERE'}`,
      `  tela na volta: botão "${c.botaoDepois ?? '—'}" · janela ${descreverJanela(c.janelaDepois)}`,
    );
  } else {
    escrever('  não executado');
  }

  escrever('', '== Critério 1 (troca de aba com a medição ligada) ==');
  if (resumo.criterio1) {
    const c = resumo.criterio1;
    const ok = c.conexoesMedindo >= 1 && c.conexoesNaAbaEnvio === 0 && c.conexoesDeVoltaAMedicao === 0;
    escrever(
      `  conexões do app: medindo ${c.conexoesMedindo} · na aba Envio ${c.conexoesNaAbaEnvio} · de volta à Medição ${c.conexoesDeVoltaAMedicao} -> ${ok ? 'SEM VAZAMENTO' : 'NÃO CONFERE'}`,
      c.envio
        ? `  envio: ligado ${c.envio.conexoesComEnvioLigado} · depois de parar ${c.envio.conexoesDepoisDeParar}`
        : '  envio: não exercitado',
    );
  } else {
    escrever('  não executado');
  }

  const linhasNativas = logcat.split(/\r?\n/).filter(l => /\/(Giroscopio|AndroidRuntime)\(/.test(l));
  escrever('', `linhas das tags Giroscopio/AndroidRuntime no logcat: ${linhasNativas.length}`, ...linhasNativas.slice(0, 10).map(l => `  ${l}`));

  const a = resumo.fases?.['A-100hz'];
  escrever('', '== Critério 4 (onde mora o envio) ==');
  if (a) {
    const decisao = leitura.decidirEnvio(a.avaliacao, resumo.build);
    escrever(`  ${decisao.decisao.toUpperCase()}: ${decisao.porque}`);
  } else {
    escrever('  sem a fase A não há decisão');
  }

  const texto = saida.join('\n');
  writeFileSync(join(pasta, 'analise.txt'), texto + '\n');
  return texto;
}

module.exports = {analisar};

if (require.main === module) {
  const pasta = process.argv[2] ?? pastaMaisRecente();
  if (!pasta || !existsSync(join(pasta, 'resumo.json'))) {
    console.error(`analisar: não achei resumo.json em ${pasta ?? PASTA_BASE}`);
    process.exitCode = 1;
  } else {
    console.log(analisar(pasta));
  }
}
