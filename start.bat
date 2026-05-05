@echo off
REM TTS Voice Generator - One-Click Quick Start (Windows)
REM Double-click this file to launch both frontend and backend.
REM Press Ctrl+C or close this window to stop all services.

title TTS Voice Generator - Quick Start

echo.
echo  TTS Voice Generator - Quick Start
echo  ==================================
echo.
echo  Starting frontend (Vite) and backend (Hono)...
echo  Frontend: http://localhost:5173
echo  Backend:  http://localhost:3001/api/health
echo.
echo  Press Ctrl+C or close this window to stop all services.
echo.

node "%~dp0scripts\start.js"

REM If the script exits (e.g. Ctrl+C), give a moment for cleanup
timeout /t 2 /nobreak >nul 2>&1
