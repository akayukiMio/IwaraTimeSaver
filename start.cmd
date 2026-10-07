@echo off
cd /d "%~dp0"
start http://127.0.0.1:8811/
if not exist state\tasks\nul mkdir state\tasks
if not exist logs\nul mkdir logs
powershell -NoProfile -ExecutionPolicy Bypass -Command "node server\server.mjs"
pause
