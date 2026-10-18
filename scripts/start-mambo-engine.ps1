param([int]$ApiPort = 18547)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$engineDirectory = Join-Path $projectDirectory 'artifacts/mambo-engine/GPT-SoVITS-v2pro-20250604-nvidia50'
$modelDirectory = Join-Path $projectDirectory 'artifacts/mambo-release/MamboTTS-v1.2.1-full/models'
$runtimePython = Join-Path $engineDirectory 'runtime/python.exe'
foreach ($requiredFile in @($runtimePython, (Join-Path $engineDirectory 'api.py'), (Join-Path $modelDirectory 'manbo_e8_s168.pth'), (Join-Path $modelDirectory 'manbo-e10.ckpt'), (Join-Path $modelDirectory 'refer.wav'))) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) { throw "Missing Mambo engine file: $requiredFile" }
}
$env:PYTHONUTF8 = '1'
Push-Location -LiteralPath $engineDirectory
try {
    & $runtimePython api.py -a 127.0.0.1 -p $ApiPort -d cuda -s (Join-Path $modelDirectory 'manbo_e8_s168.pth') -g (Join-Path $modelDirectory 'manbo-e10.ckpt') -dr (Join-Path $modelDirectory 'refer.wav') -dt '大家好，欢迎来到我的频道，今天给大家分享一个有趣的内容' -dl zh
} finally { Pop-Location }
