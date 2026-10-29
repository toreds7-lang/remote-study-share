# Opens Windows Firewall for StudyShare screen sharing. Run it through firewall.bat, which asks
# for administrator rights. The rules apply to the Domain and Private network profiles only.
[CmdletBinding(SupportsShouldProcess)]
param(
  # The StudyShare page. 0 on relay PCs, which serve no page.
  [int]$WebPort = 3000,
  # WebRTC to students (UDP, and TCP for networks that block UDP). The 99 UDP ports after it
  # carry the screen between the teacher's PC and relay PCs.
  [int]$ScreenPort = 3001,
  # Delete the rules this script made.
  [switch]$Remove,
  # Keep the window open at the end (firewall.bat runs this in a new window).
  [switch]$Pause
)
$ErrorActionPreference = 'Stop'

try {
  Get-NetFirewallRule -DisplayName 'StudyShare *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  if ($Remove) {
    Write-Host 'Removed the StudyShare firewall rules.'
    return
  }

  $last = $ScreenPort + 99
  $rules = @()
  if ($WebPort -gt 0) { $rules += @{ DisplayName = "StudyShare page (TCP $WebPort)"; Protocol = 'TCP'; LocalPort = "$WebPort" } }
  $rules += @{ DisplayName = "StudyShare screen sharing (UDP $ScreenPort-$last)"; Protocol = 'UDP'; LocalPort = "$ScreenPort-$last" }
  $rules += @{ DisplayName = "StudyShare screen sharing (TCP $ScreenPort)"; Protocol = 'TCP'; LocalPort = "$ScreenPort" }
  foreach ($rule in $rules) {
    New-NetFirewallRule @rule -Direction Inbound -Action Allow -Profile Domain, Private | Out-Null
    Write-Host "Allowed: $($rule.DisplayName)"
  }

  # Closing Windows' "allow access" prompt without allowing leaves Block rules for node.exe or
  # mediasoup-worker.exe, and a Block rule wins over any Allow rule.
  $blocks = Get-NetFirewallApplicationFilter |
    Where-Object { $_.Program -match '\\(node|mediasoup-worker)\.exe$' } |
    Get-NetFirewallRule |
    Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' }
  foreach ($block in $blocks) {
    Write-Host "Removed block rule: $($block.DisplayName)"
    $block | Remove-NetFirewallRule
  }

  $public = @(Get-NetConnectionProfile | Where-Object NetworkCategory -eq 'Public')
  if ($public.Count) {
    Write-Warning ("Network '{0}' is set to Public, where these rules don't apply. Set it to Private " +
      "(Settings > Network > Properties) or ask IT." -f ($public.Name -join ', '))
  }
  Write-Host 'Done. If screen sharing still cannot connect, a company firewall policy may override these rules; ask IT.'
} catch {
  Write-Host "Failed: $($_.Exception.Message)" -ForegroundColor Red
} finally {
  if ($Pause) { Read-Host 'Press Enter to close' | Out-Null }
}
