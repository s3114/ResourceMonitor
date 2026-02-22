@echo off
cd /d %~dp0
chcp 65001 >nul
@REM node "%~dp0server.js"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -WindowStyle Hidden -FilePath 'node' -ArgumentList '\"%~dp0server.js\"' -WorkingDirectory '%~dp0'"
pause
