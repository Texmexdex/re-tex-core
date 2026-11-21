@echo off
rem Double-click to launch Re-Tex Core in isolated Demo Mode (synthesizes 2 royalty-free 4-stem tracks
rem and opens a ready-to-play Demo Mashup without touching your main library).
cd /d "%~dp0"
title Re-Tex Core (Interactive Demo)

if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -m retex_core --demo %*
  if errorlevel 1 pause
  exit /b
)

set "PY=F:\mashup_lab\.venv-phase2\Scripts\python.exe"
if not exist "%PY%" (
  echo.
  echo   Run "install.bat" first to create a portable .venv environment.
  echo.
  pause
  exit /b 1
)
"%PY%" -m retex_core --demo %*
if errorlevel 1 pause
