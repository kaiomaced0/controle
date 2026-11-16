/**
 * A montagem do servidor — **um** lugar para as regras que `npm run dev` e `npm run telemetria`
 * precisam cumprir igual (ATI-027).
 *
 * ## Por que este módulo existe
 *
 * Até a ATI-027 eram duas partidas. O `principal.ts` montava backend de entrada, pipeline de
 * movimento, comandos e mapeador de ações; a telemetria (`cli/telemetria.ts`) subia **só o
 * transporte**. Quem abria o painel — que é justamente a ferramenta de quem está medindo — via os
 * eixos mexerem e o cursor parado, sem explicação nenhuma na tela, e concluía a coisa errada: "o
 * pipeline está quebrado". Três revisões seguidas (ATI-007, ATI-008 e ATI-009) tropeçaram nisso.
 *
 * O conserto não é a telemetria aprender a montar também: duas montagens que precisam concordar
 * por coincidência é o mesmo vão de sempre, só adiado. Por isso a cadeia inteira mora aqui, e os
 * dois pontos de entrada decidem só o que é deles — argumentos, `--teste-mouse`, âncora, painel:
 *
 * ```
 * configuração → backend de entrada → gravação → pipeline de movimento → comandos `cmd`
 *              → mapeador de ações → fechamento de sessão → transporte → teclado de vibração
 * ```
 *
 * `prepararPartida` cobre as duas primeiras peças (as que podem recusar a partida antes de qualquer
 * porta abrir); `montarServidor` cobre o resto e devolve o servidor montado, com o `instantaneo()`
 * que o painel lê a cada quadro.
 *
 * ## A chave que decide se o cursor anda
 *
 * É uma só — a `movimento` da configuração (`CONTROLE_MOVIMENTO`) — e vale igual nos dois modos:
 * `ensaio` por padrão (a cadeia roda inteira e ninguém encosta no cursor nem clica), `sistema` para
 * o `SendInput` de verdade, `desligado` para nem montar o pipeline. Ver `montarPipeline` e
 * `montarMapeadorDeAcoes`.
 */

import { resolve } from 'node:path';
import {
  criarDestinoDeAcoesDeEnsaio,
  criarMapeadorDeAcoes,
  resumirContadoresDasAcoes,
  resumirTabela,
  type DestinoDeAcoes,
  type DestinoDeAcoesDeEnsaio,
  type MapeadorDeAcoes,
} from './acoes/indice.js';
import { criarGravadorDeCaptura, type GravadorDeCaptura } from './cli/captura.js';
import { criarAtendenteDeComandos, type AtendenteDeComandos } from './comandos.js';
import {
  SENTINELAS_DO_GIRO,
  VARIAVEIS_DE_AMBIENTE,
  type ConfiguracaoServidor,
  type ModoDeMovimento,
} from './config.js';
import { criarAtendenteDeDiagnostico, ligarTecladoDeVibracao } from './diagnostico/indice.js';
import type { ControleDeEncerramento } from './encerramento.js';
import type { DadosDoLog, Registrador } from './log.js';
import {
  AJUSTES_PADRAO,
  FAIXAS_DO_GIRO,
  criarDestinoDeEnsaio,
  criarPipelineDeMovimento,
  criarRepositorioDeBias,
  resumirAjustes,
  textoDoAvisoDeBiasAlto,
  type AjustesDoGiro,
  type AjustesParciais,
  type ContadoresDoPipeline,
  type DestinoDeEnsaio,
  type DestinoDeMovimento,
  type PipelineDeMovimento,
  type RepositorioDeBias,
} from './movimento/indice.js';
import type { MensagemDeTexto, PacoteDecodificado } from './protocolo/indice.js';
import {
  avisoDaSaidaDoMouse,
  criarBackendDeEntrada,
  type BackendDeEntrada,
  type DescricaoDaSaidaDoMouse,
  type TamanhoDaTela,
} from './saida/indice.js';
import {
  criarServidorDeTransporte,
  type ServidorDeTransporte,
  type SessaoDeTransporte,
} from './transporte/indice.js';

/** Versão exibida no log e no `welcome` do handshake (PROTOCOLO.md 3.2). */
export const VERSAO_SERVIDOR = '0.1.0';

/**
 * Abre o arquivo de gravação da sessão, quando a configuração pedir um (ATI-023).
 *
 * Caminho relativo é resolvido a partir de onde o processo foi chamado (`process.cwd()`), e
 * não da pasta do módulo: quem digita `CONTROLE_GRAVACAO=dados-locais/sessao.captura` no
 * terminal espera o arquivo ao lado de onde está, e não escondido dentro de `src/`.
 *
 * Arquivo que já existe **não é sobrescrito**: a partida falha com mensagem clara (ver
 * `criarGravadorDeCaptura`). Reiniciar o servidor com a mesma variável de ambiente não pode
 * destruir a captura da sessão de ontem — é justamente o dado que a gravação existe para guardar.
 *
 * @throws {ErroDeCaptura} arquivo já existe.
 * @throws erro do sistema de arquivos quando o caminho não pode ser aberto.
 */
function abrirGravacao(
  configuracao: ConfiguracaoServidor,
  registrador: Registrador,
): GravadorDeCaptura | undefined {
  if (configuracao.gravacao === '') return undefined;

  const caminho = resolve(process.cwd(), configuracao.gravacao);
  const gravador = criarGravadorDeCaptura({
    caminho,
    cabecalho: [
      `gravadoEm=${new Date().toISOString()}`,
      `servidor=${VERSAO_SERVIDOR} taxaHz=${configuracao.taxaHz}`,
    ],
  });
  registrador.info('gravando a sessão em arquivo', {
    arquivo: caminho,
    reproduzir: `npm run simulador -- --padrao gravado --arquivo ${configuracao.gravacao}`,
  });
  return gravador;
}

/**
 * Os donos de estado que uma sessão deixa para trás quando cai.
 *
 * Objeto nomeado, e não parâmetros posicionais: eram cinco, três deles opcionais, e a bancada da
 * página já precisava passar `undefined` duas vezes para alcançar o último. O próximo dono a
 * entrar aqui (o mapeador de teclas da ATI-012) faria seis — e trocar a ordem de dois opcionais
 * do mesmo tipo é o erro que ninguém enxerga na revisão e que só aparece com um botão preso.
 *
 * Todos são opcionais porque cada um pode legitimamente não existir na execução: sem `--gravar`
 * não há gravador, com `movimento=desligado` não há pipeline, e sem backend de entrada não há o
 * que soltar.
 */
export interface PecasDaSessao {
  /** Buffer de captura a descarregar (ATI-006). */
  readonly gravador?: GravadorDeCaptura | undefined;
  /** Entrada injetada, que precisa soltar botão e tecla (ATI-007). */
  readonly backend?: BackendDeEntrada | undefined;
  /** Memória entre amostras do movimento: bias, suavização, fração de pixel (ATI-008). */
  readonly pipeline?: PipelineDeMovimento | undefined;
  /** Só para a linha de resumo do pipeline. Sem ele, o fechamento acontece calado. */
  readonly registrador?: Registrador | undefined;
  /** Botões apertados pelo celular e a fração de entalhe de scroll guardada (ATI-010). */
  readonly acoes?: MapeadorDeAcoes | undefined;
}

/**
 * O que acontece quando **uma sessão** termina — e não o processo.
 *
 * São dois donos de estado que a queda de uma sessão deixa para trás:
 *
 * - a **gravação**, que precisa descarregar o buffer (sem isto, quem desconecta o celular e vai
 *   ver a captura encontra as últimas amostras faltando até desligar o servidor);
 * - a **entrada injetada**, que precisa soltar tudo. Cabo arrancado no meio de um arrastar, app
 *   fechado com o botão apertado, aparelho novo tomando o lugar do anterior: em todos, o último
 *   evento que o servidor recebeu foi um "apertou", e o "soltou" nunca vai chegar. Sem esta
 *   linha, o botão fica apertado no Windows inteiro (CLAUDE.md, regra 5).
 * - o **pipeline de movimento**, que guarda memória entre amostras (média exponencial, fração de
 *   pixel, ordem de `seq`, régua de atraso). Nada disso pode atravessar para o próximo aparelho:
 *   a fração guardada de uma sessão sairia como movimento na primeira amostra da seguinte. E os
 *   **contadores** da sessão, que voltam a zero depois do resumo (ATI-028) — o total da execução
 *   continua em `totalDoProcesso()` e sai no Ctrl+C (`registrarTotalDaExecucao`).
 * - o **mapeador de ações** (ATI-010), que solta o que estiver apertado no destino dele e joga
 *   fora a fração de entalhe de scroll guardada — pelo mesmo motivo da fração de pixel acima.
 *
 * ⚠️ **Quem chama isto é o transporte, e só para sessão adotada** — a que completou o handshake
 * (`transporte/servidor.ts`, conjunto `adotadas`). A distinção é o conserto do bloqueante da
 * rodada 1 da **ATI-008**: antes, qualquer socket que abrisse e caísse sem `hello` (segunda aba da
 * página `/diagnostico`, reconexão que falhou, varredura de porta) disparava esta função e soltava
 * o botão de quem estava no meio de um arrastar, além de apagar a memória do pipeline dele. As
 * causas de soltura são as três da lista acima; conexão de terceiro não é uma delas.
 *
 * Fica em função própria — e exportada — porque é exatamente o tipo de caminho que só é exercitado
 * quando o cabo cai, ou seja, nunca, a não ser que um teste o exercite de propósito.
 */
export function criarFechamentoDeSessao(pecas: PecasDaSessao): () => void {
  const { gravador, backend, pipeline, registrador, acoes } = pecas;
  return () => {
    gravador?.descarregar();
    backend?.soltarTudo();
    // `backend.soltarTudo()` acima já cuidou do caso `movimento=sistema` (o destino do mapeador
    // **é** o backend). Esta chamada é o que cobre o destino de ensaio e, principalmente, a
    // fração de entalhe guardada, que é estado só do mapeador. Ela também põe no log a linha de
    // resumo da sessão, com o registrador do próprio módulo.
    acoes?.reiniciar();
    if (pipeline === undefined) return;
    // Uma linha por **sessão**, nunca por pacote: é o resumo do que a cadeia fez com o giroscópio
    // daquele aparelho, e é o que se lê depois de uma passada com o celular na mão.
    registrador?.info('pipeline de movimento — resumo da sessão', {
      destino: pipeline.destino.nome,
      ...camposDoResumoDoPipeline(pipeline.contadores),
    });
    pipeline.reiniciar();
    // A ordem é a correção da ATI-028: resumo, reinício e **só então** a conta da sessão volta a
    // zero. Fechar antes do `reiniciar()` jogaria o reinício deste fim de sessão na conta da
    // próxima; não fechar (o comportamento antigo) fazia a segunda sessão relatar a soma das duas.
    pipeline.fecharContadoresDaSessao();
  };
}

/**
 * Os campos da linha de resumo do pipeline, a partir de **uma** das duas contas — a da sessão no
 * fim de cada sessão, a do processo no fim da execução. Um lugar só para os dois formatos não
 * divergirem; a diferença entre as linhas é a mensagem, que diz qual conta é.
 */
function camposDoResumoDoPipeline(contadores: Readonly<ContadoresDoPipeline>): DadosDoLog {
  return {
    amostras: contadores.amostrasRecebidas,
    aplicadas: contadores.amostrasAplicadas,
    pixelsX: contadores.pixelsX,
    pixelsY: contadores.pixelsY,
    zonaMorta: contadores.zeradasPorZonaMorta,
    descartes:
      `dt=${contadores.descartadasPorDt} ` +
      `ordem=${contadores.descartadasPorOrdem} ` +
      `atraso=${contadores.descartadasPorAtraso} ` +
      `leitura=${contadores.descartadasPorLeituraInvalida}`,
    picosLimitados: contadores.limitadasPorPico,
  };
}

/** O que `registrarTotalDaExecucao` lê. Os dois são opcionais pelo mesmo motivo de `PecasDaSessao`. */
export interface PecasDoTotalDaExecucao {
  readonly pipeline?: PipelineDeMovimento | undefined;
  readonly acoes?: MapeadorDeAcoes | undefined;
  /** Registrador raiz; as linhas saem nos escopos `movimento` e `acoes`, como os resumos de sessão. */
  readonly registrador: Registrador;
}

/**
 * O total **do processo** (ATI-028), uma vez, no Ctrl+C — depois de a última sessão fechar.
 *
 * Até a ATI-028 este número existia por acidente: o "resumo da sessão" nunca zerava, e a última
 * linha de sessão do log era, sem dizer, o total da execução. Com os resumos passando a falar só
 * da própria sessão, o total precisava de linha própria e de nome que dissesse o que ele é — e é a
 * mensagem (`total da execução`) que separa as duas contas, nunca um campo misturando as duas.
 */
export function registrarTotalDaExecucao(pecas: PecasDoTotalDaExecucao): void {
  const { pipeline, acoes, registrador } = pecas;
  if (pipeline !== undefined) {
    registrador.comEscopo('movimento').info('pipeline de movimento — total da execução', {
      destino: pipeline.destino.nome,
      sessoes: pipeline.sessoesFechadas,
      ...camposDoResumoDoPipeline(pipeline.totalDoProcesso()),
    });
  }
  if (acoes !== undefined) {
    registrador.comEscopo('acoes').info('ações — total da execução', {
      destino: acoes.destino.nome,
      total: resumirContadoresDasAcoes(acoes.totalDoProcesso()),
    });
  }
}

/**
 * O giro como a configuração pediu: os ajustes que vão para o pipeline e o que **não** pôde ser
 * atendido do jeito que foi pedido.
 */
export interface GiroDaConfiguracao {
  /** Pedido parcial para `resolverAjustes`: campo `undefined` = "não mexi", vale o de fábrica. */
  readonly ajustes: AjustesParciais;
  /**
   * Pedidos descartados ou trocados na montagem, um por linha de `aviso` na partida. Vazio no caso
   * comum. Existe porque a outra saída seria o silêncio, e o silêncio é o defeito que a ATI-032
   * nasceu para matar: o ajuste aceito pela configuração e jogado fora antes de chegar ao cursor.
   */
  readonly avisos: readonly string[];
}

/** Nenhum ajuste da configuração: o pipeline sobe com o padrão de fábrica. */
const SEM_GIRO_DA_CONFIGURACAO: GiroDaConfiguracao = Object.freeze({ ajustes: {}, avisos: [] });

/**
 * Traduz a configuração do servidor para os ajustes do giro (ATI-032).
 *
 * Existe porque a orientação e os números do giro são a única coisa que a pessoa precisa mexer
 * hoje e não tem onde: o perfil é a ATI-016 e o controle no celular é a ATI-011. Os sentinelas de
 * `SENTINELAS_DO_GIRO` (`0` e `-1`) querem dizer "não mexi nisso", e o padrão de fábrica prevalece.
 *
 * ⚠️ **Todo campo é escrito por extenso, e o sentinela vira `undefined`** — nunca `...(cond ? {...}
 * : {})`. `AjustesParciais` é todo opcional, e a checagem de propriedade extra do TypeScript não
 * enxerga dentro de *spread*: foi assim que esta função saiu com `deadzone` no lugar de
 * `zonaMortaGrausPorS`, compilou, e o servidor usou o padrão de fábrica em silêncio. Com o campo
 * explícito, nome errado é erro de compilação.
 */
export function ajustesDaConfiguracao(
  configuracao: ConfiguracaoServidor,
  /** Resolução da tela, quando houver backend. É o que converte graus em pixels por grau. */
  tela?: TamanhoDaTela,
): GiroDaConfiguracao {
  const sensibilidade = sensibilidadeDaConfiguracao(configuracao, tela);
  const ajustes: AjustesParciais = {
    orientacao: configuracao.orientacao,
    sensXPixelsPorGrau: sensibilidade.x,
    sensYPixelsPorGrau: sensibilidade.y,
    zonaMortaGrausPorS:
      configuracao.zonaMorta === SENTINELAS_DO_GIRO.zonaMorta ? undefined : configuracao.zonaMorta,
    suavizacao:
      configuracao.suavizacao === SENTINELAS_DO_GIRO.suavizacao ? undefined : configuracao.suavizacao,
    inverterX: configuracao.inverterX,
    inverterY: configuracao.inverterY,
    // ATI-033: o filtro da etapa 4 e os dois números dele que a configuração expõe.
    filtro: configuracao.filtro,
    filtroCorteMinimoHz:
      configuracao.filtroCorteMinimo === SENTINELAS_DO_GIRO.filtroCorteMinimo
        ? undefined
        : configuracao.filtroCorteMinimo,
    filtroBeta:
      configuracao.filtroBeta === SENTINELAS_DO_GIRO.filtroBeta ? undefined : configuracao.filtroBeta,
  };
  return { ajustes, avisos: sensibilidade.avisos };
}

/** O px/grau de cada eixo que a configuração pediu, e o que ficou pelo caminho. */
interface SensibilidadeDaConfiguracao {
  /** `undefined` = nada pedido, vale o padrão de fábrica. */
  readonly x: number | undefined;
  readonly y: number | undefined;
  readonly avisos: readonly string[];
}

/**
 * De onde sai o px/grau de cada eixo.
 *
 * Duas formas de dizer a mesma coisa, e a de cima vence:
 *
 * 1. **`grausTelaCheia`** — "quantos graus atravessam a tela". O servidor divide a resolução por
 *    esse número, **cada eixo pelo seu lado**: numa tela 1920×1080, 45° dão 42,7 px/grau na
 *    horizontal e 24 px/grau na vertical. Usar um número só para os dois eixos deformaria o
 *    gesto — o mesmo giro andaria proporcionalmente mais no eixo curto, e um círculo com o pulso
 *    sairia como elipse na tela.
 * 2. **`sensibilidade`** — px/grau direto, igual nos dois eixos.
 *
 * Três situações em que o pedido não sai como foi escrito, e cada uma vira aviso:
 *
 * - **graus sem tamanho de tela** (sem backend, ou `GetSystemMetrics` sem resposta): não há o que
 *   dividir, e vale a `sensibilidade` ou o padrão de fábrica — o aviso diz qual;
 * - **graus e sensibilidade juntos**: os graus vencem, e a sensibilidade escrita é ignorada;
 * - **conta fora da faixa do giro** (graus pequenos numa tela grande): o pipeline satura em
 *   `FAIXAS_DO_GIRO.sensibilidade`, e o aviso diz o número que ficou.
 *
 * ⚠️ A conta se cumpre na tela com a saída do mouse `auto` (padrão) ou `absoluto` (ATI-026); com
 * `relativo` e a aceleração de ponteiro do Windows ligada, o Windows reescala o movimento e os 45°
 * não fecham na borda.
 */
function sensibilidadeDaConfiguracao(
  configuracao: ConfiguracaoServidor,
  tela: TamanhoDaTela | undefined,
): SensibilidadeDaConfiguracao {
  const { grausTelaCheia, grausTelaCheiaY, sensibilidade } = configuracao;
  const pediuGraus = grausTelaCheia !== SENTINELAS_DO_GIRO.grausTelaCheia;
  const pediuSensibilidade = sensibilidade !== SENTINELAS_DO_GIRO.sensibilidade;
  const avisos: string[] = [];

  if (pediuGraus) {
    // O eixo vertical aceita número próprio: o pulso não inclina tanto quanto gira, então pedir
    // os mesmos graus nos dois eixos deixa o vertical com menos da metade do ganho do horizontal.
    const grausY =
      grausTelaCheiaY !== SENTINELAS_DO_GIRO.grausTelaCheiaY ? grausTelaCheiaY : grausTelaCheia;
    const pedido = `grausTelaCheia=${grausTelaCheia}/${grausY}°`;

    if (tela !== undefined && tela.largura > 0 && tela.altura > 0) {
      const x = tela.largura / grausTelaCheia;
      const y = tela.altura / grausY;
      if (pediuSensibilidade) {
        avisos.push(
          `sensibilidade=${sensibilidade} px/grau ignorada: ${pedido} vence quando os dois vêm ` +
            `(tela ${tela.largura}×${tela.altura})`,
        );
      }
      avisarSaturacao(x, 'horizontal', tela.largura, grausTelaCheia, avisos);
      avisarSaturacao(y, 'vertical', tela.altura, grausY, avisos);
      return { x, y, avisos };
    }

    const valendo = pediuSensibilidade
      ? `sensibilidade=${sensibilidade}/${sensibilidade} px/grau, da configuração`
      : `sens=${AJUSTES_PADRAO.sensXPixelsPorGrau}/${AJUSTES_PADRAO.sensYPixelsPorGrau} px/grau, ` +
        'o padrão de fábrica';
    avisos.push(
      `${pedido} pedido, mas o tamanho da tela é desconhecido (sem backend de entrada, ou ` +
        `GetSystemMetrics sem resposta): os graus não viram px/grau; vale ${valendo}`,
    );
  }

  if (pediuSensibilidade) return { x: sensibilidade, y: sensibilidade, avisos };
  return { x: undefined, y: undefined, avisos };
}

/**
 * Graus pequenos numa tela grande dão px/grau acima do teto do giro (e muitos graus numa tela
 * minúscula, abaixo do piso), e o pipeline satura sem dizer nada — é a regra dele, PROTOCOLO.md
 * seção 3.4. Aqui o número veio de uma conta que a pessoa não vê, então a saturação precisa ser dita.
 */
function avisarSaturacao(
  pixelsPorGrau: number,
  eixo: string,
  pixels: number,
  graus: number,
  avisos: string[],
): void {
  const { minimo, maximo } = FAIXAS_DO_GIRO.sensibilidade;
  if (pixelsPorGrau >= minimo && pixelsPorGrau <= maximo) return;
  const limite = pixelsPorGrau > maximo ? maximo : minimo;
  avisos.push(
    `${graus}° para ${pixels} px na ${eixo} dão ${Math.round(pixelsPorGrau * 100) / 100} px/grau, ` +
      `fora da faixa do giro (${minimo} a ${maximo}): vale ${limite} px/grau`,
  );
}

/**
 * Monta o pipeline de movimento conforme a configuração pediu (ATI-008).
 *
 * `sistema` sem backend de entrada **não vira cursor de verdade em silêncio** e também não derruba
 * o servidor: cai para o ensaio com um aviso. É o mesmo critério do resto da partida — o servidor
 * sobe, e o que não dá para fazer fica dito no log em vez de virar um mistério com o celular na
 * mão. Pelo mesmo critério, cada ajuste do giro que a configuração pediu e não pôde ser atendido
 * (`GiroDaConfiguracao.avisos`) vira uma linha de aviso logo depois do `pipeline de movimento
 * pronto` — e só quando há pipeline: com o movimento desligado, ajuste de giro não é problema.
 *
 * Exportada para o teste conseguir afirmar **para onde o movimento vai** em cada modo sem subir o
 * servidor inteiro: é a escolha que decide se o cursor de quem está usando a máquina se mexe.
 */
export function montarPipeline(
  modo: ModoDeMovimento,
  backend: BackendDeEntrada | undefined,
  registrador: Registrador,
  /** O giro que a configuração pediu (`ajustesDaConfiguracao`); sem ele, padrão de fábrica. */
  giro: GiroDaConfiguracao = SEM_GIRO_DA_CONFIGURACAO,
): { pipeline: PipelineDeMovimento; ensaio: DestinoDeEnsaio | undefined } | undefined {
  if (modo === 'desligado') return undefined;

  let ensaio: DestinoDeEnsaio | undefined;
  let destino: DestinoDeMovimento;
  if (modo === 'sistema' && backend !== undefined) {
    destino = backend;
  } else {
    if (modo === 'sistema') {
      registrador.aviso(
        'movimento=sistema pedido, mas não há backend de entrada: caindo para o ensaio',
      );
    }
    ensaio = criarDestinoDeEnsaio();
    destino = ensaio;
  }

  // A orientação e a sensibilidade vêm da configuração enquanto não há perfil (ATI-016) nem
  // controle no celular (ATI-011). A orientação é a que mais importa: escolher a errada não dá
  // erro nenhum, só faz o cursor responder ao gesto errado — quem segura o aparelho deitado
  // apontando para a tela precisa de `apontador`, não do `retrato` de fábrica.
  const pipeline = criarPipelineDeMovimento({ destino, ajustes: giro.ajustes });
  registrador.info('pipeline de movimento pronto', {
    modo,
    destino: destino.nome,
    // O aviso importa mais que o ajuste: `sistema` é a única configuração em que um sinal
    // invertido some com o cursor da pessoa que está usando a máquina.
    cursor: destino.nome === 'ensaio' ? 'NÃO se move (ensaio)' : 'SE MOVE de verdade',
    ajustes: resumirAjustes(pipeline.ajustes),
  });
  for (const aviso of giro.avisos) registrador.aviso(aviso);
  return { pipeline, ensaio };
}

/**
 * Monta o mapeador de ações (ATI-010): o toque no celular virando clique, arrastar e scroll.
 *
 * ⚠️ **A chave que liga o clique de verdade é a mesma do cursor.** `entradaDeVerdade` é o
 * `cursorDeVerdade` de `montarServidor()`, ou seja, `CONTROLE_MOVIMENTO=sistema` **com** backend de
 * entrada. Em qualquer outro caso o destino é o ensaio: o BOTÃO percorre a cadeia inteira, é
 * contado, e ninguém clica.
 *
 * A razão de o padrão ser este é mais dura que a do movimento. Um cursor que anda sozinho
 * atrapalha quem está usando a máquina; um **clique** acontece onde o cursor estiver, e ali pode
 * ter um botão de verdade. Ligar clique por omissão seria apostar no que está embaixo do cursor de
 * outra pessoa.
 *
 * O mapeador existe **sempre**, inclusive sem backend: assim o BOTÃO que chega tem para onde ir e
 * aparece nos contadores, em vez de sumir sem deixar rastro — que foi exatamente o estado do
 * projeto até esta atividade.
 */
export function montarMapeadorDeAcoes(
  backend: BackendDeEntrada | undefined,
  entradaDeVerdade: boolean,
  registrador: Registrador,
): { mapeador: MapeadorDeAcoes; ensaio: DestinoDeAcoesDeEnsaio | undefined } {
  let ensaio: DestinoDeAcoesDeEnsaio | undefined;
  let destino: DestinoDeAcoes;
  if (entradaDeVerdade && backend !== undefined) {
    destino = backend;
  } else {
    ensaio = criarDestinoDeAcoesDeEnsaio();
    destino = ensaio;
  }

  const mapeador = criarMapeadorDeAcoes({ destino, registrador });
  registrador.info('mapeador de ações pronto', {
    destino: destino.nome,
    // O aviso importa mais que a tabela: `sistema` é a única configuração em que um toque no
    // celular aperta um botão de verdade na máquina de quem está do outro lado da tela.
    clique: destino.nome === 'ensaio' ? 'NÃO acontece (ensaio)' : 'ACONTECE de verdade',
    controles: resumirTabela(mapeador.tabela),
    scroll: 'faixa: pacote SCROLL (0x04), sem idControle',
  });
  return { mapeador, ensaio };
}

/**
 * Monta o atendente dos comandos `cmd` — `centralizar` e a calibração de bias (ATI-009).
 *
 * Ele existe **mesmo com o movimento desligado**: sem atendente, os dois comandos cairiam na
 * resposta padrão do transporte ("este comando ainda não tem dono no servidor"), que passou a ser
 * mentira nesta atividade. Com atendente, a recusa diz o motivo de verdade — o movimento está
 * desligado nesta execução.
 *
 * Exportada pelo mesmo motivo de `montarPipeline`: é aqui que se decide se o `centralizar` encosta
 * no cursor de quem está usando a máquina, e isso precisa ser afirmável por teste sem subir o
 * servidor inteiro.
 *
 * `criarRepositorio` é o ponto de injeção do arquivo de bias, pelo mesmo motivo do `criarBackend`:
 * `npm test` não escreve no `dados-locais/bias.json` de quem está desenvolvendo, e um arquivo de
 * verdade nessa pasta não muda o que o teste lê (ver `OpcoesDaMontagem.criarRepositorio`).
 */
export function montarComandos(
  configuracao: ConfiguracaoServidor,
  pipeline: PipelineDeMovimento | undefined,
  backend: BackendDeEntrada | undefined,
  cursorDeVerdade: boolean,
  registrador: Registrador,
  criarRepositorio?: () => RepositorioDeBias,
): AtendenteDeComandos {
  const repositorio = (criarRepositorio ?? (() => criarRepositorioDeBias({ registrador })))();

  // O ajuste automático é montado pelo próprio atendente: a chave da configuração vai como
  // `recalibracaoLigada` e o resto (aplicar no pipeline, registrar cada replantio) já é o padrão
  // dele. Montá-lo aqui de novo duplicaria as duas fiações e deixaria os dois caminhos livres para
  // divergirem com o tempo.
  const atendente = criarAtendenteDeComandos({
    pipeline,
    backend,
    cursorDeVerdade,
    repositorio,
    recalibracaoLigada: configuracao.recalibracao,
    registrador,
  });

  registrador.info('comandos prontos', {
    centralizar: pipeline === undefined ? 'recusa (movimento desligado)' : cursorDeVerdade ? 'MOVE o cursor' : 'ensaio (não move)',
    calibrar: pipeline === undefined ? 'recusa (movimento desligado)' : 'disponível',
    recalibracao: atendente.recalibracao.ativo ? 'ligada' : 'desligada',
    biasGuardado: repositorio.caminho,
  });
  return atendente;
}

/* ============================================================================ a partida */

export interface OpcoesDaPreparacao {
  readonly configuracao: ConfiguracaoServidor;
  readonly registrador: Registrador;
  /**
   * Como criar o backend de entrada. O padrão detecta a plataforma (`saida/escolha.ts`); os testes
   * passam a dubla, porque `npm test` não mexe no cursor de ninguém.
   */
  readonly criarBackend?: (() => BackendDeEntrada) | undefined;
  /**
   * Quem, na linha de comando, só faz sentido com backend — hoje, o `--teste-mouse`. Com isto,
   * faltar backend é **recusa de partida** com o nome de quem pediu; sem isto, é aviso e o
   * servidor sobe sem injetar nada.
   */
  readonly exigidoPor?: string | undefined;
}

/** A saída do mouse (ATI-026) em campos da linha `backend de entrada pronto`. */
function camposDaSaidaDoMouse(saida: DescricaoDaSaidaDoMouse | undefined): DadosDoLog {
  if (saida === undefined) return {};
  return {
    saidaMouse: saida.efetivo,
    motivo: saida.motivo,
    aceleracao: saida.aceleracao,
    velocidadeDoPonteiro: saida.velocidade === undefined ? 'desconhecida' : `${saida.velocidade}/20`,
  };
}

/**
 * O aviso da aceleração de ponteiro (ATI-026), uma linha de `aviso` na partida, **em qualquer modo**
 * de movimento — e nunca em silêncio. Em ensaio nada sai para o Windows, e a linha diz isso: o aviso
 * vale para quando o cursor for de verdade, que é justamente quando ninguém mais está olhando o log.
 *
 * Exportada pelo mesmo motivo de `montarPipeline`: o texto é o critério de aceite, e precisa ser
 * afirmável por teste sem depender da configuração de mouse da máquina que roda a suíte.
 */
export function avisarSaidaDoMouse(
  saida: DescricaoDaSaidaDoMouse | undefined,
  configuracao: ConfiguracaoServidor,
  registrador: Registrador,
): void {
  if (saida === undefined) return;
  const aviso = avisoDaSaidaDoMouse(saida);
  if (aviso === undefined) return;
  const quando =
    configuracao.movimento === 'sistema'
      ? ''
      : ` (agora o movimento é ${configuracao.movimento} e nada sai para o Windows; vale quando ` +
        `${VARIAVEIS_DE_AMBIENTE.movimento}=sistema)`;
  registrador.aviso(`${aviso}${quando}`);
}

/** O que `prepararPartida` deixou pronto — ou a recusa, já explicada no log. */
export type PartidaPreparada =
  | {
      readonly ok: true;
      readonly backend: BackendDeEntrada | undefined;
      readonly gravador: GravadorDeCaptura | undefined;
    }
  | { readonly ok: false };

/**
 * As duas peças que podem recusar a partida antes de qualquer porta abrir: o backend de entrada e o
 * arquivo de gravação.
 *
 * Ficam fora de `montarServidor` porque é aqui que a partida pode falhar **sem** ter instalado
 * nada: recusa devolve `{ ok: false }` com o motivo no log e o backend já desfeito, e quem chamou só
 * marca o código de saída. Nenhum ouvinte de sinal, nenhuma âncora, nenhuma porta para trás.
 */
export function prepararPartida(opcoes: OpcoesDaPreparacao): PartidaPreparada {
  const { configuracao, registrador } = opcoes;

  // Backend de entrada (ATI-007). Sistema sem backend **não derruba o servidor**: telemetria e
  // página de diagnóstico continuam valendo, e é assim que o sprint 1 já funcionava. O que muda é
  // que fica dito no log, em vez de o cursor simplesmente nunca se mexer.
  let backend: BackendDeEntrada | undefined;
  try {
    // A saída do mouse vem da configuração (ATI-026): é o backend quem lê a configuração de ponteiro
    // do Windows e resolve o `auto`, porque só ele fala com o sistema.
    backend = (
      opcoes.criarBackend ??
      (() => criarBackendDeEntrada({ saidaDoMouse: configuracao.saidaMouse }))
    )();
    const tela = backend.tamanhoDaTela();
    registrador.info('backend de entrada pronto', {
      backend: backend.nome,
      tela: tela === undefined ? 'desconhecida' : `${tela.largura}x${tela.altura}`,
      ...camposDaSaidaDoMouse(backend.saidaDoMouse),
    });
    avisarSaidaDoMouse(backend.saidaDoMouse, configuracao, registrador);
  } catch (erro) {
    if (opcoes.exigidoPor !== undefined) {
      // Pediu para mexer no cursor e não há como: recusar é a única resposta honesta.
      registrador.erro(`${opcoes.exigidoPor} pedido, mas não há backend de entrada`, { erro });
      return { ok: false };
    }
    registrador.aviso('sem backend de entrada: o servidor sobe, mas não injeta nada', { erro });
  }

  // Antes de qualquer coisa subir: gravação pedida que não abre é erro de partida, não algo
  // para se descobrir depois de uma sessão inteira perdida.
  let gravador: GravadorDeCaptura | undefined;
  try {
    gravador = abrirGravacao(configuracao, registrador);
  } catch (erro) {
    registrador.erro('não consegui abrir o arquivo de gravação', {
      arquivo: configuracao.gravacao,
      erro,
    });
    // O backend já existe e já pendurou a rede de segurança na saída do processo: desfazer aqui
    // evita deixar ouvinte para trás num caminho que nem chegou a abrir porta.
    backend?.encerrar();
    return { ok: false };
  }

  return { ok: true, backend, gravador };
}

/* ======================================================================== o servidor montado */

/**
 * Para onde o movimento está indo — o que a primeira linha do painel diz (ATI-027).
 *
 * - `real`: o `SendInput` de verdade; o cursor anda e o toque clica.
 * - `ensaio`: a cadeia roda inteira e mede, mas nada sai da máquina. É o padrão, e também o que
 *   sobra quando `sistema` foi pedido sem backend de entrada.
 * - `desligado`: nem há pipeline (`CONTROLE_MOVIMENTO=desligado`).
 */
export type DestinoDoCursor = 'real' | 'ensaio' | 'desligado';

/**
 * De onde veio o bias que o pipeline está descontando agora.
 *
 * - `nenhuma`: o aparelho conectou sem bias guardado e ninguém calibrou — o pipeline partiu do
 *   zero (o que a recalibração automática ajustar depois aparece na linha dela, não aqui);
 * - `guardado`: veio do `dados-locais/bias.json`, gravado numa sessão anterior deste aparelho;
 * - `calibracao`: `calibrar-fim` concluído nesta execução.
 */
export type OrigemDoBias = 'nenhuma' | 'guardado' | 'calibracao';

/**
 * O que o painel lê da montagem, a cada quadro (ATI-027).
 *
 * Objeto **novo** por leitura: é o painel, a ~10 Hz, e nunca o caminho quente. Todo número aqui já
 * existia no servidor — nos contadores do pipeline, do mapeador e da recalibração — e só não tinha
 * para onde ir enquanto o painel não montava nada.
 */
export interface InstantaneoDaMontagem {
  readonly cursor: DestinoDoCursor;
  /** Ajustes **efetivos** do pipeline (o objeto congelado dele); `undefined` sem pipeline. */
  readonly ajustes: AjustesDoGiro | undefined;
  /** O bias em uso está em `ajustes`; aqui fica de onde ele veio e desde quando. */
  readonly bias: {
    readonly origem: OrigemDoBias;
    /** Relógio de parede, em ms. `NaN` quando não há data (origem `nenhuma`, arquivo sem data). */
    readonly desdeMs: number;
  };
  readonly recalibracao: {
    readonly ligada: boolean;
    /** Quantas vezes o ajuste automático entregou bias ao pipeline desde que esta sessão abriu. */
    readonly aplicacoesNaSessao: number;
    readonly aplicacoesNaExecucao: number;
    /** Há quanto tempo o aparelho está parado (relógio do aparelho). Aos 3 s o ajuste começa. */
    readonly paradoMs: number;
    /**
     * A linha do aviso de bias alto (ATI-029), **o mesmo texto** que vai para a tela do aparelho
     * no quadro `aviso`; `undefined` com o aviso apagado.
     */
    readonly avisoDeBiasAlto: string | undefined;
  };
  /**
   * Pixels que a cadeia mandou para o destino — em `ensaio`, os que **teriam** saído. É o número
   * que prova o pipeline funcionando sem tocar no cursor. `undefined` sem pipeline.
   */
  readonly pixels:
    | {
        readonly sessaoX: number;
        readonly sessaoY: number;
        readonly execucaoX: number;
        readonly execucaoY: number;
      }
    | undefined;
  readonly acoes: {
    /** Apertos de botão nesta sessão — em `ensaio`, os que teriam clicado. */
    readonly cliquesNaSessao: number;
    readonly entalhesVerticaisNaSessao: number;
    readonly entalhesHorizontaisNaSessao: number;
    /** Botões presos no destino agora. Fora de um arrastar, qualquer número acima de 0 é defeito. */
    readonly presos: number;
  };
  /**
   * A saída do mouse e a aceleração de ponteiro do Windows (ATI-026). `undefined` sem backend de
   * entrada, ou com um backend que não tem o que dizer (a dubla, nos testes).
   */
  readonly ponteiro: DescricaoDaSaidaDoMouse | undefined;
}

/**
 * Os ganchos que a montagem entrega ao transporte.
 *
 * Expostos no `ServidorMontado` para o teste conseguir dirigir a cadeia inteira — sessão, pacote,
 * comando — sem socket nenhum, e afirmar o que a montagem faz com cada coisa.
 */
export interface GanchosDaMontagem {
  /** ⚠️ Caminho quente — 100 Hz. Nada aloca aqui dentro. */
  readonly aoReceberPacote: (pacote: PacoteDecodificado, sessao: SessaoDeTransporte) => void;
  readonly aoReceberTexto: (mensagem: MensagemDeTexto, sessao: SessaoDeTransporte) => boolean;
  readonly aoAbrirSessao: (sessao: SessaoDeTransporte) => void;
  readonly aoEncerrarSessao: (sessao: SessaoDeTransporte, motivo: string) => void;
}

export interface OpcoesDaMontagem {
  readonly configuracao: ConfiguracaoServidor;
  /** Registrador raiz; cada peça recebe o próprio escopo (`movimento`, `comandos`, `acoes`...). */
  readonly registrador: Registrador;
  /**
   * Onde cada peça pendura a própria soltura. As tarefas rodam na ordem inversa do registro, então
   * quem chama registra **antes** o que precisa fechar **depois** de tudo (o painel, a espera).
   */
  readonly encerramento: ControleDeEncerramento;
  /** O que `prepararPartida` devolveu. */
  readonly backend: BackendDeEntrada | undefined;
  readonly gravador?: GravadorDeCaptura | undefined;
  /**
   * Onde o bias por aparelho é guardado. O padrão é `server/dados-locais/bias.json`; os testes
   * passam uma pasta temporária — teste automático não encosta nos dados de quem está trabalhando.
   */
  readonly criarRepositorio?: (() => RepositorioDeBias) | undefined;
  /**
   * ⚠️ Caminho quente. O que o modo faz com cada pacote **depois** de a cadeia inteira tê-lo visto
   * — na telemetria, copiar os três eixos para o painel. Sem alocação, sem log.
   */
  readonly aoReceberPacote?:
    | ((pacote: PacoteDecodificado, sessao: SessaoDeTransporte) => void)
    | undefined;
  /** O que o modo faz quando a sessão cai, depois do fechamento da montagem. */
  readonly aoEncerrarSessao?: ((sessao: SessaoDeTransporte) => void) | undefined;
  /** Relógio de parede em ms, para "calibrado às ...". O padrão é `Date.now`. */
  readonly relogioDeParede?: (() => number) | undefined;
  /** O motivo que vai no `bye` quando o transporte fecha. O padrão é `Ctrl+C`. */
  readonly motivoDoFechamento?: string | undefined;
}

export interface ServidorMontado {
  readonly backend: BackendDeEntrada | undefined;
  /** `undefined` com `CONTROLE_MOVIMENTO=desligado`. */
  readonly pipeline: PipelineDeMovimento | undefined;
  readonly comandos: AtendenteDeComandos;
  readonly acoes: MapeadorDeAcoes;
  /** `true` só quando o destino do movimento (e do clique) é o backend de verdade. */
  readonly cursorDeVerdade: boolean;
  readonly destinoDoCursor: DestinoDoCursor;
  readonly transporte: ServidorDeTransporte;
  readonly ganchos: GanchosDaMontagem;
  /** O estado que o painel mostra. Aloca — ~10 Hz, nunca por pacote. */
  instantaneo(): InstantaneoDaMontagem;
}

/**
 * Monta o servidor inteiro: pipeline, comandos, mapeador de ações, fechamento de sessão, transporte
 * e teclado de vibração — com a soltura de cada peça registrada no encerramento, na ordem certa.
 *
 * É a **única** montagem do projeto: `npm run dev` (`principal.ts`) e `npm run telemetria`
 * (`cli/telemetria.ts`) chamam esta função, e o que difere entre eles entra pelas duas costuras de
 * `OpcoesDaMontagem` (`aoReceberPacote` e `aoEncerrarSessao`), nunca por uma segunda fiação.
 *
 * O transporte já sai **abrindo a porta** (é o comportamento de `criarServidorDeTransporte`); quem
 * chama espera a abertura com `servidor.transporte.ouvir()` e decide o que fazer se ela falhar.
 */
export function montarServidor(opcoes: OpcoesDaMontagem): ServidorMontado {
  const { configuracao, registrador, encerramento, backend, gravador } = opcoes;
  const relogioDeParede = opcoes.relogioDeParede ?? Date.now;

  if (backend !== undefined) {
    const backendAtivo = backend;
    // Registrado **antes** do transporte de propósito: as tarefas rodam em ordem inversa, então a
    // soltura acontece depois de a sessão cair — primeiro para de chegar comando, depois solta o
    // que estava apertado. Nenhum evento novo pode nascer entre uma coisa e outra (regra 5).
    encerramento.registrar('backend de entrada', () => {
      backendAtivo.encerrar();
      registrador.info('backend de entrada solto', {
        eventosEnviados: backendAtivo.contadores.eventosEnviados,
        eventosRecusados: backendAtivo.contadores.eventosRecusados,
        soltasDeSeguranca: backendAtivo.contadores.soltasDeSeguranca,
      });
    });
  }

  if (gravador !== undefined) {
    const aberto = gravador;
    // Registrado antes do transporte: as tarefas rodam em ordem inversa, então o arquivo é
    // fechado **depois** de a última sessão cair — sem amostra perdida no buffer (regra 5).
    encerramento.registrar('gravação da sessão', () => {
      aberto.fechar();
      registrador.info('gravação encerrada', {
        arquivo: aberto.caminho,
        amostras: aberto.amostrasGravadas,
      });
    });
  }

  // Pipeline de movimento (ATI-008). O destino padrão **não** é o cursor de verdade — ver
  // `montarPipeline` e a chave `movimento` da configuração. Os ajustes do giro vêm da configuração
  // (ATI-032), com a tela para converter graus em px/grau.
  const montagem = montarPipeline(
    configuracao.movimento,
    backend,
    registrador.comEscopo('movimento'),
    ajustesDaConfiguracao(configuracao, backend?.tamanhoDaTela()),
  );
  const pipeline = montagem?.pipeline;
  const ensaio = montagem?.ensaio;
  if (ensaio !== undefined) {
    encerramento.registrar('resumo do ensaio de movimento', () => {
      registrador.info('movimento em ensaio — total da execução', { ensaio: ensaio.resumir() });
    });
  }

  // Comandos `cmd` (ATI-009). `cursorDeVerdade` é verdade só quando o destino do movimento é o
  // backend de entrada — `montarPipeline` cai para o ensaio quando `sistema` não tem backend, e é
  // esse fato, não a chave da configuração, que decide se o `centralizar` mexe no cursor.
  const cursorDeVerdade = montagem !== undefined && ensaio === undefined;
  const destinoDoCursor: DestinoDoCursor =
    montagem === undefined ? 'desligado' : cursorDeVerdade ? 'real' : 'ensaio';
  const registradorDosComandos = registrador.comEscopo('comandos');
  // O repositório nasce aqui, e não dentro de `montarComandos`, porque o painel também o lê: é
  // dele que sai a data do bias guardado ("quando foi calibrado").
  const repositorio = (
    opcoes.criarRepositorio ?? (() => criarRepositorioDeBias({ registrador: registradorDosComandos }))
  )();
  const comandos = montarComandos(
    configuracao,
    pipeline,
    backend,
    cursorDeVerdade,
    registradorDosComandos,
    () => repositorio,
  );

  // Mapeador de ações (ATI-010): o BOTÃO e o SCROLL que chegam do celular viram clique, arrastar
  // e scroll. Mesma chave do cursor — no padrão (`ensaio`) nada clica de verdade.
  const acoes = montarMapeadorDeAcoes(backend, cursorDeVerdade, registrador.comEscopo('acoes'));
  if (acoes.ensaio !== undefined) {
    const ensaioDeAcoes = acoes.ensaio;
    encerramento.registrar('resumo do ensaio de ações', () => {
      registrador.info('ações em ensaio — total da execução', { ensaio: ensaioDeAcoes.resumir() });
    });
  }
  const mapeador = acoes.mapeador;

  // O total do processo (ATI-028). Registrado **antes** do transporte, como os resumos de ensaio
  // acima: as tarefas rodam em ordem inversa, então a linha sai depois de a última sessão fechar
  // e somar a conta dela no total.
  encerramento.registrar('total da execução', () => {
    registrarTotalDaExecucao({ pipeline, acoes: mapeador, registrador });
  });

  const fecharSessao = criarFechamentoDeSessao({
    gravador,
    backend,
    pipeline,
    registrador: registrador.comEscopo('movimento'),
    acoes: mapeador,
  });

  /**
   * O que o painel diz do bias em uso. Escrito uma vez por sessão ou por calibração — caminho
   * frio — e lido pelo `instantaneo()`. A origem é deduzida dos contadores do atendente de
   * comandos, antes e depois de cada chamada: o atendente continua sendo o único dono do bias.
   */
  const estadoDoBias = { origem: 'nenhuma' as OrigemDoBias, desdeMs: Number.NaN };
  /** `aplicacoes` da recalibração quando a sessão atual abriu — o que faz o número ser "da sessão". */
  let aplicacoesAntesDaSessao = 0;
  const aoReceberPacoteDoModo = opcoes.aoReceberPacote;
  const aoEncerrarSessaoDoModo = opcoes.aoEncerrarSessao;

  // ⚠️ Caminho quente. Os ganchos são criados **uma vez**: nada de montar função por pacote. O
  // gravador só escreve números num buffer já alocado (ver `cli/captura.ts`), o pipeline não aloca
  // nada por amostra, o `observar` dos comandos escreve em `Float64Array` já alocado, o mapeador
  // de ações só consulta um `Map` e soma números, e o gancho do modo (a telemetria) copia três
  // números para um objeto que já existe.
  const ganchos: GanchosDaMontagem = {
    aoReceberPacote: (pacote, sessao) => {
      gravador?.registrar(pacote);
      comandos.observar(pacote);
      pipeline?.processar(pacote);
      // A sessão vai junto por causa do retorno háptico: é o `click` do botão e o `tick` da
      // detente do scroll voltando para o aparelho (PROTOCOLO.md, seção 5.2).
      mapeador.processar(pacote, sessao);
      aoReceberPacoteDoModo?.(pacote, sessao);
    },

    // `centralizar` e a calibração de bias (ATI-009). Devolver `false` deixa o comando cair na
    // resposta padrão do transporte, que é o que acontece com `trocar-perfil`, `pausar` e
    // `retomar` — eles são de outras atividades.
    aoReceberTexto: (mensagem, sessao) => {
      const concluidasAntes = comandos.contadores.calibracoesConcluidas;
      const respondeu = comandos.tratar(mensagem, sessao);
      if (comandos.contadores.calibracoesConcluidas !== concluidasAntes) {
        estadoDoBias.origem = 'calibracao';
        estadoDoBias.desdeMs = relogioDeParede();
      }
      return respondeu;
    },

    // Sessão adotada: o bias guardado deste aparelho volta para o pipeline antes da primeira
    // amostra, para ninguém precisar recalibrar a cada conexão.
    aoAbrirSessao: (sessao) => {
      const restauradosAntes = comandos.contadores.biasRestaurados;
      comandos.aoAbrirSessao(sessao);
      if (comandos.contadores.biasRestaurados !== restauradosAntes) {
        const idAparelho = sessao.aparelho?.id;
        const guardado = idAparelho === undefined ? undefined : repositorio.ler(idAparelho);
        estadoDoBias.origem = 'guardado';
        estadoDoBias.desdeMs = Date.parse(guardado?.gravadoEm ?? '');
      } else {
        // Aparelho sem bias guardado: o atendente zerou o bias do pipeline (bias é por aparelho, e
        // o pipeline é um só). O que estava escrito aqui era do aparelho anterior.
        estadoDoBias.origem = 'nenhuma';
        estadoDoBias.desdeMs = Number.NaN;
      }
      aplicacoesAntesDaSessao = comandos.recalibracao.contadores.aplicacoes;
    },

    // Fim de sessão descarrega o que sobrou no buffer, guarda o bias efetivo e zera a memória do
    // pipeline: sem isto, quem desconecta o celular encontraria amostras faltando na captura, a
    // calibração pela metade ficaria aberta para a próxima sessão, e a fração de pixel de um
    // aparelho sairia como movimento no primeiro pacote do próximo.
    aoEncerrarSessao: (sessao) => {
      comandos.aoEncerrarSessao(sessao);
      fecharSessao();
      // Os contadores de sessão do pipeline e do mapeador acabaram de voltar a zero; a conta da
      // recalibração acompanha, senão o painel mostraria ajustes "nesta sessão" sem sessão nenhuma.
      aplicacoesAntesDaSessao = comandos.recalibracao.contadores.aplicacoes;
      aoEncerrarSessaoDoModo?.(sessao);
    },
  };

  const transporte = criarServidorDeTransporte({
    host: configuracao.host,
    porta: configuracao.porta,
    taxaHz: configuracao.taxaHz,
    versaoServidor: VERSAO_SERVIDOR,
    registrador: registrador.comEscopo('transporte'),
    // Mesma porta do WebSocket serve a página de diagnóstico (ATI-025): é ela que coloca um
    // giroscópio de verdade contra este servidor enquanto não há app instalado.
    atenderHttp: criarAtendenteDeDiagnostico({ registrador: registrador.comEscopo('diagnostico') }),
    aoReceberPacote: ganchos.aoReceberPacote,
    aoReceberTexto: ganchos.aoReceberTexto,
    aoAbrirSessao: ganchos.aoAbrirSessao,
    aoEncerrarSessao: ganchos.aoEncerrarSessao,
  });
  // Registrado antes de a porta abrir: se a abertura falhar no meio, o caminho de soltura já
  // existe (regra 5 do CLAUDE.md — nada pode ficar aberto sem quem feche).
  encerramento.registrar('servidor de transporte', () =>
    transporte.fechar(opcoes.motivoDoFechamento ?? 'Ctrl+C'),
  );

  // Gatilho de vibração (ATI-025), nos dois modos. Só liga quando a entrada é um terminal — e o
  // desligar é obrigatório: ouvinte de `stdin` segura o event loop e o processo não sairia do
  // Ctrl+C. Registrado depois do transporte, logo roda **antes** dele no encerramento.
  const desligarTeclado = ligarTecladoDeVibracao({
    sessaoAtual: () => transporte.sessaoAtual(),
    registrador: registrador.comEscopo('diagnostico'),
  });
  encerramento.registrar('teclado de vibração', desligarTeclado);

  return {
    backend,
    pipeline,
    comandos,
    acoes: mapeador,
    cursorDeVerdade,
    destinoDoCursor,
    transporte,
    ganchos,

    instantaneo() {
      const recalibracao = comandos.recalibracao;
      const aplicacoes = recalibracao.contadores.aplicacoes;
      const biasAltoGrausPorS = recalibracao.biasAltoGrausPorS;
      const daSessao = mapeador.contadores;
      // `totalDoProcesso()` aloca um objeto por chamada: aqui é uma vez por quadro do painel.
      const total = pipeline?.totalDoProcesso();
      return {
        cursor: destinoDoCursor,
        ajustes: pipeline?.ajustes,
        bias: { origem: estadoDoBias.origem, desdeMs: estadoDoBias.desdeMs },
        recalibracao: {
          ligada: recalibracao.ativo,
          aplicacoesNaSessao: aplicacoes - aplicacoesAntesDaSessao,
          aplicacoesNaExecucao: aplicacoes,
          paradoMs: recalibracao.paradoMs,
          avisoDeBiasAlto:
            biasAltoGrausPorS === undefined ? undefined : textoDoAvisoDeBiasAlto(biasAltoGrausPorS),
        },
        pixels:
          pipeline === undefined || total === undefined
            ? undefined
            : {
                sessaoX: pipeline.contadores.pixelsX,
                sessaoY: pipeline.contadores.pixelsY,
                execucaoX: total.pixelsX,
                execucaoY: total.pixelsY,
              },
        acoes: {
          cliquesNaSessao: daSessao.botoesApertados,
          entalhesVerticaisNaSessao: daSessao.entalhesVerticais,
          entalhesHorizontaisNaSessao: daSessao.entalhesHorizontais,
          presos: mapeador.destino.pressionados(),
        },
        ponteiro: backend?.saidaDoMouse,
      };
    },
  };
}

/**
 * Para onde o movimento e o clique vão, em campos de log — o que as duas partidas dizem quando a
 * porta abre. Um lugar só para as duas não descreverem a mesma montagem com palavras diferentes.
 *
 * Dizer isso no log evita as duas conclusões erradas possíveis no primeiro teste com o celular:
 * "o servidor está quebrado" (quando ele está só em ensaio) e a surpresa contrária, o cursor
 * andando sem que ninguém tenha pedido.
 */
export function descreverDestinos(
  servidor: ServidorMontado,
  configuracao: ConfiguracaoServidor,
): DadosDoLog {
  const { pipeline } = servidor;
  return {
    saida: servidor.backend?.nome ?? 'nenhuma',
    movimento:
      pipeline === undefined ? 'desligado' : `${configuracao.movimento} → ${pipeline.destino.nome}`,
    // Mesma razão da linha de cima, e mais grave: um clique acontece onde o cursor estiver.
    cliques: servidor.cursorDeVerdade
      ? 'CLICAM de verdade'
      : `ensaio (não clicam) → ${servidor.acoes.destino.nome}`,
  };
}
