/**
 * Fonte única da configuração do servidor.
 *
 * Precedência (o de baixo vence):
 *   1. padrões deste módulo (`CONFIGURACAO_PADRAO`)
 *   2. arquivo JSON opcional (`server/controle.config.json`)
 *   3. variáveis de ambiente com prefixo `CONTROLE_`
 *   4. só a porta: `OpcoesDeCarga.porta`, passada em código por quem chama (teste, ATI-030)
 *
 * Nenhum outro módulo pode ter número mágico de porta, taxa ou nível de log: quem precisa
 * de um valor recebe a `ConfiguracaoServidor` pronta. Valor inválido não é corrigido em
 * silêncio — vira `ErroDeConfiguracao` com a lista completa de problemas.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NIVEIS_LOG, ehNivelLog, type NivelLog } from './log.js';
import { AJUSTES_PADRAO, FAIXAS_DO_GIRO } from './movimento/ajustes.js';
import {
  FILTROS,
  ORIENTACOES,
  ehFiltro,
  ehOrientacao,
  type Filtro,
  type Orientacao,
} from './movimento/tipos.js';
import {
  MODOS_DE_SAIDA_DO_MOUSE,
  ehModoDeSaidaDoMouse,
  type ModoDeSaidaDoMouse,
} from './saida/saida-do-mouse.js';

export interface ConfiguracaoServidor {
  /** Interface de escuta do WebSocket. `127.0.0.1` = só o próprio PC (modo cabo). */
  readonly host: string;
  /** Porta do WebSocket de dados. */
  readonly porta: number;
  /** Porta do broadcast UDP de descoberta (fase 3). */
  readonly portaDescoberta: number;
  /** Taxa de amostragem combinada com o app, em Hz. */
  readonly taxaHz: number;
  /** Verbosidade do log. */
  readonly nivelLog: NivelLog;
  /**
   * Arquivo onde gravar a sessão recebida, em formato de captura (`src/cli/captura.ts`).
   * Vazio (o padrão) = **não grava**. Caminho relativo é resolvido a partir de onde o
   * processo foi chamado, que é o que quem digita no terminal espera.
   *
   * Existe para transformar sessão de aparelho real em caso de teste: o arquivo gravado aqui
   * é o mesmo que `npm run simulador -- --padrao gravado --arquivo ...` reproduz (ATI-023).
   */
  readonly gravacao: string;
  /**
   * O que o pipeline de movimento (ATI-008) faz com o giroscópio que chega.
   *
   * - `desligado` — nem cria o pipeline; o servidor volta a ser o do sprint 1.
   * - `ensaio` (**padrão**) — a cadeia roda inteira e o deslocamento vai para um destino que
   *   mede e **não mexe no cursor** (`movimento/ensaio.ts`). É o padrão porque tem gente
   *   trabalhando nesta máquina: ninguém liga o mouse de verdade sem pedir.
   * - `sistema` — o destino é o backend de entrada de verdade (`SendInput`). **O cursor anda.**
   */
  readonly movimento: ModoDeMovimento;
  /**
   * Recalibração automática do bias (ATI-009): com o aparelho parado por mais de 3 s, o bias é
   * ajustado devagar, por média exponencial lenta.
   *
   * Ligada por padrão porque é ela que mantém o cursor parado **depois de uma hora** — o bias de um
   * giroscópio anda com a temperatura do aparelho. Existe o desligamento porque um ajuste que mexe
   * sozinho num número do pipeline precisa poder sair do caminho quando alguém está medindo bias
   * (é o caso da própria bancada) ou investigando movimento residual.
   */
  readonly recalibracao: boolean;
  /**
   * Como o aparelho é segurado, quando não há perfil dizendo (ATI-010, ATI-032).
   *
   * - `retrato` — de pé, tela virada para a pessoa;
   * - `paisagem` — deitado de lado, tela virada para a pessoa;
   * - `apontador` — deitado, tela para cima, topo apontando para a tela do PC (a pegada de
   *   controle remoto): apontar para os lados move na horizontal, inclinar o nariz move na vertical;
   * - `apontador-torcao` — a mesma pegada, com o vertical vindo da **torção** do antebraço em vez
   *   da inclinação do pulso.
   *
   * Errar isto não produz erro nenhum: produz um cursor que responde ao gesto errado e parece
   * impreciso, e por isso a chave existe antes do ajuste pelo celular (ATI-011). A tabela de eixos
   * de cada uma está em `movimento/eixos.ts`.
   */
  readonly orientacao: Orientacao;
  /**
   * Sensibilidade em pixels por grau de rotação, igual nos dois eixos. Aceita fração (`42.5`),
   * como o giro aceita, na faixa de `FAIXAS_DO_GIRO.sensibilidade`.
   *
   * `0` é o sentinela: mantém o padrão de fábrica de `movimento/ajustes.ts`. Perde para
   * {@link grausTelaCheia} quando os dois vierem, e a partida avisa que ela foi ignorada.
   */
  readonly sensibilidade: number;
  /**
   * Zona morta em graus por segundo: abaixo disso o movimento é tratado como zero.
   *
   * É o que impede o tremor da mão de virar cursor tremendo. O padrão de fábrica (0,35 °/s) foi
   * pensado para aparelho apoiado; **mão humana segurando aparelho treme bem mais que isso**, na
   * faixa de 0,5 a 3 °/s.
   *
   * `-1` é o sentinela (mantém o padrão de fábrica), e **só ele**: o `0` é valor de verdade (desliga
   * a zona morta), e qualquer outro negativo é recusa — um `-0.5` aceito e trocado pelo padrão seria
   * exatamente o ajuste pedido e descartado em silêncio.
   */
  readonly zonaMorta: number;
  /**
   * Suavização de 0 a 0,9 (média exponencial). Mais suavização tira tremor e adiciona atraso.
   *
   * `-1` é o sentinela (mantém o padrão de fábrica), pelo mesmo motivo da {@link zonaMorta}: o `0`
   * é valor de verdade (sem suavização) e outro negativo é recusa.
   */
  readonly suavizacao: number;
  /**
   * Quantos graus de rotação atravessam a tela inteira. `0` é o sentinela: desligado, vale a
   * {@link sensibilidade}.
   *
   * É a forma natural de pensar sensibilidade num controle por giro: "quanto eu giro para ir de
   * um canto ao outro". O servidor divide a resolução por este número e chega ao px/grau de cada
   * eixo — que são **diferentes** numa tela que não é quadrada: 45° para 1920×1080 dão
   * 42,7 px/grau na horizontal e 24 px/grau na vertical. Pedir um número só para os dois eixos
   * deforma o gesto: o mesmo giro andaria proporcionalmente mais no eixo curto.
   *
   * Vence `sensibilidade` quando os dois vierem. Sem o tamanho da tela (sem backend de entrada) a
   * conversão não tem como acontecer, e a partida avisa qual sensibilidade ficou valendo.
   */
  readonly grausTelaCheia: number;
  /**
   * Graus que atravessam a tela **na vertical**, quando o eixo vertical merece número próprio.
   * `0` é o sentinela: usa o mesmo de {@link grausTelaCheia}.
   *
   * Existe porque os dois eixos não são simétricos na mão: o pulso gira quase 90° para os lados
   * com folga, mas inclina 25 a 30° antes de ficar desconfortável. Pedir 45° nos dois deixa o
   * vertical com metade do ganho do horizontal (24 contra 42,7 px/grau numa tela 1920×1080) **e**
   * exige do pulso um movimento que ele não faz — o gesto acaba antes da tela.
   *
   * Só vale junto com {@link grausTelaCheia}: sozinho, é recusa na carga (o horizontal ficaria sem
   * conversão, e o vertical pedido seria jogado fora).
   */
  readonly grausTelaCheiaY: number;
  /** Inverte o eixo horizontal (apontar para a direita move para a esquerda). */
  readonly inverterX: boolean;
  /** Inverte o eixo vertical (levantar o aparelho desce o cursor). */
  readonly inverterY: boolean;
  /**
   * O filtro da etapa 4 do pipeline (ATI-033): `euro` (o adaptativo — **padrão**) ou
   * `exponencial` (a média de coeficiente fixo de antes, regulada por {@link suavizacao}).
   *
   * O adaptativo filtra muito quando o movimento é lento (tremor some) e pouco quando é rápido
   * (gesto de atravessar a tela sem atraso). Valor desconhecido é recusa, como em `movimento`.
   */
  readonly filtro: Filtro;
  /**
   * Filtro `euro`: o corte com a mão parada, em Hz. Mais baixo tira mais tremor e deixa a mira
   * lenta escorregar mais depois de a mão parar. `0` é o sentinela (padrão de fábrica): corte zero
   * não existe como pedido.
   */
  readonly filtroCorteMinimo: number;
  /**
   * Filtro `euro`: quanto o corte sobe por °/s de rapidez, em Hz por °/s. Mais alto tira atraso do
   * gesto rápido. `-1` é o sentinela (padrão de fábrica), porque o `0` é pedido de verdade (corte
   * fixo no mínimo).
   */
  readonly filtroBeta: number;
  /**
   * Como o movimento do mouse sai para o Windows (ATI-026) — ver `saida/saida-do-mouse.ts`:
   *
   * - `auto` (**padrão**) — absoluto quando o relativo não sai 1:1 nesta máquina (aceleração de
   *   ponteiro ligada, ou velocidade do ponteiro fora do 10); relativo quando sai;
   * - `absoluto` — posiciona o cursor em coordenada normalizada: não passa pela aceleração;
   * - `relativo` — o `SendInput` relativo cru. É o que jogo com *raw input* precisa.
   *
   * Valor desconhecido é recusa, como em `movimento`. Só vale com `movimento=sistema` — em ensaio
   * nada sai para o Windows —, mas o aviso da aceleração aparece na partida em qualquer modo.
   */
  readonly saidaMouse: ModoDeSaidaDoMouse;
}

/** Os três destinos possíveis do pipeline de movimento. */
export const MODOS_DE_MOVIMENTO = ['desligado', 'ensaio', 'sistema'] as const;
export type ModoDeMovimento = (typeof MODOS_DE_MOVIMENTO)[number];

export function ehModoDeMovimento(valor: unknown): valor is ModoDeMovimento {
  return typeof valor === 'string' && (MODOS_DE_MOVIMENTO as readonly string[]).includes(valor);
}

/**
 * O valor que quer dizer **"não mexi nisso"** em cada ajuste do giro: o pipeline fica com o padrão
 * de fábrica (ou, nos graus, a conversão fica desligada).
 *
 * São dois números diferentes porque o zero não significa a mesma coisa em todos: sensibilidade
 * zero e zero grau não existem como pedido, então o `0` serve de sentinela; já zona morta zero e
 * suavização zero são pedidos de verdade (desligar cada uma), e o sentinela delas tem de ser `-1`.
 * Fora do sentinela, o valor precisa estar na faixa de {@link FAIXAS} — não existe terceiro caso.
 */
export const SENTINELAS_DO_GIRO = Object.freeze({
  sensibilidade: 0,
  zonaMorta: -1,
  suavizacao: -1,
  grausTelaCheia: 0,
  grausTelaCheiaY: 0,
  filtroCorteMinimo: 0,
  filtroBeta: -1,
} as const satisfies Partial<Record<keyof ConfiguracaoServidor, number>>);

/** Padrões do projeto — batem com PROTOCOLO.md, seção 1. */
export const CONFIGURACAO_PADRAO: ConfiguracaoServidor = Object.freeze({
  host: '127.0.0.1',
  porta: 8765,
  portaDescoberta: 8766,
  taxaHz: 100,
  nivelLog: 'info',
  gravacao: '',
  // Movimento medido, cursor parado: quem quiser o `SendInput` de verdade escreve `sistema`.
  movimento: 'ensaio',
  recalibracao: true,
  orientacao: 'retrato',
  // "Não mexi nisso": vale o padrão de fábrica de `movimento/ajustes.ts`.
  ...SENTINELAS_DO_GIRO,
  inverterX: false,
  inverterY: false,
  // O padrão do filtro é o de fábrica do pipeline, e não uma cópia: se lá mudar, aqui acompanha.
  filtro: AJUSTES_PADRAO.filtro,
  // ATI-026: a escolha entre absoluto e relativo acompanha a configuração de ponteiro da máquina.
  saidaMouse: 'auto',
});

/** Prefixo de toda variável de ambiente reconhecida. */
export const PREFIXO_AMBIENTE = 'CONTROLE_';

/** Nome do arquivo de configuração procurado na raiz de `server/`. */
export const NOME_ARQUIVO_CONFIGURACAO = 'controle.config.json';

/** Variável que aponta para outro arquivo de configuração. */
export const VARIAVEL_ARQUIVO_CONFIGURACAO = `${PREFIXO_AMBIENTE}ARQUIVO_CONFIG`;

/** De campo da configuração para variável de ambiente. */
export const VARIAVEIS_DE_AMBIENTE = {
  host: `${PREFIXO_AMBIENTE}HOST`,
  porta: `${PREFIXO_AMBIENTE}PORTA`,
  portaDescoberta: `${PREFIXO_AMBIENTE}PORTA_DESCOBERTA`,
  taxaHz: `${PREFIXO_AMBIENTE}TAXA_HZ`,
  nivelLog: `${PREFIXO_AMBIENTE}NIVEL_LOG`,
  gravacao: `${PREFIXO_AMBIENTE}GRAVACAO`,
  movimento: `${PREFIXO_AMBIENTE}MOVIMENTO`,
  recalibracao: `${PREFIXO_AMBIENTE}RECALIBRACAO`,
  orientacao: `${PREFIXO_AMBIENTE}ORIENTACAO`,
  sensibilidade: `${PREFIXO_AMBIENTE}SENSIBILIDADE`,
  zonaMorta: `${PREFIXO_AMBIENTE}ZONA_MORTA`,
  suavizacao: `${PREFIXO_AMBIENTE}SUAVIZACAO`,
  grausTelaCheia: `${PREFIXO_AMBIENTE}GRAUS_TELA_CHEIA`,
  grausTelaCheiaY: `${PREFIXO_AMBIENTE}GRAUS_TELA_CHEIA_Y`,
  inverterX: `${PREFIXO_AMBIENTE}INVERTER_X`,
  inverterY: `${PREFIXO_AMBIENTE}INVERTER_Y`,
  filtro: `${PREFIXO_AMBIENTE}FILTRO`,
  filtroCorteMinimo: `${PREFIXO_AMBIENTE}FILTRO_CORTE_MINIMO`,
  filtroBeta: `${PREFIXO_AMBIENTE}FILTRO_BETA`,
  saidaMouse: `${PREFIXO_AMBIENTE}SAIDA_MOUSE`,
} as const satisfies Record<keyof ConfiguracaoServidor, string>;

/**
 * Faixas aceitas, usadas na validação e na mensagem de erro.
 *
 * As três primeiras dos ajustes do giro **são** as de `FAIXAS_DO_GIRO` (`movimento/ajustes.ts`), e
 * não uma cópia: se o pipeline mudar a faixa, a configuração acompanha. A diferença de regra é de
 * propósito — o pipeline **satura** (PROTOCOLO.md, seção 3.4: quem arrasta o controle até o fim
 * recebe o fim), e a configuração **recusa**, porque um número escrito à mão fora da faixa é erro
 * de digitação, e saturar seria trocá-lo por outro sem dizer.
 */
export const FAIXAS = Object.freeze({
  porta: { minimo: 1, maximo: 65535 },
  portaDescoberta: { minimo: 1, maximo: 65535 },
  taxaHz: { minimo: 1, maximo: 1000 },
  sensibilidade: FAIXAS_DO_GIRO.sensibilidade,
  zonaMorta: FAIXAS_DO_GIRO.zonaMorta,
  suavizacao: FAIXAS_DO_GIRO.suavizacao,
  /**
   * Graus de rotação. O teto é uma volta inteira; o piso de 1° existe porque abaixo dele a conta
   * dá milhares de px/grau, que o pipeline saturaria no teto da sensibilidade.
   */
  grausTelaCheia: { minimo: 1, maximo: 360 },
  grausTelaCheiaY: { minimo: 1, maximo: 360 },
  filtroCorteMinimo: FAIXAS_DO_GIRO.filtroCorteMinimo,
  filtroBeta: FAIXAS_DO_GIRO.filtroBeta,
});

const CAMPOS = Object.keys(VARIAVEIS_DE_AMBIENTE) as ReadonlyArray<keyof ConfiguracaoServidor>;

/** Configuração inválida, com todos os problemas encontrados de uma vez. */
export class ErroDeConfiguracao extends Error {
  readonly problemas: readonly string[];

  constructor(problemas: readonly string[]) {
    super(`Configuração inválida:\n${problemas.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ErroDeConfiguracao';
    this.problemas = [...problemas];
  }
}

/** De onde veio cada valor — só aparece nas mensagens de erro e no log de partida. */
interface ValorBruto {
  readonly valor: unknown;
  readonly origem: string;
}

export interface OpcoesDeCarga {
  /** Mapa de variáveis; o padrão é `process.env`. Os testes passam o próprio. */
  readonly ambiente?: Record<string, string | undefined>;
  /** Caminho do arquivo JSON. `null` desliga a leitura de arquivo. */
  readonly caminhoDoArquivo?: string | null;
  /** Raiz para resolver caminho relativo; o padrão é a pasta `server/`. */
  readonly diretorioBase?: string;
  /**
   * Porta imposta por quem chama: vence o arquivo e o ambiente, e aceita **`0` = efêmera** (o
   * sistema escolhe uma livre na hora de abrir; o endereço efetivo sai de `transporte.endereco()`).
   *
   * Existe para teste (ATI-030). Um teste que sobe o servidor inteiro na porta da configuração
   * colide com o `npm run dev` de quem está trabalhando — e com a suíte de outro agente rodando ao
   * mesmo tempo. Fica fora de `CONTROLE_PORTA` de propósito: a porta 0 numa variável de ambiente
   * seria um servidor que o celular não tem como achar (o `adb reverse` precisa de número fixo), e
   * por isso a faixa do ambiente e do arquivo continua começando em 1.
   */
  readonly porta?: number;
}

/** Faixa da porta imposta em código (`OpcoesDeCarga.porta`): a única fonte que aceita o 0. */
const FAIXA_DA_PORTA_IMPOSTA = Object.freeze({ minimo: 0, maximo: 65535 });

/** Raiz de `server/` a partir deste arquivo (`server/src/config.ts` → `server/`). */
function raizDoServidor(): string {
  return resolve(fileURLToPath(import.meta.url), '..', '..');
}

function lerArquivo(
  caminho: string,
  obrigatorio: boolean,
  problemas: string[],
): Partial<Record<keyof ConfiguracaoServidor, unknown>> {
  let conteudo: string;
  try {
    conteudo = readFileSync(caminho, 'utf8');
  } catch (erro) {
    const codigo = (erro as NodeJS.ErrnoException).code;
    // Arquivo ausente só é problema quando alguém pediu aquele arquivo de propósito.
    if (codigo === 'ENOENT' && !obrigatorio) return {};
    problemas.push(`não consegui ler o arquivo ${caminho}: ${(erro as Error).message}`);
    return {};
  }

  let analisado: unknown;
  try {
    analisado = JSON.parse(conteudo);
  } catch (erro) {
    problemas.push(`o arquivo ${caminho} não é um JSON válido: ${(erro as Error).message}`);
    return {};
  }

  if (typeof analisado !== 'object' || analisado === null || Array.isArray(analisado)) {
    problemas.push(`o arquivo ${caminho} precisa conter um objeto JSON na raiz`);
    return {};
  }

  const resultado: Partial<Record<keyof ConfiguracaoServidor, unknown>> = {};
  for (const [chave, valor] of Object.entries(analisado)) {
    if ((CAMPOS as readonly string[]).includes(chave)) {
      resultado[chave as keyof ConfiguracaoServidor] = valor;
    } else {
      problemas.push(
        `chave desconhecida "${chave}" em ${caminho}; aceito apenas: ${CAMPOS.join(', ')}`,
      );
    }
  }
  return resultado;
}

function validarInteiro(
  bruto: ValorBruto,
  faixa: { readonly minimo: number; readonly maximo: number },
  campo: string,
  problemas: string[],
  padrao: number,
): number {
  const { valor, origem } = bruto;
  const numero = typeof valor === 'string' ? Number(valor.trim()) : valor;
  if (typeof numero !== 'number' || !Number.isInteger(numero)) {
    problemas.push(
      `${campo} (${origem}) precisa ser um número inteiro; recebi ${JSON.stringify(valor)}`,
    );
    return padrao;
  }
  if (numero < faixa.minimo || numero > faixa.maximo) {
    problemas.push(
      `${campo} (${origem}) precisa estar entre ${faixa.minimo} e ${faixa.maximo}; recebi ${numero}`,
    );
    return padrao;
  }
  return numero;
}

function validarHost(bruto: ValorBruto, problemas: string[]): string {
  const { valor, origem } = bruto;
  if (typeof valor !== 'string' || valor.trim() === '') {
    problemas.push(
      `host (${origem}) precisa ser um texto não vazio; recebi ${JSON.stringify(valor)}`,
    );
    return CONFIGURACAO_PADRAO.host;
  }
  return valor.trim();
}

/**
 * Caminho da gravação. Texto vazio é o normal (gravação desligada) — o que não pode é vir
 * número, objeto ou lista de um `controle.config.json` escrito errado.
 */
function validarGravacao(bruto: ValorBruto, problemas: string[]): string {
  const { valor, origem } = bruto;
  if (typeof valor !== 'string') {
    problemas.push(
      `gravacao (${origem}) precisa ser o caminho de um arquivo; recebi ${JSON.stringify(valor)}`,
    );
    return CONFIGURACAO_PADRAO.gravacao;
  }
  return valor.trim();
}

/**
 * Um ajuste numérico do giro vindo da configuração: **ou o sentinela, ou a faixa**.
 *
 * Aceita fração (é o que o pipeline aceita) e texto do terminal (`"1.5"`). Não existe terceiro
 * caso, e é essa a razão de a função existir separada da `validarInteiro`: antes dela, a zona
 * morta aceitava qualquer número de `-1` a `10`, e um `-0.5` passava pela validação, não era o
 * sentinela e caía no padrão de fábrica sem aviso — o ajuste pedido, descartado em silêncio. O
 * pipeline satura (PROTOCOLO.md, seção 3.4); a configuração recusa (ver {@link FAIXAS}).
 *
 * Texto vazio depois do `trim` é recusa, e não zero: `Number('  ')` dá `0`, que aqui é o sentinela
 * de três campos e o "desligar" dos outros dois — um espaço digitado sozinho viraria, calado, um
 * pedido que ninguém fez.
 */
function validarAjusteDoGiro(
  bruto: ValorBruto,
  campo: keyof typeof SENTINELAS_DO_GIRO,
  significadoDoSentinela: string,
  problemas: string[],
): number {
  const { valor, origem } = bruto;
  const sentinela = SENTINELAS_DO_GIRO[campo];
  const faixa = FAIXAS[campo];
  const numero =
    typeof valor === 'string' && valor.trim() !== '' ? Number(valor.trim()) : valor;
  if (
    typeof numero === 'number' &&
    Number.isFinite(numero) &&
    (numero === sentinela || (numero >= faixa.minimo && numero <= faixa.maximo))
  ) {
    return numero;
  }
  problemas.push(
    `${campo} (${origem}) precisa ser ${sentinela} (${significadoDoSentinela}) ou um número ` +
      `entre ${faixa.minimo} e ${faixa.maximo}; recebi ${JSON.stringify(valor)}`,
  );
  return sentinela;
}

function validarOrientacao(bruto: ValorBruto, problemas: string[]): Orientacao {
  const { valor, origem } = bruto;
  const texto = typeof valor === 'string' ? valor.trim().toLowerCase() : valor;
  if (!ehOrientacao(texto)) {
    problemas.push(
      `orientacao (${origem}) precisa ser um de: ${ORIENTACOES.join(', ')}; ` +
        `recebi ${JSON.stringify(valor)}`,
    );
    return CONFIGURACAO_PADRAO.orientacao;
  }
  return texto;
}

/**
 * Modo do pipeline de movimento. Diferente dos ajustes do giro dentro do pipeline (que **saturam**,
 * PROTOCOLO.md seção 3.4), aqui um valor desconhecido é **recusa**: cair no padrão em silêncio
 * significaria alguém pedir `sistema` com um erro de digitação, ver o servidor subir e nunca
 * entender por que o cursor não anda — ou, pior no sentido contrário, um dia o padrão mudar e o
 * cursor andar sem que ninguém tenha pedido.
 */
function validarMovimento(bruto: ValorBruto, problemas: string[]): ModoDeMovimento {
  const { valor, origem } = bruto;
  const texto = typeof valor === 'string' ? valor.trim().toLowerCase() : valor;
  if (!ehModoDeMovimento(texto)) {
    problemas.push(
      `movimento (${origem}) precisa ser um de: ${MODOS_DE_MOVIMENTO.join(', ')}; ` +
        `recebi ${JSON.stringify(valor)}`,
    );
    return CONFIGURACAO_PADRAO.movimento;
  }
  return texto;
}

/**
 * Textos aceitos como sim e como não numa chave booleana.
 *
 * O arquivo JSON escreve `true`/`false` (que é o tipo do JSON); a variável de ambiente é sempre
 * texto, e quem digita no terminal escreve `0`, `1`, `ligada` ou `desligada` com a mesma
 * naturalidade. Aceitar os quatro é reconhecer isso; aceitar **qualquer** texto (`"talvez"` virando
 * `true` por ser não vazio) é o caminho para alguém desligar a recalibração e ela continuar ligada.
 */
const TEXTOS_BOOLEANOS: Readonly<Record<string, boolean>> = Object.freeze({
  true: true,
  false: false,
  '1': true,
  '0': false,
  ligada: true,
  desligada: false,
  sim: true,
  nao: false,
});

/**
 * Chave booleana. Como em `movimento`, valor desconhecido é **recusa**: cair no padrão em silêncio
 * significaria alguém escrever `CONTROLE_RECALIBRACAO=desligado` (com o), ver o servidor subir e
 * nunca entender por que o bias continua se mexendo sozinho.
 */
function validarBooleano(bruto: ValorBruto, campo: string, problemas: string[], padrao: boolean): boolean {
  const { valor, origem } = bruto;
  if (typeof valor === 'boolean') return valor;
  const texto = typeof valor === 'string' ? valor.trim().toLowerCase() : undefined;
  const convertido = texto === undefined ? undefined : TEXTOS_BOOLEANOS[texto];
  if (convertido === undefined) {
    problemas.push(
      `${campo} (${origem}) precisa ser um de: ${Object.keys(TEXTOS_BOOLEANOS).join(', ')}; ` +
        `recebi ${JSON.stringify(valor)}`,
    );
    return padrao;
  }
  return convertido;
}

/** Filtro da etapa 4 (ATI-033). Desconhecido é recusa, pelo mesmo motivo de `validarMovimento`. */
function validarFiltro(bruto: ValorBruto, problemas: string[]): Filtro {
  const { valor, origem } = bruto;
  const texto = typeof valor === 'string' ? valor.trim().toLowerCase() : valor;
  if (!ehFiltro(texto)) {
    problemas.push(
      `filtro (${origem}) precisa ser um de: ${FILTROS.join(', ')}; recebi ${JSON.stringify(valor)}`,
    );
    return CONFIGURACAO_PADRAO.filtro;
  }
  return texto;
}

/**
 * Saída do mouse (ATI-026). Desconhecido é recusa, pelo mesmo motivo de `validarMovimento`: um
 * `absolute` digitado em inglês e trocado pelo padrão em silêncio deixaria a pessoa achando que
 * escolheu uma saída que não está valendo.
 */
function validarSaidaMouse(bruto: ValorBruto, problemas: string[]): ModoDeSaidaDoMouse {
  const { valor, origem } = bruto;
  const texto = typeof valor === 'string' ? valor.trim().toLowerCase() : valor;
  if (!ehModoDeSaidaDoMouse(texto)) {
    problemas.push(
      `saidaMouse (${origem}) precisa ser um de: ${MODOS_DE_SAIDA_DO_MOUSE.join(', ')}; ` +
        `recebi ${JSON.stringify(valor)}`,
    );
    return CONFIGURACAO_PADRAO.saidaMouse;
  }
  return texto;
}

function validarNivelLog(bruto: ValorBruto, problemas: string[]): NivelLog {
  const { valor, origem } = bruto;
  const texto = typeof valor === 'string' ? valor.trim().toLowerCase() : valor;
  if (!ehNivelLog(texto)) {
    problemas.push(
      `nivelLog (${origem}) precisa ser um de: ${NIVEIS_LOG.join(', ')}; recebi ${JSON.stringify(valor)}`,
    );
    return CONFIGURACAO_PADRAO.nivelLog;
  }
  return texto;
}

/**
 * Monta a configuração efetiva.
 *
 * @throws {ErroDeConfiguracao} quando algum valor está fora da faixa, com a lista completa.
 */
export function carregarConfiguracao(opcoes: OpcoesDeCarga = {}): ConfiguracaoServidor {
  const ambiente = opcoes.ambiente ?? process.env;
  const diretorioBase = opcoes.diretorioBase ?? raizDoServidor();
  const problemas: string[] = [];

  // 1. arquivo (opcional)
  let doArquivo: Partial<Record<keyof ConfiguracaoServidor, unknown>> = {};
  let caminhoUsado = '';
  if (opcoes.caminhoDoArquivo !== null) {
    const pedido = opcoes.caminhoDoArquivo ?? ambiente[VARIAVEL_ARQUIVO_CONFIGURACAO];
    const obrigatorio = pedido !== undefined && pedido !== '';
    const caminho = obrigatorio
      ? isAbsolute(pedido)
        ? pedido
        : resolve(diretorioBase, pedido)
      : resolve(diretorioBase, NOME_ARQUIVO_CONFIGURACAO);
    doArquivo = lerArquivo(caminho, obrigatorio, problemas);
    caminhoUsado = caminho;
  }

  // 2. ambiente vence o arquivo, que vence o padrão
  const brutos = {} as Record<keyof ConfiguracaoServidor, ValorBruto>;
  for (const campo of CAMPOS) {
    const doAmbiente = ambiente[VARIAVEIS_DE_AMBIENTE[campo]];
    if (doAmbiente !== undefined && doAmbiente !== '') {
      brutos[campo] = { valor: doAmbiente, origem: `variável ${VARIAVEIS_DE_AMBIENTE[campo]}` };
    } else if (campo in doArquivo) {
      brutos[campo] = { valor: doArquivo[campo], origem: `arquivo ${caminhoUsado}` };
    } else {
      brutos[campo] = { valor: CONFIGURACAO_PADRAO[campo], origem: 'padrão' };
    }
  }

  // 3. a porta imposta em código vence as duas fontes de fora (ver `OpcoesDeCarga.porta`).
  const portaImposta = opcoes.porta !== undefined;
  if (portaImposta) brutos.porta = { valor: opcoes.porta, origem: 'opção porta de quem chamou' };

  const host = validarHost(brutos.host, problemas);

  // Cada validação anota quantos problemas existiam antes: só assim dá para saber se o
  // valor que sobrou é o que o usuário pediu ou o padrão devolvido depois de um erro.
  const problemasAntesDaPorta = problemas.length;
  const porta = validarInteiro(
    brutos.porta,
    portaImposta ? FAIXA_DA_PORTA_IMPOSTA : FAIXAS.porta,
    'porta',
    problemas,
    CONFIGURACAO_PADRAO.porta,
  );
  const portaValida = problemas.length === problemasAntesDaPorta;

  const problemasAntesDaDescoberta = problemas.length;
  const portaDescoberta = validarInteiro(
    brutos.portaDescoberta,
    FAIXAS.portaDescoberta,
    'portaDescoberta',
    problemas,
    CONFIGURACAO_PADRAO.portaDescoberta,
  );
  const portaDescobertaValida = problemas.length === problemasAntesDaDescoberta;

  // Os dois graus entram na regra de coerência lá embaixo, e ela precisa saber se cada um é o que
  // a pessoa escreveu ou o sentinela devolvido depois de um erro — mesmo critério das portas.
  const problemasAntesDosGraus = problemas.length;
  const grausTelaCheia = validarAjusteDoGiro(
    brutos.grausTelaCheia,
    'grausTelaCheia',
    'desligado: vale a sensibilidade',
    problemas,
  );
  const grausTelaCheiaValido = problemas.length === problemasAntesDosGraus;

  const problemasAntesDosGrausY = problemas.length;
  const grausTelaCheiaY = validarAjusteDoGiro(
    brutos.grausTelaCheiaY,
    'grausTelaCheiaY',
    'usa o mesmo de grausTelaCheia',
    problemas,
  );
  const grausTelaCheiaYValido = problemas.length === problemasAntesDosGrausY;

  const configuracao: ConfiguracaoServidor = {
    host,
    porta,
    portaDescoberta,
    taxaHz: validarInteiro(
      brutos.taxaHz,
      FAIXAS.taxaHz,
      'taxaHz',
      problemas,
      CONFIGURACAO_PADRAO.taxaHz,
    ),
    nivelLog: validarNivelLog(brutos.nivelLog, problemas),
    gravacao: validarGravacao(brutos.gravacao, problemas),
    movimento: validarMovimento(brutos.movimento, problemas),
    recalibracao: validarBooleano(
      brutos.recalibracao,
      'recalibracao',
      problemas,
      CONFIGURACAO_PADRAO.recalibracao,
    ),
    orientacao: validarOrientacao(brutos.orientacao, problemas),
    sensibilidade: validarAjusteDoGiro(
      brutos.sensibilidade,
      'sensibilidade',
      'padrão de fábrica',
      problemas,
    ),
    zonaMorta: validarAjusteDoGiro(brutos.zonaMorta, 'zonaMorta', 'padrão de fábrica', problemas),
    suavizacao: validarAjusteDoGiro(brutos.suavizacao, 'suavizacao', 'padrão de fábrica', problemas),
    grausTelaCheia,
    grausTelaCheiaY,
    inverterX: validarBooleano(brutos.inverterX, 'inverterX', problemas, CONFIGURACAO_PADRAO.inverterX),
    inverterY: validarBooleano(brutos.inverterY, 'inverterY', problemas, CONFIGURACAO_PADRAO.inverterY),
    filtro: validarFiltro(brutos.filtro, problemas),
    filtroCorteMinimo: validarAjusteDoGiro(
      brutos.filtroCorteMinimo,
      'filtroCorteMinimo',
      'padrão de fábrica',
      problemas,
    ),
    filtroBeta: validarAjusteDoGiro(brutos.filtroBeta, 'filtroBeta', 'padrão de fábrica', problemas),
    saidaMouse: validarSaidaMouse(brutos.saidaMouse, problemas),
  };

  // Coerência: o vertical em graus sem o horizontal em graus não tem conversão possível — o
  // horizontal ficaria sem número, e o vertical pedido seria jogado fora na montagem do pipeline,
  // sem ninguém saber. Mesma regra das portas: só compara o que passou pela própria validação.
  if (
    grausTelaCheiaValido &&
    grausTelaCheiaYValido &&
    grausTelaCheiaY !== SENTINELAS_DO_GIRO.grausTelaCheiaY &&
    grausTelaCheia === SENTINELAS_DO_GIRO.grausTelaCheia
  ) {
    problemas.push(
      `grausTelaCheiaY (${brutos.grausTelaCheiaY.origem}) precisa de grausTelaCheia: sozinho ele ` +
        `seria descartado. Defina ${VARIAVEIS_DE_AMBIENTE.grausTelaCheia} também ` +
        `(por exemplo, 45 na horizontal e ${grausTelaCheiaY} na vertical)`,
    );
  }

  // Coerência: as duas portas no mesmo número deixariam a descoberta UDP sem lugar.
  // A comparação vale sempre que os DOIS valores passaram pela própria validação — o
  // módulo promete a lista completa de problemas, e não uma fila de um erro por execução.
  // Quando um dos dois caiu no padrão por ser inválido, a comparação seria com um valor
  // que o usuário não escreveu, e aí ela é (corretamente) pulada.
  if (portaValida && portaDescobertaValida && porta === portaDescoberta) {
    problemas.push(
      `porta e portaDescoberta não podem ser iguais (${porta}); ` +
        `use ${VARIAVEIS_DE_AMBIENTE.portaDescoberta} para separar as duas`,
    );
  }

  if (problemas.length > 0) throw new ErroDeConfiguracao(problemas);

  return Object.freeze(configuracao);
}

/** Uma linha legível com a configuração efetiva, para o log de partida. */
export function resumirConfiguracao(configuracao: ConfiguracaoServidor): string {
  let linha =
    `host=${configuracao.host} porta=${configuracao.porta} ` +
    `portaDescoberta=${configuracao.portaDescoberta} taxaHz=${configuracao.taxaHz} ` +
    `nivelLog=${configuracao.nivelLog} movimento=${configuracao.movimento}`;
  // A gravação só aparece quando está ligada: campo desligado em toda partida seria ruído
  // permanente numa linha que existe para ser lida de relance.
  if (configuracao.gravacao !== '') linha += ` gravacao=${configuracao.gravacao}`;
  // A recalibração aparece pelo motivo inverso: ela é ligada por padrão, e o que precisa ficar
  // dito é a execução em que **não** está valendo — senão o bias parado de propósito vira mistério.
  if (!configuracao.recalibracao) linha += ' recalibracao=desligada';
  // A saída do mouse só aparece quando pedida (fora do `auto`); a que ficou valendo, com o motivo,
  // sai na linha `backend de entrada pronto` (ATI-026).
  if (configuracao.saidaMouse !== CONFIGURACAO_PADRAO.saidaMouse) {
    linha += ` saidaMouse=${configuracao.saidaMouse}`;
  }
  // Os ajustes do giro aparecem só quando **pedidos** (fora do padrão e do sentinela), pela razão
  // da gravação. Esta linha diz o que foi pedido; a `pipeline de movimento pronto` diz o que ficou
  // valendo. Pôr as duas lado a lado é como se pega um ajuste aceito e descartado (ATI-032).
  linha += resumirAjustesPedidos(configuracao);
  return linha;
}

/** A parte do resumo com os ajustes do giro que fogem do padrão — vazia no caso comum. */
function resumirAjustesPedidos(configuracao: ConfiguracaoServidor): string {
  let pedidos = '';
  if (configuracao.orientacao !== CONFIGURACAO_PADRAO.orientacao) {
    pedidos += ` orientacao=${configuracao.orientacao}`;
  }
  for (const campo of Object.keys(SENTINELAS_DO_GIRO) as Array<keyof typeof SENTINELAS_DO_GIRO>) {
    if (configuracao[campo] !== SENTINELAS_DO_GIRO[campo]) pedidos += ` ${campo}=${configuracao[campo]}`;
  }
  if (configuracao.inverterX) pedidos += ' inverterX=sim';
  if (configuracao.inverterY) pedidos += ' inverterY=sim';
  if (configuracao.filtro !== CONFIGURACAO_PADRAO.filtro) pedidos += ` filtro=${configuracao.filtro}`;
  return pedidos;
}
