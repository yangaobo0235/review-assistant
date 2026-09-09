[CmdletBinding()]
param(
    [string]$BindHost = "127.0.0.1",
    [int]$Port = 8010,
    [switch]$NoReload
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$serviceRoot = Join-Path $projectRoot "review-agent-service"
$python = Join-Path $serviceRoot ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $python)) {
    throw "Python environment not found: $python. Run uv sync in review-agent-service first."
}

Push-Location $serviceRoot
try {
    $arguments = @("app.main:app", "--host", $BindHost, "--port", $Port)
    if (-not $NoReload) {
        $arguments += "--reload"
    }

    Write-Host "Starting review Agent at http://${BindHost}:${Port}" -ForegroundColor Cyan
    # Some Windows application-control policies block the uvicorn.exe shim while
    # allowing the virtual-environment Python interpreter to run module entrypoints.
    & $python -m uvicorn @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Agent exited with code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}
