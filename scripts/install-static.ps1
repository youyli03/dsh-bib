# dsh-bib 静态插件一键安装脚本（Windows，PowerShell 5.1 / 7 均兼容）
# 作用：把 plugin-pkg 固化为 web profile 的持久 bundle，重启 dsh web 后仍在。
# 幂等：重复运行安全。
#
# 用法（普通 PowerShell 即可，需要能写 ~/.dsh）：
#   powershell -ExecutionPolicy Bypass -File scripts\install-static.ps1
param(
    [string]$ProfileDir = "$env:USERPROFILE\.dsh\profiles\web",
    [string]$PluginDir  = "$PSScriptRoot\..\plugin-pkg"
)

$ErrorActionPreference = 'Stop'
$PluginDir = [System.IO.Path]::GetFullPath($PluginDir)
$ProfileDir = [System.IO.Path]::GetFullPath($ProfileDir)

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
#    解析顺序：profile 父目录 walk（与 DSH 自身 client-modules 扫描同机制）→ nvm 通配 → 明确报错
$dshToolsSrc = $null
try {
    # 从 profile 的 package.json 做 createRequire 解析：Node 沿 profiles\web → profiles → .dsh 向上找 node_modules
    $dshToolsSrc = (& node -e "const {createRequire}=require('module');process.stdout.write(createRequire(process.argv[1]).resolve('@deepseek-ai/dsh-tools'))" (Join-Path $ProfileDir 'package.json') 2>$null)
} catch { $dshToolsSrc = $null }
if (-not $dshToolsSrc -or -not (Test-Path $dshToolsSrc)) {
    # 回退：扫描 nvm 目录下所有 node 版本的安装根
    $candidates = Get-ChildItem "$env:LOCALAPPDATA\nvm\*\node_modules\@deepseek-ai\dsh-tools" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($candidates) { $dshToolsSrc = $candidates.FullName }
}
if (-not $dshToolsSrc -or -not (Test-Path $dshToolsSrc)) {
    throw "找不到 @deepseek-ai/dsh-tools。请确认 DSH 已安装（dsh 命令可用），或手动指定后重试。"
}
$toolsLink = Join-Path $PluginDir 'node_modules\@deepseek-ai\dsh-tools'
if (-not (Test-Path $toolsLink)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $toolsLink) | Out-Null
    cmd /c mklink /J "`"$toolsLink`"" "`"$dshToolsSrc`"" | Out-Null
    if (-not (Test-Path $toolsLink)) { throw "创建 dsh-tools junction 失败" }
    Write-Host "已创建 dsh-tools junction: $toolsLink -> $dshToolsSrc" -ForegroundColor Green
} else {
    Write-Host "dsh-tools junction 已存在" -ForegroundColor DarkGray
}

# 3) profile package.json：依赖 + bundles 追加（幂等）
$pkgPath = Join-Path $ProfileDir 'package.json'
$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$depKey = 'dsh-bib'
if (-not ($pkg.dependencies.PSObject.Properties.Name -contains $depKey)) {
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
