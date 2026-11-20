@echo off
rem Etsy kontrol panelini kapatip yeniden acar
timeout /t 2 /nobreak >nul
taskkill /IM electron.exe /F >nul 2>&1
timeout /t 3 /nobreak >nul
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" .
