/**
 * Encerramento limpo do processo.
 *
 * Regra do projeto (CLAUDE.md, regra 5): estado preso é o pior bug. Todo recurso que
 * segura o event loop — servidor WebSocket, timers, backend de saída com tecla
 * pressionada — precisa de um caminho garantido de soltura. Este módulo é esse caminho:
 * SIGINT (Ctrl+C) e SIGTERM disparam as tarefas registradas, na ordem inversa do
 * registro (a última coisa aberta é a primeira a fechar), e depois o processo sai
 * sozinho, sem `process.exit()` forçado — se sobrar handle pendente, o processo trava e
 * o bug aparece, em vez de ser mascarado por um exit à força.
 *
 * ⚠️ LIMITE MEDIDO (Windows, ATI-002): este caminho só existe quando o Ctrl+C chega **a
 * este processo**. Rodar o servidor debaixo de um supervisor que reinicia em troca de
 * arquivo (`tsx watch`, `node --watch`) quebra a garantia: o supervisor também recebe o
 * CTRL_C_EVENT do console e mata o filho com `TerminateProcess`, que nenhum código
 * intercepta. Medido com CTRL_C_EVENT real e tarefa de sonda com `writeFileSync`:
 * `node --import tsx` (o `npm run dev`) rodou a tarefa 5/5; `node --watch` 1/5 sem
 * trabalho e 0/5 com 50 ms de trabalho; `tsx watch` 0/5. É por isso que `npm run dev` é
 * processo único, e a recarga automática vive num script separado (`npm run dev:recarga`)
 * com a ressalva escrita no `server/README.md`. Enquanto a ATI-007 (soltar botão e tecla)
 * não tiver um supervisor que peça encerramento em vez de matar, **não use o modo de
 * recarga com estado de entrada preso**.
 */

import type { Registrador } from './log.js';

/** Tarefa de encerramento; pode ser assíncrona. */
export type TarefaDeEncerramento = () => void | Promise<void>;

/** Sinais tratados. No Windows, o Node emite SIGINT no Ctrl+C do console. */
const SINAIS = ['SIGINT', 'SIGTERM'] as const;

export interface OpcoesDeEncerramento {
  /** Tempo máximo das tarefas antes de desistir e sair com código 1. */
  readonly limiteMs?: number;
}

export interface ControleDeEncerramento {
  /** Adiciona uma tarefa; devolve uma função que cancela o registro. */
  registrar(nome: string, tarefa: TarefaDeEncerramento): () => void;
  /** Dispara o encerramento na mão (mesmo caminho do sinal). */
  encerrar(motivo: string): Promise<void>;
  /** Remove os ouvintes de sinal — usado nos testes para não vazar estado. */
  desmontar(): void;
}

/**
 * Instala os ouvintes de sinal e devolve o controle para registrar tarefas.
 * Chamar mais de uma vez cria controles independentes; o servidor chama uma vez só.
 */
export function instalarEncerramento(
  registrador: Registrador,
  opcoes: OpcoesDeEncerramento = {},
): ControleDeEncerramento {
  const limiteMs = opcoes.limiteMs ?? 5_000;
  const tarefas: Array<{ nome: string; tarefa: TarefaDeEncerramento }> = [];
  let emAndamento: Promise<void> | undefined;

  const executarTarefas = async (motivo: string): Promise<void> => {
    registrador.info('encerrando', { motivo, tarefas: tarefas.length });
    // Ordem inversa: fecha primeiro o que foi aberto por último.
    for (const { nome, tarefa } of [...tarefas].reverse()) {
      try {
        await tarefa();
        registrador.depuracao('tarefa de encerramento concluída', { nome });
      } catch (erro) {
        registrador.erro('tarefa de encerramento falhou', { nome, erro });
      }
    }
    registrador.info('encerrado');
  };

  const encerrar = (motivo: string): Promise<void> => {
    // Segundo Ctrl+C não reinicia o processo de saída: devolve o mesmo encerramento.
    if (emAndamento !== undefined) return emAndamento;

    const relogioDoLimite = setTimeout(() => {
      registrador.erro('encerramento passou do limite; saindo à força', { limiteMs });
      process.exit(1);
    }, limiteMs);
    // Sem unref(), este timer viraria justamente o handle pendente que queremos evitar.
    relogioDoLimite.unref();

    emAndamento = executarTarefas(motivo).finally(() => {
      clearTimeout(relogioDoLimite);
      desmontar();
    });
    return emAndamento;
  };

  const aoReceberSinal = (sinal: NodeJS.Signals): void => {
    void encerrar(sinal);
  };

  for (const sinal of SINAIS) process.on(sinal, aoReceberSinal);

  function desmontar(): void {
    for (const sinal of SINAIS) process.removeListener(sinal, aoReceberSinal);
  }

  return {
    registrar(nome, tarefa) {
      const entrada = { nome, tarefa };
      tarefas.push(entrada);
      return () => {
        const indice = tarefas.indexOf(entrada);
        if (indice >= 0) tarefas.splice(indice, 1);
      };
    },
    encerrar,
    desmontar,
  };
}

/**
 * Âncora do event loop.
 *
 * Enquanto o servidor WebSocket não existe (ATI-005 — o transporte; a ATI-004 é o codec do
 * protocolo, que não abre socket nenhum), nada segura o processo vivo: o
 * `principal.ts` terminaria de executar e o Node sairia na hora, sem chance de Ctrl+C.
 * A âncora é um timer ocioso que só existe para manter o event loop de pé; soltá-la é
 * o suficiente para o processo sair sozinho, sem handle pendente. Quando o transporte
 * entrar, ele passa a ser a âncora natural e esta função sai daqui.
 */
export function ancorarEventLoop(): () => void {
  const ocioso = setInterval(() => {
    // De propósito vazio: o valor está em existir, não em executar.
  }, 60_000);
  return () => clearInterval(ocioso);
}
