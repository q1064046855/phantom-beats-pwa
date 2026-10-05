# ============ PHANTOM BEATS SCF 部署包构建 ============
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File build_scf.ps1
# 产出: phantom-beats-scf.zip（内含 index.js = tencent_worker.js + 内嵌站点 base64）
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$idx = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$here\index.html"))
$app = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$here\app.js"))
$wl  = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$here\mic_worklet.js"))
$js  = [IO.File]::ReadAllText("$here\tencent_worker.js")
$js = $js.Replace('/*__SITE_INDEX_B64__*/', $idx).Replace('/*__SITE_APP_B64__*/', $app).Replace('/*__SITE_WORKLET_B64__*/', $wl)
$tmp = Join-Path $env:TEMP ('scf-built-' + [guid]::NewGuid().ToString('N') + '.js')
[IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
Add-Type -AssemblyName System.IO.Compression
$zip = "$here\phantom-beats-scf.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
$fs = [IO.File]::Open($zip, [IO.FileMode]::Create)
$arc = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
$e = $arc.CreateEntry('index.js')
$es = $e.Open()
$b = [IO.File]::ReadAllBytes($tmp)
$es.Write($b, 0, $b.Length)
$es.Close()
$arc.Dispose(); $fs.Dispose()
Remove-Item $tmp -Force
Write-Host ('OK zip=' + $zip + ' size=' + (Get-Item $zip).Length)
