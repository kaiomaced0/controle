/**
 * Raiz do app Controle.
 *
 * Na fase 1 o app tem duas telas, que respondem a perguntas diferentes:
 * - **Medição** (ATI-003): a leitura do giroscópio sustenta ~100 Hz com jitter baixo?
 * - **Envio** (ATI-006): o que está saindo daqui para o PC, e a que taxa?
 *
 * A faixa de conexão fica acima das duas: o estado do canal — e o botão de ligar e desligar —
 * precisa estar visível o tempo todo, e não escondido dentro de uma das telas (ATI-005).
 *
 * @format
 */

import {useMemo, useState} from 'react';
import {
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import {IndicadorDeConexao} from './src/telas/IndicadorDeConexao';
import {TelaGiroscopio} from './src/telas/TelaGiroscopio';
import {TelaTelemetria} from './src/telas/TelaTelemetria';

const ABAS = [
  {id: 'medicao', rotulo: 'Medição'},
  {id: 'envio', rotulo: 'Envio'},
] as const;

type Aba = (typeof ABAS)[number]['id'];

function App() {
  const modoEscuro = useColorScheme() === 'dark';

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={modoEscuro ? 'light-content' : 'dark-content'} />
      <ConteudoDoApp />
    </SafeAreaProvider>
  );
}

function ConteudoDoApp() {
  const margens = useSafeAreaInsets();
  const escuro = useColorScheme() === 'dark';
  const estilos = escuro ? ESTILOS_ESCUROS : ESTILOS_CLAROS;
  const [aba, setAba] = useState<Aba>('medicao');

  const estiloDaArea = useMemo(
    () => [
      estilos.area,
      {paddingTop: margens.top, paddingBottom: margens.bottom},
    ],
    [estilos.area, margens.top, margens.bottom],
  );

  return (
    <View style={estiloDaArea}>
      {/* A faixa de conexão fica acima das telas: o estado do canal precisa estar visível o
          tempo todo, e não escondido dentro de uma delas (ATI-005). */}
      <IndicadorDeConexao />
      <View style={estilos.abas}>
        {ABAS.map(({id, rotulo}) => {
          const ativa = id === aba;
          return (
            <Pressable
              key={id}
              onPress={() => setAba(id)}
              style={ativa ? estilos.abaAtiva : estilos.aba}
              testID={`aba-${id}`}>
              <Text style={ativa ? estilos.textoAbaAtiva : estilos.textoAba}>
                {rotulo}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {/* Uma tela por vez, de propósito: as duas assinam o giroscópio, e mantê-las montadas
          juntas deixaria o sensor ligado para quem nem está olhando. */}
      {aba === 'medicao' ? <TelaGiroscopio /> : <TelaTelemetria />}
    </View>
  );
}

function criarEstilos(escuro: boolean) {
  const cartao = escuro ? '#1b2027' : '#ffffff';
  const texto = escuro ? '#eef1f5' : '#12161c';
  const borda = escuro ? '#2a323c' : '#dfe3e8';

  return StyleSheet.create({
    area: {
      flex: 1,
    },
    abas: {
      flexDirection: 'row',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: borda,
      backgroundColor: cartao,
    },
    aba: {
      paddingVertical: 6,
      paddingHorizontal: 14,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: borda,
    },
    abaAtiva: {
      paddingVertical: 6,
      paddingHorizontal: 14,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: '#2f6fed',
      backgroundColor: '#2f6fed',
    },
    textoAba: {
      fontSize: 13,
      color: texto,
    },
    textoAbaAtiva: {
      fontSize: 13,
      fontWeight: '600',
      color: '#ffffff',
    },
  });
}

// Criadas uma vez só: trocar de tema não deve recriar folha de estilo a cada renderização.
const ESTILOS_CLAROS = criarEstilos(false);
const ESTILOS_ESCUROS = criarEstilos(true);

export default App;
