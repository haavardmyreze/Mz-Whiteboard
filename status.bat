@echo off
setlocal
title Wipboard status
if "%PORT%"=="" set PORT=4680

powershell -NoProfile -Command "try{Invoke-WebRequest -UseBasicParsing http://127.0.0.1:%PORT%/healthz -TimeoutSec 3 | Out-Null; exit 0}catch{exit 1}"
echo.
if errorlevel 1 (
  echo  Wipboard is NOT running ^(nothing answering on port %PORT%^).
  echo  Start it with start.bat.
) else (
  echo  Wipboard is RUNNING.
  echo.
  echo    This machine:   http://localhost:%PORT%
  powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } | ForEach-Object { '    On the network: http://' + $_.IPAddress + ':%PORT%' }; '    By hostname:    http://' + $env:COMPUTERNAME + ':%PORT%'"
  echo.
  echo  If others cannot connect, Windows Firewall may be blocking port %PORT%.
)
echo.
pause
