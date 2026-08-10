<#
.SYNOPSIS
    Installe le device Max for Live "Vassi Stream" dans l'Ableton Live installe sur cette machine.

.DESCRIPTION
    Ce script n'est qu'une facade : tout le travail est fait par les scripts Node du projet, qui
    servent aussi en developpement. Il n'y a donc qu'une seule version de la verite sur les
    emplacements d'installation et sur le format de la configuration - dupliquer cette logique ici
    est exactement ce qui avait fait echouer la version precedente.

    Les emplacements ne sont pas ecrits en dur : ils sont deduits de la machine par
    scripts/install-paths.js, que -Where affiche sans rien installer.

.EXAMPLE
    PS> .\install-device.ps1
    Installe le device, sans toucher a la configuration.

.EXAMPLE
    PS> .\install-device.ps1 -RelayUrl wss://live.vassi.click/publisher
    Installe le device, tire un token si aucun n'est encore enregistre, et ecrit la configuration.

.EXAMPLE
    PS> .\install-device.ps1 -Where
    Montre ou le device atterrirait sur cette machine, et ce qui traine d'une installation ratee.
#>

param(
    [string]$RelayUrl,
    [string]$Token,
    [switch]$NewToken,
    [switch]$Where,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$projet = $PSScriptRoot

function Ecrire-Titre { param([string]$Texte)
    Write-Host ""
    Write-Host "== $Texte" -ForegroundColor Cyan
}
function Ecrire-Ok { param([string]$Texte); Write-Host "OK   $Texte" -ForegroundColor Green }
function Ecrire-Stop { param([string]$Texte); Write-Host "STOP $Texte" -ForegroundColor Red }

function Afficher-Aide {
    Write-Host @"
Vassi Stream - installation du device Max for Live

  .\install-device.ps1                             installe le device
  .\install-device.ps1 -RelayUrl <wss://...>       installe puis configure le relais
  .\install-device.ps1 -RelayUrl <wss://...> -Token <jeton>
  .\install-device.ps1 -NewToken                   tire un token et l'affiche
  .\install-device.ps1 -Where                      montre les emplacements detectes
  .\install-device.ps1 -Help                       cette aide

Pre-requis : Node.js 20 ou plus, et un Ableton Live 12 avec Max for Live.

Le token n'est jamais ecrit dans le depot : il va dans %APPDATA%\Vassi Stream\publisher.json.
Ne le partagez avec personne - il autorise a diffuser sur votre page.

Si PowerShell refuse d'executer ce fichier :
  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
"@
}

if ($Help) { Afficher-Aide; exit 0 }

# Node fait tout le travail : son absence est le seul pre-requis a verifier ici.
$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
    Ecrire-Stop "Node.js est introuvable. Installez-le depuis https://nodejs.org/ puis rouvrez PowerShell."
    exit 1
}
$version = (& node --version).TrimStart("v").Split(".")[0]
if ([int]$version -lt 20) {
    Ecrire-Stop "Node.js $version est trop ancien : il en faut 20 ou plus."
    exit 1
}

if (-not (Test-Path (Join-Path $projet "scripts\install-device.js"))) {
    Ecrire-Stop "Lancez ce script depuis le dossier du projet Vassi Stream."
    exit 1
}

if ($Where) {
    Ecrire-Titre "Emplacements detectes sur cette machine"
    & node (Join-Path $projet "scripts\install-paths.js")
    exit $LASTEXITCODE
}

if ($NewToken -and -not $RelayUrl) {
    Ecrire-Titre "Nouveau token de publication"
    & node (Join-Path $projet "scripts\new-token.js")
    Write-Host ""
    Write-Host "Posez le meme token des deux cotes : dans la variable VASSI_PUBLISHER_TOKEN du" -ForegroundColor Yellow
    Write-Host "relais, et ici avec -RelayUrl/-Token. Ne le partagez avec personne." -ForegroundColor Yellow
    exit $LASTEXITCODE
}

# L'installation refait elle-meme le .amxd si le patcher a ete retouche dans Max. Ce script
# n'appelle surtout pas make-device.js : celui-la regenere le patcher depuis le code, donc il
# effacerait les retouches faites dans Max.
Ecrire-Titre "Installation"
& node (Join-Path $projet "scripts\install-device.js")
if ($LASTEXITCODE -ne 0) { Ecrire-Stop "L'installation a echoue."; exit 1 }

if ($RelayUrl) {
    Ecrire-Titre "Configuration du relais"

    # Le token passe par l'environnement, pas par la ligne de commande : il n'apparait donc ni dans
    # l'historique de PowerShell, ni dans la liste des processus.
    #
    # Sans -Token ni -NewToken, rien n'est transmis et le token deja enregistre est conserve. Un
    # token tire a chaque passage serait un piege : le relais n'accepte que celui qu'il connait, donc
    # reinstaller pour corriger l'adresse couperait la diffusion.
    $tokenNeuf = $false
    if ($Token) {
        $env:VASSI_PUBLISHER_TOKEN = $Token
    } elseif ($NewToken) {
        $env:VASSI_PUBLISHER_TOKEN = (& node (Join-Path $projet "scripts\new-token.js")).Trim()
        $tokenNeuf = $true
        Ecrire-Ok "token neuf tire (il va dans %APPDATA%, il n'est pas affiche ici)"
    }

    try {
        & node (Join-Path $projet "scripts\set-publisher-config.js") --url $RelayUrl
        $echec = $LASTEXITCODE -ne 0
    } finally {
        Remove-Item Env:\VASSI_PUBLISHER_TOKEN -ErrorAction SilentlyContinue
    }

    if ($echec) {
        if (-not $Token -and -not $NewToken) {
            Ecrire-Stop "Aucun token n'est encore enregistre. Relancez avec -NewToken pour en tirer un,"
            Write-Host "     ou avec -Token <jeton> pour reposer celui que le relais connait deja." -ForegroundColor Red
        } else {
            Ecrire-Stop "La configuration a echoue."
        }
        exit 1
    }

    if ($Token -or $tokenNeuf) {
        Write-Host ""
        Write-Host "Le meme token doit etre pose sur le relais, dans sa variable VASSI_PUBLISHER_TOKEN." -ForegroundColor Yellow
        Write-Host "Sans cela, le device sera refuse a la connexion." -ForegroundColor Yellow
    }
    if ($tokenNeuf) {
        Write-Host "Le token tire est dans %APPDATA%\Vassi Stream\publisher.json, a copier de la." -ForegroundColor Yellow
    }
}

Ecrire-Titre "Termine"
Write-Host "Dans Ableton Live : Categories > Audio Effects > Max Audio Effect > Vassi Stream,"
Write-Host "puis deposer le device sur la piste Master."
Write-Host ""
Write-Host "Si Live tournait pendant l'installation, le fermer et le rouvrir : Max ne relit sa"
Write-Host "bibliotheque qu'au demarrage."
