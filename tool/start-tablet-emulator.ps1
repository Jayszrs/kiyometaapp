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

function Set-AvdPerformanceConfig {
    param([string]$Name)

    $configPath = Join-Path $env:USERPROFILE ".android\avd\$Name.avd\config.ini"
    if (-not (Test-Path -LiteralPath $configPath)) {
        return
    }

    $settings = [ordered]@{
        'hw.gpu.enabled'                    = 'yes'
        'hw.gpu.mode'                       = 'auto'
        'hw.lcd.width'                      = '1920'
        'hw.lcd.height'                     = '1200'
        'hw.lcd.density'                    = '240'
        'hw.ramSize'                        = '2048'
        'vm.heapSize'                       = '256M'
        'fastboot.forceColdBoot'            = 'yes'
        'fastboot.forceFastBoot'            = 'no'
        'firstboot.bootFromDownloadableSnapshot' = 'no'
        'firstboot.bootFromLocalSnapshot'   = 'no'
        'firstboot.saveToLocalSnapshot'     = 'no'
    }

    $lines = [System.Collections.Generic.List[string]]::new()
    Get-Content -LiteralPath $configPath | ForEach-Object { [void]$lines.Add($_) }

    foreach ($entry in $settings.GetEnumerator()) {
        $prefix = "$($entry.Key)="
        $index = -1
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i].StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                $index = $i
                break
            }
        }

        $newLine = "$($entry.Key)=$($entry.Value)"
        if ($index -ge 0) {
            $lines[$index] = $newLine
        }
        else {
            [void]$lines.Add($newLine)
        }
    }

    [System.IO.File]::WriteAllLines($configPath, $lines)
}

function Wait-AndroidBoot {
    param(
        [string]$AdbPath,
        [string]$Serial,
        [int]$TimeoutMinutes = 5
    )

    Write-Host 'Menunggu Android selesai boot...' -ForegroundColor Cyan
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    do {
        Start-Sleep -Seconds 2
        $bootCompleted = (& $AdbPath -s $Serial shell getprop sys.boot_completed 2>$null | Select-Object -First 1).Trim()
    } until ($bootCompleted -eq '1' -or (Get-Date) -ge $deadline)

    if ($bootCompleted -ne '1') {
        throw "Android pada $Serial belum selesai boot setelah $TimeoutMinutes menit."
    }

    & $AdbPath -s $Serial shell input keyevent 82 2>$null | Out-Null
    Start-Sleep -Seconds 2
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

Set-AvdPerformanceConfig -Name $AvdName

& $adbPath start-server | Out-Null
$serial = Get-RunningAvdSerial -AdbPath $adbPath -Name $AvdName

if (-not $serial) {
    Write-Host "Menyalakan $AvdName..." -ForegroundColor Cyan
    Start-Process -FilePath $emulatorPath -ArgumentList @(
        '-avd', $AvdName,
        '-gpu', 'auto',
        '-no-snapshot-load',
        '-no-boot-anim'
    )

    $deadline = (Get-Date).AddMinutes(3)
    do {
        Start-Sleep -Seconds 2
        $serial = Get-RunningAvdSerial -AdbPath $adbPath -Name $AvdName
    } until ($serial -or (Get-Date) -ge $deadline)

    if (-not $serial) {
        throw "Emulator $AvdName tidak terdeteksi setelah 3 menit. Buka Android Studio Device Manager untuk melihat errornya."
    }
}

Wait-AndroidBoot -AdbPath $adbPath -Serial $serial

Write-Host "Tablet aktif: $AvdName ($serial)" -ForegroundColor Green

if ($RunApp) {
    $webAppPath = Join-Path $projectRoot 'webapp'
    $packageJsonPath = Join-Path $webAppPath 'package.json'
    if (-not (Test-Path -LiteralPath $packageJsonPath)) {
        throw "Web application tidak ditemukan di $webAppPath."
    }

    $nodeModulesPath = Join-Path $webAppPath 'node_modules'
    if (-not (Test-Path -LiteralPath $nodeModulesPath)) {
        Write-Host 'Meng-install dependency webapp...' -ForegroundColor Cyan
        Push-Location $webAppPath
        try {
            & npm.cmd install
            if ($LASTEXITCODE -ne 0) {
                throw 'npm install gagal.'
            }
        }
        finally {
            Pop-Location
        }
    }

    $viteListener = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
    if (-not $viteListener) {
        Write-Host 'Menyalakan web server Vite...' -ForegroundColor Cyan
        Start-Process `
            -FilePath 'npm.cmd' `
            -ArgumentList @('run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173') `
            -WorkingDirectory $webAppPath `
            -WindowStyle Hidden

        $serverDeadline = (Get-Date).AddSeconds(45)
        do {
            Start-Sleep -Milliseconds 500
            $viteListener = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
        } until ($viteListener -or (Get-Date) -ge $serverDeadline)

        if (-not $viteListener) {
            throw 'Vite tidak berhasil membuka port 5173 dalam 45 detik.'
        }
    }

    Write-Host 'Menghubungkan web server ke emulator...' -ForegroundColor Cyan
    & $adbPath -s $serial reverse tcp:5173 tcp:5173
    if ($LASTEXITCODE -ne 0) {
        throw 'adb reverse gagal. Restart emulator lalu coba lagi.'
    }

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
