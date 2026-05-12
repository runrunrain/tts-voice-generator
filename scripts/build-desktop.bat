@echo off
setlocal
cd /d "%~dp0\.."
npm run desktop:target -- --platform win32 --arch x64
exit /b %ERRORLEVEL%
