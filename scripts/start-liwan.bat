@echo off
REM Windows: double-click to start The Liwan Ops (dashboard + 9pm / Sunday reports).
cd /d "%~dp0.."
if not exist data\inbox mkdir data\inbox
echo Starting The Liwan Ops - keep this window open. Dashboard: http://localhost:8787
npm start
