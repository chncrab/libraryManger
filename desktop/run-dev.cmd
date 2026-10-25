@echo off
rem Double click to launch the development build.
rem Renders via Vite dev server (hot reload) against data\library.db.
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
node scripts\dev.mjs --disable-gpu --in-process-gpu
if errorlevel 1 pause
