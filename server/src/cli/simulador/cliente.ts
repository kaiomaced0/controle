/**
 * O aparelho de mentira — cliente WebSocket que conversa com o servidor exatamente como o app.
 *
 * Faz o handshake da seção 2 do PROTOCOLO.md, responde `ping` com `pong` ecoando o carimbo,
 * envia MOVIMENTO no ritmo pedido e encerra com `bye`. **Usa o mesmo codec do servidor**
 * (`src/protocolo/`), sem cópia própria do formato: uma segunda implementação do binário só
 * divergiria do original — e divergiria justamente onde a gente mais confia no teste.
 *
 * ## Ritmo sem deriva
 *
 * `setInterval(enviar, 10)` parece 100 Hz e não é: cada disparo atrasado empurra o próximo, e o
 * erro **acumula** — em um minuto o simulador já está mandando 96 Hz sem ninguém perceber. Aqui
 * cada amostra tem um **alvo absoluto** no relógio monotônico (a soma dos `dtMs` desde o
 * primeiro envio) e a espera é sempre calculada para esse alvo. Disparo atrasado encurta o
 * próximo em vez de somar; o total de amostras é sempre o da fonte, e o atraso medido
 * (`atrasoMedioMs`, `atrasoMaximoMs`) vai no resumo em vez de sumir.
 *
 * ## O limite do relógio do Windows (medido nesta máquina)
 *
 * Não adianta corrigir deriva se o temporizador não acorda: com a resolução padrão do Windows
 * (15,6 ms), `setTimeout` entrega **~67 disparos por segundo**, com qualquer valor de espera —
 * medido com 10 ms, 5 ms, 2 ms, 1 ms e 0,5 ms de alvo, sempre ~67 Hz. Uma amostra por disparo
 * seria, então, um teto de 67 Hz para um simulador que precisa fingir 100 Hz. Daí os dois modos:
 *
 * - **`timer` (padrão)** — um disparo pode mandar **o lote** de amostras cujo alvo já passou
 *   (até `LOTE_MAXIMO`). A taxa média fica na pedida; o espaçamento fica grosso (rajadinha a
 *   cada ~15 ms). Custo de CPU: nenhum.
 * - **`preciso`** — dorme no `setTimeout` até a vizinhança do alvo e gira no `setImmediate` no
 *   trecho final, entregando espaçamento fiel. Custo: um núcleo ocupado enquanto gira, porque
 *   abaixo de 15,6 ms **não existe** espera barata neste sistema.
 *
 * `TCP_NODELAY`, exigência da seção 1 do PROTOCOLO.md, vem da própria biblioteca: o `ws` chama
 * `socket.setNoDelay()` ao adotar o socket (`ws/lib/websocket.js:248`), nos dois lados.
 */

import { performance } from 'node:perf_hooks';
import { WebSocket, type RawData } from 'ws';
import { criarRegistrador, type Registrador } from '../../log.js';
import {
  RESULTADO_DECODIFICACAO,
  TIPO_HAPTICO,
  TIPO_RUMBLE,
  VERSAO_PROTOCOLO,
  criarCodificador,
  criarDecodificador,
  interpretarMensagemDeTexto,
  serializarMensagemDeTexto,
  type MensagemDeTexto,
} from '../../protocolo/indice.js';
import {
  TEMPO_INICIAL_DO_APARELHO_MS,
  criarAmostraSimulada,
  type AmostraSimulada,
  type FonteDeAmostras,
  type NomeDePadrao,
} from './padroes.js';

/** Sem `welcome` neste tempo, não há sessão: o simulador desiste em vez de esperar para sempre. */
export const LIMITE_DE_WELCOME_MS = 5000;

/** Espera pelo fechamento educado antes de cortar o socket. */
export const GRACA_DE_FECHAMENTO_MS = 500;

/** Como o simulador espera entre uma amostra e outra. */
export const RITMOS = ['timer', 'preciso'] as const;
export type Ritmo = (typeof RITMOS)[number];

export function ehRitmo(valor: string): valor is Ritmo {
  return (RITMOS as readonly string[]).includes(valor);
}

/**
 * Máximo de amostras que um disparo atrasado pode mandar de uma vez, no modo `timer`.
 *
 * Existe teto porque um laço síncrono ilimitado seguraria o event loop: com 60 s de atraso
 * acumulado ele tentaria despejar 6000 pacotes sem deixar o socket respirar. 64 cobre com folga
 * o pior caso real (~15,6 ms de atraso a 1000 Hz = 16 amostras).
 */
export const LOTE_MAXIMO = 64;

/**
 * Faixa final, antes do alvo, em que o modo `preciso` gira em vez de dormir.
 *
 * Um pouco acima da resolução padrão do Windows (15,6 ms) de propósito: é exatamente o trecho
 * em que `setTimeout` não consegue acordar na hora.
 */
export const MARGEM_DE_GIRO_MS = 17;

/** Como a execução terminou. */
export type DesfechoDoSimulador = 'completo' | 'servidor-encerrou' | 'erro' | 'cancelado';

export interface ResumoDoSimulador {
  readonly padrao: NomeDePadrao;
  readonly descricao: string;
  readonly amostrasPrevistas: number;
  readonly amostrasEnviadas: number;
  readonly bytesEnviados: number;
  /** Graus integrados no eixo escolhido (0 nos padrões em que o total não é o ponto). */
  readonly grausTotais: number;
  /** Do primeiro ao último envio. */
  readonly duracaoDoEnvioMs: number;
  /** Taxa que o simulador realmente conseguiu manter. */
  readonly taxaHzEfetiva: number;
  readonly atrasoMedioMs: number;
  readonly atrasoMaximoMs: number;
  /** Amostras enviadas com mais de um intervalo de atraso — o ritmo escorregou ali. */
  readonly amostrasForaDoRitmo: number;
  /** Quantas amostras saíram em lote, na mesma acordada do temporizador (modo `timer`). */
  readonly amostrasEmLote: number;
  readonly pingsRespondidos: number;
  readonly quadrosBinariosRecebidos: number;
  readonly rumblesRecebidos: number;
  readonly hapticosRecebidos: number;
  /** `id` da sessão que o servidor devolveu no `welcome`. */
  readonly sessao: string | undefined;
  readonly desfecho: DesfechoDoSimulador;
  readonly motivo: string;
}

export interface OpcoesDoCliente {
  /** Endereço do servidor, `ws://host:porta`. */
  readonly url: string;
  readonly fonte: FonteDeAmostras;
  readonly registrador?: Registrador | undefined;
  /** Relógio monotônico em ms. Trocável no teste. */
  readonly relogio?: (() => number) | undefined;
  /** `taxaHzDesejada` do `hello`. O padrão vem da fonte (1000 / dt da primeira amostra). */
  readonly taxaHzDesejada?: number | undefined;
  readonly nomeDoAparelho?: string | undefined;
  readonly idDoAparelho?: string | undefined;
  readonly limiteDeWelcomeMs?: number | undefined;
  readonly gracaDeFechamentoMs?: number | undefined;
  /**
   * `true` (padrão) encerra limpo: quadro `bye` e depois o *close handshake* do WebSocket.
   *
   * `false` encerra **abrupto**: nenhum `bye`, nenhum quadro de fechamento — o socket é cortado
   * com `terminate()`. Do lado do servidor não chega código de fechamento nenhum (o `ws` reporta
   * 1006), que é o caminho em que a sessão morre sem aviso e onde nasce botão preso (regra 5 do
   * CLAUDE.md). Não é o socket **meio-aberto** da seção 3.6 do PROTOCOLO.md (esse não gera
   * fechamento nenhum, e não dá para produzi-lo de dentro do processo: exige cortar o pacote
   * fora do sistema); é o corte mais abrupto que o cliente consegue fazer sozinho.
   */
  readonly enviarBye?: boolean | undefined;
  /** `timer` (padrão, barato) ou `preciso` (espaçamento fiel, gira CPU). */
  readonly ritmo?: Ritmo | undefined;
  /** Chamado a cada amostra enviada. ⚠️ Caminho quente: nada de trabalho pesado aqui. */
  readonly aoEnviar?: ((amostra: AmostraSimulada) => void) | undefined;
}

export interface Simulador {
  /** Conecta, envia e resolve com o resumo. **Não rejeita**: falha vira `desfecho: 'erro'`. */
  executar(): Promise<ResumoDoSimulador>;
  /** Interrompe no meio (Ctrl+C). Idempotente. */
  cancelar(motivo: string): void;
}

/** Registrador mudo: por padrão o simulador não polui o terminal de quem o chama. */
const REGISTRADOR_MUDO = criarRegistrador('erro', 'simulador', () => {
  // De propósito vazio.
});

export function criarSimulador(opcoes: OpcoesDoCliente): Simulador {
  const registrador = opcoes.registrador ?? REGISTRADOR_MUDO;
  const relogio = opcoes.relogio ?? (() => performance.now());
  const fonte = opcoes.fonte;
  const limiteDeWelcomeMs = opcoes.limiteDeWelcomeMs ?? LIMITE_DE_WELCOME_MS;
  const gracaDeFechamentoMs = opcoes.gracaDeFechamentoMs ?? GRACA_DE_FECHAMENTO_MS;
  const enviarBye = opcoes.enviarBye ?? true;
  const ritmo: Ritmo = opcoes.ritmo ?? 'timer';

  const codificador = criarCodificador();
  const decodificador = criarDecodificador();
  const amostra = criarAmostraSimulada();

  let socket: WebSocket | undefined;
  let relogioDeEnvio: NodeJS.Timeout | undefined;
  let relogioDeWelcome: NodeJS.Timeout | undefined;
  let relogioDeFechamento: NodeJS.Timeout | undefined;
  let giroPendente: NodeJS.Immediate | undefined;
  let concluir: ((resumo: ResumoDoSimulador) => void) | undefined;
  let terminado = false;

  let inicioDoEnvioMs = 0;
  let fimDoEnvioMs = 0;
  let inicioDaConexaoMs = 0;
  let alvoAcumuladoMs = 0;
  let enviadas = 0;
  let bytesEnviados = 0;
  let somaDeAtrasoMs = 0;
  let atrasoMaximoMs = 0;
  let amostrasForaDoRitmo = 0;
  let amostrasEmLote = 0;
  let pingsRespondidos = 0;
  let quadrosBinariosRecebidos = 0;
  let rumblesRecebidos = 0;
  let hapticosRecebidos = 0;
  let sessao: string | undefined;
  let temProximaAmostra = false;

  /** Relógio do "aparelho": monotônico, começa no mesmo lugar do `tDispositivoMs` das amostras. */
  function relogioDoAparelho(): number {
    return Math.round(TEMPO_INICIAL_DO_APARELHO_MS + (relogio() - inicioDaConexaoMs));
  }

  function montarResumo(desfecho: DesfechoDoSimulador, motivo: string): ResumoDoSimulador {
    const duracaoDoEnvioMs = enviadas > 0 ? fimDoEnvioMs - inicioDoEnvioMs : 0;
    return {
      padrao: fonte.padrao,
      descricao: fonte.descricao,
      amostrasPrevistas: fonte.total,
      amostrasEnviadas: enviadas,
      bytesEnviados,
      grausTotais: fonte.grausTotais,
      duracaoDoEnvioMs,
      // `enviadas - 1` porque a primeira amostra sai no instante zero: com n envios existem
      // n − 1 intervalos, e dividir por n daria uma taxa sistematicamente menor.
      taxaHzEfetiva:
        enviadas > 1 && duracaoDoEnvioMs > 0 ? ((enviadas - 1) * 1000) / duracaoDoEnvioMs : 0,
      atrasoMedioMs: enviadas > 0 ? somaDeAtrasoMs / enviadas : 0,
      atrasoMaximoMs,
      amostrasForaDoRitmo,
      amostrasEmLote,
      pingsRespondidos,
      quadrosBinariosRecebidos,
      rumblesRecebidos,
      hapticosRecebidos,
      sessao,
      desfecho,
      motivo,
    };
  }

  function limparRelogios(): void {
    if (giroPendente !== undefined) {
      clearImmediate(giroPendente);
      giroPendente = undefined;
    }
    if (relogioDeEnvio !== undefined) {
      clearTimeout(relogioDeEnvio);
      relogioDeEnvio = undefined;
    }
    if (relogioDeWelcome !== undefined) {
      clearTimeout(relogioDeWelcome);
      relogioDeWelcome = undefined;
    }
    if (relogioDeFechamento !== undefined) {
      clearTimeout(relogioDeFechamento);
      relogioDeFechamento = undefined;
    }
  }

  /**
   * Caminho **único** de saída, chame quem chamar (fim da fonte, erro de socket, `bye` do
   * servidor, Ctrl+C). Roda uma vez só e nunca deixa temporizador nem socket para trás — a
   * mesma regra do `encerrar()` da sessão do servidor (regra 5 do CLAUDE.md).
   */
  function finalizar(desfecho: DesfechoDoSimulador, motivo: string): void {
    if (terminado) return;
    terminado = true;
    limparRelogios();

    const socketAtual = socket;
    if (socketAtual !== undefined) {
      if (socketAtual.readyState === socketAtual.OPEN && enviarBye) {
        socketAtual.send(serializarMensagemDeTexto({ t: 'bye', motivo }));
        socketAtual.close(1000, 'simulador encerrando');
        // Fechamento educado espera resposta do outro lado. Se ela não vier, o socket é
        // cortado — senão o processo do simulador ficaria pendurado depois de terminar.
        relogioDeFechamento = setTimeout(() => {
          socketAtual.terminate();
        }, gracaDeFechamentoMs);
        relogioDeFechamento.unref();
      } else {
        // Sem `bye`, o encerramento é **abrupto de verdade**: nada de `close(1000)`, que faria o
        // close handshake e entregaria ao servidor um fechamento tão limpo quanto o normal. O
        // socket é cortado, e o servidor descobre a queda como descobriria a de um aparelho que
        // sumiu. Vale também para socket que já não está aberto: não há o que negociar.
        socketAtual.terminate();
      }
    }

    const resumo = montarResumo(desfecho, motivo);
    registrador.info('simulador encerrado', {
      desfecho,
      motivo,
      amostras: enviadas,
      taxaHz: Number(resumo.taxaHzEfetiva.toFixed(2)),
    });
    concluir?.(resumo);
    concluir = undefined;
  }

  function enviarTexto(mensagem: MensagemDeTexto): void {
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(serializarMensagemDeTexto(mensagem));
  }

  /** ⚠️ Caminho quente. Escreve o pacote no buffer reaproveitado do codec e manda. */
  function enviarAmostra(): void {
    const socketAtual = socket;
    if (socketAtual === undefined || socketAtual.readyState !== WebSocket.OPEN) {
      finalizar('erro', 'socket fechou no meio do envio');
      return;
    }
    const pacote = amostra.temAcelerometro
      ? codificador.movimentoComAcelerometro(
          amostra.seq,
          amostra.tDispositivoMs,
          amostra.dtMs,
          amostra.gx,
          amostra.gy,
          amostra.gz,
          amostra.ax,
          amostra.ay,
          amostra.az,
          amostra.flags,
        )
      : codificador.movimento(
          amostra.seq,
          amostra.tDispositivoMs,
          amostra.dtMs,
          amostra.gx,
          amostra.gy,
          amostra.gz,
          amostra.flags,
        );
    // `send` copia para a fila do socket de forma síncrona: por isso dá para reaproveitar a
    // janela do codificador sem copiar (ver o aviso em `binario.ts`).
    socketAtual.send(pacote, { binary: true });
    bytesEnviados += pacote.byteLength;
    enviadas += 1;
    opcoes.aoEnviar?.(amostra);
  }

  /**
   * Manda a(s) amostra(s) cujo alvo já chegou e agenda a próxima.
   *
   * O laço só continua enquanto o **alvo seguinte já passou** — é a recuperação de um disparo
   * atrasado, não uma rajada por escolha. Sem ele, num sistema cuja acordada mínima é 15,6 ms,
   * a taxa efetiva ficaria presa em ~67 Hz por mais correta que fosse a conta do alvo.
   */
  function passo(): void {
    if (terminado || !temProximaAmostra) return;

    for (let noLote = 0; noLote < LOTE_MAXIMO; noLote += 1) {
      const agora = relogio();
      const atraso = agora - (inicioDoEnvioMs + alvoAcumuladoMs);
      // Adiantamento não é atraso: o temporizador pode acordar um pouco antes do alvo, e somar
      // esse número negativo faria o "atraso médio" do resumo parecer melhor do que foi.
      if (atraso > 0) somaDeAtrasoMs += atraso;
      if (atraso > atrasoMaximoMs) atrasoMaximoMs = atraso;
      if (amostra.dtMs > 0 && atraso > amostra.dtMs) amostrasForaDoRitmo += 1;
      if (noLote > 0) amostrasEmLote += 1;

      enviarAmostra();
      fimDoEnvioMs = agora;
      if (terminado) return;

      temProximaAmostra = fonte.proxima(amostra);
      if (!temProximaAmostra) {
        finalizar('completo', 'sequência concluída');
        return;
      }

      alvoAcumuladoMs += amostra.dtMs;
      if (inicioDoEnvioMs + alvoAcumuladoMs - relogio() > 0) break;
    }

    agendar();
  }

  /** Escolhe entre dormir (barato) e girar (fiel), conforme o modo e o quanto falta. */
  function agendar(): void {
    if (terminado) return;
    const faltaMs = inicioDoEnvioMs + alvoAcumuladoMs - relogio();
    if (ritmo === 'preciso' && faltaMs < MARGEM_DE_GIRO_MS) {
      // `setImmediate` volta depois de o event loop atender o I/O pendente: o socket continua
      // sendo servido enquanto se espera, ao contrário de um `while` puro.
      giroPendente = setImmediate(girar);
      return;
    }
    relogioDeEnvio = setTimeout(passo, faltaMs > 0 ? faltaMs : 0);
  }

  function girar(): void {
    giroPendente = undefined;
    if (terminado) return;
    if (relogio() < inicioDoEnvioMs + alvoAcumuladoMs) {
      giroPendente = setImmediate(girar);
      return;
    }
    passo();
  }

  function comecarAEnviar(): void {
    temProximaAmostra = fonte.proxima(amostra);
    if (!temProximaAmostra) {
      finalizar('completo', 'a fonte não tem amostra nenhuma');
      return;
    }
    inicioDoEnvioMs = relogio();
    // A primeira amostra sai no instante zero, e não em `dtMs`: o `dtMs` de uma amostra é o
    // intervalo desde a **anterior**, e a primeira não tem anterior. Nos padrões gerados isso dá
    // no mesmo (a primeira vai com `dtMs` 0), mas uma captura pode começar com `dtMs` > 0 — e aí
    // o alvo antigo empurrava a sequência inteira e ainda contava um atraso negativo no resumo.
    alvoAcumuladoMs = 0;
    passo();
  }

  function tratarTexto(quadro: string): void {
    const leitura = interpretarMensagemDeTexto(quadro);
    if (!leitura.ok) {
      finalizar('erro', `o servidor mandou um quadro que não entendi: ${leitura.motivo}`);
      return;
    }

    const mensagem = leitura.mensagem;
    switch (mensagem.t) {
      case 'welcome':
        if (relogioDeWelcome !== undefined) {
          clearTimeout(relogioDeWelcome);
          relogioDeWelcome = undefined;
        }
        sessao = mensagem.sessao.id;
        registrador.info('sessão aceita pelo servidor', {
          sessao: mensagem.sessao.id,
          taxaHz: mensagem.sessao.taxaHz,
          servidor: mensagem.servidor.nome,
          // O perfil é `Record<string, unknown>` (quem valida conteúdo é o módulo `perfis/`):
          // só o `id` textual interessa aqui, e o resto vira travessão em vez de `[object Object]`.
          perfil: typeof mensagem.perfilAtivo['id'] === 'string' ? mensagem.perfilAtivo['id'] : '—',
        });
        comecarAEnviar();
        return;

      case 'ping':
        // O eco tem de ser **exato**: o servidor confere `n` e `tServidorMs` antes de deixar o
        // RTT entrar na estatística (PROTOCOLO.md, seção 3.6).
        enviarTexto({
          t: 'pong',
          n: mensagem.n,
          tServidorMs: mensagem.tServidorMs,
          tDispositivoMs: relogioDoAparelho(),
        });
        pingsRespondidos += 1;
        return;

      case 'erro':
        finalizar('erro', `o servidor recusou a sessão: ${mensagem.codigo}`);
        return;

      case 'bye':
        finalizar('servidor-encerrou', mensagem.motivo ?? 'o servidor mandou bye');
        return;

      default:
        // `config-ok`, `cmd-ok`, `cmd-erro`: o simulador não manda `config` nem `cmd` nesta
        // fase, então não há resposta esperada — ignorar é mais honesto do que reagir.
        return;
    }
  }

  /** Mesma conversão do lado do servidor (`transporte/sessao.ts`): cópia só no caso raro. */
  function comoBytes(dados: RawData): Uint8Array {
    if (Buffer.isBuffer(dados)) return dados;
    if (Array.isArray(dados)) return Buffer.concat(dados);
    return new Uint8Array(dados);
  }

  function comoTexto(dados: RawData): string {
    if (Buffer.isBuffer(dados)) return dados.toString('utf8');
    if (Array.isArray(dados)) return Buffer.concat(dados).toString('utf8');
    return Buffer.from(dados).toString('utf8');
  }

  function tratarBinario(dados: RawData): void {
    quadrosBinariosRecebidos += 1;
    if (decodificador.decodificar(comoBytes(dados)) !== RESULTADO_DECODIFICACAO.OK) return;
    if (decodificador.saida.tipo === TIPO_RUMBLE) rumblesRecebidos += 1;
    else if (decodificador.saida.tipo === TIPO_HAPTICO) hapticosRecebidos += 1;
  }

  return {
    executar() {
      return new Promise<ResumoDoSimulador>((resolver) => {
        concluir = resolver;
        inicioDaConexaoMs = relogio();

        const novo = new WebSocket(opcoes.url, { perMessageDeflate: false });
        novo.binaryType = 'nodebuffer';
        socket = novo;

        novo.on('open', () => {
          enviarTexto({
            t: 'hello',
            v: VERSAO_PROTOCOLO,
            aparelho: {
              id: opcoes.idDoAparelho ?? 'simulador-000000',
              nome: opcoes.nomeDoAparelho ?? 'Simulador',
              so: 'android',
              versaoSo: '14',
              modelo: 'controle-simulador',
            },
            capacidades: ['giroscopio', 'acelerometro'],
            taxaHzDesejada: opcoes.taxaHzDesejada ?? 100,
          });
          relogioDeWelcome = setTimeout(() => {
            relogioDeWelcome = undefined;
            finalizar('erro', `o servidor não mandou welcome em ${limiteDeWelcomeMs} ms`);
          }, limiteDeWelcomeMs);
        });

        novo.on('message', (dados: RawData, ehBinario: boolean) => {
          if (ehBinario) tratarBinario(dados);
          else tratarTexto(comoTexto(dados));
        });

        novo.on('error', (erro: Error) => {
          finalizar('erro', `erro de socket: ${erro.message}`);
        });

        novo.on('close', () => {
          // O fechamento chegou dentro da graça: o corte de misericórdia não tem mais função, e
          // `finalizar` já saiu cedo por causa da guarda de `terminado` — quem cancela o
          // temporizador tem de ser este caminho, senão ele fica marcado depois do fim (a regra
          // do comentário de `finalizar`: nunca deixar temporizador para trás).
          if (relogioDeFechamento !== undefined) {
            clearTimeout(relogioDeFechamento);
            relogioDeFechamento = undefined;
          }
          // Se a sequência já tinha acabado, `finalizar` rodou antes e este `close` é o eco do
          // nosso próprio fechamento — a guarda de `terminado` cuida disso.
          finalizar('servidor-encerrou', 'o servidor fechou a conexão');
        });
      });
    },

    cancelar(motivo) {
      finalizar('cancelado', motivo);
    },
  };
}
