$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$extensionRoot = Join-Path $projectRoot "review-extension"

Push-Location $extensionRoot
try {
    Write-Host "Building browser extension..." -ForegroundColor Cyan
    npm run build
    if ($LASTEXITCODE -ne 0) {
        throw "扩展构建失败，退出码：$LASTEXITCODE"
    }
    Write-Host "Build complete. Load or reload review-extension/dist in edge://extensions." -ForegroundColor Green
}
finally {
    Pop-Location
}
