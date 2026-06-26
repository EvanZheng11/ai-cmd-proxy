# Function to launch CommandCode Proxy Manager from anywhere
function ccproxy {
  & "C:\Users\hayou\Desktop\OH-WorkSpace\_tools\command-code-proxy\command-code-proxy.ps1" @args
}

# Set-Location alias for quick cd to the proxy directory
Set-Alias -Name ccp  -Value "C:\Users\hayou\Desktop\OH-WorkSpace\_tools\command-code-proxy"  -ErrorAction SilentlyContinue
