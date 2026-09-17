@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tool\start-tablet-emulator.ps1" -RunApp %*

