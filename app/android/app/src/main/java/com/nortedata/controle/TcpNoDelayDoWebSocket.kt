/*
 * Lado do celular do `TCP_NODELAY` — o item "obrigatório nos dois lados" da seção 1 do
 * PROTOCOLO.md.
 *
 * No PC isso é uma linha (`socketCru.setNoDelay(true)`, em `server/src/transporte/sessao.ts`).
 * Aqui não dá para fazer pelo JavaScript: o `WebSocket` do React Native não expõe o socket TCP.
 * O caminho real é este arquivo — o `WebSocketModule` monta o cliente a partir de
 * `OkHttpClientProvider.getOkHttpClient()` e aplica por cima o `CustomClientBuilder` registrado
 * aqui, então trocar a `SocketFactory` é o ponto em que dá para pegar o socket antes de conectar.
 *
 * Por que importa: o fluxo do controle é de 24 bytes a 100 Hz. O algoritmo de Nagle segura pacote
 * pequeno enquanto houver dado sem ACK e, casado com o ACK atrasado do outro lado, custa dezenas
 * de milissegundos — atraso puro no cursor, no eixo em que esta fase inteira está apostando.
 */

package com.nortedata.controle

import android.util.Log
import com.facebook.react.modules.network.CustomClientBuilder
import com.facebook.react.modules.websocket.WebSocketModule
import java.net.InetAddress
import java.net.Socket
import java.net.SocketException
import javax.net.SocketFactory

/** Etiqueta do logcat: `adb logcat -s ControleTransporte` mostra só o que sai daqui. */
private const val ETIQUETA = "ControleTransporte"

/**
 * Contadores do transporte no lado nativo.
 *
 * Existe pelo mesmo motivo do `noDelayAplicado` do servidor: "obrigatório nos dois lados" só vale
 * como garantia se der para provar que aconteceu — e nem o OkHttp nem o `Socket` guardam isso.
 */
object DiagnosticoDoTransporte {
  /** Sockets que subiram com `TCP_NODELAY` confirmado na releitura. */
  @Volatile
  var socketsComTcpNoDelay: Int = 0
    private set

  /** Sockets em que o ajuste falhou ou não pegou — se isto crescer, o Nagle continua ligado. */
  @Volatile
  var falhasDeTcpNoDelay: Int = 0
    private set

  internal fun contarSocketAjustado() {
    socketsComTcpNoDelay += 1
  }

  internal fun contarFalha() {
    falhasDeTcpNoDelay += 1
  }
}

/**
 * `SocketFactory` que devolve todo socket com `TCP_NODELAY` ligado.
 *
 * O OkHttp usa a variante sem argumento (socket ainda desconectado) e conecta depois; as outras
 * quatro são as abstratas de [SocketFactory] e existem para o contrato ficar completo.
 */
private class FabricaDeSocketSemNagle : SocketFactory() {

  override fun createSocket(): Socket = semNagle(Socket())

  override fun createSocket(maquina: String?, porta: Int): Socket = semNagle(Socket(maquina, porta))

  override fun createSocket(
      maquina: String?,
      porta: Int,
      enderecoLocal: InetAddress?,
      portaLocal: Int,
  ): Socket = semNagle(Socket(maquina, porta, enderecoLocal, portaLocal))

  override fun createSocket(endereco: InetAddress?, porta: Int): Socket =
      semNagle(Socket(endereco, porta))

  override fun createSocket(
      endereco: InetAddress?,
      porta: Int,
      enderecoLocal: InetAddress?,
      portaLocal: Int,
  ): Socket = semNagle(Socket(endereco, porta, enderecoLocal, portaLocal))

  private fun semNagle(socket: Socket): Socket {
    try {
      socket.tcpNoDelay = true
      // Releitura de propósito: garantia que ninguém confere é promessa, não garantia.
      if (socket.tcpNoDelay) {
        val jaConfirmados = DiagnosticoDoTransporte.socketsComTcpNoDelay
        DiagnosticoDoTransporte.contarSocketAjustado()
        // Uma linha só, na primeira vez: log por socket viraria log por reconexão.
        if (jaConfirmados == 0) {
          Log.i(ETIQUETA, "TCP_NODELAY ligado nos WebSockets do app (Nagle desligado).")
        }
      } else {
        DiagnosticoDoTransporte.contarFalha()
        Log.w(ETIQUETA, "TCP_NODELAY não pegou neste socket: o Nagle continua ligado.")
      }
    } catch (erro: SocketException) {
      // Falhar aqui não pode derrubar a conexão: sem TCP_NODELAY o controle fica lento, não morto.
      DiagnosticoDoTransporte.contarFalha()
      Log.w(ETIQUETA, "falhei ao ligar TCP_NODELAY: ${erro.message}")
    }
    return socket
  }
}

/**
 * Registra a fábrica no `WebSocketModule`.
 *
 * Chamada no `onCreate` do `MainApplication`, **antes** de o React Native subir: o cliente do
 * WebSocket é montado na primeira conexão pedida pelo JS, e o registro precisa já estar de pé.
 *
 * Só os WebSockets são afetados, de propósito: o resto da rede do app (HTTP, Metro) não tem fluxo
 * de 100 Hz e não ganha nada com a troca.
 */
fun instalarTcpNoDelayNosWebSockets() {
  WebSocketModule.setCustomClientBuilder(
      CustomClientBuilder { construtor -> construtor.socketFactory(FabricaDeSocketSemNagle()) }
  )
}
