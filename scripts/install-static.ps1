# dsh-bib 静态插件一键安装脚本（Windows）
# 作用：把 plugin-pkg 固化为 web profile 的持久 bundle，重启 dsh web 后仍在。
# 幂等：重复运行安全。
#
# 用法（管理员或普通 PowerShell 均可，需要能写 ~/.dsh）：
#   powershell -ExecutionPolicy Bypass -File scripts\install-static.ps1
param(
    [string]$ProfileDir = "$env:USERPROFILE\.dsh\profiles\web",
    [string]$PluginDir  = "$PSScriptRoot\..\plugin-pkg"
)

$ErrorActionPreference = 'Stop'
$PluginDir = [System.IO.Path]::GetFullPath($PluginDir)

Write-Host "== dsh-bib 静态插件安装 ==" -ForegroundColor Cyan
Write-Host "Profile : $ProfileDir"
Write-Host "Plugin  : $PluginDir"

# 0) 前置检查
if (-not (Test-Path (Join-Path $PluginDir 'package.json'))) { throw "找不到插件包: $PluginDir" }
if (-not (Test-Path (Join-Path $ProfileDir 'package.json'))) { throw "找不到 web profile: $ProfileDir" }

# 1) node_modules\dsh-bib junction -> plugin-pkg（DSH bundle 解析入口）
$link = Join-Path $ProfileDir 'node_modules\dsh-bib'
if (-not (Test-Path $link)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $link) | Out-Null
    cmd /c mklink /J "`"$link`"" "`"$PluginDir`"" | Out-Null
    if (-not (Test-Path $link)) { throw "创建 junction 失败: $link" }
    Write-Host "已创建 junction: $link" -ForegroundColor Green
} else {
    Write-Host "junction 已存在: $link" -ForegroundColor DarkGray
}

# 2) 插件内 node_modules\@deepseek-ai\dsh-tools junction（host 代码 import 依赖解析）
$dshToolsSrc = "$env:LOCALAPPDATA\nvm\v22.23.2\node_modules\@deepseek-ai\dsh-tools"
if (-not (Test-Path $dshToolsSrc)) {
    # 回退：从本机 node 解析 @deepseek-ai/dsh-tools（安装路径可能不同）
    $dshToolsSrc = (& node -e "process.stdout.write(require.resolve('@deepseek-ai/dsh-tools', { paths: [process.cwd()] }))" 2>$null | ForEach-Object { if ($_ -match 'dsh-tools\\(lib\\index\.js)?$') { ($_ -replace '\\lib\\index\.js$','') } }) 
    if (-not $dshToolsSrc -or -not (Test-Path $dshToolsSrc)) { throw "找不到 @deepseek-ai/dsh-tools（请确认 DSH 安装位置）" }
}
$toolsLink = Join-Path $PluginDir 'node_modules\@deepseek-ai\dsh-tools'
if (-not (Test-Path $toolsLink)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $toolsLink) | Out-Null
    cmd /c mklink /J "`"$toolsLink`"" "`"$dshToolsSrc`"" | Out-Null
    if (-not (Test-Path $toolsLink)) { throw "创建 dsh-tools junction 失败" }
    Write-Host "已创建 dsh-tools junction: $toolsLink" -ForegroundColor Green
} else {
    Write-Host "dsh-tools junction 已存在" -ForegroundColor DarkGray
}

# 3) profile package.json：依赖 + bundles 追加（幂等）
$pkgPath = Join-Path $ProfileDir 'package.json'
$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$depKey = 'dsh-bib'
if (-not $pkg.dependencies.PSObject.Properties.Name -contains $depKey) {
    $pkg.dependencies | Add-Member -NotePropertyName $depKey -NotePropertyValue ("link:" + $PluginDir.Replace('\','/'))
    Write-Host "已添加依赖 dsh-bib -> link:$($PluginDir.Replace('\','/'))" -ForegroundColor Green
} else {
    Write-Host "依赖已存在: dsh-bib" -ForegroundColor DarkGray
}
$bundles = $pkg.dsh.profile.bundles
if (-not ($bundles -contains $depKey)) {
    $pkg.dsh.profile.bundles = @($bundles) + $depKey
    Write-Host "已追加 bundle: dsh-bib" -ForegroundColor Green
} else {
    Write-Host "bundle 已存在: dsh-bib" -ForegroundColor DarkGray
}
# 写回（无 BOM，避免 DSH JSON 解析失败）
$json = $pkg | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
Write-Host "== 安装完成。请重启 dsh web（Ctrl+C 后重新运行 dsh web），browser_* 工具与内嵌浏览器窗口即生效。==" -ForegroundColor Green
Write-Host "卸载：删除 profile package.json 里的 dsh-bib 依赖/bundle 项，并删除 node_modules\dsh-bib junction。" -ForegroundColor DarkGray
