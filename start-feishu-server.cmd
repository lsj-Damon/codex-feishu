@echo off
setlocal

pushd "%~dp0"

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

echo [INFO] Building latest code...
call npm.cmd run build
if errorlevel 1 (
  echo [ERROR] Build failed.
  pause
  exit /b 1
)

echo [INFO] Stopping existing managed gateway/worker processes...
powershell.exe -ExecutionPolicy Bypass -File "%~dp0scripts\manage-service-processes.ps1" -Mode stop

echo [INFO] Starting gateway window...
start "Feishu Gateway" "%ComSpec%" /k call "%~dp0scripts\start-gateway.cmd"

echo [INFO] Starting worker window...
start "Feishu Worker" "%ComSpec%" /k call "%~dp0scripts\start-worker.cmd"

echo.
echo [OK] Gateway and worker launch commands have been sent.
echo Close the opened windows or run stop-feishu-server.cmd to stop them.
pause
