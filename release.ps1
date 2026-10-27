# Nieuwe Flits-versie bouwen en op GitHub zetten:  .\release.ps1 1.2 "Wat is er nieuw"
# Zet het versienummer in beide apps, bouwt APK en exe, en maakt een release met Flits.apk en Flits.exe.
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$Notes = ""
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
if ($Version -notmatch '^\d+\.\d+$') { throw "Gebruik een versie als 1.2" }
$code = [int]($Version.Split('.')[0]) * 100 + [int]($Version.Split('.')[1])

# 1. versienummers
$gradle = Join-Path $root "android\app\build.gradle.kts"
(Get-Content $gradle -Raw) -replace 'versionCode = \d+', "versionCode = $code" -replace 'versionName = "[^"]+"', "versionName = `"$Version`"" | Set-Content $gradle -NoNewline
Push-Location (Join-Path $root "windows")
npm version "$Version.0" --no-git-tag-version --allow-same-version | Out-Null
Pop-Location

# 2. bouwen
$env:JAVA_HOME = "C:\Users\Gain\android-tools\jdk"
Push-Location (Join-Path $root "android")
& "C:\Users\Gain\android-tools\gradle-8.7\bin\gradle.bat" assembleRelease --console=plain
if ($LASTEXITCODE) { throw "Android-build mislukt" }
& "C:\Users\Gain\android-tools\gradle-8.7\bin\gradle.bat" --stop | Out-Null
Pop-Location
Push-Location (Join-Path $root "windows")
npm run dist
if ($LASTEXITCODE) { throw "Windows-build mislukt" }
Pop-Location

# 3. verzamelen en publiceren
$out = Join-Path $root "release"
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item (Join-Path $root "android\app\build\outputs\apk\release\app-release.apk") (Join-Path $out "Flits.apk") -Force
Copy-Item (Join-Path $root "windows\dist\Flits.exe") (Join-Path $out "Flits.exe") -Force

git -C $root add -A
git -C $root commit -m "Flits $Version" | Out-Null
git -C $root push
gh release create "v$Version" (Join-Path $out "Flits.apk") (Join-Path $out "Flits.exe") --repo BossevdK/flits --title "Flits $Version" --notes $(if ($Notes) { $Notes } else { "Flits $Version" })
Write-Host "Klaar: v$Version staat op GitHub. De apps werken zichzelf bij."
