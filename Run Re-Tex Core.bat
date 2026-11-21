@echo off
rem Double-click to launch Re-Tex Core (opens in your default browser at http://127.0.0.1:8770).
rem Close this console window to stop the local server.
cd /d "%~dp0"
title Re-Tex Core

rem 1) Prefer local portable .venv if installed (laptop / standalone clone)
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -m retex_core %*
  if errorlevel 1 pause
  exit /b
)

rem 2) Otherwise reuse shared Re-Tex environment on this PC (zero duplication)
set "PY=F:\mashup_lab\.venv-phase2\Scripts\python.exe"
if not exist "%PY%" (
  echo.
  echo   Re-Tex Core is not installed yet.
  echo   Run "install.bat" first to create a portable .venv environment.
  echo.
  pause
  exit /b 1
)
"%PY%" -m retex_core %*
if errorlevel 1 pause
