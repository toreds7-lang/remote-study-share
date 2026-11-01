@echo off
rem The installed StudyShare (teacher's PC): starts the server in this window and opens the
rem browser. Close the window (or press Ctrl+C) to stop it. Settings (env.txt) and class data
rem are in %ProgramData%\StudyShare, since this folder under Program Files is read-only.
setlocal
title Study Share
set "STUDYSHARE_HOME=%ProgramData%\StudyShare"
set "MEDIASOUP_WORKER_BIN=%~dp0mediasoup-worker.exe"
set "PATH=%SystemRoot%\System32;%PATH%"

rem Port, with the same precedence as server/config.ts: environment, .env, env.txt.
set "APP_PORT="
for %%f in ("%STUDYSHARE_HOME%\env.txt" "%STUDYSHARE_HOME%\.env") do if exist "%%~f" (
  for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"PORT=" "%%~f"') do set "APP_PORT=%%b"
)
if defined PORT set "APP_PORT=%PORT%"
if not defined APP_PORT set "APP_PORT=3000"
set "URL=http://localhost:%APP_PORT%"

rem Already running (e.g. opened twice)? Just open the browser.
"%SystemRoot%\System32\curl.exe" -s -m 2 "http://127.0.0.1:%APP_PORT%/" 2>nul | findstr /l /c:"<title>StudyShare</title>" >nul && (
  echo Study Share is already running at %URL%
  start "" "%URL%"
  timeout /t 3 >nul 2>nul
  exit /b 0
)

rem Open the browser once the server answers (gives up after 2 minutes).
start "" /b "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "$ProgressPreference = 'SilentlyContinue'; for ($i = 0; $i -lt 120; $i++) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:%APP_PORT%/' | Out-Null; Start-Process '%URL%'; break } catch { Start-Sleep 1 } }"

echo Starting Study Share. Close this window or press Ctrl+C to stop it.
echo Settings: %STUDYSHARE_HOME%\env.txt
"%~dp0node.exe" --disable-warning=ExperimentalWarning "%~dp0server\server.mjs" --prod
echo.
echo Study Share has stopped.
pause
