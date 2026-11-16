/**
 * O contrato da camada de saída: `BackendDeEntrada` (docs/ARQUITETURA.md, seção 2.3).
 *
 * Uma interface só, implementações por plataforma. Quem está acima daqui — o pipeline de
 * movimento (ATI-008) e o mapeador de perfis (ATI-018) — fala **sempre** com esta interface e
 * nunca com `user32.dll`: é o que permite testar todo o sprint 2 sem mexer no cursor da máquina
 * de quem está desenvolvendo (`dubla.ts`) e é o que deixa a porta aberta para outra plataforma
 * sem tocar em nada acima.
 *
 * Três regras deste módulo, e nenhuma delas é negociável:
 *
 * 1. **Nada de clique atômico.** Aperto e soltura são chamadas separadas (`pressionado: boolean`).
 *    Sem isso não existe arrastar, e arrastar é metade do que um mouse faz.
 * 2. **Tudo que pressiona sabe soltar.** O backend guarda o que está preso e `soltarTudo()`
 *    devolve o sistema ao estado neutro — idempotente, chamável de qualquer caminho de saída
 *    (desconexão, erro, pausa, troca de perfil, Ctrl+C). Regra 5 do CLAUDE.md.
 * 3. **Erro vira número, não exceção.** No caminho quente ninguém está olhando: o que a chamada
 *    do sistema recusou entra em `contadores`, e quem quiser saber lê depois (regra 7 do
 *    CLAUDE.md — medição com número).
 *
 * ⚠️ CAMINHO QUENTE: `moverMouseRelativo` roda uma vez por pacote de sensor, 100 vezes por
 * segundo. Nenhuma implementação pode alocar, formatar texto ou registrar log por chamada.
 */

import type { DescricaoDaSaidaDoMouse } from './saida-do-mouse.js';

/** Os três botões da v1. Nomes em PT-BR, como manda a seção 4 do ARQUITETURA.md. */
export type BotaoDoMouse = 'esquerdo' | 'direito' | 'meio';

/** Lista canônica dos botões — a fonte de verdade de "quais botões existem". */
export const BOTOES_DO_MOUSE: readonly BotaoDoMouse[] = Object.freeze([
  'esquerdo',
  'direito',
  'meio',
]);

/**
 * Se o valor é um dos três botões da v1.
 *
 * Guarda de fronteira, não zelo de tipo: o mapeador de perfis (ATI-018) e o pipeline (ATI-008)
 * traduzem o `idControle` que veio **do fio** para estes nomes, e tradução errada chega aqui como
 * uma string qualquer. Sem esta guarda, um nome desconhecido viraria exceção dentro do caminho
 * quente — e nada trata exceção a 100 Hz. Com ela, vira `pedidosInvalidos`.
 *
 * Sem alocação: `typeof` mais uma varredura de três posições.
 */
export function ehBotaoDoMouse(valor: unknown): valor is BotaoDoMouse {
  return typeof valor === 'string' && (BOTOES_DO_MOUSE as readonly string[]).includes(valor);
}

/** Resolução da área de trabalho principal, em pixels. */
export interface TamanhoDaTela {
  readonly largura: number;
  readonly altura: number;
}

/** Posição do cursor em coordenadas de tela. */
export interface PosicaoDoMouse {
  readonly x: number;
  readonly y: number;
}

/**
 * Contadores do backend. Objeto **mutável reaproveitado** — mesmo padrão do `ContadoresDoCodec`
 * (`protocolo/binario.ts`): o caminho quente só incrementa campo já alocado.
 *
 * Ler estes números é a única forma honesta de responder "a injeção está funcionando?": no meio
 * de um jogo ninguém vê log, e uma exceção por evento a 100 Hz derrubaria o servidor.
 */
export interface ContadoresDeSaida {
  /** Eventos que o sistema aceitou (`SendInput` devolveu exatamente o que foi pedido). */
  eventosEnviados: number;
  /**
   * Eventos que o sistema **não** aceitou.
   *
   * `SendInput` devolve quantos eventos entrou na fila; qualquer número diferente do pedido é
   * bloqueio (UIPI: janela elevada em primeiro plano) ou erro de estrutura. Ver
   * `ultimoCodigoDeErro`.
   */
  eventosRecusados: number;
  /** Chamadas de apoio que falharam (`SetCursorPos`, `GetCursorPos`, `GetSystemMetrics`). */
  chamadasComErro: number;
  /** `GetLastError()` da última falha; 0 enquanto nada falhou. */
  ultimoCodigoDeErro: number;
  /** Pedidos recusados por valor inválido (NaN, infinito, scancode fora da faixa). */
  pedidosInvalidos: number;
  /** Pedidos que não geraram evento por serem nulos (`dx=dy=0`, scroll de zero). */
  pedidosNulos: number;
  /**
   * Pedidos ignorados por já estarem no estado pedido — soltar o que não está preso, ou apertar
   * o que já está.
   *
   * Existe por segurança, não por economia: o estado de botão é **global** no Windows. Injetar
   * um "solta o esquerdo" que nós não apertamos soltaria o botão que a pessoa está segurando com
   * a mão de verdade.
   */
  pedidosRedundantes: number;
  /** Botões e teclas que `soltarTudo()` encontrou presos e soltou. */
  soltasDeSeguranca: number;
}

/** Contadores zerados. Objeto novo a cada chamada — nunca no caminho quente. */
export function criarContadoresDeSaida(): ContadoresDeSaida {
  return {
    eventosEnviados: 0,
    eventosRecusados: 0,
    chamadasComErro: 0,
    ultimoCodigoDeErro: 0,
    pedidosInvalidos: 0,
    pedidosNulos: 0,
    pedidosRedundantes: 0,
    soltasDeSeguranca: 0,
  };
}

/**
 * Zera os contadores **no mesmo objeto**.
 *
 * Existe porque `contadores` é uma referência que outros módulos guardam (telemetria, testes):
 * trocar o objeto por um novo deixaria quem guardou lendo o antigo para sempre.
 */
export function zerarContadoresDeSaida(alvo: ContadoresDeSaida): void {
  alvo.eventosEnviados = 0;
  alvo.eventosRecusados = 0;
  alvo.chamadasComErro = 0;
  alvo.ultimoCodigoDeErro = 0;
  alvo.pedidosInvalidos = 0;
  alvo.pedidosNulos = 0;
  alvo.pedidosRedundantes = 0;
  alvo.soltasDeSeguranca = 0;
}

/**
 * Backend de entrada — a interface da seção 2.3 do ARQUITETURA.md.
 *
 * Além dos cinco métodos do esboço original, o contrato entregue na ATI-007 traz o que a regra 5
 * do CLAUDE.md exige (`soltarTudo`, `pressionados`) e o que o comando **centralizar** precisa
 * (`tamanhoDaTela`, `lerPosicaoDoMouse`) — o esboço já previa o centralizar, só não tinha dito
 * por onde o centro chegaria.
 */
export interface BackendDeEntrada {
  /** Identificação curta para log e telemetria: `windows`, `dubla`. */
  readonly nome: string;
  /** Contadores vivos; o objeto é o mesmo entre chamadas (não copie a referência esperando cópia). */
  readonly contadores: ContadoresDeSaida;
  /**
   * Como o movimento sai para o sistema e o estado da aceleração de ponteiro (ATI-026). Opcional:
   * só o backend do Windows tem o que dizer; a dubla diz quando o teste pede.
   */
  readonly saidaDoMouse?: DescricaoDaSaidaDoMouse | undefined;

  /**
   * ⚠️ Caminho quente. Movimento **relativo**, em pixels inteiros.
   *
   * Relativo e não absoluto porque é o que gyro aim exige: "mais 3 px para a direita", e não "vá
   * para o pixel 812" — mira absoluta embute a posição anterior e briga com o jogo.
   *
   * O **pedido** é sempre relativo; **como ele chega ao sistema** é a saída do mouse (ATI-026,
   * {@link saidaDoMouse}): o backend do Windows pode realizá-lo em coordenada absoluta (posição
   * atual + deslocamento), que não passa pela aceleração de ponteiro.
   */
  moverMouseRelativo(dx: number, dy: number): void;

  /** Posição absoluta em coordenadas de tela. É o que o comando **centralizar** usa. */
  posicionarMouse(x: number, y: number): void;

  /** Aperta (`true`) ou solta (`false`) um botão. Nunca há clique atômico — ver regra 1 acima. */
  botaoMouse(botao: BotaoDoMouse, pressionado: boolean): void;

  /**
   * Roda a roda do mouse, em **entalhes** (um entalhe = `WHEEL_DELTA`, 120).
   *
   * Sinais como o Win32 define: vertical positivo rola para **cima** (para longe de quem usa),
   * horizontal positivo rola para a **direita**. Aceita fração (rolagem suave); quem converte
   * para a unidade do sistema é o backend.
   */
  scroll(deltaVertical: number, deltaHorizontal: number): void;

  /**
   * Aperta ou solta uma tecla por **scancode** (não por virtual-key): jogo que lê DirectInput
   * só enxerga scancode. Códigos estendidos entram como `0xE0xx` (setas, Ctrl direito, etc.).
   */
  tecla(scancode: number, pressionada: boolean): void;

  /** Resolução da tela principal. `undefined` quando o sistema não soube informar. */
  tamanhoDaTela(): TamanhoDaTela | undefined;

  /** Onde o cursor está agora. `undefined` quando a leitura falhou. */
  lerPosicaoDoMouse(): PosicaoDoMouse | undefined;

  /** Quantos botões e teclas este backend tem presos neste instante. */
  pressionados(): number;

  /**
   * Solta **tudo** que este backend apertou, na ordem inversa do aperto. Idempotente: chamar duas
   * vezes seguidas não manda evento nenhum na segunda.
   */
  soltarTudo(): void;

  /**
   * Solta tudo e desliga a rede de segurança da saída do processo. Depois disto o backend
   * continua utilizável (nada é destruído), só não há mais quem solte por ele.
   */
  encerrar(): void;
}

/**
 * Pedido que a camada de saída não tem como atender: sistema sem backend, biblioteca do sistema
 * que não carrega, estrutura com tamanho diferente do que o Windows espera.
 *
 * Só nasce **fora** do caminho quente — na escolha e na carga do backend. Já com o backend de
 * pé, erro vira contador, nunca exceção.
 */
export class ErroDeSaida extends Error {
  constructor(mensagem: string, opcoes?: { readonly cause?: unknown }) {
    super(mensagem, opcoes);
    this.name = 'ErroDeSaida';
  }
}
