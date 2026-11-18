' Runs the Vision PC reader with no window (Task Scheduler, every 5 min;
' install-vision-task.ps1). Waits for it to finish, so runs never overlap.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
WScript.Quit shell.Run("node vision.mjs", 0, True)
