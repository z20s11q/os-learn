param(
    [switch]$Publish,
    [switch]$DryRun,
    [ValidateSet('all', 'boot', 'panorama')][string]$Bundle = 'all',
    [ValidateRange(0.5, 2.0)][double]$Rate = 1.0
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pythonPath = Join-Path $projectRoot 'artifacts/tts-venv/Scripts/python.exe'
if (!(Test-Path -LiteralPath $pythonPath)) {
    throw 'Install the narration Python environment first; see docs/local-narration.md.'
}
$originalKey = $env:FISH_API_KEY
try {
    if (!$DryRun -and !$env:FISH_API_KEY) {
        $secureKey = Read-Host 'Fish API Key (hidden; only used for this run)' -AsSecureString
        $credential = [System.Net.NetworkCredential]::new('', $secureKey)
        $env:FISH_API_KEY = $credential.Password
    }
    $generatorArgs = @((Join-Path $PSScriptRoot 'generate-local-narration.py'),
        '--engine', 'fish', '--bundle', $Bundle, '--rate', $Rate.ToString([cultureinfo]::InvariantCulture))
    if (!$Publish) { $generatorArgs += '--sample' }
    if ($DryRun) { $generatorArgs += '--dry-run' }
    & $pythonPath @generatorArgs
    if ($LASTEXITCODE -ne 0) { throw "Fish narration generation failed (exit $LASTEXITCODE)." }
} finally {
    $env:FISH_API_KEY = $originalKey
}
