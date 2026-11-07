@echo off
cd /d "%~dp0.."
node options_site/build.mjs
if errorlevel 1 goto failed
node options_site/local_bridge.mjs
if errorlevel 1 goto failed
exit /b 0
:failed
echo Please check Node.js 22 and port 8767.
pause
exit /b 1
