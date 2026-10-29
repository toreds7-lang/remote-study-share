@echo off
rem StudyShare relay PC: sends the teacher's shared screen to part of the class.
rem   run-relay.bat http://<teacher PC>:3000 <relay key> [name] [seats]
rem Without arguments it asks once and remembers the answers in relay.txt.
rem The teacher sees the address and the key under the screen-share menu (relay PC instructions).
setlocal
cd /d "%~dp0"
title StudyShare relay
set "MEDIASOUP_WORKER_BIN=%~dp0mediasoup-worker.exe"
set "ORIGIN=%~1"
set "RELAY_KEY=%~2"
if not "%~3"=="" set "RELAY_NAME=%~3"
if not "%~4"=="" set "RELAY_SEATS=%~4"
if "%ORIGIN%"=="" if exist relay.txt for /f "usebackq tokens=1,2" %%a in ("relay.txt") do (
  set "ORIGIN=%%a"
  set "RELAY_KEY=%%b"
)
if "%ORIGIN%"=="" set /p "ORIGIN=Teacher PC address (e.g. http://10.0.0.5:3000): "
if "%RELAY_KEY%"=="" set /p "RELAY_KEY=Relay key: "
>relay.txt echo %ORIGIN% %RELAY_KEY%

:run
rem Full paths: Windows may be set not to run programs from the current folder.
"%~dp0node.exe" "%~dp0relay.mjs" --origin "%ORIGIN%" --key "%RELAY_KEY%"
set "CODE=%errorlevel%"
rem 3 = the media worker stopped (start again), 2 = wrong key, anything else = settings or port problem.
if "%CODE%"=="3" (
  echo Restarting in 5 seconds. Close this window to stop the relay.
  "%SystemRoot%\System32\ping.exe" -n 6 127.0.0.1 >nul
  goto run
)
if "%CODE%"=="2" del relay.txt 2>nul
pause
exit /b 1
