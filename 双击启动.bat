@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not available in PATH.
  echo Please install Node.js 24+ first.
  pause
  exit /b 1
)

if not exist ".env" (
  echo [ERROR] Missing .env in project root.
  echo Please create .env before starting.
  pause
  exit /b 1
)

if not exist "dist\apps\bot-gateway\main.js" (
  echo [INFO] Build output not found. Running build...
  call npm.cmd run build
  if errorlevel 1 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
  )
)

echo [INFO] Starting gateway window...
start "Feishu Gateway" cmd.exe /k "%~dp0scripts\start-gateway.cmd"

echo [INFO] Starting worker window...
start "Feishu Worker" cmd.exe /k "%~dp0scripts\start-worker.cmd"

echo.
echo [OK] Gateway and worker launch commands have been sent.
echo Close the opened windows or run "双击停止.bat" to stop them.
pause
