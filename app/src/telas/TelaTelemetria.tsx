/**
 * Tela de telemetria do **envio** — o outro lado do painel que roda no PC (ATI-006).
 *
 * Responde, no celular, às três perguntas de quem está com o cabo na mão: o que está saindo
 * daqui (gx, gy, gz), a que taxa, e para onde. Sem isso, "o PC não mostra nada" é indistinguível
 * de "o sensor não ligou", "o app não conectou" e "o `adb reverse` não está de pé".
 *
 * Reaproveitamento, em vez de uma segunda medição:
 * - a assinatura do sensor e o `dtMs` medido no nativo vêm do módulo da ATI-003;
 * - a estatística de janela é o mesmo `MedidorDeTaxa` que a tela de medição usa;
 * - o estado da conexão e o botão **Ligar/Desligar** são o `IndicadorDeConexao` (ATI-005), que
 *   fica no topo do app, acima desta tela — dois botões para o mesmo estado só criariam dúvida
 *   sobre qual deles manda.
 *
 * Regra do caminho quente: o callback por amostra só acumula número. Nenhum `setState` por
 * amostra — a interface é redesenhada uma vez por janela.
 *
 * @format
 */

import {useEffect, useMemo, useRef, useState} from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';

import {
  giroscopioDisponivel,
  type AmostraGiroscopio,
  type InfoGiroscopio,
} from '../sensores/giroscopio';
import {MedidorDeTaxa, type ResumoMedicao} from '../sensores/medidorDeTaxa';
import {agoraMs} from '../sensores/relogio';
import {conexaoDoApp} from '../transporte/conexaoDoApp';
import type {SituacaoDaConexao} from '../transporte/conexao';
import {
  iniciarEnvioDeMovimento,
  type ContadoresDeEnvio,
} from '../transporte/envioDeMovimento';

/** Janela de atualização da tela. Meio segundo ainda dá ~50 amostras para a estatística. */
const JANELA_MS = 500;
const RAD_PARA_GRAU = 180 / Math.PI;

const ROTULOS_DE_ESTADO: Record<SituacaoDaConexao['estado'], string> = {
  desconectado: 'desconectado',
  conectando: 'conectando…',
  conectado: 'conectado',
  erro: 'erro',
};

const CONTADORES_ZERADOS: ContadoresDeEnvio = {
  amostras: 0,
  enviados: 0,
  recusados: 0,
  bytes: 0,
  ultimoSeq: 0,
};

export function TelaTelemetria() {
  const escuro = useColorScheme() === 'dark';
  const estilos = escuro ? ESTILOS_ESCUROS : ESTILOS_CLAROS;

  const conexao = conexaoDoApp();
  const medidor = useMemo(() => new MedidorDeTaxa(), []);
  const ultimaAmostra = useRef<AmostraGiroscopio | null>(null);
  const disponivel = giroscopioDisponivel();

  const [enviando, setEnviando] = useState(false);
  const [situacao, setSituacao] = useState<SituacaoDaConexao>(() =>
    conexao.situacao(),
  );
  const [resumo, setResumo] = useState<ResumoMedicao | null>(null);
  const [amostraExibida, setAmostraExibida] =
    useState<AmostraGiroscopio | null>(null);
  const [contadores, setContadores] =
    useState<ContadoresDeEnvio>(CONTADORES_ZERADOS);
  const [info, setInfo] = useState<InfoGiroscopio | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    const cancelar = conexao.assinar(setSituacao);
    // O estado pode ter mudado entre o `useState` inicial e a assinatura.
    setSituacao(conexao.situacao());
    return cancelar;
  }, [conexao]);

  useEffect(() => {
    if (!enviando) {
      return;
    }

    medidor.reiniciar(agoraMs());
    ultimaAmostra.current = null;

    const envio = iniciarEnvioDeMovimento({
      conexao,
      aoReceberAmostra: amostra => {
        // ⚠️ Caminho quente: só guarda a referência e soma no medidor.
        ultimaAmostra.current = amostra;
        medidor.registrar(amostra.dtMs, agoraMs());
      },
      aoIniciar: setInfo,
      aoFalhar: falha => {
        setErro(falha.message);
        setEnviando(false);
      },
    });

    const relogioDaJanela = setInterval(() => {
      setResumo(medidor.fechar(agoraMs()));
      setAmostraExibida(ultimaAmostra.current);
      // Cópia por janela: os contadores do envio são um objeto vivo, e guardar a referência
      // faria o React comparar o objeto com ele mesmo e nunca redesenhar.
      setContadores({...envio.contadores});
    }, JANELA_MS);

    return () => {
      clearInterval(relogioDaJanela);
      // Sensor solto ao sair da tela (regra 5 do CLAUDE.md): o envio não pode continuar de pé
      // sem ninguém olhando, gastando bateria e enchendo o canal.
      envio.parar();
    };
  }, [enviando, conexao, medidor]);

  const alternarEnvio = () => {
    setErro(null);
    if (enviando) {
      setEnviando(false);
      return;
    }
    setResumo(null);
    setAmostraExibida(null);
    setContadores(CONTADORES_ZERADOS);
    setInfo(null);
    setEnviando(true);
  };

  const estiloDoBotao = enviando
    ? estilos.botaoParar
    : disponivel
      ? estilos.botaoIniciar
      : estilos.botaoDesligado;

  return (
    <ScrollView
      style={estilos.tela}
      contentContainerStyle={estilos.conteudo}
      testID="tela-telemetria">
      <Text style={estilos.titulo}>Telemetria do envio</Text>
      <Text style={estilos.subtitulo}>
        O que está saindo deste aparelho para o PC · janela de {JANELA_MS} ms
      </Text>

      {!disponivel && (
        <Text style={estilos.aviso}>
          Módulo nativo não encontrado. É preciso compilar e reinstalar o app.
        </Text>
      )}

      {erro !== null && <Text style={estilos.erro}>{erro}</Text>}

      <Text style={estilos.secao}>Canal</Text>
      <View style={estilos.caixa}>
        <Text style={estilos.detalhe} testID="endereco-em-uso">
          endereço {conexao.url}
        </Text>
        <Text style={estilos.detalhe} testID="estado-da-conexao">
          estado {ROTULOS_DE_ESTADO[situacao.estado]} ·{' '}
          {situacao.servidor?.nome ?? 'PC —'} · sessão{' '}
          {situacao.sessao?.id ?? '—'} · {situacao.pingsRespondidos} pings
        </Text>
        <Text style={estilos.detalhe}>
          {situacao.ultimoErro ?? 'Ligar e Desligar ficam na faixa acima.'}
        </Text>
      </View>

      <Pressable
        onPress={alternarEnvio}
        disabled={!disponivel}
        style={estiloDoBotao}
        testID="botao-envio">
        <Text style={estilos.textoBotao}>
          {enviando ? 'Parar envio' : 'Enviar giroscópio'}
        </Text>
      </Pressable>

      {enviando && situacao.estado !== 'conectado' && (
        <Text style={estilos.aviso}>
          Sem sessão: os pacotes estão sendo recusados até o welcome chegar.
        </Text>
      )}

      <View style={estilos.grade}>
        <Metrica
          estilos={estilos}
          rotulo="Taxa de envio"
          valor={formatar(resumo?.taxaHz, 1)}
          unidade="Hz"
        />
        <Metrica
          estilos={estilos}
          rotulo="Enviados"
          valor={String(contadores.enviados)}
          unidade="pacotes"
        />
        <Metrica
          estilos={estilos}
          rotulo="Recusados"
          valor={String(contadores.recusados)}
          unidade="sem sessão"
        />
        <Metrica
          estilos={estilos}
          rotulo="dt médio"
          valor={formatar(resumo?.dtMedioMs, 2)}
          unidade="ms"
        />
        <Metrica
          estilos={estilos}
          rotulo="dt desvio"
          valor={formatar(resumo?.dtDesvioMs, 2)}
          unidade="ms"
        />
        <Metrica
          estilos={estilos}
          rotulo="Bytes"
          valor={String(contadores.bytes)}
          unidade="no fio"
        />
      </View>

      <Text style={estilos.secao}>Última amostra enviada</Text>
      <View style={estilos.caixa}>
        <Eixo estilos={estilos} nome="gx" valorRadS={amostraExibida?.gx} />
        <Eixo estilos={estilos} nome="gy" valorRadS={amostraExibida?.gy} />
        <Eixo estilos={estilos} nome="gz" valorRadS={amostraExibida?.gz} />
        <Text style={estilos.detalhe}>
          seq {contadores.ultimoSeq} · tDispositivoMs{' '}
          {formatar(amostraExibida?.tDispositivoMs, 1)} · dt{' '}
          {formatar(amostraExibida?.dtMs, 2)} ms
        </Text>
      </View>

      {info !== null && (
        <>
          <Text style={estilos.secao}>Sensor</Text>
          <View style={estilos.caixa}>
            <Text style={estilos.detalhe}>
              {info.nome} · {info.fornecedor}
            </Text>
            <Text style={estilos.detalhe}>
              período pedido {info.periodoUs} µs · mínimo do sensor{' '}
              {info.periodoMinimoUs} µs
            </Text>
          </View>
        </>
      )}
    </ScrollView>
  );
}

type ConjuntoDeEstilos = ReturnType<typeof criarEstilos>;

type PropsMetrica = {
  estilos: ConjuntoDeEstilos;
  rotulo: string;
  valor: string;
  unidade: string;
};

function Metrica({estilos, rotulo, valor, unidade}: PropsMetrica) {
  return (
    <View style={estilos.cartao}>
      <Text style={estilos.rotulo}>{rotulo}</Text>
      <Text style={estilos.valor}>{valor}</Text>
      <Text style={estilos.unidade}>{unidade}</Text>
    </View>
  );
}

type PropsEixo = {
  estilos: ConjuntoDeEstilos;
  nome: string;
  valorRadS: number | undefined;
};

function Eixo({estilos, nome, valorRadS}: PropsEixo) {
  const emGraus =
    valorRadS === undefined ? undefined : valorRadS * RAD_PARA_GRAU;
  return (
    <Text style={estilos.detalhe}>
      {nome} {formatar(valorRadS, 4)} rad/s ({formatar(emGraus, 1)} °/s)
    </Text>
  );
}

function formatar(valor: number | undefined, casas: number): string {
  if (valor === undefined || !Number.isFinite(valor)) {
    return '—';
  }
  return valor.toFixed(casas);
}

function criarEstilos(escuro: boolean) {
  const fundo = escuro ? '#111418' : '#f5f6f8';
  const cartao = escuro ? '#1b2027' : '#ffffff';
  const texto = escuro ? '#eef1f5' : '#12161c';
  const apagado = escuro ? '#93a0b1' : '#5c6773';
  const borda = escuro ? '#2a323c' : '#dfe3e8';

  return StyleSheet.create({
    tela: {
      flex: 1,
      backgroundColor: fundo,
    },
    conteudo: {
      padding: 16,
      gap: 12,
    },
    titulo: {
      fontSize: 22,
      fontWeight: '700',
      color: texto,
    },
    subtitulo: {
      fontSize: 13,
      color: apagado,
    },
    aviso: {
      fontSize: 13,
      color: '#b46b00',
    },
    erro: {
      fontSize: 13,
      color: '#c0392b',
    },
    botaoIniciar: {
      paddingVertical: 14,
      borderRadius: 10,
      alignItems: 'center',
      backgroundColor: '#1f8f4e',
    },
    botaoParar: {
      paddingVertical: 14,
      borderRadius: 10,
      alignItems: 'center',
      backgroundColor: '#c0392b',
    },
    botaoDesligado: {
      paddingVertical: 14,
      borderRadius: 10,
      alignItems: 'center',
      backgroundColor: apagado,
    },
    textoBotao: {
      color: '#ffffff',
      fontSize: 16,
      fontWeight: '600',
    },
    grade: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 10,
    },
    cartao: {
      flexGrow: 1,
      flexBasis: '30%',
      minWidth: 104,
      padding: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: borda,
      backgroundColor: cartao,
    },
    rotulo: {
      fontSize: 11,
      color: apagado,
    },
    valor: {
      fontSize: 22,
      fontWeight: '700',
      color: texto,
    },
    unidade: {
      fontSize: 11,
      color: apagado,
    },
    secao: {
      marginTop: 8,
      fontSize: 15,
      fontWeight: '600',
      color: texto,
    },
    caixa: {
      padding: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: borda,
      backgroundColor: cartao,
      gap: 4,
    },
    detalhe: {
      fontSize: 13,
      color: apagado,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
  });
}

// Criadas uma vez só: trocar de tema não deve recriar folha de estilo a cada renderização.
const ESTILOS_CLAROS = criarEstilos(false);
const ESTILOS_ESCUROS = criarEstilos(true);
