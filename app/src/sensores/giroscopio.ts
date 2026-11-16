/**
 * Ponte tipada para o módulo nativo `Giroscopio`.
 *
 * O módulo nativo entrega uma amostra crua por evento do sensor. Este arquivo só assina, cancela e
 * dá tipo — não filtra, não calibra e não converte unidade (ADR-4: regra no servidor, sensor cru
 * no fio). A única coisa que ele garante é que o sensor nativo fica ligado enquanto houver ao menos
 * um assinante, e desligado quando o último cancela.
 */

import {NativeEventEmitter, NativeModules} from 'react-native';
import type {EventSubscription} from 'react-native';

/** Uma leitura do giroscópio, como sai do sensor. */
export type AmostraGiroscopio = {
  /** Velocidade angular no eixo X, em rad/s. */
  readonly gx: number;
  /** Velocidade angular no eixo Y, em rad/s. */
  readonly gy: number;
  /** Velocidade angular no eixo Z, em rad/s. */
  readonly gz: number;
  /** Carimbo monotônico do próprio evento de sensor, em ms. */
  readonly tDispositivoMs: number;
  /** Intervalo real desde a amostra anterior, medido no nativo. 0 = primeira amostra do ciclo. */
  readonly dtMs: number;
};

/** Descrição do sensor, devolvida quando a leitura começa. */
export type InfoGiroscopio = {
  readonly nome: string;
  readonly fornecedor: string;
  readonly taxaHzSolicitada: number;
  readonly periodoUs: number;
  /** Menor período que o sensor aceita, segundo o próprio Android. */
  readonly periodoMinimoUs: number;
  readonly resolucaoRadS: number;
};

export type OpcoesDeAssinatura = {
  readonly taxaHz: number;
  readonly aoReceber: (amostra: AmostraGiroscopio) => void;
  readonly aoIniciar?: (info: InfoGiroscopio) => void;
  readonly aoFalhar?: (erro: Error) => void;
};

export type AssinaturaGiroscopio = {
  /** Idempotente: chamar duas vezes não desliga o sensor de outro assinante. */
  cancelar(): void;
};

/** Em que ponto está a partida do sensor nativo — que é um só para o app inteiro. */
export type EstadoDaPartida = 'parado' | 'pendente' | 'ligado' | 'falhou';

type ModuloGiroscopioNativo = {
  iniciar(taxaHz: number): Promise<InfoGiroscopio>;
  parar(): void;
  addListener(nomeEvento: string): void;
  removeListeners(quantidade: number): void;
};

/** Deve casar com `EVENTO_AMOSTRA_GIROSCOPIO` do GiroscopioModule.kt. */
const NOME_DO_EVENTO = 'controleGiroscopioAmostra' as const;

/** Deve casar com `EVENTO_FALHA_GIROSCOPIO` do GiroscopioModule.kt. */
const NOME_DO_EVENTO_FALHA = 'controleGiroscopioFalha' as const;

/** Falha avisada pelo nativo por fora de qualquer promessa (hoje: o religar do segundo plano). */
type FalhaNativa = {
  readonly codigo: string;
  readonly mensagem: string;
};

type MapaDeEventosDoGiroscopio = {
  readonly controleGiroscopioAmostra: readonly [AmostraGiroscopio];
  readonly controleGiroscopioFalha: readonly [FalhaNativa];
};

const CODIGO_FALHA_DESCONHECIDA = 'FALHA_DESCONHECIDA';
const MENSAGEM_FALHA_DESCONHECIDA =
  'o módulo nativo avisou falha sem dizer qual (corpo do evento fora do formato)';

const MENSAGEM_SEM_MODULO =
  'Módulo nativo Giroscopio indisponível. Reinstale o app depois de compilar o Android ' +
  '(o módulo é código nativo, não recarrega pelo Metro).';

const ASSINATURA_INERTE: AssinaturaGiroscopio = {
  cancelar(): void {
    // Nada a cancelar: a assinatura nunca chegou a existir.
  },
};

type Assinante = {
  readonly opcoes: OpcoesDeAssinatura;
  readonly inscricao: EventSubscription;
  /** Falso a partir do cancelamento (ou da falha da partida): nenhum aviso chega depois disso. */
  viva: boolean;
};

/*
 * Estado de módulo (global ao bundle), porque o listener nativo também é um só para o app inteiro.
 *
 * Armadilha conhecida do ciclo de desenvolvimento: num *fast refresh* este estado sobrevive ao
 * remount da tela, enquanto o estado do lado nativo pode não sobreviver. Se a medição parecer
 * travada logo depois de salvar um arquivo, recarregue o app inteiro (R+R) em vez de confiar no
 * recarregamento parcial — em produção o caso não existe.
 *
 * Pelo mesmo motivo, `__tests__/giroscopio.test.ts` zera o registro de módulos a cada teste: sem
 * isso, o que um teste deixa aqui atravessa para o seguinte.
 */
const assinantes = new Set<Assinante>();
let estadoDaPartida: EstadoDaPartida = 'parado';
let infoDaPartida: InfoGiroscopio | null = null;
let erroDaPartida: Error | null = null;
/** Taxa pedida à partida em curso (ou à última que ligou). `null` quando não há partida. */
let taxaHzDaPartida: number | null = null;
/** Identifica a tentativa de partida em curso; desfecho de tentativa velha é ignorado. */
let tentativaDePartida = 0;
/**
 * Escuta do evento de falha do nativo. É uma só para o app inteiro (o evento também é), e existe
 * apenas enquanto houver assinante — sem ninguém para avisar, não há o que escutar.
 */
let inscricaoDeFalha: EventSubscription | null = null;

/**
 * Resolvido a cada chamada, não no carregamento do arquivo: importar este módulo não pode depender
 * de o registro nativo já existir (o Metro carrega o JS antes de a ponte terminar de subir).
 */
function obterModuloNativo(): ModuloGiroscopioNativo | undefined {
  const modulo = NativeModules.Giroscopio as ModuloGiroscopioNativo | undefined;
  return modulo == null ? undefined : modulo;
}

/** Verdadeiro quando o módulo nativo foi compilado dentro do app. */
export function giroscopioDisponivel(): boolean {
  return obterModuloNativo() !== undefined;
}

/** Diagnóstico somente-leitura: em que pé está a partida, quantos assinantes, qual foi o erro. */
export function situacaoDoGiroscopio(): {
  readonly estado: EstadoDaPartida;
  readonly assinantes: number;
  readonly erro: Error | null;
} {
  return {
    estado: estadoDaPartida,
    assinantes: assinantes.size,
    erro: erroDaPartida,
  };
}

/**
 * Começa a receber amostras. A primeira assinatura liga o sensor; a última a cancelar o desliga.
 *
 * Com o sensor **já ligado**, vale a `taxaHz` de quem disparou a partida — o Android registra um
 * período por listener nativo, e aqui só existe um. A exceção é a partida ainda **pendente**: uma
 * assinatura que peça outra taxa nessa janela reinicia a partida, senão mediria na taxa de quem
 * veio antes sem que a tela tivesse como perceber.
 *
 * Se a partida falhar, **todos** os assinantes vivos são avisados por `aoFalhar` e soltos; a
 * assinatura seguinte tenta ligar o sensor de novo, com a taxa que ela pedir. Vale tanto para a
 * rejeição de `iniciar()` quanto para a falha que o nativo avisa por evento (o religar do segundo
 * plano, que não tem promessa para rejeitar).
 */
export function assinarGiroscopio(
  opcoes: OpcoesDeAssinatura,
): AssinaturaGiroscopio {
  const modulo = obterModuloNativo();
  if (modulo === undefined) {
    opcoes.aoFalhar?.(new Error(MENSAGEM_SEM_MODULO));
    return ASSINATURA_INERTE;
  }

  // Um emissor por assinatura: o construtor não registra nada globalmente (a entrega é sempre pelo
  // `RCTDeviceEventEmitter`), então guardar um em cache só criaria referência velha após recarga.
  const emissor = new NativeEventEmitter<MapaDeEventosDoGiroscopio>(modulo);
  const assinante: Assinante = {
    opcoes,
    inscricao: emissor.addListener(NOME_DO_EVENTO, opcoes.aoReceber),
    viva: true,
  };
  assinantes.add(assinante);
  garantirEscutaDeFalha(modulo);

  if (estadoDaPartida === 'parado' || estadoDaPartida === 'falhou') {
    iniciarPartida(modulo, opcoes.taxaHz);
  } else if (
    estadoDaPartida === 'pendente' &&
    opcoes.taxaHz !== taxaHzDaPartida
  ) {
    // Partida em voo com outra taxa. Sem reiniciar, esta assinatura mediria calada no período da
    // anterior: na tela de telemetria, trocar de 100 para 200 Hz antes de a promessa resolver
    // mostraria "alvo 200 Hz" com o sensor a 100. Reiniciar troca o período no nativo (que
    // desregistra e registra de novo) e faz a descrição do sensor chegar coerente com o pedido.
    iniciarPartida(modulo, opcoes.taxaHz);
  } else if (estadoDaPartida === 'ligado') {
    avisarPartidaJaFeita(assinante);
  }
  // 'pendente' com a mesma taxa: o desfecho da promessa avisa todo mundo de uma vez.

  return {
    cancelar: () => encerrarAssinante(assinante, modulo),
  };
}

/**
 * A falha do religar chega por evento, não por promessa: sem esta escuta o sensor pararia depois
 * do segundo plano sem ninguém no JS ficar sabendo (ver `onHostResume` no GiroscopioModule.kt).
 */
function garantirEscutaDeFalha(modulo: ModuloGiroscopioNativo): void {
  if (inscricaoDeFalha !== null) {
    return;
  }
  const emissor = new NativeEventEmitter<MapaDeEventosDoGiroscopio>(modulo);
  inscricaoDeFalha = emissor.addListener(NOME_DO_EVENTO_FALHA, falha =>
    tratarFalhaNativa(falha, modulo),
  );
}

function soltarEscutaDeFalha(): void {
  inscricaoDeFalha?.remove();
  inscricaoDeFalha = null;
}

function tratarFalhaNativa(
  falha: Partial<FalhaNativa> | null | undefined,
  modulo: ModuloGiroscopioNativo,
): void {
  // A partida em curso deixou de valer: descartar o desfecho dela impede que uma promessa antiga
  // ressuscite o estado 'ligado' depois de todo mundo já ter sido avisado da falha.
  tentativaDePartida += 1;
  derrubarPartida(new Error(descreverFalhaNativa(falha)), modulo);
}

/**
 * O `RCTDeviceEventEmitter` é um espaço de nomes global do app: nada garante que o corpo do evento
 * tenha a forma que o GiroscopioModule.kt emite. Sem normalizar, um corpo torto viraria
 * "undefined: undefined" na tela — justamente no caminho de erro mais difícil de reproduzir.
 */
function descreverFalhaNativa(
  falha: Partial<FalhaNativa> | null | undefined,
): string {
  const codigo =
    typeof falha?.codigo === 'string' && falha.codigo !== ''
      ? falha.codigo
      : CODIGO_FALHA_DESCONHECIDA;
  const mensagem =
    typeof falha?.mensagem === 'string' && falha.mensagem !== ''
      ? falha.mensagem
      : MENSAGEM_FALHA_DESCONHECIDA;
  return `${codigo}: ${mensagem}`;
}

function iniciarPartida(
  modulo: ModuloGiroscopioNativo,
  taxaHz: number,
): void {
  estadoDaPartida = 'pendente';
  infoDaPartida = null;
  erroDaPartida = null;
  taxaHzDaPartida = taxaHz;
  tentativaDePartida += 1;
  const tentativa = tentativaDePartida;

  modulo.iniciar(taxaHz).then(
    (info: InfoGiroscopio) => {
      if (tentativa !== tentativaDePartida) {
        return;
      }
      if (assinantes.size === 0) {
        // Todos cancelaram antes de a promessa resolver: o sensor chegou a ligar, então desliga.
        estadoDaPartida = 'parado';
        taxaHzDaPartida = null;
        soltarEscutaDeFalha();
        modulo.parar();
        return;
      }
      estadoDaPartida = 'ligado';
      infoDaPartida = info;
      for (const assinante of Array.from(assinantes)) {
        if (assinante.viva) {
          assinante.opcoes.aoIniciar?.(info);
        }
      }
    },
    (motivo: unknown) => {
      if (tentativa !== tentativaDePartida) {
        return;
      }
      derrubarPartida(comoErro(motivo), modulo);
    },
  );
}

/**
 * Encerra a partida por erro e avisa todo mundo. Único caminho de falha do módulo — a rejeição de
 * `iniciar()` e o evento de falha do nativo passam os dois por aqui, para o JS não ter dois jeitos
 * diferentes de reagir ao mesmo problema.
 */
function derrubarPartida(erro: Error, modulo: ModuloGiroscopioNativo): void {
  estadoDaPartida = 'falhou';
  infoDaPartida = null;
  erroDaPartida = erro;
  taxaHzDaPartida = null;

  // Solta todas as inscrições antes de avisar: erro não pode deixar assinatura pendurada
  // recebendo (ou esperando) amostra que nunca vem.
  const atingidos = Array.from(assinantes);
  assinantes.clear();
  soltarEscutaDeFalha();
  for (const assinante of atingidos) {
    assinante.viva = false;
    assinante.inscricao.remove();
  }

  // Erro não deixa sensor preso. Na maioria das falhas o nativo já não tem listener e o `parar()` é
  // inofensivo (GiroscopioModule.kt documenta isso); mas, com uma partida reiniciada por troca de
  // taxa em voo, o desfecho de um `iniciar()` que **registrou** o sensor é descartado por
  // `tentativaDePartida` — e sem esta chamada ninguém o desligaria até a próxima pausa. Vem antes
  // dos avisos de propósito: um `aoFalhar` que assine de novo enfileira o `iniciar()` dele depois
  // deste `parar()`, e a fila da ponte preserva a ordem.
  modulo.parar();

  for (const assinante of atingidos) {
    assinante.opcoes.aoFalhar?.(erro);
  }
}

/**
 * Quem assina com o sensor já ligado também recebe a descrição — mas fora da pilha atual, para o
 * aviso chegar sempre depois do retorno de `assinarGiroscopio`, como acontece no caminho normal.
 */
function avisarPartidaJaFeita(assinante: Assinante): void {
  const info = infoDaPartida;
  if (info === null) {
    return;
  }
  Promise.resolve().then(() => {
    if (assinante.viva && estadoDaPartida === 'ligado') {
      assinante.opcoes.aoIniciar?.(info);
    }
  });
}

function encerrarAssinante(
  assinante: Assinante,
  modulo: ModuloGiroscopioNativo,
): void {
  if (!assinante.viva) {
    return;
  }
  assinante.viva = false;
  assinante.inscricao.remove();
  assinantes.delete(assinante);
  if (assinantes.size > 0) {
    return;
  }

  infoDaPartida = null;
  // Ninguém para avisar: a escuta da falha do nativo perde a razão de existir. A assinatura seguinte
  // a recria antes de qualquer partida.
  soltarEscutaDeFalha();
  if (estadoDaPartida === 'ligado') {
    estadoDaPartida = 'parado';
    taxaHzDaPartida = null;
    modulo.parar();
  }
  // 'pendente': quem resolve a promessa desliga o que tiver sido ligado (ver `iniciarPartida`).
  // 'falhou' e 'parado': não há sensor ligado para desligar.
}

function comoErro(motivo: unknown): Error {
  if (motivo instanceof Error) {
    return motivo;
  }
  return new Error(String(motivo));
}
