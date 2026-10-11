# Converts an Office file to PDF through the installed Microsoft Office (COM automation).
# Called by server/convert.ts:  powershell -File office-to-pdf.ps1 -App powerpoint -In a.pptx -Out a.pdf
# The ids of Office processes this script starts are written to "<Out>.pid", so the server
# can end them if a hidden dialog makes the conversion hang.
param(
  [Parameter(Mandatory)][ValidateSet('powerpoint', 'word', 'excel')][string]$App,
  [Parameter(Mandatory)][string]$In,
  [Parameter(Mandatory)][string]$Out
)
$ErrorActionPreference = 'Stop'
# msoAutomationSecurityForceDisable: never run macros in uploaded files.
$NoMacros = 3

function Start-Office([string]$progId, [string]$processName) {
  $before = @(Get-Process $processName -ErrorAction SilentlyContinue | ForEach-Object Id)
  $app = New-Object -ComObject $progId
  $started = @(Get-Process $processName -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | ForEach-Object Id)
  Set-Content -Path "$Out.pid" -Value ($started -join ',') -Encoding Ascii
  return $app
}

switch ($App) {
  'powerpoint' {
    # PowerPoint runs as a single instance, so this may attach to one the user has open.
    $ppt = Start-Office 'PowerPoint.Application' 'POWERPNT'
    try {
      $ppt.AutomationSecurity = $NoMacros
      # ReadOnly = msoTrue, Untitled = msoFalse, WithWindow = msoFalse
      $pres = $ppt.Presentations.Open($In, -1, 0, 0)
      try { $pres.SaveAs($Out, 32) }  # ppSaveAsPDF
      finally { $pres.Close() }
    } finally {
      # Only quit if no other presentations (e.g. the teacher's own) are open.
      if ($ppt.Presentations.Count -eq 0) { $ppt.Quit() }
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($ppt)
    }
  }
  'word' {
    $word = Start-Office 'Word.Application' 'WINWORD'
    try {
      $word.Visible = $false
      $word.DisplayAlerts = 0
      $word.AutomationSecurity = $NoMacros
      # FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, PasswordDocument: a dummy password
      # makes protected files fail instead of waiting for someone to type one.
      $doc = $word.Documents.Open($In, $false, $true, $false, '!')
      try { $doc.ExportAsFixedFormat($Out, 17) }  # wdExportFormatPDF
      finally { $doc.Close([ref]0) }  # wdDoNotSaveChanges; Word wants these by reference
    } finally {
      $word.Quit([ref]0)
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)
    }
  }
  'excel' {
    $excel = Start-Office 'Excel.Application' 'EXCEL'
    try {
      $excel.Visible = $false
      $excel.DisplayAlerts = $false
      $excel.AutomationSecurity = $NoMacros
      # Filename, UpdateLinks, ReadOnly, Format, Password
      $book = $excel.Workbooks.Open($In, 0, $true, 5, '!')
      try { $book.ExportAsFixedFormat(0, $Out) }  # xlTypePDF
      finally { $book.Close($false) }
    } finally {
      $excel.Quit()
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
    }
  }
}
