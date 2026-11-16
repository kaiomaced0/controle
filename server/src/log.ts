/**
 * Log estruturado mínimo do servidor — sem dependência externa.
 *
 * Escreve sempre em **stderr**: a saída padrão (stdout) fica livre para o modo telemetria
 * da CLI e para qualquer coisa que precise ser encanada (`| jq`, arquivo, etc.).
 *
 * ⚠️ CAMINHO QUENTE: nenhuma função deste módulo pode ser chamada por pacote recebido.
 * A 100 Hz, um log por amostra vira 100 escritas por segundo em stderr, mais uma string
 * alocada por pacote — exatamente o que a regra 2 do CLAUDE.md proíbe. Para medir fluxo,
 * use contador agregado e registre um resumo por segundo (ver PROTOCOLO.md, seção 7).
 */

/** Níveis aceitos, do mais grave para o mais verboso. */
export const NIVEIS_LOG = ['erro', 'aviso', 'info', 'depuracao'] as const;

export type NivelLog = (typeof NIVEIS_LOG)[number];

/** Menor número = mais grave. Uma mensagem sai quando sua severidade <= a do registrador. */
const SEVERIDADE: Record<NivelLog, number> = {
  erro: 0,
  aviso: 1,
  info: 2,
  depuracao: 3,
};

/** Rótulos com largura fixa, para as colunas ficarem alinhadas no terminal. */
const ROTULOS: Record<NivelLog, string> = {
  erro: 'ERRO ',
  aviso: 'AVISO',
  info: 'INFO ',
  depuracao: 'DEBUG',
};

export function ehNivelLog(valor: unknown): valor is NivelLog {
  return typeof valor === 'string' && (NIVEIS_LOG as readonly string[]).includes(valor);
}

/** Dados extras de uma linha de log (`chave=valor` no fim da linha). */
export type DadosDoLog = Readonly<Record<string, unknown>>;

export interface Registrador {
  /** Nível configurado; útil para pular trabalho caro antes de montar a mensagem. */
  readonly nivel: NivelLog;
  /** Escopo do registrador (`transporte`, `movimento`, ...), ou string vazia. */
  readonly escopo: string;
  erro(mensagem: string, dados?: DadosDoLog): void;
  aviso(mensagem: string, dados?: DadosDoLog): void;
  info(mensagem: string, dados?: DadosDoLog): void;
  depuracao(mensagem: string, dados?: DadosDoLog): void;
  /** Se `nivel` sairia na saída atual — para não montar mensagem que será descartada. */
  habilitado(nivel: NivelLog): boolean;
  /** Registrador irmão, com o mesmo destino e um escopo próprio. */
  comEscopo(escopo: string): Registrador;
}

/** Destino da escrita; trocável nos testes. Recebe a linha já pronta, com `\n`. */
export type DestinoDeLog = (linha: string) => void;

const DESTINO_PADRAO: DestinoDeLog = (linha) => {
  process.stderr.write(linha);
};

function formatarValor(valor: unknown): string {
  if (typeof valor === 'string') {
    // Só aspeia quando há espaço, senão a linha fica poluída de aspas.
    return /[\s"]/.test(valor) ? JSON.stringify(valor) : valor;
  }
  if (
    typeof valor === 'number' ||
    typeof valor === 'boolean' ||
    typeof valor === 'bigint' ||
    valor === null
  ) {
    return String(valor);
  }
  if (valor === undefined) return 'undefined';
  if (valor instanceof Error) return JSON.stringify(`${valor.name}: ${valor.message}`);
  // Objeto/função/símbolo: JSON quando dá. Quando não dá (ciclo, função, símbolo), o tipo
  // diz mais do que o `[object Object]` que `String()` produziria.
  try {
    return JSON.stringify(valor) ?? `[${typeof valor}]`;
  } catch {
    return `[${typeof valor} não serializável]`;
  }
}

function montarLinha(
  nivel: NivelLog,
  escopo: string,
  mensagem: string,
  dados: DadosDoLog | undefined,
): string {
  const partes = [new Date().toISOString(), ROTULOS[nivel]];
  if (escopo !== '') partes.push(`[${escopo}]`);
  partes.push(mensagem);
  if (dados !== undefined) {
    for (const [chave, valor] of Object.entries(dados)) {
      partes.push(`${chave}=${formatarValor(valor)}`);
    }
  }
  return `${partes.join(' ')}\n`;
}

/**
 * Cria um registrador. `escopo` aparece entre colchetes e serve para saber de qual módulo
 * veio a linha; `destino` existe para os testes capturarem a saída sem tocar em stderr.
 */
export function criarRegistrador(
  nivel: NivelLog,
  escopo = '',
  destino: DestinoDeLog = DESTINO_PADRAO,
): Registrador {
  const limite = SEVERIDADE[nivel];

  const escrever = (nivelDaLinha: NivelLog, mensagem: string, dados?: DadosDoLog): void => {
    if (SEVERIDADE[nivelDaLinha] > limite) return;
    destino(montarLinha(nivelDaLinha, escopo, mensagem, dados));
  };

  return {
    nivel,
    escopo,
    erro: (mensagem, dados) => escrever('erro', mensagem, dados),
    aviso: (mensagem, dados) => escrever('aviso', mensagem, dados),
    info: (mensagem, dados) => escrever('info', mensagem, dados),
    depuracao: (mensagem, dados) => escrever('depuracao', mensagem, dados),
    habilitado: (nivelConsultado) => SEVERIDADE[nivelConsultado] <= limite,
    comEscopo: (novoEscopo) => criarRegistrador(nivel, novoEscopo, destino),
  };
}
