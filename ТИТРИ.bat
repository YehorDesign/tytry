@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".next\BUILD_ID" (
  echo First run: building the app, takes a couple of minutes...
  call npm run build
  if errorlevel 1 (
    echo Build failed. See errors above.
    pause
    exit /b 1
  )
)
start "" /b npx electron .
exit /b 0
