@echo off
rem Double-click: open the last folder. Drop a folder onto this file: open that folder.
chcp 65001 >nul
cd /d "%~dp0"
if exist "runtime\python.exe" (
  "runtime\python.exe" review_viewer.py "%~1"
) else (
  where python >nul 2>nul
  if errorlevel 1 (
    echo The runtime is not installed yet. Run Install.bat in this folder once, then try again.
    pause
    exit /b 1
  )
  python review_viewer.py "%~1"
)
if errorlevel 1 (
  pause
  exit /b 1
)
