# dsh-session-xc 打包脚本
# 生成 npm .tgz，供 dsh plugin --profile web add ... 使用。
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
Push-Location $root
try {
    if (Test-Path .\dsh-session-xc-*.tgz) {
        Remove-Item .\dsh-session-xc-*.tgz -Force
    }
    npm pack --pack-destination .
    if ($LASTEXITCODE -ne 0) { throw "npm pack failed (exit $LASTEXITCODE)" }
    $name = (Get-ChildItem .\dsh-session-xc-*.tgz | Select-Object -First 1 -ExpandProperty Name)
    Get-ChildItem .\dsh-session-xc-*.tgz | Select-Object Name, Length
    Write-Host ""
    Write-Host "打包完成。安装："
    Write-Host "  dsh plugin --profile web add dsh-session-xc@file:$root\$name"
    Write-Host "然后重启 dsh web。"
}
finally {
    Pop-Location
}
