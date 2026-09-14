@echo off
rem DeepSeek Harness local launcher (dev tree)
cd /d "%~dp0"
if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" . --no-sandbox --disable-gpu
) else (
  echo [DeepSeek Harness] Dependencies not installed.
  echo Run first: npm install
  pause
)
