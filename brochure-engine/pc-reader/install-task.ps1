# Installs the Mini marts PC reader as a Windows scheduled task: every 15
# minutes while the owner is logged on, with no window, on battery too; a run
# still going when the next one is due is left alone. Run once from this
# folder after `npm install`:  powershell -ExecutionPolicy Bypass -File install-task.ps1
# Remove it with:  Unregister-ScheduledTask -TaskPath '\SuperSearch\' -TaskName 'MiniMartsReader'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + (Join-Path $dir 'run-hidden.vbs') + '"') -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 45)
Register-ScheduledTask -TaskPath '\SuperSearch\' -TaskName 'MiniMartsReader' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Mini marts PC reader: Claude Haiku 5.5 reads the shops'' Snapchat offer pictures for the brochure engine (pc-reader/reader.mjs).' -Force | Out-Null
Get-ScheduledTask -TaskPath '\SuperSearch\' -TaskName 'MiniMartsReader' | Select-Object TaskName, State
