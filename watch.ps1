$folder = Split-Path -Parent $MyInvocation.MyCommand.Path
$debounce = 10

Write-Host "=== Auto Deploy Watcher ===" -ForegroundColor Cyan
Write-Host "Watching: $folder" -ForegroundColor Gray
Write-Host "Auto push $debounce sec after last change" -ForegroundColor Gray
Write-Host "Press Ctrl+C to stop" -ForegroundColor Gray
Write-Host ""

$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $folder
$watcher.Filter = "*.*"
$watcher.IncludeSubdirectories = $false
$watcher.EnableRaisingEvents = $true

$global:lastChange = $null

$action = {
    $name = Split-Path $Event.SourceEventArgs.FullPath -Leaf
    if ($name -match '^\.' -or $name -eq 'watch.ps1' -or $name -eq 'start-watch.bat') { return }
    $global:lastChange = Get-Date
    $t = Get-Date -Format "HH:mm:ss"
    Write-Host "[$t] Changed: $name" -ForegroundColor Yellow
}

Register-ObjectEvent $watcher Changed -Action $action | Out-Null
Register-ObjectEvent $watcher Created -Action $action | Out-Null

Write-Host "Watching started..." -ForegroundColor Green

while ($true) {
    Start-Sleep -Seconds 2
    if ($null -ne $global:lastChange) {
        $elapsed = (Get-Date) - $global:lastChange
        if ($elapsed.TotalSeconds -ge $debounce) {
            $global:lastChange = $null
            $t = Get-Date -Format "HH:mm:ss"
            Write-Host ""
            Write-Host "[$t] Deploying..." -ForegroundColor Cyan
            Set-Location $folder
            git add -A 2>&1 | Out-Null
            $status = git status --porcelain
            if ($status) {
                $msg = "auto-deploy"
                git commit -m $msg 2>&1 | Out-Null
                git push 2>&1 | Out-Null
                $t = Get-Date -Format "HH:mm:ss"
                Write-Host "[$t] Push complete! Render is redeploying..." -ForegroundColor Green
            } else {
                $t = Get-Date -Format "HH:mm:ss"
                Write-Host "[$t] No changes to push" -ForegroundColor Gray
            }
            Write-Host ""
        }
    }
}
