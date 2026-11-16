/**
 * Faixa de estado da conexão com o PC.
 *
 * É o "está ligado?" da fase 1: cor, palavra e, quando o canal cai, quanto falta para a próxima
 * tentativa. Sem isso, "não funcionou" no celular é indistinguível de "o servidor nem subiu".
 *
 * A conexão em si é do app (`conexaoDoApp`), não deste componente: sair da tela não derruba a
 * sessão. O que este arquivo faz é ligar a conexão quando o app aparece e mostrar o estado.
 *
 * @format
 */

import {useEffect, useState} from 'react';
import {Pressable, StyleSheet, Text, View, useColorScheme} from 'react-native';

import {conexaoDoApp} from '../transporte/conexaoDoApp';
import type {EstadoDaConexao, SituacaoDaConexao} from '../transporte/conexao';

const ROTULOS: Record<EstadoDaConexao, string> = {
  desconectado: 'Desconectado',
  conectando: 'Conectando…',
  conectado: 'Conectado',
  erro: 'Erro',
};

const CORES: Record<EstadoDaConexao, string> = {
  desconectado: '#8a94a6',
  conectando: '#b46b00',
  conectado: '#1f8f4e',
  erro: '#c0392b',
};

export function IndicadorDeConexao() {
  const escuro = useColorScheme() === 'dark';
  const estilos = escuro ? ESTILOS_ESCUROS : ESTILOS_CLAROS;
  const conexao = conexaoDoApp();
  const [situacao, setSituacao] = useState<SituacaoDaConexao>(() =>
    conexao.situacao(),
  );

  useEffect(() => {
    const cancelar = conexao.assinar(setSituacao);
    // Estado pode ter mudado entre o `useState` inicial e a assinatura.
    setSituacao(conexao.situacao());
    conexao.conectar();
    // Sem `desconectar` aqui de propósito: a conexão é do app, não desta tela. Desmontar o
    // componente (troca de tela, recarga do Metro) não pode derrubar a sessão do servidor.
    return cancelar;
  }, [conexao]);

  const cor = CORES[situacao.estado];
  const detalhe = descreverDetalhe(situacao);

  return (
    <View style={estilos.faixa} testID="indicador-conexao">
      <View style={[estilos.bolinha, {backgroundColor: cor}]} />
      <View style={estilos.textos}>
        <Text style={estilos.rotulo} testID="rotulo-conexao">
          {ROTULOS[situacao.estado]}
        </Text>
        {detalhe !== null && <Text style={estilos.detalhe}>{detalhe}</Text>}
      </View>
      <Pressable
        onPress={() =>
          situacao.estado === 'conectado'
            ? conexao.desconectar()
            : conexao.conectar()
        }
        style={estilos.botao}
        testID="botao-conexao">
        <Text style={estilos.textoBotao}>
          {situacao.estado === 'conectado' ? 'Desligar' : 'Ligar'}
        </Text>
      </Pressable>
    </View>
  );
}

function descreverDetalhe(situacao: SituacaoDaConexao): string | null {
  if (situacao.estado === 'conectado') {
    const nome = situacao.servidor?.nome ?? 'PC';
    const sessao = situacao.sessao?.id ?? '—';
    return `${nome} · sessão ${sessao} · ${situacao.pingsRespondidos} pings`;
  }
  if (situacao.estado === 'conectando' && situacao.esperaAtualMs !== undefined) {
    const segundos = (situacao.esperaAtualMs / 1000).toFixed(1);
    // Sondagem e escada são esperas com significados diferentes: uma diz "já volta", a outra diz
    // "o PC parece fora do ar". Mostrar as duas iguais faria a faixa mentir sobre a expectativa.
    return situacao.sondando
      ? `procurando o PC · nova tentativa em ${segundos} s`
      : `tentativa ${situacao.tentativas + 1} em ${segundos} s`;
  }
  return situacao.ultimoErro ?? null;
}

function criarEstilos(escuro: boolean) {
  const cartao = escuro ? '#1b2027' : '#ffffff';
  const texto = escuro ? '#eef1f5' : '#12161c';
  const apagado = escuro ? '#93a0b1' : '#5c6773';
  const borda = escuro ? '#2a323c' : '#dfe3e8';

  return StyleSheet.create({
    faixa: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: borda,
      backgroundColor: cartao,
    },
    bolinha: {
      width: 12,
      height: 12,
      borderRadius: 6,
    },
    textos: {
      flex: 1,
    },
    rotulo: {
      fontSize: 14,
      fontWeight: '600',
      color: texto,
    },
    detalhe: {
      fontSize: 12,
      color: apagado,
    },
    botao: {
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: borda,
    },
    textoBotao: {
      fontSize: 13,
      color: texto,
    },
  });
}

// Criadas uma vez só: trocar de tema não deve recriar folha de estilo a cada renderização.
const ESTILOS_CLAROS = criarEstilos(false);
const ESTILOS_ESCUROS = criarEstilos(true);
