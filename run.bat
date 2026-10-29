@echo off
rem Double-click to start Study Share: installs dependencies on the first run,
rem rebuilds the client when its source has changed, starts the server and
rem opens the browser. Close this window (or press Ctrl+C) to stop the server.
setlocal
cd /d "%~dp0"
title Study Share

rem Node is installed in Program Files but is not always on PATH (nor, in some
rem shells, System32 with findstr/timeout).
set "PATH=%SystemRoot%\System32;%PATH%"
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
node --version >nul 2>nul || (
  echo Node.js was not found. Install Node.js 22.13 or newer from https://nodejs.org
  goto :fail
)

rem Port, with the same precedence as server/config.ts: environment, .env, env.txt.
set "APP_PORT="
for %%f in (env.txt .env) do if exist "%%f" (
  for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"PORT=" "%%f"') do set "APP_PORT=%%b"
)
if defined PORT set "APP_PORT=%PORT%"
if not defined APP_PORT set "APP_PORT=3000"
set "URL=http://localhost:%APP_PORT%"

rem Already running (e.g. double-clicked twice)? Just open the browser.
"%SystemRoot%\System32\curl.exe" -s -m 2 "http://127.0.0.1:%APP_PORT%/" 2>nul | findstr /l /c:"<title>StudyShare</title>" >nul && (
  echo Study Share is already running at %URL%
  start "" "%URL%"
  timeout /t 3 >nul 2>nul
  exit /b 0
)

if not exist "node_modules\" (
  echo Installing dependencies, first run only...
  call npm install || goto :fail
)

rem Rebuild dist/ only if client/, shared/, vite.config.ts or package-lock.json changed since the last build.
node -e "const fs=require('fs'),path=require('path');const mtime=f=>{try{return fs.statSync(f).mtimeMs}catch{return 0}};const built=mtime('dist/index.html');const src=['client','shared'].flatMap(d=>fs.readdirSync(d,{recursive:true}).map(f=>path.join(d,f)));process.exit(built&&[...src,'vite.config.ts','package-lock.json'].every(f=>mtime(f)<=built)?0:1)" || (
  echo Building the client...
  call npm run build || goto :fail
)

rem Open the browser once the server answers (gives up after 2 minutes).
start "" /b "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "$ProgressPreference = 'SilentlyContinue'; for ($i = 0; $i -lt 120; $i++) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:%APP_PORT%/' | Out-Null; Start-Process '%URL%'; break } catch { Start-Sleep 1 } }"

echo Starting Study Share. Close this window or press Ctrl+C to stop it.
call npm start
echo.
echo Study Share has stopped.
pause
exit /b 0

:fail
echo.
echo Study Share could not start. See the messages above.
pause
exit /b 1
