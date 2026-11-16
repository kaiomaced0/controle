package com.nortedata.controle

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registra o [GiroscopioModule]. Como o módulo é código do próprio app (e não uma biblioteca em
 * `node_modules`), o autolinking não o enxerga: o registro é feito à mão no `MainApplication`.
 *
 * `BaseReactPackage` é a forma que funciona nas duas arquiteturas: na New Architecture o módulo
 * entra pela camada de interoperabilidade de módulos legados, que o React Native 0.87 mantém
 * ligada por padrão quando o modo bridgeless está ativo.
 */
class GiroscopioPackage : BaseReactPackage() {

  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == NOME_MODULO_GIROSCOPIO) GiroscopioModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
        NOME_MODULO_GIROSCOPIO to
            ReactModuleInfo(
                NOME_MODULO_GIROSCOPIO,
                GiroscopioModule::class.java.name,
                false, // canOverrideExistingModule
                false, // needsEagerInit — só sobe quando a tela de telemetria pede
                false, // isCxxModule
                false, // isTurboModule — módulo legado, atendido pela camada de interoperabilidade
            )
    )
  }
}
