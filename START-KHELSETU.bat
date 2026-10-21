@echo off
cd /d "%~dp0"
title KhelSetu - Local Server
echo ==============================================
echo  KhelSetu - starting local website on port 5000
echo ==============================================
if not exist node_modules\ (
  echo Installing project packages for the first run...
  call npm install
  if errorlevel 1 (
    echo.
    echo Package installation failed. Check internet and npm error above.
    pause
    exit /b 1
  )
)
echo.
call npm start
pause
