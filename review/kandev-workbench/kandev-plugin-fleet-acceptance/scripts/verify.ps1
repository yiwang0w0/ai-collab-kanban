param([string]$GoExe='go',[switch]$Package)
$ErrorActionPreference='Stop'
$pluginRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$goPath=(Get-Command $GoExe -ErrorAction Stop).Source
$gofmt=Join-Path (Split-Path $goPath -Parent) 'gofmt.exe'
Push-Location $pluginRoot
try {
    $manifest=Get-Content -LiteralPath 'manifest.yaml' -Raw
    $makefile=Get-Content -LiteralPath 'Makefile' -Raw
    $manifestVersion=[regex]::Match($manifest,'(?m)^version: "([0-9]+\.[0-9]+\.[0-9]+)"\r?$').Groups[1].Value
    $makeVersion=[regex]::Match($makefile,'(?m)^VERSION := ([0-9]+\.[0-9]+\.[0-9]+)\r?$').Groups[1].Value
    if (-not $manifestVersion -or $manifestVersion -ne $makeVersion) { throw '清单和构建版本不一致' }
    if ($manifest -notmatch '(?m)^id: "kandev-plugin-fleet-acceptance"\r?$' -or (Get-Content go.mod -Raw) -notmatch '(?m)^module kandev-plugin-fleet-acceptance\r?$') { throw '插件 ID 与模块名不匹配' }
    $dependencyPatches=@{
        kandev='compat/kandev-v0.97.0-fleet.patch'
        board='compat/ai-fleet-kanban-v0.24.0-shared-gate.patch'
    }
    foreach ($dependency in $dependencyPatches.GetEnumerator()) {
        $dependencyRoot=[IO.Path]::GetFullPath((Join-Path $pluginRoot ('../'+$dependency.Key)))
        & git -C $dependencyRoot apply --reverse --check (Join-Path $pluginRoot $dependency.Value)
        if ($LASTEXITCODE -ne 0) { throw ('依赖源码与兼容补丁不一致：'+$dependency.Key) }
    }
    $unformatted=& $gofmt -l server
    if ($unformatted) { throw ('Go 文件需要格式化：'+($unformatted -join ', ')) }
    & $GoExe mod tidy -diff
    if ($LASTEXITCODE -ne 0) { throw 'Go 依赖锁不一致' }
    & $GoExe vet ./server/...
    if ($LASTEXITCODE -ne 0) { throw 'Go 静态检查失败' }
    & $GoExe test -race ./server/... -count=1
    if ($LASTEXITCODE -ne 0) { throw '插件测试失败' }
    & node --test tests/ui-panel.test.js
    if ($LASTEXITCODE -ne 0) { throw '面板注册测试失败' }
    if ($Package) { & (Join-Path $PSScriptRoot 'package-windows.ps1') -GoExe $goPath }
} finally { Pop-Location }
