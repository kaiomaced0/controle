# App Controle (React Native)

O lado do celular do projeto: mede o giroscópio, manda para o PC pelo protocolo binário e vibra
quando o PC pede. Visão, arquitetura e contrato de rede ficam em [`../docs`](../docs).

## Rodar no celular pelo cabo — um comando só

Com o celular no cabo USB, **depuração USB** ligada e o aviso "Permitir depuração USB?" aceito:

```powershell
cd app
npm run android:cabo
```

O script [`scripts/rodar-android.js`](scripts/rodar-android.js) faz, em ordem:

1. monta o **JDK 18.0.2** só para o Gradle (é o JDK que passa no bloqueio desta máquina — ver
   [ATI-024](../docs/plano-acao/atividade/ATI-024.md));
2. compila o APK de depuração **só para a ABI do aparelho** conectado (como o `--active-arch-only`
   do run-android), com as duas chaves que o build precisa aqui;
3. instala com `adb install -r`;
4. encaminha pelo cabo a **8081** (Metro) e a **8765** (servidor) com `adb reverse`;
5. sobe o **Metro neste mesmo terminal** (ou reaproveita um que já esteja de pé);
6. abre o app (`com.nortedata.controle/.MainActivity`) e avisa se a tela estiver bloqueada ou se
   o processo do app morrer logo depois de abrir.

**Ctrl+C** encerra o Metro. O servidor do PC é à parte — em outro terminal: `cd server; npm run dev`.
Sem ele o app abre normalmente e fica tentando conectar.

### Opções

No PowerShell, o `--` do `npm run x -- --opção` é engolido pelo próprio PowerShell. Para passar
opções, chame o Node direto:

```powershell
node scripts/rodar-android.js --sem-compilar          # só reinstala e abre o APK que já existe
node scripts/rodar-android.js --sem-metro             # Metro já está rodando em outro terminal
node scripts/rodar-android.js --aparelho RQ8N209ND8Z  # mais de um aparelho conectado
node scripts/rodar-android.js --todas-as-arquiteturas # APK com as 4 ABIs (~117 MB)
node scripts/rodar-android.js --porta-do-servidor 8770  # o 8765 do celular vai para outra porta do PC
node scripts/rodar-android.js --ajuda
```

O JDK pode ser trocado com `--java-home <pasta>` ou com a variável `CONTROLE_JAVA_HOME`.

### Por que não `npx react-native run-android`

Nesta máquina o controle de aplicações do antivírus corporativo barra o `Selector.open()` do Java
em quase todo JDK instalado (17, 21 e o JBR do Android Studio); o 18.0.2 passa. O run-android
chama o Gradle com o JDK do ambiente e sem as chaves abaixo, e não encaminha a porta do servidor.
Em máquina **sem** esse bloqueio, o caminho oficial (JDK 17 + `npm run android`) continua valendo.

Compilar à mão (Git Bash), se precisar:

```bash
cd app/android
export JAVA_HOME="C:/Program Files/Java/jdk-18.0.2"; export PATH="/c/Program Files/Java/jdk-18.0.2/bin:$PATH"
./gradlew assembleDebug -Preact.internal.disableJavaVersionAlignment=true -Pkotlin.jvm.target.validation.mode=warning
```

## Problemas comuns

| Sintoma | Causa e conserto |
|---|---|
| `unauthorized` no `adb devices` | Aceite "Permitir depuração USB?" na tela do celular. |
| App abre numa tela vermelha "Unable to load script" | O Metro não está de pé ou a 8081 não foi encaminhada: rode o comando de novo. |
| App abre e não conecta | Servidor fora do ar (`cd server; npm run dev`) ou a 8765 não foi encaminhada. O `adb reverse` cai junto com o cabo. |
| Nada aparece na tela | Celular bloqueado: o Android abre o app por trás do bloqueio. Desbloqueie. |
| `Unable to establish loopback connection` no Gradle | O JDK em uso está sendo barrado; confira o `--java-home`. |

Ver o que o app registrou:

```powershell
D:\Android\Sdk\platform-tools\adb.exe logcat -d -s AndroidRuntime:E ReactNativeJS:V ReactNative:V Giroscopio:V ControleTransporte:V
```

## Desenvolvimento

```powershell
npm start            # só o Metro
npx tsc --noEmit     # tipos
npm run lint         # ESLint
npm test             # Jest
```

Salvar um arquivo recarrega o app sozinho (Fast Refresh). Recarga completa: agite o celular >
**Reload**.

iOS fica para a fase 6 (ver [VISAO.md](../docs/VISAO.md)); a pasta `ios/` ainda é a do template.
