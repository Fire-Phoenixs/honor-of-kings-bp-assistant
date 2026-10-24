@echo off
rem HOK BP v2 launcher
cd /d "%~dp0"
node server.mjs --port 3721 --open
if errorlevel 1 pause

