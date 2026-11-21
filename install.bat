@echo off
setlocal enabledelayedexpansion
title Re-Tex Core - Portable Standalone Installer
cd /d "%~dp0"

echo.
echo  ============================================================
echo   Re-Tex Core - Standalone Portable Installer (Windows)
echo  ============================================================
echo.

where python >nul 2>&1
if errorlevel 1 (
  echo  [ERROR] Python 3.11-3.13 not found on PATH.
  echo  Download from https://www.python.org/downloads/ and check "Add Python to PATH".
  pause
  exit /b 1
)

where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo  [WARN] ffmpeg not found on PATH. MP3 export/import requires ffmpeg.
  echo         Install quickly with: winget install Gyan.FFmpeg
  echo.
)

if not exist ".venv\Scripts\python.exe" (
  echo  [1/3] Creating local portable virtual environment (.venv)...
  python -m venv .venv
  if errorlevel 1 (
    echo  [ERROR] Failed to create .venv
    pause
    exit /b 1
  )
)

echo  [2/3] Installing Re-Tex Core DAW dependencies...
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
  echo  [ERROR] Failed to install core dependencies.
  pause
  exit /b 1
)

echo.
echo  [3/3] Optional: Install Standalone AI Stem Separation (Mel-Band Roformer + HTDemucs)?
echo        (Auto-downloads model checkpoints on first song import into .\data\models\)
echo.
echo    [1] NVIDIA GPU (CUDA) - Fastest, recommended if laptop/PC has RTX/GTX GPU
echo    [2] CPU Only          - Works on any laptop (slower separation)
echo    [3] Skip for now      - Core DAW only (import pre-separated songs or install later)
echo.
set /p SEP_CHOICE="Choose [1 / 2 / 3] (default 3): "

if "%SEP_CHOICE%"=="1" (
  echo  Installing PyTorch CUDA + audio-separator...
  ".venv\Scripts\python.exe" -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
  ".venv\Scripts\python.exe" -m pip install -r requirements-standalone.txt
) else if "%SEP_CHOICE%"=="2" (
  echo  Installing PyTorch CPU + audio-separator...
  ".venv\Scripts\python.exe" -m pip install torch torchaudio
  ".venv\Scripts\python.exe" -m pip install -r requirements-standalone.txt
) else (
  echo  Skipped standalone AI separation install (can run install.bat again anytime).
)

echo.
echo  Done! Double-click "Run Re-Tex Core.bat" to launch Re-Tex Core.
echo.
pause
