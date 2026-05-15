@echo off
setlocal

pushd "%~dp0"

echo [INFO] Stopping managed Feishu gateway/worker processes...
powershell.exe -ExecutionPolicy Bypass -File "%~dp0scripts\manage-service-processes.ps1" -Mode stop

echo.
echo [OK] Stop commands issued.
pause
