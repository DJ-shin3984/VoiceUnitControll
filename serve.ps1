# Serves this folder at http://localhost:PORT/ so Chrome treats the page as a real origin
# (file:// breaks speech recognition and re-asks for mic permission). Local machine only.
param([int]$Port = 8123, [switch]$NoOpen)
$root = (Resolve-Path $PSScriptRoot).Path
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() } catch {
    Write-Host "Port $Port is busy. It may already be running - opening the browser anyway."
    Start-Process "http://localhost:$Port/voice-rts.html"
    exit
}
Write-Host "Serving $root at http://localhost:$Port/  (close this window to stop)"
if (-not $NoOpen) { Start-Process "http://localhost:$Port/voice-rts.html" }
$types = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.css'='text/css; charset=utf-8'; '.json'='application/json'; '.png'='image/png'; '.svg'='image/svg+xml' }
while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $res = $ctx.Response
    try {
        $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
        if (-not $rel) { $rel = 'voice-rts.html' }
        $path = [IO.Path]::GetFullPath((Join-Path $root $rel))
        if ($path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path $path -PathType Leaf)) {
            $bytes = [IO.File]::ReadAllBytes($path)
            $ext = [IO.Path]::GetExtension($path).ToLower()
            if ($types.ContainsKey($ext)) { $res.ContentType = $types[$ext] } else { $res.ContentType = 'application/octet-stream' }
            $res.Headers.Add('Cache-Control', 'no-store')
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        } else { $res.StatusCode = 404 }
    } catch { $res.StatusCode = 500 }
    $res.Close()
}
