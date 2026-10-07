@echo off
setlocal
cd /d "%~dp0"
title Wipboard server
if "%PORT%"=="" set PORT=4680

call :check
if "%UP%"=="1" (
  echo.
  echo  Wipboard is already running on port %PORT%.
  echo  Open http://localhost:%PORT% in your browser, or run stop.bat to shut it down.
  echo.
  pause
  exit /b 0
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund || goto :error
)

echo.
echo  ==================== Wipboard ====================
echo   Leave this window open while you use the tool.
echo   Stop it with Ctrl+C here, or run stop.bat.
echo   Check it is running with status.bat.
echo  ==================================================
echo.

rem Open the browser once the server answers.
start "" /b powershell -NoProfile -Command "for($i=0;$i -lt 30;$i++){try{Invoke-WebRequest -UseBasicParsing http://127.0.0.1:%PORT%/healthz -TimeoutSec 1 | Out-Null; Start-Process http://localhost:%PORT%; break}catch{Start-Sleep -Milliseconds 500}}"

node server.js
set CODE=%ERRORLEVEL%

echo.
if "%CODE%"=="0" (
  echo  Wipboard has stopped.
) else (
  echo  Wipboard stopped unexpectedly ^(exit code %CODE%^). Check the messages above.
  echo  If it says the port is in use, another copy may already be running: try stop.bat.
)
echo.
pause
exit /b %CODE%

:check
set UP=0
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:%PORT%/healthz -TimeoutSec 3).StatusCode | Out-Null; exit 0}catch{exit 1}"
if not errorlevel 1 set UP=1
exit /b 0

:error
echo.
echo Could not install dependencies. Is Node.js installed? https://nodejs.org
pause
exit /b 1
