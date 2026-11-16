/**
 * Os comandos `cmd` que o aparelho manda pelo quadro de texto (PROTOCOLO.md, seção 3.5).
 *
 * Esta é a ATI-009, e ela entrega dois — os dois que todo perfil com giroscópio precisa ter para
 * ser usável:
 *
 * | Comando | O que faz |
 * |---|---|
 * | `centralizar` | leva o cursor ao centro da tela **e zera o estado guardado do pipeline** |
 * | `calibrar-inicio` / `calibrar-fim` | mede o bias com o aparelho parado e passa a descontá-lo |
 *
 * `trocar-perfil`, `pausar` e `retomar` continuam sem dono e caem na resposta padrão do transporte
 * (`transporte/sessao.ts`): eles são de outras atividades, e responder por eles aqui seria fingir
 * que existem.
 *
 * ## Por que `centralizar` zera o pipeline
 *
 * O cursor salta para o centro, mas a cadeia de movimento guarda memória entre amostras: a média
 * exponencial e a fração de subpixel. Sem zerar as duas, o resíduo do gesto anterior sai **depois**
 * do salto e o cursor escorrega sozinho ao recomeçar — o defeito que a ATI-009 nomeia e que o
 * `pipeline.reiniciar()` existe para evitar (ARQUITETURA.md, seção 3).
 *
 * ## O cursor só anda de verdade em `movimento=sistema`
 *
 * Um comando que salta com o cursor é tão perigoso quanto a cadeia de movimento inteira: com
 * `CONTROLE_MOVIMENTO=ensaio` (o padrão) o `centralizar` faz tudo — calcula o centro, zera o
 * pipeline, responde e vibra — **menos** encostar no cursor de quem está trabalhando na máquina. A
 * resposta diz qual dos dois aconteceu, no campo `cursor` do `resultado`. É a mesma decisão que
 * pôs o destino de ensaio como padrão na ATI-008: ninguém liga o mouse de verdade sem pedir.
 *
 * ## O aviso de bias alto (ATI-029)
 *
 * Quem decide que o bias está alto é a recalibração automática (`movimento/recalibracao.ts`); aqui
 * só se leva a decisão para fora — uma linha de log e o quadro `aviso` com `codigo: "BIAS_ALTO"`
 * para o aparelho (PROTOCOLO.md, seção 3.8), dizendo o nome do comando que resolve. O mesmo texto
 * aparece no painel da telemetria, que o lê pela montagem.
 *
 * ## Estado preso (regra 5 do CLAUDE.md)
 *
 * A coleta de calibração é estado que fica aberto entre dois comandos, e um `calibrar-fim` que
 * nunca chega (cabo arrancado, app fechado com a tela de calibração aberta) a deixaria coletando
 * para sempre. `aoEncerrarSessao` cancela — é o mesmo caminho garantido de soltura que o botão
 * pressionado usa.
 */

import {
  ALVO_DE_AMOSTRAS,
  GRAUS_POR_RADIANO,
  MINIMO_DE_AMOSTRAS,
  criarAjusteAutomaticoDeBias,
  criarCalibracaoDeBias,
  textoDoAvisoDeBiasAlto,
  type AjusteAutomaticoDeBias,
  type CalibracaoDeBias,
  type PipelineDeMovimento,
  type RepositorioDeBias,
} from './movimento/indice.js';
import { enviarHaptico } from './diagnostico/indice.js';
import type { Registrador } from './log.js';
import type {
  Comando,
  MensagemDeTexto,
  NomeDePadraoHaptico,
  PacoteDecodificado,
} from './protocolo/indice.js';
import { centralizarCursor, centroDaTela, type BackendDeEntrada } from './saida/indice.js';
import type { SessaoDeTransporte } from './transporte/indice.js';

/**
 * Diferença de bias, em rad/s, a partir da qual vale a pena regravar o arquivo no fim da sessão.
 *
 * 1e-6 rad/s é ~0,00006 °/s: qualquer coisa acima disso é ajuste de verdade (manual ou automático)
 * e merece atravessar para a próxima conexão; abaixo, é o mesmo número de antes e gravar seria
 * escrever no disco por nada, uma vez por sessão, para sempre.
 */
export const DIFERENCA_MINIMA_PARA_GRAVAR = 1e-6;

/**
 * Amostras **da sessão** a partir das quais vale a pena cobrar um ajuste da recalibração.
 *
 * 6000 são 60 s a 100 Hz. Abaixo disso, "nenhuma janela de ajuste" não diz nada — a sessão foi
 * curta demais para o aparelho ter ficado 3 s parado. Acima, o resumo de fim de sessão fica dito
 * com todas as letras: é a diferença entre uma recalibração que trabalhou e uma que só olhou.
 */
export const AMOSTRAS_PARA_COBRAR_AJUSTE = 6000;

/** Os comandos que esta atividade responde. O resto cai na resposta padrão do transporte. */
export const COMANDOS_ATENDIDOS: readonly Comando[] = Object.freeze([
  'centralizar',
  'calibrar-inicio',
  'calibrar-fim',
]);

/** Diagnóstico do atendente. Objeto mutável reaproveitado. */
export interface ContadoresDosComandos {
  centralizados: number;
  centralizacoesRecusadas: number;
  calibracoesPedidas: number;
  calibracoesConcluidas: number;
  calibracoesRecusadas: number;
  /** Sessões que abriram com bias guardado deste aparelho e o receberam de volta. */
  biasRestaurados: number;
  /** Gravações de bias no fim da sessão (manual ou vindo do ajuste automático). */
  biasGravados: number;
}

export function criarContadoresDosComandos(): ContadoresDosComandos {
  return {
    centralizados: 0,
    centralizacoesRecusadas: 0,
    calibracoesPedidas: 0,
    calibracoesConcluidas: 0,
    calibracoesRecusadas: 0,
    biasRestaurados: 0,
    biasGravados: 0,
  };
}

export interface AtendenteDeComandos {
  readonly contadores: ContadoresDosComandos;
  readonly calibracao: CalibracaoDeBias;
  readonly recalibracao: AjusteAutomaticoDeBias;

  /**
   * Ponto de extensão `aoReceberTexto` do transporte. `true` = "eu respondi".
   *
   * Mensagem que não é `cmd`, e `cmd` de comando que não é desta atividade, devolvem `false`.
   */
  tratar(mensagem: MensagemDeTexto, sessao: SessaoDeTransporte): boolean;
  /** ⚠️ Caminho quente. Alimenta a coleta de calibração e o ajuste automático. */
  observar(pacote: PacoteDecodificado): void;
  /** Sessão adotada: devolve ao pipeline o bias guardado deste aparelho, se houver. */
  aoAbrirSessao(sessao: SessaoDeTransporte): void;
  /** Fim de sessão: cancela coleta aberta e guarda o bias efetivo quando ele mudou. */
  aoEncerrarSessao(sessao: SessaoDeTransporte): void;
}

export interface OpcoesDoAtendenteDeComandos {
  /**
   * O pipeline de movimento. `undefined` com `CONTROLE_MOVIMENTO=desligado` — e aí os dois
   * comandos são recusados com o motivo dito, em vez de responderem `cmd-ok` sem fazer nada.
   */
  readonly pipeline?: PipelineDeMovimento | undefined;
  /** Backend de entrada; `undefined` quando não há saída nesta máquina. */
  readonly backend?: BackendDeEntrada | undefined;
  /** `true` só quando o destino do movimento é o backend de verdade (`movimento=sistema`). */
  readonly cursorDeVerdade?: boolean | undefined;
  /** Onde o bias por aparelho é guardado. Sem repositório, o bias vale só na sessão. */
  readonly repositorio?: RepositorioDeBias | undefined;
  readonly calibracao?: CalibracaoDeBias | undefined;
  readonly recalibracao?: AjusteAutomaticoDeBias | undefined;
  /**
   * Se o ajuste automático montado **por omissão** nasce ligado (configuração `recalibracao`).
   *
   * Só vale quando `recalibracao` não é passado: quem entrega o próprio ajuste já decidiu isso na
   * montagem dele. Existe para o construtor não ter um padrão que ignora a configuração — quem
   * montar o atendente sem passar as duas coisas ligaria o mecanismo mesmo com
   * `CONTROLE_RECALIBRACAO=desligada`, que é armadilha para o próximo chamador.
   */
  readonly recalibracaoLigada?: boolean | undefined;
  readonly registrador?: Registrador | undefined;
  /** Envio do háptico; o padrão é o `enviarHaptico` da página de diagnóstico (ATI-025). */
  readonly haptico?:
    | ((sessao: SessaoDeTransporte, padrao: NomeDePadraoHaptico) => boolean)
    | undefined;
}

export function criarAtendenteDeComandos(
  opcoes: OpcoesDoAtendenteDeComandos = {},
): AtendenteDeComandos {
  const pipeline = opcoes.pipeline;
  const backend = opcoes.backend;
  const cursorDeVerdade = opcoes.cursorDeVerdade ?? false;
  const repositorio = opcoes.repositorio;
  const registrador = opcoes.registrador;
  const calibracao = opcoes.calibracao ?? criarCalibracaoDeBias();
  const recalibracao =
    opcoes.recalibracao ??
    criarAjusteAutomaticoDeBias({
      // Sem pipeline não há bias a ajustar; a chave da configuração manda no resto.
      ativo: (opcoes.recalibracaoLigada ?? true) && pipeline !== undefined,
      aplicar: (gx, gy, gz) => {
        pipeline?.definirBias(gx, gy, gz);
      },
      aoReplantar: (gx, gy, gz, tinhaEstimativa) => {
        registrarReplantio(gx, gy, gz, tinhaEstimativa);
      },
      aoMudarAvisoDeBiasAlto: (grausPorS) => {
        avisarBiasAlto(grausPorS);
      },
    });
  const haptico = opcoes.haptico ?? enviarHaptico;
  const contadores = criarContadoresDosComandos();

  /**
   * A sessão que recebe o quadro `aviso` (ATI-029). É a sessão **adotada** — guardada em
   * `aoAbrirSessao` e solta em `aoEncerrarSessao` —, porque o aviso nasce dentro do `observar`, que
   * não carrega sessão nenhuma: passar a sessão por pacote só para um quadro que sai a cada vários
   * segundos seria pagar no caminho quente o que se resolve no frio.
   */
  let sessaoDoAviso: SessaoDeTransporte | undefined;
  /** O texto que está na tela do aparelho agora; `undefined` = nenhum aviso aceso. */
  let avisoNaTela: string | undefined;

  /**
   * O aviso de bias alto mudou (ATI-029): uma linha de log na passagem e o quadro `aviso` para o
   * aparelho (PROTOCOLO.md, seção 3.8).
   *
   * Não é caminho quente: o módulo só chama isto ao acender (no máximo uma vez a cada 2 s de
   * leitura sustentada), ao confirmar com uma sequência nova e ao apagar. A confirmação que não
   * muda o texto — o mesmo sensor medindo o mesmo bias — não vira quadro nem log: o aparelho já
   * está mostrando aquilo.
   */
  function avisarBiasAlto(grausPorS: number | undefined): void {
    const texto = grausPorS === undefined ? undefined : textoDoAvisoDeBiasAlto(grausPorS);
    if (texto === avisoNaTela) return;
    const acendeu = avisoNaTela === undefined;
    avisoNaTela = texto;

    if (texto === undefined) {
      registrador?.info('recalibração: bias alto resolvido — o aviso saiu da tela');
      sessaoDoAviso?.enviarTexto({ t: 'aviso', codigo: 'BIAS_ALTO', ativo: false });
      return;
    }
    if (acendeu) {
      // Aviso, e não info: é o caso em que o cursor está andando sozinho agora, e o log é onde
      // quem não está olhando a tela do aparelho vai procurar o porquê.
      registrador?.aviso('recalibração: bias alto detectado — o cursor anda sozinho até sincronizar', {
        grausPorS: grausPorS?.toFixed(2),
        oQueFazer: 'apoie o aparelho e mande sincronizar',
      });
    }
    sessaoDoAviso?.enviarTexto({ t: 'aviso', codigo: 'BIAS_ALTO', ativo: true, mensagem: texto });
  }

  /**
   * Uma linha de log quando o ajuste automático replanta a estimativa.
   *
   * Não é caminho quente: o replantio só pode acontecer depois de 2 s de leitura sustentada, ou
   * seja, no máximo uma vez a cada 2 s. E é o que torna visível, com o celular na mão, a saída de
   * um impasse que antes era silenciosa (rodada 2 da ATI-009).
   */
  function registrarReplantio(
    gx: number,
    gy: number,
    gz: number,
    tinhaEstimativa: boolean,
  ): void {
    registrador?.info(
      tinhaEstimativa
        ? 'recalibração: a estimativa não correspondia mais à leitura e foi replantada'
        : 'recalibração: primeira estimativa da sessão, medida na própria leitura',
      {
        biasGrausPorS:
          `${(gx * GRAUS_POR_RADIANO).toFixed(3)}/${(gy * GRAUS_POR_RADIANO).toFixed(3)}/` +
          `${(gz * GRAUS_POR_RADIANO).toFixed(3)}`,
      },
    );
  }

  /**
   * O que já foi contado em resumos anteriores — o que permite o resumo sair **por sessão**.
   *
   * Os contadores do módulo são acumulados do processo (ele não os zera em `esquecer`), e o resumo
   * sai no fim de cada sessão: sem esta diferença, a segunda conexão repetiria os números da
   * primeira somados aos novos e nada seria atribuível à sessão que acabou de fechar. Objeto
   * mutável, reaproveitado — ele é escrito uma vez por sessão.
   */
  const jaResumido = {
    amostras: 0,
    interrupcoes: 0,
    janelasDeAjuste: 0,
    aplicacoes: 0,
    replantios: 0,
    replantiosAdiados: 0,
    replantiosRecusados: 0,
  };

  /**
   * O que o ajuste automático fez **nesta sessão** — uma vez, no fim dela.
   *
   * Os contadores existiam desde a rodada 1 e ninguém os lia: o servidor anunciava
   * `recalibracao=ligada` na partida e não havia como saber se ela chegou a ajustar alguma coisa.
   */
  function registrarResumoDaRecalibracao(): void {
    if (registrador === undefined || !recalibracao.ativo) return;
    const numeros = recalibracao.contadores;

    const amostras = numeros.amostrasObservadas - jaResumido.amostras;
    if (amostras === 0) return;
    const interrupcoes = numeros.interrupcoes - jaResumido.interrupcoes;
    const janelasDeAjuste = numeros.janelasDeAjuste - jaResumido.janelasDeAjuste;
    const aplicacoes = numeros.aplicacoes - jaResumido.aplicacoes;
    const replantios = numeros.replantios - jaResumido.replantios;
    const replantiosAdiados = numeros.replantiosAdiados - jaResumido.replantiosAdiados;
    const replantiosRecusados = numeros.replantiosRecusados - jaResumido.replantiosRecusados;

    jaResumido.amostras = numeros.amostrasObservadas;
    jaResumido.interrupcoes = numeros.interrupcoes;
    jaResumido.janelasDeAjuste = numeros.janelasDeAjuste;
    jaResumido.aplicacoes = numeros.aplicacoes;
    jaResumido.replantios = numeros.replantios;
    jaResumido.replantiosAdiados = numeros.replantiosAdiados;
    jaResumido.replantiosRecusados = numeros.replantiosRecusados;

    registrador.info('recalibração automática — nesta sessão', {
      amostras,
      interrupcoes,
      janelasDeAjuste,
      aplicacoes,
      replantios,
      replantiosAdiados,
      ajustou:
        janelasDeAjuste > 0
          ? 'sim'
          : amostras < AMOSTRAS_PARA_COBRAR_AJUSTE
            ? 'ainda não (sessão curta)'
            : 'NÃO — o aparelho nunca ficou 3 s parado',
    });

    // O aviso só ajuda quem **nunca** conseguiu ajustar nada: `replantiosRecusados` sobe uma vez a
    // cada leitura sustentada acima do teto de módulo, e girar o aparelho acima do teto é o uso
    // normal do controle. Numa sessão saudável ele subiria junto com as janelas de ajuste, e
    // mandar "apoie o aparelho e sincronize" para quem está com tudo funcionando é ruído.
    if (replantiosRecusados > 0 && janelasDeAjuste === 0 && replantios === 0) {
      registrador.aviso('recalibração: nunca conseguiu medir bias nesta sessão', {
        recusasPorModulo: replantiosRecusados,
        oQueFazer: 'apoie o aparelho numa superfície firme e mande sincronizar',
      });
    }
  }

  function responderOk(
    sessao: SessaoDeTransporte,
    comando: Comando,
    resultado: Readonly<Record<string, unknown>>,
  ): boolean {
    sessao.enviarTexto({ t: 'cmd-ok', comando, resultado });
    haptico(sessao, 'sucesso');
    return true;
  }

  function responderErro(sessao: SessaoDeTransporte, comando: Comando, motivo: string): boolean {
    sessao.enviarTexto({ t: 'cmd-erro', comando, motivo });
    haptico(sessao, 'erro');
    return true;
  }

  /** Motivo comum às duas recusas por falta de pipeline — uma frase só, num lugar só. */
  function motivoSemPipeline(): string {
    return 'o movimento está desligado nesta execução do servidor (CONTROLE_MOVIMENTO=desligado).';
  }

  function centralizar(sessao: SessaoDeTransporte): boolean {
    if (pipeline === undefined) {
      contadores.centralizacoesRecusadas += 1;
      return responderErro(sessao, 'centralizar', motivoSemPipeline());
    }
    if (backend === undefined) {
      contadores.centralizacoesRecusadas += 1;
      return responderErro(
        sessao,
        'centralizar',
        'não há backend de entrada nesta máquina: o cursor não pode ser posicionado.',
      );
    }

    // Em `ensaio` o centro é calculado e **não** é aplicado: o resto do comando (zerar o pipeline,
    // responder, vibrar) acontece igual. Ver o cabeçalho deste arquivo.
    const centro = cursorDeVerdade ? centralizarCursor(backend) : centroDaTela(backend);
    if (centro === undefined) {
      contadores.centralizacoesRecusadas += 1;
      return responderErro(
        sessao,
        'centralizar',
        'o sistema não informou o tamanho da tela; não dá para saber onde é o centro.',
      );
    }

    // O salto do cursor sem este `reiniciar()` é o defeito que a ATI-009 nomeia: a média
    // exponencial e a fração de subpixel guardam o gesto anterior, e ele sairia **depois** do
    // salto — o cursor escorrega ao recomeçar.
    pipeline.reiniciar();
    contadores.centralizados += 1;
    registrador?.info('centralizar', {
      x: centro.x,
      y: centro.y,
      cursor: cursorDeVerdade ? 'movido' : 'ensaio (não se move)',
    });
    return responderOk(sessao, 'centralizar', {
      x: centro.x,
      y: centro.y,
      cursor: cursorDeVerdade ? 'movido' : 'ensaio',
    });
  }

  function calibrarInicio(sessao: SessaoDeTransporte): boolean {
    if (pipeline === undefined) {
      contadores.calibracoesRecusadas += 1;
      return responderErro(sessao, 'calibrar-inicio', motivoSemPipeline());
    }
    calibracao.iniciar();
    contadores.calibracoesPedidas += 1;
    registrador?.info('calibração de bias iniciada', {
      aparelho: sessao.aparelho?.id ?? '—',
    });
    // Sem háptico aqui: o retorno háptico declarado na ATI-009 é `sucesso` ao concluir e `erro` ao
    // recusar. Vibrar no começo competiria com a própria coleta — o motor sacudindo o aparelho é
    // exatamente o movimento que a calibração precisa não ter.
    // O `resultado` diz por quanto tempo segurar parado — é o que o cliente precisa para decidir
    // quando mandar o `calibrar-fim` sem ter esse número escrito à mão do lado de lá.
    sessao.enviarTexto({
      t: 'cmd-ok',
      comando: 'calibrar-inicio',
      resultado: { minimoDeAmostras: MINIMO_DE_AMOSTRAS, alvoDeAmostras: ALVO_DE_AMOSTRAS },
    });
    return true;
  }

  function calibrarFim(sessao: SessaoDeTransporte): boolean {
    if (pipeline === undefined) {
      contadores.calibracoesRecusadas += 1;
      return responderErro(sessao, 'calibrar-fim', motivoSemPipeline());
    }

    const resultado = calibracao.finalizar();
    if (!resultado.ok) {
      contadores.calibracoesRecusadas += 1;
      registrador?.aviso('calibração de bias recusada', {
        motivo: resultado.motivo,
        amostras: resultado.amostras,
      });
      return responderErro(sessao, 'calibrar-fim', resultado.mensagem);
    }

    const bias = resultado.bias;
    pipeline.definirBias(bias.gx, bias.gy, bias.gz);
    // A estimativa do ajuste automático parte do bias que acabou de ser medido: sem isso, ela
    // continuaria seguindo o valor antigo e desfaria a calibração devagar.
    recalibracao.semear(bias.gx, bias.gy, bias.gz);

    const idAparelho = sessao.aparelho?.id;
    const guardado =
      idAparelho === undefined ? false : (repositorio?.gravar(idAparelho, bias, resultado.amostras) ?? false);
    if (guardado) contadores.biasGravados += 1;

    contadores.calibracoesConcluidas += 1;
    registrador?.info('calibração de bias concluída', {
      aparelho: idAparelho ?? '—',
      amostras: resultado.amostras,
      descartadas: resultado.descartadas,
      biasRadPorS: `${bias.gx.toFixed(5)}/${bias.gy.toFixed(5)}/${bias.gz.toFixed(5)}`,
      dispersaoGrausPorS: resultado.dispersaoGrausPorS.toFixed(3),
      duracaoMs: Math.round(resultado.duracaoMs),
      guardado,
    });

    return responderOk(sessao, 'calibrar-fim', {
      // A forma do exemplo da seção 3.5 do PROTOCOLO.md, letra por letra.
      bias: [bias.gx, bias.gy, bias.gz],
      amostras: resultado.amostras,
      descartadas: resultado.descartadas,
      dispersaoGrausPorS: Number(resultado.dispersaoGrausPorS.toFixed(3)),
      guardado,
    });
  }

  return {
    contadores,
    calibracao,
    recalibracao,

    tratar(mensagem, sessao) {
      if (mensagem.t !== 'cmd') return false;
      switch (mensagem.comando) {
        case 'centralizar':
          return centralizar(sessao);
        case 'calibrar-inicio':
          return calibrarInicio(sessao);
        case 'calibrar-fim':
          return calibrarFim(sessao);
        default:
          // `trocar-perfil`, `pausar`, `retomar`: sem dono nesta atividade.
          return false;
      }
    },

    observar(pacote) {
      calibracao.registrar(pacote);
      recalibracao.observar(pacote);
    },

    aoAbrirSessao(sessao) {
      sessaoDoAviso = sessao;
      if (pipeline === undefined) return;
      const idAparelho = sessao.aparelho?.id;
      const guardado =
        idAparelho === undefined ? undefined : repositorio?.ler(idAparelho);

      if (guardado === undefined) {
        // **Bias é por aparelho, e o pipeline é um só.** Um aparelho novo que entrasse sem zerar
        // herdaria o bias do anterior — e sairia com o cursor caminhando sozinho, exatamente o
        // defeito que a calibração existe para evitar. Sem bias guardado, começa-se do zero.
        pipeline.definirBias(0, 0, 0);
        recalibracao.esquecer();
        registrador?.depuracao('sem bias guardado para este aparelho: começando do zero', {
          aparelho: idAparelho ?? '—',
        });
        return;
      }
      pipeline.definirBias(guardado.gx, guardado.gy, guardado.gz);
      recalibracao.semear(guardado.gx, guardado.gy, guardado.gz);
      contadores.biasRestaurados += 1;
      registrador?.info('bias guardado devolvido ao pipeline', {
        aparelho: idAparelho,
        biasRadPorS: `${guardado.gx.toFixed(5)}/${guardado.gy.toFixed(5)}/${guardado.gz.toFixed(5)}`,
        medidoEm: guardado.gravadoEm === '' ? '—' : guardado.gravadoEm,
      });
    },

    aoEncerrarSessao(sessao) {
      // Primeiro de tudo: o `esquecer()` do fim desta função apaga o aviso de bias alto, e o
      // quadro de "apagou" não tem para onde ir numa sessão que está fechando. Só a sessão que
      // está saindo é solta — fim atrasado de uma sessão velha não cala a nova.
      if (sessaoDoAviso === sessao) sessaoDoAviso = undefined;

      // Coleta aberta que ninguém fechou: cancelar aqui é o que impede a próxima sessão de
      // encontrar uma calibração pela metade esperando por um `calibrar-fim` que já não vem.
      calibracao.cancelar();

      const idAparelho = sessao.aparelho?.id;
      if (pipeline !== undefined && repositorio !== undefined && idAparelho !== undefined) {
        const atual = pipeline.ajustes;
        const guardado = repositorio.ler(idAparelho);
        const anteriorGx = guardado?.gx ?? 0;
        const anteriorGy = guardado?.gy ?? 0;
        const anteriorGz = guardado?.gz ?? 0;
        const mudou =
          Math.abs(atual.biasGxRadPorS - anteriorGx) > DIFERENCA_MINIMA_PARA_GRAVAR ||
          Math.abs(atual.biasGyRadPorS - anteriorGy) > DIFERENCA_MINIMA_PARA_GRAVAR ||
          Math.abs(atual.biasGzRadPorS - anteriorGz) > DIFERENCA_MINIMA_PARA_GRAVAR;
        // Guardar o bias do **fim** da sessão é o que faz a correção térmica do ajuste automático
        // atravessar para a próxima conexão: sem isto, cada reconexão voltaria ao bias frio.
        if (mudou) {
          const gravou = repositorio.gravar(
            idAparelho,
            {
              gx: atual.biasGxRadPorS,
              gy: atual.biasGyRadPorS,
              gz: atual.biasGzRadPorS,
            },
            guardado?.amostras ?? 0,
          );
          if (gravou) {
            contadores.biasGravados += 1;
            registrador?.info('bias guardado no fim da sessão', {
              aparelho: idAparelho,
              biasRadPorS:
                `${atual.biasGxRadPorS.toFixed(5)}/${atual.biasGyRadPorS.toFixed(5)}/` +
                `${atual.biasGzRadPorS.toFixed(5)}`,
            });
          }
        }
      }

      // Antes de esquecer, dizer o que ela fez: é a única visibilidade do mecanismo que trabalha
      // sozinho, e é ela que separa "ajustou" de "olhou a sessão inteira e não ajustou nada".
      registrarResumoDaRecalibracao();

      // O próximo aparelho é outro sensor, com outro bias: a estimativa do ajuste automático não
      // pode atravessar a troca (o bias em si atravessa pelo arquivo, que é por aparelho).
      recalibracao.esquecer();
    },
  };
}
