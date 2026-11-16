/**
 * Sonda de encerramento — ponto de entrada alternativo, só para medição.
 *
 * Por que existe: `medir-ctrlc.ps1` sozinho só sabe dizer que as linhas `encerrando` e
 * `encerrado` apareceram no stderr. Isso prova que o caminho de encerramento *começou*, não
 * que uma tarefa com trabalho de verdade *terminou* antes de o processo morrer — que é o
 * caso que importa para a ATI-007 (soltar botão e tecla presos). A sonda pendura uma tarefa
 * que leva `CONTROLE_SONDA_MS` e só então grava `CONTROLE_SONDA_ARQUIVO`: o arquivo existir
 * é a prova de que a tarefa chegou ao fim.
 *
 * Não é código de produção e não entra no `dist/` — `.mjs` fora de `src/`, de propósito.
 * Sobe o servidor pela mesma `principal()` do `npm run dev`, então trocar o runner na linha
 * de comando mede exatamente o que a tabela de runners do `server/README.md` afirma:
 *
 *   node --import tsx ferramentas\sonda-encerramento.mjs      (equivale ao `npm run dev`)
 *   node --watch --import tsx ferramentas\sonda-encerramento.mjs
 *   tsx watch ferramentas\sonda-encerramento.mjs              (equivale ao `npm run dev:recarga`)
 */

import { writeFileSync } from 'node:fs';
import { setTimeout as esperar } from 'node:timers/promises';
import { principal } from '../src/principal.ts';

const arquivo = process.env.CONTROLE_SONDA_ARQUIVO ?? '';
const trabalhoMs = Number.parseInt(process.env.CONTROLE_SONDA_MS ?? '0', 10) || 0;

const encerramento = principal();

if (encerramento === undefined) {
  // Configuração inválida ou porta ocupada: `principal()` já explicou no stderr e marcou o
  // código de saída. Sem controle de encerramento não há onde pendurar a sonda.
  process.exitCode = 1;
} else if (arquivo !== '') {
  encerramento.registrar('sonda de medição', async () => {
    // Espera assíncrona (e não laço ocupado) porque é o caso realista e o mais difícil de
    // sobreviver: o processo fica vulnerável a TerminateProcess justamente enquanto cede o
    // event loop — que é o que um supervisor de recarga faz com o filho no Ctrl+C.
    await esperar(trabalhoMs);
    // Gravação síncrona: se o processo for terminado logo em seguida, o byte já está no disco.
    writeFileSync(arquivo, `sonda terminou apos ${String(trabalhoMs)} ms\n`, 'utf8');
  });
}
