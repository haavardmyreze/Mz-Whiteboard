@echo off
setlocal
title Stop Boards by Myreze
if "%PORT%"=="" set PORT=4680

echo.
echo  Asking Boards by Myreze on port %PORT% to save and shut down...
powershell -NoProfile -Command "try{Invoke-WebRequest -UseBasicParsing -Method Post http://127.0.0.1:%PORT%/__shutdown -TimeoutSec 3 | Out-Null; exit 0}catch{exit 1}"
if errorlevel 1 (
  echo  Boards by Myreze was not running, or did not respond.
) else (
  ping -n 3 127.0.0.1 >nul
  powershell -NoProfile -Command "try{Invoke-WebRequest -UseBasicParsing http://127.0.0.1:%PORT%/healthz -TimeoutSec 3 | Out-Null; exit 1}catch{exit 0}"
  if errorlevel 1 (echo  It is still answering. Close its window or press Ctrl+C there.) else (echo  Boards by Myreze has stopped. Your boards were saved.)
)
echo.
pause
