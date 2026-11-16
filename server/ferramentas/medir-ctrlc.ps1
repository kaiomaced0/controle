# Mede o encerramento limpo com Ctrl+C DE VERDADE (Windows).
#
# Por que existe: no Windows nao da para entregar um Ctrl+C de console a um processo filho
# pelo shell (`process.kill(pid,'SIGINT')` mata sem entregar o sinal, e emitir SIGINT dentro
# do proprio processo pula o supervisor de recarga - que e justamente a peca que falha).
# Este roteiro entrega o CTRL_C_EVENT real, o mesmo evento que o teclado gera:
#   FreeConsole -> AttachConsole(pid do filho) -> SetConsoleCtrlHandler(NULL,TRUE)
#   -> GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)
#
# O que ele responde, com numero:
#   - as tarefas de encerramento rodaram?  (linhas "encerrando" e "encerrado" no stderr)
#   - a tarefa de encerramento TERMINOU o trabalho dela? (sonda opcional, ver -SondaMs)
#   - o processo saiu sozinho? em quantos ms?
#   - sobrou processo vivo na arvore que este roteiro iniciou?
#
# ALVO E LIMPEZA: SOMENTE A ARVORE DO PROCESSO QUE ESTE ROTEIRO INICIOU.
# A versao anterior deste arquivo decidia o que era "o servidor" e o que era "orfao" por
# diferenca de conjunto sobre TODO node.exe da maquina. Nesta maquina rodam Metro, agentes do
# plano de acao e o proprio editor - todos node.exe -, entao aquilo (a) matava processo de
# terceiro com Stop-Process -Force e (b) produzia falso negativo: um node.exe alheio nascido
# durante a medicao entrava no conjunto esperado e a espera estourava o teto (10 s medidos, em
# vez dos ~21 ms reais). Agora a arvore vem do ParentProcessId (Win32_Process) a partir do PID
# que o Start-Process devolveu, e o que estiver fora dela nunca e tocado - no maximo contado e
# relatado como contaminacao da rodada (coluna `alheios`).
#
# stderr vai para ARQUIVO de proposito: escrita em arquivo no Node e sincrona, entao
# nenhuma linha se perde se o processo for terminado logo depois. Em pipe ela se perderia,
# e a medicao acusaria "nao rodou" para um encerramento que rodou.
#
# Uso (a partir de server/):
#   powershell -NoProfile -ExecutionPolicy Bypass -File ferramentas\medir-ctrlc.ps1 `
#     -Rotulo "npm run dev" -Comando "npm run dev" -Repeticoes 5
#
#   # com sonda: a tarefa de encerramento faz 50 ms de trabalho e so entao grava um arquivo.
#   # `sonda=True` significa que a tarefa TERMINOU - nao que o processo sumiu.
#   powershell -NoProfile -ExecutionPolicy Bypass -File ferramentas\medir-ctrlc.ps1 `
#     -Rotulo "node --import tsx (sonda 50 ms)" `
#     -Comando "node --import tsx ferramentas\sonda-encerramento.mjs" -SondaMs 50 -Repeticoes 5
#
# Dica: se ja houver um servidor Controle de pe na porta padrao, exporte CONTROLE_PORTA antes
# de chamar (o processo filho herda o ambiente) para as duas medicoes nao brigarem pela porta.

param(
  [string]$Rotulo = 'npm run dev',
  [string]$Comando = 'npm run dev',
  [int]$Repeticoes = 1,
  [string]$Trabalho = '',
  [int]$EsperaSubidaS = 30,
  [int]$EsperaSaidaS = 10,
  # Trecho procurado no stderr para saber que o servidor subiu. O padrao casa tanto com
  # "scaffold no ar" (ATI-002) quanto com "servidor no ar" (ATI-005 em diante).
  [string]$MarcaDeSubida = 'no ar',
  # -1 desliga a sonda. >= 0 liga: a tarefa de encerramento leva N ms e depois grava o arquivo.
  # Exige um -Comando que aponte para ferramentas\sonda-encerramento.mjs.
  [int]$SondaMs = -1
)

$ErrorActionPreference = 'Stop'
if ($Trabalho -eq '') { $Trabalho = Split-Path -Parent $PSScriptRoot }

Add-Type -Namespace Win32 -Name Console -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint dwProcessId);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);
'@

# Desce a arvore de processos a partir de $raiz usando ParentProcessId.
#
# `$nascidosApos` descarta candidato mais velho que a propria raiz: filho de verdade nasce
# depois do pai, entao um ParentProcessId que aponte para um PID reaproveitado nao arrasta
# processo alheio para dentro do alvo. Devolve [] quando nao consegue ler a tabela de
# processos - preferimos perder a rodada a chutar quem matar.
function Obter-Arvore {
  param([int]$Raiz, [datetime]$NascidosApos)

  try {
    $todos = @(Get-CimInstance -ClassName Win32_Process `
        -Property ProcessId, ParentProcessId, Name, CreationDate -ErrorAction Stop)
  } catch {
    Write-Warning ("nao consegui ler a tabela de processos ({0}); rodada sem alvo" -f $_.Exception.Message)
    return @()
  }

  $porPai = @{}
  foreach ($p in $todos) {
    if ($null -eq $p.CreationDate -or $p.CreationDate -lt $NascidosApos) { continue }
    $pai = [int]$p.ParentProcessId
    if (-not $porPai.ContainsKey($pai)) { $porPai[$pai] = New-Object System.Collections.ArrayList }
    [void]$porPai[$pai].Add($p)
  }

  $fila = New-Object System.Collections.Queue
  $fila.Enqueue($Raiz)
  $vistos = @{ $Raiz = $true }
  $arvore = New-Object System.Collections.ArrayList
  while ($fila.Count -gt 0) {
    $atual = [int]$fila.Dequeue()
    if (-not $porPai.ContainsKey($atual)) { continue }
    foreach ($filho in $porPai[$atual]) {
      $id = [int]$filho.ProcessId
      if ($vistos.ContainsKey($id)) { continue }
      $vistos[$id] = $true
      [void]$arvore.Add($filho)
      $fila.Enqueue($id)
    }
  }
  return @($arvore)
}

# Pega os objetos Process dos PIDs pedidos e SEGURA o identificador de cada um.
#
# Enquanto o identificador esta aberto o Windows nao reaproveita o PID, entao daqui para a
# frente `HasExited` e `Kill()` falam sempre do MESMO processo - nunca de um recem-nascido que
# herdou o numero. E o que torna a limpeza segura.
function Segurar-Processos {
  param([int[]]$Ids)

  $presos = New-Object System.Collections.ArrayList
  foreach ($id in $Ids) {
    try {
      $p = Get-Process -Id $id -ErrorAction Stop
      $null = $p.Handle
      [void]$presos.Add($p)
    } catch {
      # Ja saiu entre a leitura da arvore e agora, ou nao temos permissao: nada a fazer.
    }
  }
  return @($presos)
}

# Encerra a arvore iniciada pelo roteiro - e so ela.
# taskkill /T cobre o caso normal; os sobreviventes sao mortos pelo identificador ja preso
# (processo re-parenteado nao aparece mais para o /T, mas continua na nossa lista).
function Limpar-Arvore {
  param([int]$RaizId, $Presos)

  try { & taskkill.exe /PID $RaizId /T /F 2>&1 | Out-Null } catch {}
  foreach ($p in @($Presos)) {
    try { if (-not $p.HasExited) { $p.Kill() } } catch {}
  }
}

function Medir-UmaVez {
  $base = Join-Path ([IO.Path]::GetTempPath()) ("ctrlc-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $base | Out-Null
  $arqOut = Join-Path $base 'saida.txt'
  $arqErr = Join-Path $base 'erro.txt'
  $arqSonda = Join-Path $base 'sonda.txt'

  # Usado SO para relatar contaminacao: node.exe que nao e nosso jamais e tocado.
  $nodesAntes = @(Get-Process -Name node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)

  if ($SondaMs -ge 0) {
    $env:CONTROLE_SONDA_ARQUIVO = $arqSonda
    $env:CONTROLE_SONDA_MS = "$SondaMs"
  }
  # 200 ms de folga cobrem a granularidade do relogio entre Get-Date e o CreationDate do CIM.
  $nascidosApos = (Get-Date).AddMilliseconds(-200)
  $linha = '/c "' + $Comando + ' > "' + $arqOut + '" 2> "' + $arqErr + '""'
  $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList $linha -WorkingDirectory $Trabalho -WindowStyle Hidden -PassThru
  if ($SondaMs -ge 0) {
    Remove-Item Env:CONTROLE_SONDA_ARQUIVO, Env:CONTROLE_SONDA_MS -ErrorAction SilentlyContinue
  }

  $relogio = [Diagnostics.Stopwatch]::StartNew()
  $subiu = $false
  while ($relogio.Elapsed.TotalSeconds -lt $EsperaSubidaS) {
    if (Test-Path $arqErr) {
      $txt = Get-Content -Raw -Encoding UTF8 $arqErr -ErrorAction SilentlyContinue
      if ($txt -and $txt -match [regex]::Escape($MarcaDeSubida)) { $subiu = $true; break }
    }
    Start-Sleep -Milliseconds 120
  }
  if (-not $subiu) {
    $presos = Segurar-Processos -Ids @(Obter-Arvore -Raiz $proc.Id -NascidosApos $nascidosApos |
        Select-Object -ExpandProperty ProcessId)
    Limpar-Arvore -RaizId $proc.Id -Presos $presos
    # Mesmo formato do caminho feliz: quem imprime nao precisa saber por onde a medicao passou.
    return [pscustomobject]@{
      subiu = $false; encerrando = $false; encerrado = $false; saiuSozinho = $false
      sonda = $null; ms = $null; alvos = 0; sobreviventes = 0; alheios = 0
      stderr = (Get-Content -Raw -Encoding UTF8 $arqErr -ErrorAction SilentlyContinue); pasta = $base
    }
  }

  Start-Sleep -Milliseconds 900
  $marcaAntes = (Get-Content -Raw -Encoding UTF8 $arqErr).Length

  # Sao os node.exe DA NOSSA ARVORE que precisam sair sozinhos. O cmd.exe do `npm run` fica
  # preso no "Terminate batch job (Y/N)?" do proprio Windows - prompt do interpretador de
  # lote, nao do servidor -, por isso o cronometro olha node.exe e nao a raiz.
  $arvore = Obter-Arvore -Raiz $proc.Id -NascidosApos $nascidosApos
  $presos = Segurar-Processos -Ids @($arvore | Select-Object -ExpandProperty ProcessId)
  $alvos = @($presos | Where-Object { $_.ProcessName -eq 'node' })

  [Win32.Console]::FreeConsole() | Out-Null
  [Win32.Console]::AttachConsole([uint32]$proc.Id) | Out-Null
  [Win32.Console]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null

  $cronometro = [Diagnostics.Stopwatch]::StartNew()
  [Win32.Console]::GenerateConsoleCtrlEvent(0, 0) | Out-Null   # 0 = CTRL_C_EVENT, grupo 0 = todos

  $saiuSozinho = $false
  if ($alvos.Count -eq 0) {
    # Sem alvo nao ha o que cronometrar: a rodada e inconclusiva, e dizer isso vale mais do
    # que devolver 0 ms como se fosse encerramento instantaneo.
    $saiuSozinho = $null
  } else {
    while ($cronometro.Elapsed.TotalSeconds -lt $EsperaSaidaS) {
      if (@($alvos | Where-Object { -not $_.HasExited }).Count -eq 0) { $saiuSozinho = $true; break }
      Start-Sleep -Milliseconds 20
    }
  }
  $ms = if ($alvos.Count -eq 0) { $null } else { [math]::Round($cronometro.Elapsed.TotalMilliseconds, 1) }
  $cronometro.Stop()

  [Win32.Console]::SetConsoleCtrlHandler([IntPtr]::Zero, $false) | Out-Null
  [Win32.Console]::FreeConsole() | Out-Null

  Start-Sleep -Milliseconds 2000
  $err = Get-Content -Raw -Encoding UTF8 $arqErr
  $depois = if ($err.Length -gt $marcaAntes) { $err.Substring($marcaAntes) } else { '' }

  $sobreviventes = @($alvos | Where-Object { -not $_.HasExited })
  $idsNossos = @($presos | ForEach-Object { $_.Id })
  # Contaminacao: node.exe que nasceu durante a medicao e NAO e da nossa arvore. So contado.
  $alheios = @(Get-Process -Name node -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Id |
    Where-Object { $nodesAntes -notcontains $_ -and $idsNossos -notcontains $_ })

  Limpar-Arvore -RaizId $proc.Id -Presos $presos

  return [pscustomobject]@{
    subiu       = $true
    encerrando  = [bool]($depois -match 'encerrando')
    encerrado   = [bool]($depois -match 'encerrado')
    saiuSozinho = $saiuSozinho
    sonda       = if ($SondaMs -ge 0) { [bool](Test-Path $arqSonda) } else { $null }
    ms          = $ms
    alvos       = $alvos.Count
    sobreviventes = $sobreviventes.Count
    alheios     = $alheios.Count
    stderr      = $depois
    pasta       = $base
  }
}

$subiram = 0; $ok = 0; $tempos = @(); $sobreviventes = 0; $alheios = 0; $sondasOk = 0; $inconclusivas = 0
for ($i = 1; $i -le $Repeticoes; $i++) {
  $r = Medir-UmaVez
  if (-not $r.subiu) {
    # Nao subir e um problema DIFERENTE de nao encerrar; contar junto esconderia os dois.
    Write-Output ("  [{0}/{1}] NAO SUBIU: a marca `"{2}`" nao apareceu em {3} s - repeticao fora do calculo de encerramento (log em {4})" -f `
        $i, $Repeticoes, $MarcaDeSubida, $EsperaSubidaS, $r.pasta)
    continue
  }
  $subiram++
  if ($r.encerrado) { $ok++ }
  if ($null -ne $r.ms) { $tempos += $r.ms }
  if ($r.alvos -eq 0) { $inconclusivas++ }
  if ($r.sonda -eq $true) { $sondasOk++ }
  $sobreviventes += $r.sobreviventes
  $alheios += $r.alheios
  $sonda = if ($null -eq $r.sonda) { '-' } else { $r.sonda }
  Write-Output ("  [{0}/{1}] subiu=True encerrado={2} saiuSozinho={3} ms={4} sonda={5} alvos={6} sobreviventes={7} alheios={8}" -f `
      $i, $Repeticoes, $r.encerrado, $r.saiuSozinho, $r.ms, $sonda, $r.alvos, $r.sobreviventes, $r.alheios)
}
$media = if ($tempos.Count -gt 0) { [math]::Round((($tempos | Measure-Object -Average).Average), 1) } else { 0 }
Write-Output ''
Write-Output ("{0}: subiu {1}/{2} | encerramento completo {3}/{1} das que subiram | saida media {4} ms | sobreviventes da arvore {5}" -f `
    $Rotulo, $subiram, $Repeticoes, $ok, $media, $sobreviventes)
if ($SondaMs -ge 0) {
  Write-Output ("  sonda ({0} ms de trabalho): tarefa terminou {1}/{2} das que subiram" -f $SondaMs, $sondasOk, $subiram)
}
if ($inconclusivas -gt 0) {
  Write-Output ("  aviso: {0} repeticao(oes) sem node.exe visivel na arvore - tempo nao medido" -f $inconclusivas)
}
if ($alheios -gt 0) {
  Write-Output ("  aviso: {0} node.exe alheio(s) apareceram durante a medicao. Nao foram tocados, mas a maquina estava ocupada - a rodada pode estar contaminada." -f $alheios)
}

# O taskkill de limpeza deixa $LASTEXITCODE sujo; o que vale e o relatorio acima.
exit 0
