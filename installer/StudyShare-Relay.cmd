@echo off
rem The installed StudyShare relay PC: sends the teacher's shared screen to part of the class.
rem Its settings (teacher PC address, relay key, name, seats) are in
rem %ProgramData%\StudyShare\relay.txt, which setup writes. Close the window to stop the relay.
setlocal
title StudyShare relay
set "SETTINGS=%ProgramData%\StudyShare\relay.txt"
set "MEDIASOUP_WORKER_BIN=%~dp0mediasoup-worker.exe"

:run
"%~dp0node.exe" --env-file-if-exists="%SETTINGS%" "%~dp0server\relay.mjs"
set "CODE=%errorlevel%"
rem 3 = the media worker stopped (start again), 2 = wrong key, anything else = settings or port problem.
if "%CODE%"=="3" (
  echo Restarting in 5 seconds. Close this window to stop the relay.
  "%SystemRoot%\System32\ping.exe" -n 6 127.0.0.1 >nul
  goto run
)
echo.
echo Fix the settings in the Notepad window that opens, save them, and start the relay again.
start "" "%SystemRoot%\System32\notepad.exe" "%SETTINGS%"
pause
exit /b 1
