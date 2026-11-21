// These are fixed programs. The PowerShell command line never contains an account, identifier or tool argument.
const CHECK_TEAMS = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($PSVersionTable.PSVersion.Major -lt 7) { exit 20 }
# Prefer the modules downloaded into Relay's data folder. Existing user/system modules can still be used.
if ($IsWindows) {
  $userModules = [IO.Path]::Combine([Environment]::GetFolderPath('MyDocuments'), 'PowerShell', 'Modules')
  $systemModules = [IO.Path]::Combine([Environment]::GetFolderPath('ProgramFiles'), 'PowerShell', 'Modules')
} else {
  $userModules = $env:RELAY_TEAMS_USER_MODULES
  $systemModules = '/usr/local/share/powershell/Modules'
}
$env:PSModulePath = @($env:RELAY_TEAMS_MODULES, [IO.Path]::Combine($PSHOME, 'Modules'), $userModules, $systemModules) -join [IO.Path]::PathSeparator
$name = 'Microsoft.Graph.Authentication'
`;

export const PROBE_TEAMS =
  CHECK_TEAMS +
  `
try { Import-Module -Name $name -ErrorAction Stop } catch { exit 21 }
`;

export const INSTALL_TEAMS =
  CHECK_TEAMS +
  `
$gallery = 'https://www.powershellgallery.com/api/v2'
if (Get-Module -ListAvailable -Name Microsoft.PowerShell.PSResourceGet) {
  $repo = Microsoft.PowerShell.PSResourceGet\\Get-PSResourceRepository -Name PSGallery
  if ($repo.Uri.AbsoluteUri.TrimEnd('/') -ne $gallery) { exit 22 }
  Microsoft.PowerShell.PSResourceGet\\Save-PSResource -Name $name -Path $env:RELAY_TEAMS_MODULE_STAGE -Repository PSGallery -TrustRepository -Quiet
} else {
  $repo = PowerShellGet\\Get-PSRepository -Name PSGallery
  if ($repo.SourceLocation.TrimEnd('/') -ne $gallery) { exit 22 }
  PowerShellGet\\Save-Module -Name $name -Path $env:RELAY_TEAMS_MODULE_STAGE -Repository PSGallery -Force
}
# Import the saved version by its own manifest, even if a broken or newer user copy is discoverable.
$stage = $env:RELAY_TEAMS_MODULE_STAGE
$moduleDir = [IO.Path]::Combine($stage, $name)
$manifest = @(Get-ChildItem -LiteralPath $moduleDir -Filter ($name + '.psd1') -File -Depth 1)
if ($manifest.Count -ne 1) { exit 22 }
$env:PSModulePath = $stage + [IO.Path]::PathSeparator + $env:PSModulePath
try { Import-Module -Name ($manifest[0].FullName) -ErrorAction Stop } catch { exit 22 }
`;

// The write-capable helper is started only by an explicit, separate device sign-in.
function connectTeams(posting: boolean): string {
  const authorization = posting
    ? "$posting = $true\n$scopes = @('Team.ReadBasic.All', 'Channel.ReadBasic.All', 'Chat.ReadBasic', 'User.Read', 'ChannelMessage.Send', 'ChatMessage.Send')\n"
    : "$posting = $false\n$scopes = @('Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Read.All')\n";
  return (
    PROBE_TEAMS +
    authorization +
    String.raw`
function Reply($reply) {
  [Console]::WriteLine('RELAY ' + (ConvertTo-Json -Compress -Depth 4 -InputObject $reply))
}
try {
  [Threading.Thread]::CurrentThread.CurrentUICulture = [Globalization.CultureInfo]::GetCultureInfo('en-US')
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
  if (!$context.TenantId) { exit 23 }
  if ($posting) {
    Set-MgRequestContext -MaxRetry 0 | Out-Null
    if ((Get-MgRequestContext).MaxRetry -ne 0) { exit 23 }
  }
  Reply @{account = $context.Account; tenantId = $context.TenantId}
  while ($null -ne ($line = [Console]::ReadLine())) {
    $request = ConvertFrom-Json -AsHashtable -InputObject $line
    try {
      # TeamsGraph builds the routes. Only the dedicated posting session can submit a message.
      if ($request.ContainsKey('text')) {
        $now = Get-MgContext
        if (!$posting -or $now.ContextScope -ne 'Process' -or $now.AuthType -ne 'Delegated' -or
            $now.TenantId -ne $context.TenantId -or $now.Account -ne $context.Account -or
            ($scopes | Where-Object { $now.Scopes -notcontains $_ })) { exit 23 }
        $body = @{body = @{contentType = 'text'; content = $request.text}} | ConvertTo-Json -Depth 4 -Compress
        $response = Invoke-MgGraphRequest -Method POST -Uri $request.uri -Body $body -ContentType 'application/json; charset=utf-8' -OutputType Json
      } else {
        $response = Invoke-MgGraphRequest -Method GET -Uri $request.uri -OutputType Json
      }
      $response | ForEach-Object {
        if ($_ -isnot [string] -or !$_.TrimStart().StartsWith('{')) {
          # The SDK needs explicit user interaction again. Discard the challenge and end this session.
          exit 23
        }
        if ([Text.Encoding]::UTF8.GetByteCount($_) -gt 2097152) { Reply @{id = $request.id; error = 'size'} }
        else { Reply @{id = $request.id; json = $_} }
      }
    } catch {
      $status = [int]$_.Exception.Response.StatusCode
      Reply @{id = $request.id; error = 'graph'; status = $status}
      if ($status -eq 401) { exit 23 }
    }
  }
} catch {
  # Only the documented Microsoft error number can leave the helper. Exceptions can include service responses.
  if ($_.Exception.Message -match 'AADSTS[0-9]{4,9}') { Reply @{authError = $Matches[0]} }
  exit 23
}
`
  );
}

export const CONNECT_TEAMS = connectTeams(false);
export const POST_TEAMS = connectTeams(true);
