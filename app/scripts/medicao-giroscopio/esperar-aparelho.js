#!/usr/bin/env node
/**
 * Espera um aparelho aparecer no adb, sem mexer em nada: só lê `adb devices` a cada 20 s.
 *
 * Uso, de dentro de `app/`:
 *   node scripts/medicao-giroscopio/esperar-aparelho.js [minutos] [--aparelho <serial>]
 *
 * Padrão: 15 minutos, aparelho RQ8N209ND8Z (o S20+ do Kaio). Sai com 0 quando o aparelho fica
 * "device"; com 2 quando o prazo acaba. Em "unauthorized" avisa e continua esperando: o aviso
 * "Permitir depuração USB?" está na tela do aparelho e aceitá-lo muda o estado para "device".
 * Em "nada visível", lembra o que a ATI-003 já viu dar errado: cabo só de carga, porta, ou o
 * aparelho em "Somente carregar" — sem modo de dados, nem o Windows enxerga o aparelho.
 */

const {execFileSync} = require('node:child_process');

const {lerAparelhos} = require('../rodar-android');
const {acharAdb} = require('./adb');

const SERIAL_PADRAO = 'RQ8N209ND8Z';
const INTERVALO_MS = 20000;

function lerArgumentos(argumentos) {
  const opcoes = {minutos: 15, aparelho: SERIAL_PADRAO};
  for (let i = 0; i < argumentos.length; i += 1) {
    if (argumentos[i] === '--aparelho') {
      opcoes.aparelho = argumentos[i + 1] ?? SERIAL_PADRAO;
      i += 1;
    } else if (/^\d+(\.\d+)?$/.test(argumentos[i])) {
      opcoes.minutos = Number(argumentos[i]);
    } else {
      throw new Error(`argumento desconhecido: ${argumentos[i]}`);
    }
  }
  return opcoes;
}

function principal() {
  const {minutos, aparelho} = lerArgumentos(process.argv.slice(2));
  const adb = acharAdb();
  const inicio = Date.now();
  const registrar = texto =>
    console.log(
      `${new Date().toISOString()} +${Math.round((Date.now() - inicio) / 1000)}s ${texto}`,
    );

  registrar(`esperando ${aparelho} por até ${minutos} min (adb: ${adb})`);
  const conferir = () => {
    let saida = '';
    try {
      saida = execFileSync(adb, ['devices'], {encoding: 'utf8'});
    } catch (erro) {
      saida = String(erro.message);
    }
    const visto = lerAparelhos(saida).find(({serial}) => serial === aparelho);
    registrar(visto === undefined ? '(ausente)' : `${visto.serial} ${visto.estado}`);
    if (visto?.estado === 'device') {
      registrar('CONECTADO');
      process.exitCode = 0;
      return;
    }
    if (visto?.estado === 'unauthorized') {
      registrar('AUTORIZAR: aceite "Permitir depuração USB?" na tela do aparelho');
    }
    if (Date.now() - inicio > minutos * 60 * 1000) {
      registrar(
        'PRAZO ESGOTADO. Se o aparelho nem aparece: cabo de dados (não só de carga), outra ' +
          'porta USB, e "Transferir arquivos" na notificação de USB do aparelho.',
      );
      process.exitCode = 2;
      return;
    }
    setTimeout(conferir, INTERVALO_MS);
  };
  conferir();
}

module.exports = {lerArgumentos};

if (require.main === module) {
  principal();
}
