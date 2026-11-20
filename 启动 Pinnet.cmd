@echo off
rem 双击启动 Pinnet（开发版）
rem 注意：不要直接双击 node_modules\electron\dist\electron.exe ——
rem 那只是运行时外壳，不带项目路径会弹 "Error launching app"。

setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="

if exist "%~dp0out\main\index.js" goto launch
echo 正在编译...
call npm run compile
if errorlevel 1 (
  echo 编译失败，请查看上面的错误。
  pause
  exit /b 1
)

:launch
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
endlocal
