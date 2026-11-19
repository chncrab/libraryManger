@echo off
rem Double click to launch the development build.
rem Renders via Vite dev server (hot reload) against data\library.db.
rem Node and Electron write UTF-8 to stdout. The console defaults to 936 on a
rem Chinese Windows, which turns every log line into mojibake, so switch it.
chcp 65001 >nul
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
rem Do not pass --disable-gpu / --in-process-gpu. Software rasterizing makes zoom stutter.
rem ANGLE + D3D11 (NVIDIA) is fine on this machine, gpu_compositing is enabled.
node scripts\dev.mjs
if errorlevel 1 pause
