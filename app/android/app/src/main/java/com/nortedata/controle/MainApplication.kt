package com.nortedata.controle

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Módulo nativo do próprio app: o autolinking só enxerga bibliotecas de node_modules.
          add(GiroscopioPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    // Antes de o React Native subir: o cliente de WebSocket nasce na primeira conexão pedida pelo
    // JS, e o `TCP_NODELAY` dos dois lados é item obrigatório do PROTOCOLO.md (seção 1).
    instalarTcpNoDelayNosWebSockets()
    loadReactNative(this)
  }
}
