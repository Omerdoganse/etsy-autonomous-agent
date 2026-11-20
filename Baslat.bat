@echo off
chcp 65001 >nul
title Etsy Otonom Fabrika
cd /d "%~dp0"
if not exist ".env" copy ".env.example" ".env" >nul
if not exist "config.json" copy "config.example.json" "config.json" >nul

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js bulunamadi. Otomatik kuruluyor ^(winget^)...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  echo.
  echo Kurulum bitti. Lutfen bu pencereyi kapatip Baslat.bat dosyasina tekrar cift tiklayin.
  pause
  exit /b 0
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo ================================================
  echo  Ilk kurulum: paketler yukleniyor ^(2-5 dk^)...
  echo ================================================
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [X] npm install basarisiz. Internet baglantinizi kontrol edin.
    pause
    exit /b 1
  )
)

if not exist "data\base_mockups\mockups.json" (
  echo Mockup sablonlari olusturuluyor ^(ilk sefer, 1-3 dk^)...
  call node src\setup_mockups.js
)

echo Kontrol paneli aciliyor...
call npm run gui
