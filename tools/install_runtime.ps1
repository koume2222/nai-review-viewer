# Builds .\runtime : an embeddable Python + Pillow + numpy, private to this folder.
# Nothing is installed system-wide. Run via "설치.bat" (or: powershell -ExecutionPolicy Bypass -File tools\install_runtime.ps1).
# Sources: python.org (embeddable zip, SHA-256 pinned below) and pypi.org (wheels, SHA-256 checked against the PyPI index).
# This file is ASCII-only on purpose (Windows PowerShell 5.1 reads BOM-less files as ANSI).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$PyVersion = '3.14.2'
$PyTag     = 'cp314'
$PySha256  = 'f05e28d161c6b15af64a7cb7f08b4a22b3a6b03eee71baee24ea557b3bdd5798'
$Packages  = [ordered]@{ pillow = '12.1.0'; numpy = '2.5.1' }

$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root 'runtime'
$work = Join-Path $root 'runtime.partial'
$tmp  = Join-Path ([IO.Path]::GetTempPath()) ('nrv-setup-' + [Guid]::NewGuid().ToString('N'))

function Get-Checked($url, $out, $sha) {
    Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
    $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $out).Hash.ToLower()
    if ($sha -and $got -ne $sha.ToLower()) { throw "SHA-256 mismatch for $url (got $got)" }
    return $got
}

try {
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }

    Write-Host "[1/3] Python $PyVersion (embeddable)"
    $pyZip = Join-Path $tmp 'python-embed.zip'
    $got = Get-Checked "https://www.python.org/ftp/python/$PyVersion/python-$PyVersion-embed-amd64.zip" $pyZip $PySha256
    Write-Host "      sha256 $got"
    Expand-Archive -LiteralPath $pyZip -DestinationPath $work

    $site = Join-Path $work 'Lib\site-packages'
    New-Item -ItemType Directory -Force -Path $site | Out-Null
    $n = 2
    foreach ($name in $Packages.Keys) {
        $ver = $Packages[$name]
        Write-Host "[$n/3] $name $ver"
        $meta = Invoke-RestMethod -Uri "https://pypi.org/pypi/$name/$ver/json" -UseBasicParsing
        $file = $meta.urls | Where-Object { $_.filename -like "*-$PyTag-$PyTag-win_amd64.whl" } | Select-Object -First 1
        if (-not $file) { throw "No $PyTag win_amd64 wheel for $name $ver" }
        $whl = Join-Path $tmp ($name + '.zip')
        Get-Checked $file.url $whl $file.digests.sha256 | Out-Null
        Expand-Archive -LiteralPath $whl -DestinationPath $site
        $n++
    }

    # Isolated search path: standard library zip, the runtime folder, and site-packages only.
    $pth = Get-ChildItem -LiteralPath $work -Filter 'python*._pth' | Select-Object -First 1
    [IO.File]::WriteAllLines($pth.FullName, @(($pth.BaseName + '.zip'), '.', 'Lib\site-packages'))

    & (Join-Path $work 'python.exe') -c "import PIL, numpy, sqlite3, ctypes; print('      OK  Pillow', PIL.__version__, ' numpy', numpy.__version__)"
    if ($LASTEXITCODE -ne 0) { throw 'Runtime self-test failed' }

    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
    Rename-Item -LiteralPath $work -NewName 'runtime'
    Write-Host 'Runtime ready.'
}
catch {
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
finally {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
