<#
  PHANTOM BEATS PWA 一键发布到 GitHub Pages
  用法（在 phantom-beats-pwa 文件夹内运行）：
    .\deploy.ps1 -User 你的GitHub用户名 -Token 你的PAT
  说明：
    - 需要 Personal Access Token（classic），勾选 repo 权限（含 public_repo / pages:write）。
    - 脚本会：① 用 API 建公开仓库 ② 推送 main 分支 ③ 开启 Pages(main/根) ④ 打印访问地址。
    - 私密信息仅用于本地 git remote 与 API，不会写入任何被提交的文件。
#>
param(
  [Parameter(Mandatory = $true)] [string]$User,
  [Parameter(Mandatory = $true)] [string]$Token,
  [string]$RepoName = "phantom-beats-pwa",
  [string]$RepoDesc = "PHANTOM BEATS 音乐可视化器 · 手机 PWA 版"
)

$base = "https://api.github.com"
$hdrs = @{ Authorization = "Bearer $Token"; Accept = "application/vnd.github+json" }

Write-Output "==> 1/4 创建仓库 $User/$RepoName ..."
$body = @{ name = $RepoName; description = $RepoDesc; private = $false; auto_init = $false } | ConvertTo-Json
try {
  $r = Invoke-RestMethod -Uri "$base/user/repos" -Method Post -Headers $hdrs -Body $body -ContentType "application/json"
  Write-Output ("    已创建: " + $r.html_url)
}
catch {
  Write-Output ("    ⚠ 创建仓库返回: " + $_.Exception.Message + "（若已存在可忽略）")
}

Write-Output "==> 2/4 配置 remote 并推送 ..."
$remote = "https://$Token@github.com/$User/$RepoName.git"
git remote remove origin -ErrorAction SilentlyContinue
git remote add origin $remote
git branch -M main
git push -u origin main 2>&1 | Select-Object -Last 8

Write-Output "==> 3/4 开启 GitHub Pages ..."
Start-Sleep -Seconds 4
try {
  Invoke-RestMethod -Uri "$base/repos/$User/$RepoName/pages" -Method Post -Headers $hdrs `
    -Body (@{ source = @{ branch = "main"; path = "/" } } | ConvertTo-Json) -ContentType "application/json" | Out-Null
  Write-Output "    已开启 Pages（main 分支 / 根目录）"
}
catch {
  Write-Output ("    ⚠ 自动开启 Pages 失败，请到仓库 Settings → Pages 手动选 main/root: " + $_.Exception.Message)
}

Write-Output ""
Write-Output "✅ 发布完成。等 1–2 分钟待 Pages 构建后，用手机 Chrome 打开："
Write-Output "   https://$User.github.io/$RepoName/"
Write-Output "点浏览器 ⋮ → 「添加到主屏幕」即可安装为全屏 App。"
