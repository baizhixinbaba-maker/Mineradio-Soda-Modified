param(
  [string]$OutputPath = (Join-Path $env:TEMP ("Mineradio-Diagnostics-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss')))
)

$ErrorActionPreference = 'SilentlyContinue'

function Get-Sha256([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Read-SafeJson([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { return [ordered]@{ parseError = $_.Exception.Message } }
}

function Test-HttpsEndpoint([string]$Url) {
  $started = Get-Date
  try {
    $response = Invoke-WebRequest -Uri $Url -Method Head -UseBasicParsing -TimeoutSec 12
    return [ordered]@{
      ok = $true
      status = [int]$response.StatusCode
      elapsedMs = [int]((Get-Date) - $started).TotalMilliseconds
    }
  } catch {
    $status = $null
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      $status = [int]$_.Exception.Response.StatusCode
    }
    # Any HTTP response proves DNS, TCP and TLS succeeded. Only a transport
    # exception means the QR host is unreachable from this computer.
    return [ordered]@{
      ok = ($null -ne $status)
      status = $status
      error = $_.Exception.Message
      elapsedMs = [int]((Get-Date) - $started).TotalMilliseconds
    }
  }
}

$allProcesses = @(Get-CimInstance Win32_Process)
$mineradioProcesses = @($allProcesses | Where-Object {
  $_.Name -ieq 'Mineradio.exe'
} | ForEach-Object {
  [ordered]@{
    name = $_.Name
    pid = [int]$_.ProcessId
    executablePath = $_.ExecutablePath
    commandLine = $_.CommandLine
    parentPid = [int]$_.ParentProcessId
  }
})

$rawFilePages = @($allProcesses | Where-Object {
  $_.CommandLine -match '(?i)(file:///|public[\\/]+index\.html)'
} | ForEach-Object {
  [ordered]@{
    name = $_.Name
    pid = [int]$_.ProcessId
    commandLine = $_.CommandLine
  }
})

$candidateRoots = [System.Collections.Generic.List[string]]::new()
foreach ($process in $mineradioProcesses) {
  if ($process.executablePath) {
    $candidateRoots.Add((Split-Path -Parent $process.executablePath))
  }
}
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'Mineradio.exe')) {
  $candidateRoots.Add($PSScriptRoot)
}

$packages = @()
foreach ($root in @($candidateRoots | Select-Object -Unique)) {
  $appRoot = Join-Path $root 'resources\app'
  $packageJson = Join-Path $appRoot 'package.json'
  if (-not (Test-Path -LiteralPath $packageJson -PathType Leaf)) { continue }
  $package = Read-SafeJson $packageJson
  $exe = Join-Path $root 'Mineradio.exe'
  $packages += [ordered]@{
    root = $root
    packageVersion = $package.version
    executableFileVersion = if (Test-Path -LiteralPath $exe) { (Get-Item -LiteralPath $exe).VersionInfo.FileVersion } else { $null }
    hashes = [ordered]@{
      executable = Get-Sha256 $exe
      packageJson = Get-Sha256 $packageJson
      main = Get-Sha256 (Join-Path $appRoot 'desktop\main.js')
      preload = Get-Sha256 (Join-Path $appRoot 'desktop\preload.js')
      index = Get-Sha256 (Join-Path $appRoot 'public\index.html')
      sodaLogin = Get-Sha256 (Join-Path $appRoot 'public\soda-login\login.html')
    }
  }
}

$userData = Join-Path $env:APPDATA 'Mineradio'
$listeners = @(Get-NetTCPConnection -State Listen | Where-Object {
  $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::1', '::')
} | ForEach-Object {
  $owner = $allProcesses | Where-Object ProcessId -eq $_.OwningProcess | Select-Object -First 1
  if ($owner -and ($owner.Name -ieq 'Mineradio.exe' -or $owner.CommandLine -match '(?i)Mineradio')) {
    [ordered]@{
      address = $_.LocalAddress
      port = [int]$_.LocalPort
      pid = [int]$_.OwningProcess
      process = $owner.Name
    }
  }
})

$report = [ordered]@{
  schemaVersion = 1
  createdAt = (Get-Date).ToString('o')
  computer = [ordered]@{
    name = $env:COMPUTERNAME
    os = (Get-CimInstance Win32_OperatingSystem).Caption
    osVersion = [Environment]::OSVersion.VersionString
    architecture = $env:PROCESSOR_ARCHITECTURE
    powershell = $PSVersionTable.PSVersion.ToString()
  }
  processes = $mineradioProcesses
  rawFilePages = $rawFilePages
  packages = $packages
  localListeners = $listeners
  network = [ordered]@{
    qishuiApi = Test-HttpsEndpoint 'https://api.qishui.com/'
    qishuiBff = Test-HttpsEndpoint 'https://bff-pc.qishui.com/'
    sodaLoginAsset = Test-HttpsEndpoint 'https://lf-headquarters-speed.yhgfb-cn-static.com/'
  }
  sodaQrDiagnostics = Read-SafeJson (Join-Path $userData 'soda-qr-diagnostics.json')
  bridgeDeployment = Read-SafeJson (Join-Path $userData 'soda-runtime\bridge-deployment.json')
  notes = @(
    'This report intentionally excludes cookies, account data and bridge tokens.',
    'rawFilePages must be empty; Soda QR IPC only exists in the Electron desktop window.',
    'A successful QR start normally records getQrcode.count >= 1 and getQrcode.status = 200.'
  )
}

$parent = Split-Path -Parent $OutputPath
if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
Write-Output $OutputPath
