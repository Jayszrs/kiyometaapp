@echo off
setlocal EnableExtensions

set "REAL_FLUTTER="
for /f "delims=" %%F in ('where flutter.bat 2^>nul') do if not defined REAL_FLUTTER set "REAL_FLUTTER=%%F"

if not defined REAL_FLUTTER (
    echo Flutter asli tidak ditemukan di PATH.
    echo Pastikan Flutter SDK sudah terpasang, lalu buka ulang terminal VS Code.
    exit /b 1
)

if /i not "%~1"=="run" goto passthrough
if not "%~2"=="" goto passthrough

echo Connected devices:
echo Windows (desktop)      ^> windows       ^> windows-x64
echo Chrome (web)           ^> chrome        ^> web-javascript
echo Edge (web)             ^> edge          ^> web-javascript
echo Kiyometa Tablet        ^> Android 14    ^> Pixel Tablet emulator
echo [1]: Windows (windows)
echo [2]: Chrome (chrome)
echo [3]: Edge (edge)
echo [4]: Kiyometa Tablet (android emulator)

:choose_device
set "DEVICE_CHOICE="
set /p "DEVICE_CHOICE=Please choose one (or q to quit): "
if errorlevel 1 exit /b 1

if /i "%DEVICE_CHOICE%"=="q" exit /b 0
if "%DEVICE_CHOICE%"=="1" (
    call "%REAL_FLUTTER%" run -d windows
    exit /b %ERRORLEVEL%
)
if "%DEVICE_CHOICE%"=="2" (
    call "%REAL_FLUTTER%" run -d chrome
    exit /b %ERRORLEVEL%
)
if "%DEVICE_CHOICE%"=="3" (
    call "%REAL_FLUTTER%" run -d edge
    exit /b %ERRORLEVEL%
)
if "%DEVICE_CHOICE%"=="4" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\tool\start-tablet-emulator.ps1" -RunApp
    exit /b %ERRORLEVEL%
)

echo Pilihan tidak valid. Gunakan 1, 2, 3, 4, atau q.
goto choose_device

:passthrough
call "%REAL_FLUTTER%" %*
exit /b %ERRORLEVEL%
