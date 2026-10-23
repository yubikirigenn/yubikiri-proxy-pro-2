@echo off
rem Yubikiri hostname-mode launcher (double-click me). Starts the local relay,
rem waits for its CA, then runs scripts\hostname-setup.ps1 (installs the CA and
rem sets the system proxy). Keep this file ASCII-only for cmd.exe.
cd /d "%~dp0"
if not exist ".env" (
  echo === Yubikiri hostname-mode first-time setup ^(answers saved to .env^) ===
  call npm run setup-agent
  if errorlevel 1 (echo Setup failed. & pause & exit /b 1)
)
start "Yubikiri hostname-agent" cmd /k npm run hostname-agent
echo Waiting for the local CA to be generated...
set /a WAITED=0
:waitloop
if exist "%USERPROFILE%\.yubikiri-hostname\ca.cert.pem" goto setup
if %WAITED% GEQ 60 goto fail
timeout /t 1 /nobreak >nul
set /a WAITED+=1
goto waitloop
:fail
echo Could not confirm the agent startup. Check the other window.
pause
exit /b 1
:setup
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\hostname-setup.ps1
echo.
echo Hostname mode enabled. Restart your browser to apply.
echo To revert, run scripts\hostname-teardown.ps1
pause
