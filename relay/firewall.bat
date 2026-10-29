@echo off
rem Opens Windows Firewall for a StudyShare relay PC (once). Asks for administrator rights.
rem   firewall.bat          screen sharing on UDP+TCP 3001 and pipes on UDP 3002-3100
rem   firewall.bat 4001     if the relay runs with SCREEN_PORT=4001
rem   firewall.bat remove   deletes the rules again
setlocal
set "SCREEN=%~1"
if "%SCREEN%"=="" set "SCREEN=3001"
set "ARGS=-WebPort 0 -ScreenPort %SCREEN%"
if /i "%~1"=="remove" set "ARGS=-Remove"
set "SCRIPT=%~dp0firewall.ps1"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%PS%" -NoProfile -Command "Start-Process -Verb RunAs -FilePath $env:PS -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File \"{0}\" {1} -Pause' -f $env:SCRIPT, $env:ARGS)"
