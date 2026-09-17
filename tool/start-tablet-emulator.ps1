[CmdletBinding()]
param(
    [string]$AvdName = 'Kiyometa_Tablet',
    [string]$AndroidApi = '34',
    [switch]$RunApp,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$FlutterArguments
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

function Get-AndroidSdkPath {
    $candidates = @(
        $env:ANDROID_SDK_ROOT,
        $env:ANDROID_HOME,
        (Join-Path $env:LOCALAPPDATA 'Android\Sdk'),
        'C:\Android'
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

    if ($candidates.Count -gt 0) {
        return $candidates[0]
    }

    $localProperties = Join-Path $projectRoot 'android\local.properties'
    if (Test-Path -LiteralPath $localProperties) {
        $sdkLine = Get-Content -LiteralPath $localProperties |
            Where-Object { $_ -match '^sdk\.dir=' } |
            Select-Object -First 1
        if ($sdkLine) {
            $sdkPath = ($sdkLine -replace '^sdk\.dir=', '') -replace '\\\\', '\'
            if (Test-Path -LiteralPath $sdkPath) {
                return $sdkPath
            }
        }
    }

    throw 'Android SDK tidak ditemukan. Install Android Studio lalu jalankan flutter doctor.'
}

function Get-RunningAvdSerial {
    param(
        [string]$AdbPath,
        [string]$Name
    )

    $deviceLines = & $AdbPath devices 2>$null
    $serials = @($deviceLines | ForEach-Object {
        if ($_ -match '^(emulator-\d+)\s+device$') { $Matches[1] }
    })

    foreach ($serial in $serials) {
        $runningName = (& $AdbPath -s $serial emu avd name 2>$null | Select-Object -First 1).Trim()
        if ($runningName -eq $Name) {
            return $serial
        }
    }

    return $null
}

$sdkPath = Get-AndroidSdkPath
$emulatorPath = Join-Path $sdkPath 'emulator\emulator.exe'
$adbPath = Join-Path $sdkPath 'platform-tools\adb.exe'
$commandLineTools = Get-ChildItem -LiteralPath (Join-Path $sdkPath 'cmdline-tools') `
    -Recurse -Filter 'avdmanager.bat' -ErrorAction SilentlyContinue |
    Select-Object -First 1

if (-not (Test-Path -LiteralPath $emulatorPath) -or -not (Test-Path -LiteralPath $adbPath)) {
    throw 'Android Emulator atau platform-tools belum terpasang. Install keduanya dari Android Studio SDK Manager.'
}

$installedAvds = @(& $emulatorPath -list-avds 2>$null)
if ($installedAvds -notcontains $AvdName) {
    if (-not $commandLineTools) {
        throw 'avdmanager tidak ditemukan. Install Android SDK Command-line Tools dari SDK Manager.'
    }

    $sdkManagerPath = Join-Path $commandLineTools.Directory.FullName 'sdkmanager.bat'
    $systemImage = "system-images;android-$AndroidApi;google_apis;x86_64"

    Write-Host "Menyiapkan system image Android $AndroidApi..." -ForegroundColor Cyan
    & $sdkManagerPath --install 'platform-tools' 'emulator' $systemImage
    if ($LASTEXITCODE -ne 0) {
        throw 'System image gagal dipasang. Jalankan flutter doctor --android-licenses, lalu coba lagi.'
    }

    Write-Host "Membuat emulator tablet $AvdName..." -ForegroundColor Cyan
    'no' | & $commandLineTools.FullName create avd `
        --name $AvdName `
        --package $systemImage `
        --device 'pixel_tablet' `
        --force
    if ($LASTEXITCODE -ne 0) {
        throw "Gagal membuat emulator $AvdName."
    }
}

& $adbPath start-server | Out-Null
$serial = Get-RunningAvdSerial -AdbPath $adbPath -Name $AvdName

if (-not $serial) {
    Write-Host "Menyalakan $AvdName..." -ForegroundColor Cyan
    Start-Process -FilePath $emulatorPath -ArgumentList @('-avd', $AvdName)

    $deadline = (Get-Date).AddMinutes(3)
    do {
        Start-Sleep -Seconds 2
        $serial = Get-RunningAvdSerial -AdbPath $adbPath -Name $AvdName
    } until ($serial -or (Get-Date) -ge $deadline)

    if (-not $serial) {
        throw "Emulator $AvdName tidak terdeteksi setelah 3 menit. Buka Android Studio Device Manager untuk melihat errornya."
    }
}

Write-Host "Tablet aktif: $AvdName ($serial)" -ForegroundColor Green

if ($RunApp) {
    Push-Location $projectRoot
    try {
        & flutter run -d $serial @FlutterArguments
        exit $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}

Write-Host 'Sekarang jalankan: flutter run' -ForegroundColor Green

