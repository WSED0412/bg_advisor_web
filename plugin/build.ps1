# Build BgAdvisorBridge.dll (an HDT plugin) with the C# compiler from Visual Studio Build Tools.
#
#   powershell -ExecutionPolicy Bypass -File plugin\build.ps1            # build into plugin\dist
#   powershell -ExecutionPolicy Bypass -File plugin\build.ps1 -Install   # also copy into HDT's Plugins

param([switch]$Install)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$csc = Get-ChildItem "C:\Program Files (x86)\Microsoft Visual Studio", "C:\Program Files\Microsoft Visual Studio" `
         -Filter csc.exe -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'Roslyn' } |
       Select-Object -First 1 -ExpandProperty FullName
if (-not $csc) { throw "找不到 Roslyn csc.exe（請安裝 Visual Studio Build Tools 的 .NET 桌面組建工具）" }

$hdtRoot = Join-Path $env:LOCALAPPDATA "HearthstoneDeckTracker"
$hdt = Get-ChildItem $hdtRoot -Directory -Filter "app-*" | Sort-Object { [Version]($_.Name -replace '^app-', '') } |
       Select-Object -Last 1 -ExpandProperty FullName
if (-not $hdt) { throw "找不到 Hearthstone Deck Tracker（$hdtRoot）" }

$fw = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319"
$refs = @(
  (Join-Path $hdt "HearthstoneDeckTracker.exe"),
  "$fw\System.dll", "$fw\System.Core.dll", "$fw\System.Xaml.dll", "$fw\System.IO.Compression.dll",
  "$fw\WPF\PresentationFramework.dll", "$fw\WPF\PresentationCore.dll", "$fw\WPF\WindowsBase.dll"
)
$dist = Join-Path $here "dist"
New-Item -ItemType Directory -Force $dist | Out-Null
$out = Join-Path $dist "BgAdvisorBridge.dll"
$src = Get-ChildItem (Join-Path $here "src") -Filter *.cs | Select-Object -ExpandProperty FullName

$args = @("/nologo", "/target:library", "/optimize+", "/langversion:latest", "/out:$out") +
        ($refs | ForEach-Object { "/reference:$_" }) + $src
& $csc @args
if ($LASTEXITCODE -ne 0) { throw "編譯失敗" }
Write-Host "已建置：$out（HDT $([IO.Path]::GetFileName($hdt))）" -ForegroundColor Green

if ($Install) {
  $plugins = Join-Path $env:APPDATA "HearthstoneDeckTracker\Plugins"
  New-Item -ItemType Directory -Force $plugins | Out-Null
  Copy-Item $out $plugins -Force
  Write-Host "已安裝到 $plugins。重新啟動 HDT，到 選項 > 追蹤器 > 外掛 啟用「BG Advisor」。" -ForegroundColor Green
}
