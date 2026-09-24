# dsh-session-xc 构建脚本
# 1) 校验 src/ 与 lib/ 一致：lib/ 是权威运行时产物（package.json 的 files 只发布 lib/），src/ 是它的同源镜像。
#    默认以 lib/ 为准把漂移的文件同步回 src/；-NoSync 则只校验，不一致即报错退出（供 CI / 发布前把关）。
# 2) npm pack 生成 .tgz，供 dsh plugin --profile web add ... 使用。
#    注意：~/.dsh/profiles/web/package.json 用 file: 精确指向「带版本号」的 tgz，
#    因此这里只清理「当前版本」的同名 tgz，历史版本 tgz 一律保留 —— 删掉会打断 profile 的依赖解析。
[CmdletBinding()]
param(
    [switch]$NoSync
)

$ErrorActionPreference = 'Stop'

$name = 'dsh-session-xc'
$root = $PSScriptRoot
Push-Location $root
try {
    # ---- 1) 以 lib/ 为准校验并同步 src/ ----
    $libDir = Join-Path $root 'lib'
    $srcDir = Join-Path $root 'src'
    $drift = @()
    $synced = @()

    foreach ($f in (Get-ChildItem -Path $libDir -File -Recurse)) {
        $rel = $f.FullName.Substring($libDir.Length).TrimStart('\', '/')
        $dest = Join-Path $srcDir $rel
        $same = (Test-Path $dest) -and `
            ((Get-FileHash -Algorithm SHA256 $dest).Hash -eq (Get-FileHash -Algorithm SHA256 $f.FullName).Hash)
        if ($same) { continue }

        $drift += $rel
        if ($NoSync) { continue }

        $destParent = Split-Path $dest -Parent
        if (-not (Test-Path $destParent)) {
            New-Item -ItemType Directory -Path $destParent -Force | Out-Null
        }
        Copy-Item -Path $f.FullName -Destination $dest -Force
        $synced += $rel
    }

    if ($drift.Count -eq 0) {
        Write-Host "src/ 与 lib/ 一致。" -ForegroundColor Green
    }
    elseif ($NoSync) {
        Write-Host "src/ 与 lib/ 不一致（本次为 -NoSync，仅校验、未改动）：" -ForegroundColor Red
        foreach ($r in $drift) { Write-Host "  - $r" }
        throw "src/ 落后于 lib/。请以 lib/ 为准同步：Copy-Item lib\<file> src\<file> -Force"
    }
    else {
        Write-Host "src/ 曾与 lib/ 不一致，已以 lib/ 为准同步：" -ForegroundColor Yellow
        foreach ($r in $drift) { Write-Host "  - $r" }
    }

    if ($NoSync) {
        Write-Host ""
        Write-Host "-NoSync：仅校验 src/ 与 lib/ 一致性，未同步、未打包。" -ForegroundColor Cyan
        return
    }
    # ---- 2) 打包 ----
    $version = (Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    $current = "$name-$version.tgz"

    if (Test-Path ".\$current") { Remove-Item ".\$current" -Force }
    npm pack --pack-destination .
    if ($LASTEXITCODE -ne 0) { throw "npm pack failed (exit $LASTEXITCODE)" }

    Get-ChildItem ".\$name-*.tgz" | Sort-Object Name | Select-Object Name, Length | Format-Table -AutoSize

    $others = @(Get-ChildItem ".\$name-*.tgz" | Where-Object { $_.Name -ne $current })
    if ($others.Count -gt 0) {
        Write-Host "本目录另存有历史版本 tgz，已保留（profile 的 file: 依赖可能指向它们，请勿删除）：" -ForegroundColor Yellow
        foreach ($o in $others) { Write-Host "  - $($o.Name)" }
    }

    Write-Host ""
    Write-Host "打包完成。安装："
    Write-Host "  dsh plugin --profile web add $name@file:$root\$current"
    Write-Host "然后重启 dsh web。"
}
finally {
    Pop-Location
}
