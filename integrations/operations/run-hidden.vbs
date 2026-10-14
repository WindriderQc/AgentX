Option Explicit

' A task's original command line lives in a private UTF-16 configuration file.
' Run it without allocating a visible console, retaining its arguments exactly.
If WScript.Arguments.Count <> 1 Then WScript.Quit 2

Dim files, configuration, command, shell, status
Set files = CreateObject("Scripting.FileSystemObject")
If Not files.FileExists(WScript.Arguments(0)) Then WScript.Quit 2
Set configuration = files.OpenTextFile(WScript.Arguments(0), 1, False, -1)
command = Trim(configuration.ReadAll)
configuration.Close
If Len(command) = 0 Or InStr(command, vbCr) > 0 Or InStr(command, vbLf) > 0 Then
  WScript.Quit 2
End If

Set shell = CreateObject("WScript.Shell")
' Waiting keeps the native task's overlap policy and child exit code meaningful.
On Error Resume Next
status = shell.Run(command, 0, True)
If Err.Number <> 0 Then WScript.Quit 1
On Error GoTo 0
WScript.Quit status
