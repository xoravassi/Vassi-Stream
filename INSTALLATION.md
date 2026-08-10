# Installer le device Vassi Stream

Ce document ne sert qu'a installer le device sur une machine. Ce qu'il fait et comment il est
construit sont dans [`docs/device-max.md`](docs/device-max.md).

## Pre-requis

- **Node.js 20 ou plus** — <https://nodejs.org/>. Une fois installe, rouvrir PowerShell pour qu'il
  le voie.
- **Ableton Live 12 avec Max for Live.** Rien a installer du cote de Max : Live embarque le sien, et
  c'est celui-la que le device utilise.

## Installer

Dans PowerShell, depuis le dossier du projet :

```powershell
.\install-device.ps1
```

Si PowerShell refuse d'executer le fichier, l'autoriser une fois pour ce compte :

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

La commande affiche ce qu'elle trouve et ce qu'elle pose. Une installation reussie se termine par
`Tout est en place`. Chaque ligne commence par `OK` ou par `STOP` suivi de quoi faire.

**Si Ableton Live tournait pendant l'installation, le fermer et le rouvrir.** Max ne relit sa
bibliotheque qu'a son demarrage : sans cela, le device se pose mais ne trouve pas son moteur.

Puis, dans Live :

1. **Categories > Audio Effects > Max Audio Effect > Vassi Stream**
2. Deposer le device sur la piste **Master**.

## Configurer le relais

Le device a besoin de deux choses : l'adresse du relais et un token de publication. Les deux
peuvent etre saisies dans l'onglet **Reglages** du device, ou posees d'avance :

```powershell
# Premiere fois : tirer un token et l'enregistrer
.\install-device.ps1 -RelayUrl wss://live.vassi.click/publisher -NewToken

# Reposer un token que le relais connait deja
.\install-device.ps1 -RelayUrl wss://live.vassi.click/publisher -Token <jeton>

# Corriger seulement l'adresse : le token enregistre est conserve
.\install-device.ps1 -RelayUrl wss://live.vassi.click/publisher
```

**Le meme token doit etre pose des deux cotes** : ici, et dans la variable d'environnement
`VASSI_PUBLISHER_TOKEN` du relais. Le relais n'accepte que le token qu'il connait — c'est pourquoi
`-RelayUrl` seul ne le regenere jamais : cela couperait la diffusion sans prevenir.

Le token vit dans `%APPDATA%\Vassi Stream\publisher.json`, hors du projet, donc il ne peut pas
partir dans un commit. **Ne le partagez avec personne** : il autorise a diffuser sur votre page.

## Depanner

**Premiere chose a faire :** demander a l'installateur ou il en est.

```powershell
.\install-device.ps1 -Where
```

Il repond sans rien installer : quel `Documents` compte sur cette machine, quels Ableton sont
installes avec leur version de Max, ou le device atterrit, et ce qui traine d'une installation
precedente mal placee.

| Symptome | Cause probable |
|---|---|
| Le device n'apparait pas dans le navigateur de Live | Live tournait pendant l'installation. Le fermer et le rouvrir. |
| Le device s'affiche mais aucun bouton ne repond | Le moteur Node n'a pas demarre. Verifier avec `-Where` que la bibliotheque Max visee est bien celle de la version de Max livree avec votre Live. |
| `Enregistrer` ou `Tester le relais` echoue | Adresse ou token. Relancer avec `-RelayUrl`, et verifier que le relais porte le meme token. |
| `STOP ... non copie` | Ableton Live ou Max verrouille le fichier. Les fermer tous les deux, puis relancer. |
| `Node.js est introuvable` | Installer Node.js, puis **rouvrir PowerShell**. |

## Ou vont les fichiers

Les emplacements ne sont pas fixes : ils sont deduits de la machine, parce que les deviner ne marche
pas. `Documents` peut etre repris par OneDrive, et la version de Max est celle qu'Ableton embarque —
Live 12.4 livre Max 9, qui ignore le dossier `Max 8`. `-Where` donne les valeurs reelles.

| Fichier | Ou | Qui le lit |
|---|---|---|
| `Vassi Stream.amxd` | `<Documents>\Ableton\User Library\Presets\Audio Effects\Max Audio Effect\Vassi Stream\` | Live, pour l'afficher dans son navigateur |
| `node/` avec son `node_modules` | `<Documents>\Max <N>\Library\Vassi Stream\node\` | Max, qui n'indexe **que** sa propre bibliotheque |
| `vassi.encoder~.mxe64` | `<Documents>\Max <N>\Library\Vassi Stream\externals\` | Max, idem |
| `publisher.json` | `%APPDATA%\Vassi Stream\` | le device, au demarrage |

Le raisonnement derriere ces deux emplacements — et pourquoi ils ne sont pas interchangeables — est
dans [`docs/device-max.md`](docs/device-max.md), section « Installer sur un nouvel ordinateur ».

## Pour developper

L'installation n'en a pas besoin, mais les outils du projet (tests, verification du relais,
construction du device depuis le code) demandent les dependances de developpement :

```powershell
npm install
```

| Commande | Effet |
|---|---|
| `npm.cmd run device:where` | ce que `-Where` affiche |
| `npm.cmd run device:install` | l'installation seule, sans la facade PowerShell |
| `npm.cmd run device:build` | **regenere le patcher depuis le code** — ecrase les retouches faites dans Max |
| `npm.cmd run relay:check -- https://live.vassi.click` | verifie le relais de l'exterieur, sans token |
