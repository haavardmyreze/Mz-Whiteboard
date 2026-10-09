@echo off
setlocal
title Boards by Myreze public tunnel
set "CF=cloudflared"
where cloudflared >nul 2>nul
if errorlevel 1 (
  rem A window opened before the install does not know the new program yet, so look where it is installed.
  if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" (
    set "CF=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
  ) else if exist "%ProgramFiles%\cloudflared\cloudflared.exe" (
    set "CF=%ProgramFiles%\cloudflared\cloudflared.exe"
  ) else (
    echo.
    echo  cloudflared is not installed. Install it once with:
    echo      winget install Cloudflare.cloudflared
    echo  then run tunnel.bat again.
    echo.
    pause
    exit /b 1
  )
)
if "%PORT%"=="" set PORT=4680
echo.
echo  ================= Public tunnel =================
echo   Boards by Myreze (start.bat) must be running first.
echo   Look below for a line with an address like
echo       https://something-random.trycloudflare.com
echo   That is the address to share. Share it together
echo   with the team password. It changes every time
echo   this window is started, and stops when you close it.
echo  =================================================
echo.
"%CF%" tunnel --url http://localhost:%PORT%
echo.
echo  The tunnel has stopped.
pause
