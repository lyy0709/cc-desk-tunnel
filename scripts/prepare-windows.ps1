param(
  [string]$VendorDirectory = (Join-Path $PSScriptRoot '../apps/desktop/vendor')
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Run with PowerShell 7 (pwsh.exe).' }
if (-not [Environment]::Is64BitProcess) { throw 'The current Windows package supports x64 only.' }
$cache = Join-Path $PSScriptRoot '../.tools'
New-Item -ItemType Directory -Path $cache,$VendorDirectory -Force | Out-Null
function Get-VerifiedArchive([string]$Name, [string]$Url, [string]$Sha256) {
  $path = Join-Path $cache $Name
  if (-not (Test-Path -LiteralPath $path)) {
    Invoke-WebRequest -Uri $Url -OutFile $path
  }
  if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha256) {
    throw "Checksum mismatch for $Name"
  }
  return $path
}
$pwshArchive = Get-VerifiedArchive 'PowerShell-7.6.6-win-x64.zip' 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.6/PowerShell-7.6.6-win-x64.zip' '02fe458be20493fbdf43f61ea20610b811ee6c738ab1676c61b9cfcd1a33c860'
$pwshDirectory = Join-Path $VendorDirectory 'pwsh'
Expand-Archive -LiteralPath $pwshArchive -DestinationPath $pwshDirectory -Force
& (Join-Path $pwshDirectory 'pwsh.exe') -NoLogo -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.ToString()'
if ($LASTEXITCODE) { throw 'Bundled PowerShell verification failed.' }
