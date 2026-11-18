# Installs the Vision PC reader as a Windows scheduled task: every 5 minutes
# while the owner is logged on, with no window, on battery too; a run still
# going when the next one is due is left alone. Run once from this folder
# after `npm install`:  powershell -ExecutionPolicy Bypass -File install-vision-task.ps1
# Remove it with:  Unregister-ScheduledTask -TaskPath '\SuperSearch\' -TaskName 'VisionReader'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + (Join-Path $dir 'run-vision-hidden.vbs') + '"') -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 60)
Register-ScheduledTask -TaskPath '\SuperSearch\' -TaskName 'VisionReader' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Vision PC reader: Claude Haiku 5.5 reads new flyer crops (names, brand, size) for the brochure engine, one reading a crop (pc-reader/vision.mjs).' -Force | Out-Null
Get-ScheduledTask -TaskPath '\SuperSearch\' -TaskName 'VisionReader' | Select-Object TaskName, State
