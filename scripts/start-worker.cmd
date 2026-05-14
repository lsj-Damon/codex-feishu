@echo off
setlocal
cd /d "%~dp0\.."
node dist\apps\assistant-worker\main.js

