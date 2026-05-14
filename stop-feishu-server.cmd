@echo off
setlocal

echo [INFO] Stopping Feishu Gateway...
taskkill /FI "WINDOWTITLE eq Feishu Gateway" /T /F >nul 2>nul

echo [INFO] Stopping Feishu Worker...
taskkill /FI "WINDOWTITLE eq Feishu Worker" /T /F >nul 2>nul

echo.
echo [OK] Stop commands issued.
pause
