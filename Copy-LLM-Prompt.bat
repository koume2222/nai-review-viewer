@echo off
rem Copies the LLM connection prompt (with this PC's real paths) to the clipboard.
chcp 65001 >nul
cd /d "%~dp0"
if exist "runtime\python.exe" (
  "runtime\python.exe" review_viewer.py llm-prompt --copy
) else (
  python review_viewer.py llm-prompt --copy
)
pause
