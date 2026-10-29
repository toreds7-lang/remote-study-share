@echo off
rem Opens Windows Firewall for StudyShare on the teacher's PC (once). Asks for administrator rights.
rem   firewall.bat          page on TCP 3000, screen sharing on UDP+TCP 3001, relay pipes on UDP 3002-3100
rem   firewall.bat 8080     if PORT in .env or env.txt is 8080 (screen sharing then uses 8081)
rem   firewall.bat remove   deletes the rules again
setlocal
set "WEB=%~1"
if "%WEB%"=="" set "WEB=3000"
set /a SCREEN=WEB+1
set "ARGS=-WebPort %WEB% -ScreenPort %SCREEN%"
if /i "%~1"=="remove" set "ARGS=-Remove"
set "SCRIPT=%~dp0firewall.ps1"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%PS%" -NoProfile -Command "Start-Process -Verb RunAs -FilePath $env:PS -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File \"{0}\" {1} -Pause' -f $env:SCRIPT, $env:ARGS)"
