package com.nortedata.controle

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule
import kotlin.math.roundToInt

/** Nome pelo qual o JS pede o módulo: `NativeModules.Giroscopio`. */
const val NOME_MODULO_GIROSCOPIO: String = "Giroscopio"

/** Nome do evento no `RCTDeviceEventEmitter`, que é um espaço de nomes global do app inteiro. */
const val EVENTO_AMOSTRA_GIROSCOPIO: String = "controleGiroscopioAmostra"

/**
 * Falha que **não** nasce de uma chamada do JS e por isso não tem promessa para rejeitar: hoje, só
 * o religar automático depois do segundo plano. Sem este evento a leitura pararia calada, com o JS
 * ainda achando que mede.
 */
const val EVENTO_FALHA_GIROSCOPIO: String = "controleGiroscopioFalha"

/**
 * Leitura do giroscópio do aparelho, uma amostra por evento do sensor.
 *
 * O módulo é burro de propósito: entrega `gx`, `gy`, `gz` crus em rad/s, o carimbo de tempo
 * monotônico do próprio evento e o intervalo real medido entre amostras. Filtragem, calibração de
 * bias e sensibilidade são responsabilidade do servidor (ADR-4 da ARQUITETURA.md).
 *
 * O `dtMs` é calculado aqui, no lado nativo, porque só aqui existe o `SensorEvent.timestamp` — o
 * relógio monotônico em nanossegundos do próprio evento. Medir o intervalo no JS embutiria o
 * atraso da ponte no número, que é justamente o que esta atividade quer separar.
 *
 * Cada registro no `SensorManager` cria um [CicloDeLeitura] novo, e o carimbo da amostra anterior
 * mora dentro dele. Assim, o estado do intervalo nasce zerado a cada religada e um evento atrasado
 * do ciclo anterior (o `SensorManager` pode entregar eventos já enfileirados depois do
 * `unregisterListener`) não tem como escrever no ciclo que está valendo.
 */
@ReactModule(name = NOME_MODULO_GIROSCOPIO)
class GiroscopioModule(contextoReact: ReactApplicationContext) :
    ReactContextBaseJavaModule(contextoReact), LifecycleEventListener {

  /** Protege o par (estado desejado pelo JS, ciclo realmente registrado). */
  private val tranca = Any()

  private val gerenciadorDeSensores: SensorManager? by lazy {
    reactApplicationContext.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
  }

  /** Linha dedicada: entregar a 100 Hz na thread principal disputaria espaço com a interface. */
  private var linhaDoSensor: HandlerThread? = null
  private var entregadorDoSensor: Handler? = null

  /** O que o JS pediu. Sobrevive à pausa do app, para o `onHostResume` saber se deve religar. */
  private var medicaoLigada = false

  /** O ciclo que está registrado no `SensorManager`, ou `null` quando não há leitura em curso. */
  private var cicloAtual: CicloDeLeitura? = null

  /**
   * Identidade do ciclo que vale agora. Avança a cada registro e a cada desregistro, sempre com a
   * [tranca] tomada; é lido da linha do sensor, daí o `@Volatile`. Evento cuja geração não bate com
   * esta é sobra do ciclo anterior e é descartado antes de tocar em qualquer estado.
   */
  @Volatile private var geracaoAtual = 0

  private var periodoUs = 0

  init {
    contextoReact.addLifecycleEventListener(this)
  }

  override fun getName(): String = NOME_MODULO_GIROSCOPIO

  // ---------------------------------------------------------------------------------------------
  // API exposta ao JS
  // ---------------------------------------------------------------------------------------------

  /**
   * Liga o giroscópio na taxa pedida. Resolve com a descrição do sensor (que vai para a tela de
   * telemetria) ou rejeita com um código legível quando o aparelho não tem o sensor.
   */
  @ReactMethod
  fun iniciar(taxaHz: Double, promessa: Promise) {
    val gerenciador = gerenciadorDeSensores
    if (gerenciador == null) {
      promessa.reject(ERRO_SEM_SERVICO, MENSAGEM_SEM_SERVICO)
      return
    }

    val giroscopio = gerenciador.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
    if (giroscopio == null) {
      promessa.reject(ERRO_SEM_GIROSCOPIO, MENSAGEM_SEM_GIROSCOPIO)
      return
    }

    val taxaValida = saturarTaxa(taxaHz)
    val periodoPedidoUs = (MICROSSEGUNDOS_POR_SEGUNDO / taxaValida).roundToInt()

    synchronized(tranca) {
      periodoUs = periodoPedidoUs
      medicaoLigada = true
      if (!registrarListener(gerenciador, giroscopio)) {
        medicaoLigada = false
        promessa.reject(
            ERRO_REGISTRO,
            "O sistema recusou registrar o giroscópio a $taxaValida Hz.",
        )
        return
      }
    }

    val informacao = Arguments.createMap()
    informacao.putString("nome", giroscopio.name)
    informacao.putString("fornecedor", giroscopio.vendor)
    informacao.putDouble("taxaHzSolicitada", taxaValida)
    informacao.putInt("periodoUs", periodoPedidoUs)
    informacao.putInt("periodoMinimoUs", giroscopio.minDelay)
    informacao.putDouble("resolucaoRadS", giroscopio.resolution.toDouble())
    promessa.resolve(informacao)
  }

  /** Desliga o giroscópio. Chamar com o sensor já parado é inofensivo. */
  @ReactMethod
  fun parar() {
    synchronized(tranca) {
      medicaoLigada = false
      desregistrarListener()
    }
  }

  /**
   * Nomes em inglês por exigência do `NativeEventEmitter` — é contrato do React Native, não do
   * projeto. Ficam vazios de propósito: a emissão é global, pelo `RCTDeviceEventEmitter`, e quem
   * decide se o sensor fica ligado é o par `iniciar`/`parar`. Sem eles o `NativeEventEmitter`
   * reclama em tempo de execução.
   */
  @ReactMethod
  @Suppress("UNUSED_PARAMETER")
  fun addListener(eventName: String) {
    // Ver o comentário acima: nada a fazer.
  }

  /** Ver [addListener]: nome ditado pelo `NativeEventEmitter`. */
  @ReactMethod
  @Suppress("UNUSED_PARAMETER")
  fun removeListeners(count: Double) {
    // Ver o comentário de [addListener]: nada a fazer.
  }

  // ---------------------------------------------------------------------------------------------
  // Sensor
  // ---------------------------------------------------------------------------------------------

  /**
   * Um ciclo de leitura: nasce a cada registro no `SensorManager` e morre no desregistro seguinte.
   *
   * [tAmostraAnteriorNs] só é tocado aqui dentro, e o `SensorManager` entrega todos os eventos deste
   * ciclo na mesma linha ([entregadorDoSensor]) — por isso o campo é uma variável comum, sem
   * sincronização e sem corrida de leitura-modificação-escrita.
   */
  private inner class CicloDeLeitura(private val geracao: Int) : SensorEventListener {

    private var tAmostraAnteriorNs = 0L

    override fun onSensorChanged(evento: SensorEvent) {
      if (geracao != geracaoAtual) {
        // Sobra do ciclo anterior: o `SensorManager` ainda pode entregar o que já estava
        // enfileirado quando o listener foi solto. Descartar aqui é o que impede a primeira
        // amostra depois de religar de sair com o `dtMs` do tamanho da pausa.
        return
      }
      if (evento.sensor.type != Sensor.TYPE_GYROSCOPE) {
        return
      }

      val agoraNs = evento.timestamp
      val anteriorNs = tAmostraAnteriorNs
      tAmostraAnteriorNs = agoraNs

      emitirAmostra(
          evento,
          agoraNs,
          // A primeira amostra do ciclo não tem intervalo anterior; 0 avisa o JS para não contá-la.
          if (anteriorNs == 0L) 0.0 else (agoraNs - anteriorNs) / NANOSSEGUNDOS_POR_MS,
      )
    }

    override fun onAccuracyChanged(sensor: Sensor?, precisao: Int) {
      // A precisão relatada pelo Android não muda o que o servidor faz com a amostra crua.
    }
  }

  /** Roda na linha do sensor. Um `WritableMap` por amostra é o preço da ponte — ver "Riscos". */
  private fun emitirAmostra(evento: SensorEvent, tDispositivoNs: Long, dtMs: Double) {
    val amostra = Arguments.createMap()
    amostra.putDouble("gx", evento.values[0].toDouble())
    amostra.putDouble("gy", evento.values[1].toDouble())
    amostra.putDouble("gz", evento.values[2].toDouble())
    amostra.putDouble("tDispositivoMs", tDispositivoNs / NANOSSEGUNDOS_POR_MS)
    amostra.putDouble("dtMs", dtMs)

    val contexto = reactApplicationContext
    if (contexto.hasActiveReactInstance()) {
      contexto.emitDeviceEvent(EVENTO_AMOSTRA_GIROSCOPIO, amostra)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Ciclo de vida — nada de listener vivo com o app em segundo plano
  // ---------------------------------------------------------------------------------------------

  /**
   * Religa o sensor na volta do segundo plano.
   *
   * Se o religar falhar, ninguém pode ficar sem saber: este é o único caminho de erro do módulo sem
   * promessa do lado do JS, e falhar calado deixa a tela em "Parar medição" com a taxa em 0,00 e
   * nenhuma explicação — exatamente o que o critério de aceite 2 da ATI-003 proíbe.
   */
  override fun onHostResume() {
    val falha =
        synchronized(tranca) {
          if (!medicaoLigada || cicloAtual != null) {
            return
          }
          val motivo = religarListener()
          if (motivo != null) {
            // Sem listener registrado não há medição em curso: o estado interno não pode mentir para
            // a pausa seguinte, nem para um `iniciar()` que venha depois.
            medicaoLigada = false
          }
          motivo
        }

    if (falha == null) {
      return
    }
    // Fora da tranca de propósito: emitir é chamada de ponte, e a tranca só protege o estado local.
    // O `Log.w` sai mesmo quando o evento chega ao JS, porque é o que aparece no `adb logcat` — e o
    // logcat é o único registro que sobra se a ponte já tiver caído.
    Log.w(
        NOME_MODULO_GIROSCOPIO,
        "Falha ao religar o giroscópio: ${falha.codigo} — ${falha.mensagem}",
    )
    emitirFalha(falha)
  }

  override fun onHostPause() {
    // `medicaoLigada` continua verdadeiro de propósito: é o que faz o sensor religar na volta.
    synchronized(tranca) { desregistrarListener() }
  }

  override fun onHostDestroy() {
    encerrarTudo()
  }

  override fun invalidate() {
    reactApplicationContext.removeLifecycleEventListener(this)
    encerrarTudo()
    super.invalidate()
  }

  // ---------------------------------------------------------------------------------------------
  // Internos
  // ---------------------------------------------------------------------------------------------

  /** Motivo pelo qual a leitura parou sem que o JS tivesse pedido. */
  private data class FalhaDoGiroscopio(val codigo: String, val mensagem: String)

  /**
   * Deve ser chamado com [tranca] tomada.
   *
   * Devolve `null` quando o listener voltou a valer, ou a falha a ser contada ao JS. Espelha as três
   * recusas que [iniciar] já trata — sem serviço de sensores, sem giroscópio e registro recusado —,
   * que aqui não têm promessa para rejeitar.
   */
  private fun religarListener(): FalhaDoGiroscopio? {
    val gerenciador =
        gerenciadorDeSensores ?: return FalhaDoGiroscopio(ERRO_SEM_SERVICO, MENSAGEM_SEM_SERVICO)
    val giroscopio =
        gerenciador.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
            ?: return FalhaDoGiroscopio(ERRO_SEM_GIROSCOPIO, MENSAGEM_SEM_GIROSCOPIO)
    if (!registrarListener(gerenciador, giroscopio)) {
      return FalhaDoGiroscopio(ERRO_REGISTRO, MENSAGEM_RELIGAR_RECUSADO)
    }
    return null
  }

  /** Fora do caminho quente: acontece no máximo uma vez por retomada do app. */
  private fun emitirFalha(falha: FalhaDoGiroscopio) {
    val corpo = Arguments.createMap()
    corpo.putString("codigo", falha.codigo)
    corpo.putString("mensagem", falha.mensagem)

    val contexto = reactApplicationContext
    if (contexto.hasActiveReactInstance()) {
      contexto.emitDeviceEvent(EVENTO_FALHA_GIROSCOPIO, corpo)
    }
  }

  /** Deve ser chamado com [tranca] tomada. */
  private fun registrarListener(gerenciador: SensorManager, giroscopio: Sensor): Boolean {
    desregistrarListener()
    val entregador = garantirEntregador()
    geracaoAtual += 1
    val ciclo = CicloDeLeitura(geracaoAtual)
    val registrou = gerenciador.registerListener(ciclo, giroscopio, periodoUs, entregador)
    cicloAtual = if (registrou) ciclo else null
    return registrou
  }

  /** Deve ser chamado com [tranca] tomada. */
  private fun desregistrarListener() {
    val ciclo = cicloAtual ?: return
    // A geração avança **antes** do desregistro: assim, qualquer evento que ainda esteja a caminho
    // já nasce obsoleto e é descartado no início de `onSensorChanged`.
    geracaoAtual += 1
    cicloAtual = null
    gerenciadorDeSensores?.unregisterListener(ciclo)
  }

  /**
   * Deve ser chamado com [tranca] tomada.
   *
   * A linha é criada uma vez e sobrevive ao `parar()` de propósito: entre uma medição e outra ela
   * fica ociosa (custo desprezível) e evita criar/destruir thread a cada toque no botão da tela de
   * telemetria. Só morre em `onHostDestroy`/`invalidate`, em [encerrarTudo].
   */
  private fun garantirEntregador(): Handler {
    val existente = entregadorDoSensor
    if (existente != null) {
      return existente
    }
    val linha = HandlerThread(NOME_DA_LINHA, Process.THREAD_PRIORITY_FOREGROUND)
    linha.start()
    val novo = Handler(linha.looper)
    linhaDoSensor = linha
    entregadorDoSensor = novo
    return novo
  }

  private fun encerrarTudo() {
    synchronized(tranca) {
      medicaoLigada = false
      desregistrarListener()
      linhaDoSensor?.quitSafely()
      linhaDoSensor = null
      entregadorDoSensor = null
    }
  }

  private fun saturarTaxa(taxaHz: Double): Double =
      when {
        taxaHz.isNaN() -> TAXA_PADRAO_HZ
        taxaHz < TAXA_MINIMA_HZ -> TAXA_MINIMA_HZ
        taxaHz > TAXA_MAXIMA_HZ -> TAXA_MAXIMA_HZ
        else -> taxaHz
      }

  private companion object {
    const val NOME_DA_LINHA = "controle-giroscopio"
    const val NANOSSEGUNDOS_POR_MS = 1_000_000.0
    const val MICROSSEGUNDOS_POR_SEGUNDO = 1_000_000.0
    const val TAXA_MINIMA_HZ = 1.0
    const val TAXA_MAXIMA_HZ = 1_000.0
    const val TAXA_PADRAO_HZ = 100.0

    const val ERRO_SEM_SERVICO = "SEM_SERVICO_DE_SENSORES"
    const val ERRO_SEM_GIROSCOPIO = "SEM_GIROSCOPIO"
    const val ERRO_REGISTRO = "REGISTRO_RECUSADO"

    // Mesma frase para a mesma recusa, venha ela de `iniciar()` (promessa) ou do religar (evento).
    const val MENSAGEM_SEM_SERVICO = "Este aparelho não expõe o serviço de sensores."
    const val MENSAGEM_SEM_GIROSCOPIO = "Este aparelho não tem giroscópio."
    const val MENSAGEM_RELIGAR_RECUSADO =
        "O sistema recusou religar o giroscópio ao voltar do segundo plano."
  }
}
