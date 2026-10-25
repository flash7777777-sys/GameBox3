@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==========================================
echo   GameBox 3 独立 EXE 打包工具
echo   需要本机 Node.js 18+（仅构建需要）
echo ==========================================
echo.
where node >nul 2>nul
if %errorlevel%==0 (
  node tools\build.js
) else (
  echo [提示] 未在 PATH 找到 Node，尝试使用 WorkBuddy 内置 Node...
  "C:\Users\flash777\.workbuddy\binaries\node\versions\22.22.2\node.exe" tools\build.js
)
echo.
pause
