param(
    [string]$GoExe = 'go',
    [string]$KandevBackend = (Join-Path $PSScriptRoot '..\..\kandev\apps\backend')
)
$ErrorActionPreference = 'Stop'
$pluginRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sdkRoot = [IO.Path]::GetFullPath($KandevBackend)
$manifestPath = Join-Path $pluginRoot 'manifest.yaml'
$manifest = Get-Content -Raw -LiteralPath $manifestPath
$versionMatch = [regex]::Match($manifest, '(?m)^version: "([0-9]+\.[0-9]+\.[0-9]+)"\r?$')
if (-not $versionMatch.Success) { throw '清单版本无效' }
$packageName = 'kandev-plugin-fleet-acceptance-' + $versionMatch.Groups[1].Value + '.tar.gz'
$stage = Join-Path $pluginRoot ('.build\stage-' + [Guid]::NewGuid().ToString('N'))
$verification = Join-Path $pluginRoot ('.build\verify-' + [Guid]::NewGuid().ToString('N'))
$packagePath = Join-Path $pluginRoot $packageName
New-Item -ItemType Directory -Path (Join-Path $stage 'server'), (Join-Path $stage 'ui'), $verification -Force | Out-Null
Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $stage 'manifest.yaml')
Copy-Item -LiteralPath (Join-Path $pluginRoot 'ui\bundle.js') -Destination (Join-Path $stage 'ui\bundle.js')
$previousCGO = $env:CGO_ENABLED
$previousGOOS = $env:GOOS
$previousGOARCH = $env:GOARCH
try {
    $env:CGO_ENABLED = '0'
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    Push-Location $pluginRoot
    try {
        & $GoExe build -trimpath -o (Join-Path $stage 'server\plugin-windows-amd64.exe') ./server
        if ($LASTEXITCODE -ne 0) { throw '插件编译失败' }
    } finally { Pop-Location }
    Push-Location $sdkRoot
    try {
        & $GoExe run ./cmd/plugin-pack -dir $stage -out $packagePath -platform-only
        if ($LASTEXITCODE -ne 0) { throw '官方打包校验失败' }
    } finally { Pop-Location }
} finally {
    $env:CGO_ENABLED = $previousCGO
    $env:GOOS = $previousGOOS
    $env:GOARCH = $previousGOARCH
}
& tar -xzf $packagePath -C $verification
if ($LASTEXITCODE -ne 0) { throw '无法读取生成的包' }
$expected = @('checksums.txt', 'manifest.yaml', 'server/plugin-windows-amd64.exe', 'ui/bundle.js') | Sort-Object
$actual = Get-ChildItem -LiteralPath $verification -File -Recurse | ForEach-Object { [IO.Path]::GetRelativePath($verification, $_.FullName).Replace('\','/') } | Sort-Object
if (Compare-Object $expected $actual) { throw '包内出现缺失或额外文件' }
$checksums = Get-Content -LiteralPath (Join-Path $verification 'checksums.txt')
$seen = @{}
foreach ($line in $checksums) {
    if ($line -notmatch '^([a-f0-9]{64})  (.+)$') { throw '包内校验和格式无效' }
    $digest = $Matches[1]
    $relative = $Matches[2]
    if ($relative -notin $expected -or $relative -eq 'checksums.txt' -or $seen.ContainsKey($relative)) { throw '校验和目录不匹配' }
    $seen[$relative] = $true
    $actualDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $verification $relative)).Hash.ToLowerInvariant()
    if ($actualDigest -ne $digest) { throw '包内文件校验失败' }
}
if ($seen.Count -ne 3) { throw '包内校验和覆盖不完整' }
Write-Output ('已生成并核对：' + $packagePath)
