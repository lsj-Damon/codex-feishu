@echo off
setlocal
pushd "%~dp0\.."
powershell.exe -ExecutionPolicy Bypass -File "%~dp0manage-service-processes.ps1" -Mode status
