@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund || goto :error
)
node server.js
goto :eof

:error
echo.
echo Could not install dependencies. Is Node.js installed? https://nodejs.org
pause
