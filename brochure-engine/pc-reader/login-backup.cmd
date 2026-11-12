@echo off
rem Signs the Mini marts reader's BACKUP Claude account in. Run it once (double-click).
rem
rem The reader's main account is this PC's own Claude login. The backup is a
rem second Claude sign-in kept in its own folder (%USERPROFILE%\.claude-backup),
rem so the two never mix. Claude Code opens here: sign in with the BACKUP
rem account in the browser page it shows, then type /exit. The reader starts
rem using it on its next run, whenever the main account is at its limit.
setlocal
set "CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-backup"
if not exist "%CLAUDE_CONFIG_DIR%" mkdir "%CLAUDE_CONFIG_DIR%"
echo Sign in with the BACKUP Claude account, then type /exit.
echo.
call claude /login
echo.
if exist "%CLAUDE_CONFIG_DIR%\.credentials.json" (
  echo The backup account is signed in. The reader will use it when the main one is at its limit.
) else (
  echo No sign-in was saved. Run this again to try once more.
)
pause
