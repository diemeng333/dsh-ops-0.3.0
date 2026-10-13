<#
  dsh-ops 0.3.0 installer for DSH Desktop (Windows x64)

  Usage:
    pwsh -File install.ps1                  # install into the desktop profile
    pwsh -File install.ps1 -EnablePtc       # also enable the opt-in PTC component
    pwsh -File install.ps1 -Profile web     # target another profile
    pwsh -File install.ps1 -SkipHashCheck   # skip package hash verification

  This script only calls the official DSH CLI. It never edits system PATH,
  never writes outside the target profile, and keeps a rollback copy of the
  profile patch before touching it.
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [switch]$EnablePtc,
  [switch]$SkipHashCheck
)

$ErrorActionPreference = 'Stop'

$root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$pkg  = Join-Path $root 'dist\dsh-ops-0.3.0.tgz'
$sums = Join-Path $root 'checksums.txt'

$ExpectedSha256 = '64514e71997454e58713dd23e1be9b570974f12b70318cd8d97f5ad985299575'
$ExpectedVersion = '0.3.0'

function Info([string]$m) { Write-Host "[dsh-ops] $m" }
function Warn([string]$m) { Write-Host "[dsh-ops] $m" -ForegroundColor Yellow }
function Fail([string]$m) { Write-Host "[dsh-ops] ERROR: $m" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 1. package

if (-not (Test-Path -LiteralPath $pkg)) { Fail "package not found: $pkg" }
$pkgItem = Get-Item -LiteralPath $pkg
Info ("package : {0} ({1} bytes)" -f $pkgItem.Name, $pkgItem.Length)

if (-not $SkipHashCheck) {
  $actual = (Get-FileHash -LiteralPath $pkg -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $ExpectedSha256) {
    Fail "package hash mismatch.`n  expected $ExpectedSha256`n  actual   $actual`n  Re-download the repository, or pass -SkipHashCheck to bypass."
  }
  Info "sha256  : OK ($actual)"
} else {
  Warn "sha256  : SKIPPED by request"
}

if (Test-Path -LiteralPath $sums) {
  $line = Select-String -LiteralPath $sums -Pattern 'dsh-ops-0\.3\.0\.tgz' | Select-Object -First 1
  if ($line) { Info ("checksums.txt: {0}" -f $line.Line.Trim()) }
}

# ---------------------------------------------------------------- 2. dsh CLI

function Find-DshCli {
  $candidates = New-Object System.Collections.Generic.List[string]

  $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'))
  if ($env:ProgramFiles) {
    $candidates.Add((Join-Path $env:ProgramFiles 'DSH Desktop\resources\runtime\cli\bin\dsh.cmd'))
  }

  # The desktop app materialises a per-generation shim under host-commands.
  $hostCommands = Join-Path $env:APPDATA 'DSH Desktop\host-commands'
  if (Test-Path -LiteralPath $hostCommands) {
    Get-ChildItem -LiteralPath $hostCommands -Recurse -Filter 'dsh.cmd' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      ForEach-Object { $candidates.Add($_.FullName) }
  }

  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  return $null
}

$cli = Find-DshCli
if (-not $cli) {
  Fail @"
Could not locate the DSH Desktop CLI (dsh.cmd).
Install DSH Desktop first, or pass the CLI explicitly:

  & "<DSH install dir>\resources\runtime\cli\bin\dsh.cmd" plugin --profile $Profile add "file:$($pkg -replace '\\','/')"

Note: an ordinary `dsh` on PATH cannot manage the reserved `desktop` profile.
"@
}
Info "dsh cli : $cli"

# ---------------------------------------------------------------- 3. profile

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$Profile"
if (-not (Test-Path -LiteralPath (Join-Path $profileDir 'package.json'))) {
  Fail "profile '$Profile' is not initialised at $profileDir. Start DSH Desktop once, then re-run."
}
Info "profile : $Profile ($profileDir)"

# ---------------------------------------------------------------- 4. install

$fileSpec = 'file:' + ($pkg -replace '\\','/')
Info "running : dsh plugin --profile $Profile add $fileSpec"

& $cli plugin --profile $Profile add $fileSpec
if ($LASTEXITCODE -ne 0) { Fail "official CLI exited with code $LASTEXITCODE" }

$installed = Join-Path $profileDir "node_modules\dsh-ops\package.json"
if (-not (Test-Path -LiteralPath $installed)) { Fail "install finished but $installed is missing" }
$version = (Get-Content -LiteralPath $installed -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($version -ne $ExpectedVersion) { Fail "expected dsh-ops $ExpectedVersion but found $version" }
Info "installed: dsh-ops $version"

$worker = Join-Path $profileDir 'node_modules\dsh-ops\runtime\win32-x64\dsh-ops-worker.exe'
if (Test-Path -LiteralPath $worker) {
  $wHash = (Get-FileHash -LiteralPath $worker -Algorithm SHA256).Hash.ToLowerInvariant()
  Info "worker  : $wHash"
  if ($wHash -ne '31d26d8410c54d839e16e6af44790fd55263d234326cff68277ec6a3b811067c') {
    Warn "worker hash differs from the reference build. That is expected if you rebuilt from source."
  }
} else {
  Warn "native worker not found at $worker; the file component will degrade until you run 'npm run build:ptc' in a source checkout."
}

# ---------------------------------------------------------------- 5. PTC opt-in

if ($EnablePtc) {
  $patch = Join-Path $profileDir 'cordis.patch.yml'
  if (-not (Test-Path -LiteralPath $patch)) { Fail "profile patch not found: $patch" }

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = "$patch.pre-ptc-enable-$stamp.bak"
  Copy-Item -LiteralPath $patch -Destination $backup -Force
  Info "backup  : $backup"

  # Read/write bytes directly: Get-Content -Raw + Set-Content would silently
  # normalise line endings and can drop the trailing newline, and the block we
  # append must carry the same 2-space indent as the surrounding entries.
  $text = [System.IO.File]::ReadAllText($patch)

  if ($text -match '(?m)^- id: dsh-ops-ptc\s*$') {
    # An override already exists; force it to disabled: false.
    # `(?m)` only — NOT `(?s)`: a dotall `.` would let `.*` swallow the
    # following entries and silently delete them.
    $text = [regex]::Replace(
      $text,
      '(?m)^- id: dsh-ops-ptc[ \t]*\r?\n(?:(?!^- ).*(\r?\n|$))*',
      "- id: dsh-ops-ptc`n  disabled: false`n")
    Info "patch   : existing dsh-ops-ptc override updated"
  } else {
    $text = $text.TrimEnd("`r","`n") + "`n- id: dsh-ops-ptc`n  disabled: false`n"
    Info "patch   : dsh-ops-ptc override appended"
  }
  [System.IO.File]::WriteAllText($patch, $text)

  # Parse the patch back before trusting it. A malformed override would break
  # the whole profile boot, so fail loudly instead of leaving a broken file.
  $parsed = $null
  try {
    $yamlLib = Join-Path $env:ProgramFiles 'DSH Desktop\resources\app\node_modules\yaml\dist\index.js'
    if (Test-Path -LiteralPath $yamlLib) {
      $parsed = & node -e "const YAML=require(process.argv[1]);const fs=require('fs');const d=YAML.parse(fs.readFileSync(process.argv[2],'utf8'));const r=d.find(e=>e.id==='dsh-ops-ptc');process.stdout.write(JSON.stringify(r))" $yamlLib $patch
    }
  } catch { $parsed = $null }

  if ($null -ne $parsed -and $parsed -match '"disabled":false') {
    Info "verified: patch parses and dsh-ops-ptc is disabled: false"
  } elseif ($null -ne $parsed) {
    Copy-Item -LiteralPath $backup -Destination $patch -Force
    Fail "the patched file parsed but dsh-ops-ptc is not disabled: false. Original restored from $backup"
  } else {
    Warn "could not parse-verify the patch (yaml module or node unavailable)."
    Warn "Check it manually before restarting:"
    Warn "  & `"$cli`" --profile $Profile --dump-config | Select-String 'dsh-ops-ptc' -Context 0,4"
  }

  Info "rollback: Copy-Item `"$backup`" `"$patch`" -Force"
}

# ---------------------------------------------------------------- 6. next

Write-Host ''
Info 'DONE. Restart DSH Desktop to load the new plugin code.'
Write-Host ''
Write-Host '  Verify after restart:'
Write-Host '    - the file tools ops_glob / ops_grep / ops_inspect_local_file / ops_replace are available'
Write-Host '    - no fastctx.exe is spawned for file operations (only the background component uses it)'
if ($EnablePtc) {
  Write-Host ''
  Write-Host '  PTC is enabled. To reach the advertised token reduction, start a session'
  Write-Host '  with the "ptc" agent preset so the wire presentation is PTC-only.'
}
Write-Host ''
