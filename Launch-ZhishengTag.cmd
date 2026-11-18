@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
set "ZHISHENG_ELECTRON=%~dp0runtime\electron.exe"
if not exist "%ZHISHENG_ELECTRON%" set "ZHISHENG_ELECTRON=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%ZHISHENG_ELECTRON%" (
  echo [ZhishengTag] Run npm install in the project folder first.
  pause
  exit /b 1
)
start "" "%ZHISHENG_ELECTRON%" "%~dp0."
