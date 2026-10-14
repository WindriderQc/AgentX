Option Explicit

' Task Scheduler starts this GUI-subsystem host without allocating a console.
' Hide PowerShell from process creation, rather than after its window appears.
Dim shell, files, command, argument, status
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")

command = QuoteArgument(shell.ExpandEnvironmentStrings( _
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")) _
  & " -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " _
  & QuoteArgument(files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), _
    "sync-codex-usage-to-prod.ps1"))

For Each argument In WScript.Arguments
  command = command & " " & QuoteArgument(argument)
Next

' Wait so the scheduled task retains its overlap policy and actual exit code.
status = shell.Run(command, 0, True)
WScript.Quit status

Function QuoteArgument(value)
  Dim result, slashes, position, character
  result = Chr(34)
  slashes = 0
  For position = 1 To Len(value)
    character = Mid(value, position, 1)
    If character = "\" Then
      slashes = slashes + 1
    ElseIf character = Chr(34) Then
      result = result & String(slashes * 2 + 1, "\") & character
      slashes = 0
    Else
      result = result & String(slashes, "\") & character
      slashes = 0
    End If
  Next
  QuoteArgument = result & String(slashes * 2, "\") & Chr(34)
End Function
