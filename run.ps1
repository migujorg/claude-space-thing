<#
.SYNOPSIS
  From a fresh clone to the running app, in one command (Windows PowerShell 5.1 or PowerShell 7).

.DESCRIPTION
  1. checks the machine (python -m pipeline doctor: Python, packages, Node, disk space, long paths, data hosts),
  2. builds the data with the chosen profile (default standard; see README "Build profiles"). The build resumes:
     after an interruption or a failed stage, run the same command again and finished work is kept,
  3. installs the app's packages and starts the dev server in your browser.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\run.ps1
  powershell -ExecutionPolicy Bypass -File .\run.ps1 full
  .\run.ps1 minimal -SkipDoctor
  .\run.ps1 standard -- --skip sky
#>
param(
    [Parameter(Position = 0)]
    [ValidateSet('minimal', 'standard', 'full')]
    [Alias('Profile')]
    [string]$BuildProfile = 'standard',
    [switch]$SkipDoctor,
    [switch]$SkipBuild,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$BuildArgs = @()
)
$ErrorActionPreference = 'Stop'
# Python in UTF-8 mode: the pipeline's text files and logs are UTF-8 whatever the Windows code page is.
$env:PYTHONUTF8 = '1'
$BuildArgs = @($BuildArgs | Where-Object { $_ -ne '--' })

function Need([string]$Cmd, [string]$Hint) {
    if (-not (Get-Command $Cmd -ErrorAction SilentlyContinue)) {
        Write-Host "$Cmd not found: $Hint" -ForegroundColor Red
        exit 1
    }
}

Push-Location -LiteralPath $PSScriptRoot
try {
    Need 'uv' 'install it: powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
    Need 'npm' 'install Node.js 22 LTS from https://nodejs.org'

    Write-Host '== Python environment (pipeline\)' -ForegroundColor Cyan
    Set-Location pipeline
    uv sync --locked
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    if (-not $SkipDoctor) {
        Write-Host "== Checking this machine (profile $BuildProfile)" -ForegroundColor Cyan
        uv run python -m pipeline doctor --profile $BuildProfile
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'Fix the problems above and run .\run.ps1 again (or add -SkipDoctor to go on anyway).' -ForegroundColor Red
            exit 1
        }
    }

    if (-not $SkipBuild) {
        Write-Host "== Building the data (profile $BuildProfile); run the same command again to resume if it stops" -ForegroundColor Cyan
        uv run python -m pipeline build --profile $BuildProfile @BuildArgs
        $rc = $LASTEXITCODE
        if ($rc -eq 130) {
            Write-Host "Build interrupted. Run .\run.ps1 $BuildProfile again to resume." -ForegroundColor Yellow
            exit 130
        } elseif ($rc -ne 0) {
            Write-Host 'Some stages did not finish (see the summary above). The app starts with what was built and shows' -ForegroundColor Yellow
            Write-Host "what is missing; run .\run.ps1 $BuildProfile again later to resume the build." -ForegroundColor Yellow
        }
    }

    Write-Host '== App (app\)' -ForegroundColor Cyan
    Set-Location ..\app
    if (Test-Path node_modules) { npm install --no-audit --no-fund } else { npm ci --no-audit --no-fund }
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host '== Starting the app at http://localhost:5173 (Ctrl-C stops it). Use Chrome or Edge (WebGPU).' -ForegroundColor Cyan
    # '--' quoted: PowerShell would otherwise swallow it when calling npm's .ps1 shim, and --open would go to npm
    npm run dev '--' --open
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
