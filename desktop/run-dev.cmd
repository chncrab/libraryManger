@echo off
rem Double click to launch the development build.
rem Renders via Vite dev server (hot reload) against data\library.db.
rem Node and Electron write UTF-8 to stdout. The console defaults to 936 on a
rem Chinese Windows, which turns every log line into mojibake, so switch it.
chcp 65001 >nul
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
node scripts\dev.mjs --disable-gpu --in-process-gpu
if errorlevel 1 pause
