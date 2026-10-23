@echo off
rem Yubikiri agent launcher (double-click me). Japanese guidance is printed
rem by the node scripts themselves; keep this file ASCII-only for cmd.exe.
cd /d "%~dp0"
if not exist ".env" (
  echo === Yubikiri agent first-time setup ^(answers saved to .env^) ===
  call npm run setup-agent
  if errorlevel 1 (echo Setup failed. & pause & exit /b 1)
)
echo === Yubikiri agent starting ^(close this window to stop^) ===
call npm run agent
pause
