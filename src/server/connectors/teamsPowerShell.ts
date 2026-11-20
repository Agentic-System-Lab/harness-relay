// These are fixed programs. The PowerShell command line never contains an account, identifier or tool argument.
const CHECK_TEAMS = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($PSVersionTable.PSVersion.Major -lt 7) { exit 20 }
# Resolve from PowerShell's own installation and the standard user/system directories.
if ($IsWindows) {
  $userModules = [IO.Path]::Combine([Environment]::GetFolderPath('MyDocuments'), 'PowerShell', 'Modules')
  $systemModules = [IO.Path]::Combine([Environment]::GetFolderPath('ProgramFiles'), 'PowerShell', 'Modules')
} else {
  $userModules = $env:RELAY_TEAMS_USER_MODULES
  $systemModules = '/usr/local/share/powershell/Modules'
}
$env:PSModulePath = @([IO.Path]::Combine($PSHOME, 'Modules'), $userModules, $systemModules) -join [IO.Path]::PathSeparator
$name = 'Microsoft.Graph.Authentication'
`;

export const PROBE_TEAMS =
  CHECK_TEAMS +
  `
if (!(Get-Module -ListAvailable -Name $name)) { exit 21 }
`;

export const INSTALL_TEAMS =
  CHECK_TEAMS +
  `
if (!(Get-Module -ListAvailable -Name $name)) {
  $gallery = 'https://www.powershellgallery.com/api/v2'
  if (Get-Module -ListAvailable -Name Microsoft.PowerShell.PSResourceGet) {
    $repo = Microsoft.PowerShell.PSResourceGet\\Get-PSResourceRepository -Name PSGallery
    if ($repo.Uri.AbsoluteUri.TrimEnd('/') -ne $gallery) { exit 22 }
    Microsoft.PowerShell.PSResourceGet\\Install-PSResource -Name $name -Scope CurrentUser -Repository PSGallery -TrustRepository -Quiet
  } else {
    $repo = PowerShellGet\\Get-PSRepository -Name PSGallery
    if ($repo.SourceLocation.TrimEnd('/') -ne $gallery) { exit 22 }
    PowerShellGet\\Install-Module -Name $name -Scope CurrentUser -Repository PSGallery -Force
  }
}
Import-Module $name
`;

export const CONNECT_TEAMS =
  PROBE_TEAMS +
  String.raw`
function Reply($reply) {
  [Console]::WriteLine('RELAY ' + (ConvertTo-Json -Compress -Depth 4 -InputObject $reply))
}
try { Import-Module $name } catch { exit 22 }
try {
  [Threading.Thread]::CurrentThread.CurrentUICulture = [Globalization.CultureInfo]::GetCultureInfo('en-US')
  $scopes = @('Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Read.All')
  # Windows resolves the SDK's .mg directory through the OS user profile. The SDK can delete its
  # existing account hint if Connect fails. Let it read the hint, but preserve the original file.
  $existingHint = $null
  try {
    if ($IsWindows) {
      $path = [IO.Path]::Combine([Environment]::GetFolderPath('UserProfile'), '.mg', 'mg.authrecord.json')
      if ([IO.File]::Exists($path)) {
        $existingHint = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
      }
    }
    Connect-MgGraph -UseDeviceCode -ContextScope Process -TenantId organizations -Environment Global -Scopes $scopes -NoWelcome -ClientTimeout 20 |
      ForEach-Object { [Console]::WriteLine([string]$_) }
  } catch {
    # AuthenticationHelpers.AuthenticateAsync wraps an expired sign-in. PowerShell may wrap it again.
    # Match the SDK's inactivity error before its text is discarded; unrelated failures stay distinct.
    for ($cause = $_.Exception; $null -ne $cause; $cause = $cause.InnerException) {
      if ($cause.Message -match 'Authentication timed out after [0-9]+ seconds due to inactivity\.') { exit 24 }
    }
    throw
  } finally {
    if ($null -ne $existingHint) { $existingHint.Dispose() }
  }
  $context = Get-MgContext
  if ($context.ContextScope -ne 'Process' -or $context.AuthType -ne 'Delegated' -or !$context.Account -or
      ($scopes | Where-Object { $context.Scopes -notcontains $_ })) { exit 23 }
  Reply @{account = $context.Account}
  while ($null -ne ($line = [Console]::ReadLine())) {
    $request = ConvertFrom-Json -AsHashtable -InputObject $line
    try {
      # Each URI comes only from the three fixed GET routes in TeamsGraph.
      Invoke-MgGraphRequest -Method GET -Uri $request.uri -OutputType Json | ForEach-Object {
        if ($_ -isnot [string] -or !$_.TrimStart().StartsWith('{')) {
          # The SDK needs explicit user interaction again. Discard the challenge and end this session.
          exit 23
        }
        if ([Text.Encoding]::UTF8.GetByteCount($_) -gt 2097152) { Reply @{id = $request.id; error = 'size'} }
        else { Reply @{id = $request.id; json = $_} }
      }
    } catch {
      $status = [int]$_.Exception.Response.StatusCode
      if ($status -eq 401) { exit 23 }
      Reply @{id = $request.id; error = 'graph'; status = $status}
    }
  }
} catch {
  # Only the documented Microsoft error number can leave the helper. Exceptions can include service responses.
  if ($_.Exception.Message -match 'AADSTS[0-9]{4,9}') { Reply @{authError = $Matches[0]} }
  exit 23
}
`;
