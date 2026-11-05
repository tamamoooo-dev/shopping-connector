' Runs the Mini marts PC reader with no window (Task Scheduler, every 15 min;
' install-task.ps1). Waits for it to finish, so runs never overlap.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
WScript.Quit shell.Run("node reader.mjs", 0, True)
