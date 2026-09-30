@echo off
rem Build the MarioCode Windows installer locally.
rem   scripts\package-win.bat          full build (renderer + installer)
rem   scripts\package-win.bat --skip-build   installer only (reuse out\)
rem Output: apps\desktop\release\MarioCode-<version>-x64.exe
chcp 65001 >nul
setlocal
set "ROOT=%~dp0.."
cd /d "%ROOT%\apps\desktop" || exit /b 1

rem Mainland-China mirrors (github.com downloads often time out).
set "ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/"

rem electron-builder's winCodeSign archive contains two macOS symlinks that
rem 7-Zip cannot create without Windows Developer Mode; the extraction is
rem otherwise complete, so promote it to the name electron-builder expects.
node "%ROOT%\scripts\fix-wincodesign.mjs"

if /i "%~1"=="--skip-build" goto builder
call pnpm.cmd run build || goto fail
node -e "require('fs').rmSync('../../packages/contracts/dist',{recursive:true,force:true})" || goto fail
node build\dereference-workspace-symlinks.cjs || goto fail

:builder
call node_modules\.bin\electron-builder.cmd --publish never || goto fail
echo.
echo ===== done: %CD%\release =====
dir /b release\*.exe
goto end

:fail
echo.
echo ===== packaging FAILED (exit %ERRORLEVEL%) =====
:end
endlocal
