@echo off
rem Double click to launch the development build.
rem Renders via Vite dev server (hot reload) against data\library.db.
rem Node and Electron write UTF-8 to stdout. The console defaults to 936 on a
rem Chinese Windows, which turns every log line into mojibake, so switch it.
chcp 65001 >nul
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
rem 别加 --disable-gpu：关掉 GPU 合成之后整屏都走软件光栅，缩放时掉到个位数帧。
rem 这台机器上 ANGLE + D3D11（NVIDIA）是好的，gpu_compositing 也是 enabled。
node scripts\dev.mjs
if errorlevel 1 pause
