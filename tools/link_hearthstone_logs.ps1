# Move Hearthstone's Logs folder out of Program Files so a browser may read it.
#
# Chrome, Edge and Brave refuse to let a web page open folders under Program Files. This moves
# Logs to Documents\HearthstoneLogs and leaves a junction (a folder link) at the old place, so
# Hearthstone keeps writing to the same path. Close Hearthstone and Battle.net first.
#
#   powershell -ExecutionPolicy Bypass -File link_hearthstone_logs.ps1           # set up
#   powershell -ExecutionPolicy Bypass -File link_hearthstone_logs.ps1 -Undo     # put it back
#   ... -HearthstoneDir "D:\Games\Hearthstone"                                   # other install

param(
  [string]$HearthstoneDir = "C:\Program Files (x86)\Hearthstone",
  [string]$Target = (Join-Path ([Environment]::GetFolderPath("MyDocuments")) "HearthstoneLogs"),
  [switch]$Undo
)
$ErrorActionPreference = "Stop"
$logs = Join-Path $HearthstoneDir "Logs"

if (Get-Process -Name Hearthstone -ErrorAction SilentlyContinue) {
  Write-Host "請先關閉爐石再執行。" -ForegroundColor Yellow; exit 1
}

if ($Undo) {
  $item = Get-Item -LiteralPath $logs -Force -ErrorAction SilentlyContinue
  if (-not $item -or $item.LinkType -ne "Junction") { Write-Host "原位置不是連結，不需要還原。"; exit 0 }
  $item.Delete()  # removes only the link, never the files it points to
  Move-Item -LiteralPath $Target -Destination $logs
  Write-Host "已還原：Logs 回到 $logs" -ForegroundColor Green
  exit 0
}

$item = Get-Item -LiteralPath $logs -Force -ErrorAction SilentlyContinue
if ($item -and $item.LinkType -eq "Junction") {
  Write-Host "已經設定過了：$logs -> $($item.Target)" -ForegroundColor Green; exit 0
}
if (-not $item) { throw "找不到 $logs（爐石裝在別的位置？用 -HearthstoneDir 指定）" }
if (Test-Path -LiteralPath $Target) { throw "$Target 已經存在，請先改名或刪除" }

$before = Get-ChildItem -LiteralPath $logs -Recurse -File -Force | Measure-Object -Property Length -Sum
Move-Item -LiteralPath $logs -Destination $Target
try {
  New-Item -ItemType Junction -Path $logs -Target $Target | Out-Null
} catch {
  Move-Item -LiteralPath $Target -Destination $logs
  throw "建立連結失敗，已還原：$($_.Exception.Message)"
}
$after = Get-ChildItem -LiteralPath $Target -Recurse -File -Force | Measure-Object -Property Length -Sum

$probe = Join-Path $logs "_linktest.txt"
"x" | Out-File -LiteralPath $probe
$ok = Test-Path -LiteralPath (Join-Path $Target "_linktest.txt")
Remove-Item -LiteralPath $probe

Write-Host ("搬移 {0} 個檔案（{1:N1} MB），大小相符：{2}" -f $after.Count, ($after.Sum / 1MB), ($before.Sum -eq $after.Sum))
Write-Host "連結：$logs -> $Target，寫入測試：$ok"
Write-Host "完成。在網頁上選擇這個資料夾：$Target" -ForegroundColor Green
