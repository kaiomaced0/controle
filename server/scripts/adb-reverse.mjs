#!/usr/bin/env node
/**
 * Prepara o modo cabo: `adb reverse tcp:8765 tcp:8765`.
 *
 * O que isso faz, em uma frase: o **celular** passa a tratar `127.0.0.1:8765` como se fosse a
 * porta 8765 **do PC**, e o tráfego viaja pelo USB. É por isso que o app fala com `127.0.0.1` e
 * o servidor escuta em `127.0.0.1` — nada precisa sair na rede local (ARQUITETURA.md, seção 5).
 *
 * Exige **depuração USB** ligada no aparelho e a autorização aceita na tela dele. O encaminhamento
 * se perde quando o cabo é desconectado ou o `adb` reinicia: rodar de novo é o conserto.
 *
 * Uso:
 *   node scripts/adb-reverse.mjs            # porta 8765 (ou CONTROLE_PORTA)
 *   node scripts/adb-reverse.mjs 9000       # outra porta
 *   node scripts/adb-reverse.mjs --listar   # só mostra o que já está encaminhado
 *   node scripts/adb-reverse.mjs --remover  # desfaz o encaminhamento desta porta
 *
 * Sem dependência externa de propósito: é um script de bancada, precisa funcionar num clone
 * recém-baixado, antes de qualquer `npm install`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Mesma porta do PROTOCOLO.md, seção 1. */
const PORTA_PADRAO = 8765;

/**
 * Palpites de onde o SDK costuma ficar em cada sistema — **último recurso**.
 *
 * Isto não é configuração: é chute de caminho de máquina dentro de arquivo versionado. Por isso
 * só entra depois de `CONTROLE_ADB`, das variáveis do SDK e do PATH, e por isso o script avisa
 * na saída quando o `adb` que ele achou veio daqui. Quem quiser mandar no caminho usa
 * `CONTROLE_ADB=<caminho do adb>` ou `ANDROID_SDK_ROOT=<raiz do SDK>`.
 */
const PALPITES_DE_SDK = {
  win32: ['D:\\Android\\Sdk', 'C:\\Android\\Sdk'],
  darwin: [join(process.env.HOME ?? '', 'Library', 'Android', 'sdk')],
  linux: [join(process.env.HOME ?? '', 'Android', 'Sdk')],
};

function nomeDoExecutavel() {
  return process.platform === 'win32' ? 'adb.exe' : 'adb';
}

/** Candidatos a `adb`, do mais explícito ao mais chutado. */
function candidatosDeAdb() {
  const candidatos = [];
  const executavel = nomeDoExecutavel();

  const explicito = process.env.CONTROLE_ADB;
  if (typeof explicito === 'string' && explicito !== '') {
    candidatos.push({ caminho: explicito, origem: 'CONTROLE_ADB', palpite: false });
  }

  for (const variavel of ['ANDROID_SDK_ROOT', 'ANDROID_HOME']) {
    const raiz = process.env[variavel];
    if (typeof raiz === 'string' && raiz !== '') {
      candidatos.push({
        caminho: join(raiz, 'platform-tools', executavel),
        origem: `${variavel}=${raiz}`,
        palpite: false,
      });
    }
  }

  candidatos.push({ caminho: executavel, origem: 'PATH', palpite: false });

  for (const raiz of PALPITES_DE_SDK[process.platform] ?? []) {
    if (raiz === '') continue;
    candidatos.push({
      caminho: join(raiz, 'platform-tools', executavel),
      origem: `palpite de SDK em ${raiz}`,
      palpite: true,
    });
  }

  return candidatos;
}

/**
 * Escolhe o primeiro candidato que responde `adb version`.
 *
 * Responder é o teste, não existir: um `adb` truncado ou de outra arquitetura existe no disco e
 * não serve para nada.
 */
function encontrarAdb() {
  let ultimoErro = '';
  for (const candidato of candidatosDeAdb()) {
    // No PATH quem resolve é o `spawnSync`; nos demais, o arquivo precisa existir.
    if (candidato.origem !== 'PATH' && !existsSync(candidato.caminho)) continue;
    const versao = rodar(candidato.caminho, ['version']);
    if (versao.codigo === 0) return { ...candidato, ok: true, erro: '' };
    if (versao.erro !== '') ultimoErro = versao.erro;
  }
  return { caminho: nomeDoExecutavel(), origem: 'PATH', palpite: false, ok: false, erro: ultimoErro };
}

/** Roda o adb e devolve saída e código; nunca lança. */
function rodar(adb, argumentos) {
  const resultado = spawnSync(adb, argumentos, { encoding: 'utf8' });
  if (resultado.error !== undefined) {
    return { codigo: -1, saida: '', erro: resultado.error.message };
  }
  return {
    codigo: resultado.status ?? -1,
    saida: (resultado.stdout ?? '').trim(),
    erro: (resultado.stderr ?? '').trim(),
  };
}

/**
 * Lê `adb devices -l`.
 *
 * Cada linha útil é `<serial> <estado> [chave:valor ...]`. Só o estado `device` serve; os outros
 * são justamente os casos que confundem quem está começando, e por isso viram aviso nomeado.
 */
function listarAparelhos(adb) {
  const { codigo, saida, erro } = rodar(adb, ['devices', '-l']);
  if (codigo !== 0) return { ok: false, motivo: erro === '' ? 'adb devices falhou' : erro, aparelhos: [] };

  const aparelhos = [];
  for (const linha of saida.split(/\r?\n/).slice(1)) {
    const texto = linha.trim();
    if (texto === '') continue;
    const partes = texto.split(/\s+/);
    const serial = partes[0];
    const estado = partes[1] ?? 'desconhecido';
    if (serial === undefined) continue;
    const modelo = partes.find((parte) => parte.startsWith('model:'));
    aparelhos.push({
      serial,
      estado,
      modelo: modelo === undefined ? '' : modelo.slice('model:'.length),
    });
  }
  return { ok: true, motivo: '', aparelhos };
}

function descrever(aparelho) {
  const modelo = aparelho.modelo === '' ? '' : ` (${aparelho.modelo})`;
  return `${aparelho.serial}${modelo} — ${aparelho.estado}`;
}

function explicarEstado(estado) {
  switch (estado) {
    case 'unauthorized':
      return 'o aparelho ainda não autorizou este PC: aceite o aviso de depuração USB na tela dele.';
    case 'offline':
      return 'o aparelho está offline: desconecte e reconecte o cabo, ou rode `adb kill-server`.';
    case 'no':
      return 'permissão negada ao acessar o dispositivo.';
    default:
      return `estado "${estado}" não serve para encaminhar a porta.`;
  }
}

function lerPorta(argumentos) {
  const pedida = argumentos.find((argumento) => !argumento.startsWith('-'));
  const bruto = pedida ?? process.env.CONTROLE_PORTA ?? String(PORTA_PADRAO);
  const porta = Number(bruto);
  if (!Number.isInteger(porta) || porta < 1 || porta > 65535) {
    console.error(`Porta inválida: ${bruto}. Use um inteiro entre 1 e 65535.`);
    process.exit(1);
  }
  return porta;
}

function principal() {
  const argumentos = process.argv.slice(2);
  const porta = lerPorta(argumentos);
  const soListar = argumentos.includes('--listar');
  const remover = argumentos.includes('--remover');

  const { caminho: adb, origem, palpite, ok, erro } = encontrarAdb();
  if (!ok) {
    console.error('Não encontrei um adb que respondesse `adb version`. Tentei, nesta ordem:');
    for (const candidato of candidatosDeAdb()) {
      console.error(`  • ${candidato.caminho} (${candidato.origem})`);
    }
    console.error('Instale o Android SDK Platform Tools ou aponte CONTROLE_ADB/ANDROID_SDK_ROOT.');
    if (erro !== '') console.error(erro);
    process.exit(1);
  }
  console.log(`adb: ${adb} (${origem})`);
  if (palpite) {
    // Palpite acertar não é o mesmo que estar configurado: dizer de onde veio evita que a próxima
    // máquina descubra o caminho lendo o código-fonte deste script.
    console.log('  ↑ veio de um palpite de caminho, não de configuração desta máquina.');
    console.log('    Para fixar: CONTROLE_ADB=<caminho do adb> ou ANDROID_SDK_ROOT=<raiz do SDK>.');
  }

  const lista = listarAparelhos(adb);
  if (!lista.ok) {
    console.error(`Não consegui listar os aparelhos: ${lista.motivo}`);
    process.exit(1);
  }

  if (lista.aparelhos.length === 0) {
    console.error('Nenhum aparelho Android visível pelo adb.');
    console.error('Confira, nesta ordem:');
    console.error('  1. o cabo está conectado (e é cabo de dados, não só de carga);');
    console.error('  2. "Depuração USB" está ligada nas opções do desenvolvedor;');
    console.error('  3. o aviso "Permitir depuração USB?" foi aceito na tela do aparelho;');
    console.error('  4. ou suba um emulador — ele também aparece aqui.');
    process.exit(1);
  }

  console.log(`Aparelhos vistos (${lista.aparelhos.length}):`);
  for (const aparelho of lista.aparelhos) console.log(`  • ${descrever(aparelho)}`);

  const prontos = lista.aparelhos.filter((aparelho) => aparelho.estado === 'device');
  for (const aparelho of lista.aparelhos) {
    if (aparelho.estado !== 'device') {
      console.error(`  ! ${aparelho.serial}: ${explicarEstado(aparelho.estado)}`);
    }
  }
  if (prontos.length === 0) {
    console.error('Nenhum aparelho em estado utilizável; nada foi encaminhado.');
    process.exit(1);
  }

  let falhou = false;
  for (const aparelho of prontos) {
    const base = ['-s', aparelho.serial, 'reverse'];

    if (soListar) {
      const listagem = rodar(adb, [...base, '--list']);
      const conteudo = listagem.saida === '' ? '(nenhum encaminhamento)' : listagem.saida;
      console.log(`${aparelho.serial}: ${conteudo.split(/\r?\n/).join(' | ')}`);
      continue;
    }

    if (remover) {
      const remocao = rodar(adb, [...base, '--remove', `tcp:${porta}`]);
      if (remocao.codigo === 0) console.log(`${aparelho.serial}: encaminhamento de tcp:${porta} removido.`);
      else {
        falhou = true;
        console.error(`${aparelho.serial}: falhei ao remover — ${remocao.erro || remocao.saida}`);
      }
      continue;
    }

    const aplicacao = rodar(adb, [...base, `tcp:${porta}`, `tcp:${porta}`]);
    if (aplicacao.codigo !== 0) {
      falhou = true;
      console.error(`${aparelho.serial}: falhei ao encaminhar — ${aplicacao.erro || aplicacao.saida}`);
      continue;
    }

    // Conferência: o `reverse` responde 0 mesmo em situação estranha, e ver o encaminhamento
    // na lista do próprio adb é a única prova de que ele existe.
    const conferencia = rodar(adb, [...base, '--list']);
    const encaminhado = conferencia.saida.includes(`tcp:${porta} tcp:${porta}`);
    if (encaminhado) {
      console.log(`${aparelho.serial}: tcp:${porta} do aparelho → tcp:${porta} deste PC. ✔`);
    } else {
      falhou = true;
      console.error(`${aparelho.serial}: o adb aceitou, mas o encaminhamento não aparece em --list.`);
    }
  }

  if (falhou) process.exit(1);

  if (!soListar && !remover) {
    console.log('');
    console.log(`Agora suba o servidor (npm run dev) e aponte o app para ws://127.0.0.1:${porta}.`);
    console.log('O encaminhamento cai junto com o cabo: reconectou, rode este script de novo.');
  }
}

principal();
