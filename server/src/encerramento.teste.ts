/**
 * Teste do encerramento limpo: o sinal dispara as tarefas uma vez só, na ordem inversa,
 * e os ouvintes de sinal são removidos (nada de handle pendente segurando o processo).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ancorarEventLoop, instalarEncerramento } from './encerramento.js';
import { criarRegistrador, type Registrador } from './log.js';

/** Registrador que joga fora a saída — teste não polui o terminal. */
function registradorMudo(): Registrador {
  return criarRegistrador('erro', 'teste', () => {});
}

describe('instalarEncerramento', () => {
  it('executa as tarefas na ordem inversa do registro', async () => {
    const encerramento = instalarEncerramento(registradorMudo());
    const ordem: string[] = [];

    encerramento.registrar('primeira', () => {
      ordem.push('primeira');
    });
    encerramento.registrar('segunda', async () => {
      // Cede o controle de propósito: prova que a tarefa assíncrona é aguardada de verdade,
      // e não só chamada (se não fosse, 'primeira' entraria na frente).
      await Promise.resolve();
      ordem.push('segunda');
    });

    await encerramento.encerrar('teste');

    assert.deepEqual(ordem, ['segunda', 'primeira']);
  });

  it('roda o encerramento uma vez só, mesmo com dois pedidos', async () => {
    const encerramento = instalarEncerramento(registradorMudo());
    let vezes = 0;

    encerramento.registrar('conta', () => {
      vezes += 1;
    });

    await Promise.all([encerramento.encerrar('primeiro'), encerramento.encerrar('segundo')]);
    await encerramento.encerrar('terceiro');

    assert.equal(vezes, 1);
  });

  it('segue em frente quando uma tarefa falha', async () => {
    const encerramento = instalarEncerramento(registradorMudo());
    let seguinteRodou = false;

    encerramento.registrar('ok', () => {
      seguinteRodou = true;
    });
    encerramento.registrar('quebrada', () => {
      throw new Error('falha proposital');
    });

    await encerramento.encerrar('teste');

    assert.equal(seguinteRodou, true);
  });

  it('cancela o registro de uma tarefa', async () => {
    const encerramento = instalarEncerramento(registradorMudo());
    let rodou = false;

    const cancelar = encerramento.registrar('some', () => {
      rodou = true;
    });
    cancelar();

    await encerramento.encerrar('teste');

    assert.equal(rodou, false);
  });

  it('responde ao SIGINT e depois solta os ouvintes de sinal', async () => {
    const antes = process.listenerCount('SIGINT');
    const encerramento = instalarEncerramento(registradorMudo());
    assert.equal(process.listenerCount('SIGINT'), antes + 1);

    let rodou = false;
    encerramento.registrar('tarefa', () => {
      rodou = true;
    });

    process.emit('SIGINT', 'SIGINT');
    await encerramento.encerrar('espera');

    assert.equal(rodou, true, 'o SIGINT disparou a tarefa');
    assert.equal(
      process.listenerCount('SIGINT'),
      antes,
      'ouvinte removido: nada segurando o processo depois de encerrar',
    );
  });
});

describe('ancorarEventLoop', () => {
  it('segura o event loop enquanto não é solta e some quando é', () => {
    const antes = contarTemporizadoresAtivos();

    const soltar = ancorarEventLoop();
    assert.equal(contarTemporizadoresAtivos(), antes + 1, 'a âncora é um timer ativo');

    soltar();
    assert.equal(
      contarTemporizadoresAtivos(),
      antes,
      'soltar a âncora tira o timer dos recursos ativos: nada segura o processo',
    );
  });
});

/** Timers vivos no event loop — é o que decide se o processo sai sozinho ou trava. */
function contarTemporizadoresAtivos(): number {
  return process.getActiveResourcesInfo().filter((recurso) => recurso === 'Timeout').length;
}
