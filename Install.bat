@echo off
setlocal
rem One-time setup for a source checkout: downloads a private Python runtime + Pillow + numpy into .\runtime.
rem Nothing is installed system-wide. The release zip already contains runtime\ and does not need this.
cd /d "%~dp0"
echo NAI Review Viewer - downloading the runtime into this folder's runtime\ (about 30 MB, 1-2 minutes)
echo.
rem Let Windows PowerShell load its own built-in modules when launched from pwsh.
set "PSModulePath="
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\install_runtime.ps1"
if errorlevel 1 (
  echo.
  echo Setup failed. Check your internet connection and run Install.bat again.
  pause
  exit /b 1
)
echo.
echo Done. Double-click NAI-Review-Viewer.bat to start.
pause
