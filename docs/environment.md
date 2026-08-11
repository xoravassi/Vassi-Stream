# Environnement et cibles

Ce document dit sur quoi le projet tourne et ce qu'il doit savoir gerer. Les versions exactes d'une
machine ne sont pas ecrites en dur : `npm.cmd run device:where` les lit sur la machine, et c'est
cette lecture qui fait foi.

## Plateforme

| Element | Valeur |
|---|---|
| Systeme cible | Windows x64 |
| Hote Max | celui livre avec Ableton Live, jamais un Max installe a part |
| Node du device | celui de Node for Max, embarque dans Max |
| Node des outils du depot | 24.12 ou plus (`devEngines` dans `package.json`) |

**macOS n'est pas supporte.** L'external `vassi.encoder~` n'existe qu'en `.mxe64` Windows ; il
faudrait un `.mxo` compile sur un Mac. Le sujet est traite dans
[partage-device.md](partage-device.md) et dans [Roadmap-v2.md](Roadmap-v2.md).

**La version de Max n'est pas devinable.** C'est celle qu'Ableton embarque, pas celle du dernier Max
sorti ni celle d'un dossier deja present : Live 12.4 livre Max 9, qui indexe `Max 9\Library` et
ignore `Max 8`. De meme, `Documents` peut etre repris par OneDrive. Les deux valeurs sont deduites de
la machine par `scripts/install-paths.js`. Le raisonnement complet est dans
[device-max.md](device-max.md), section « Installer sur un nouvel ordinateur ».

## Audio d'entree

Ableton peut tourner a 44,1 kHz comme a 48 kHz. Opus n'accepte que 48 kHz : le worker de l'objet
natif reechantillonne donc le flux avant d'encoder. Gerer au moins 44,1 et 48 kHz en entree est une
exigence du projet, pas une precaution.

Le fichier `assets/audio/vassi-stereo-test-48k-24bit.wav` sert a verifier la chaine sans jouer de
morceau : 10 secondes, WAV PCM 48 kHz 24 bit, sinus 440 Hz a gauche et 880 Hz a droite. Une inversion
de canaux ou une perte de stereo s'entend immediatement.

## Navigateurs

| Role | Navigateur |
|---|---|
| Vassi | Firefox |
| Le professeur | Safari sur macOS |

La page ne doit dependre d'aucun navigateur precis. Sa cible est Firefox, Safari, Chrome et Edge en
version recente. Elle utilise quatre fonctions modernes :

- WebSocket, pour recevoir le flux ;
- Web Worker, pour decoder sans bloquer l'interface ;
- WebAssembly, pour le decodeur Opus ;
- AudioWorklet, pour jouer l'audio a latence stable.

**Safari se teste explicitement.** Son comportement audio est plus strict que celui de Firefox ou de
Chrome, et c'est le navigateur du professeur. Le moteur seul se teste sans le site avec
`npm.cmd run player:fixture`. Les contraintes propres a iOS et aux pages en arriere-plan sont dans
[player-web.md](player-web.md), section « Telephone en veille et page en arriere-plan ».

`SharedArrayBuffer` n'est pas disponible : les en-tetes COOP/COEP ne sont pas poses sur le site, et
ne le seront pas. Le moteur bascule alors sur un transport par `MessagePort`, valide sous charge
reelle. Le detail est dans [player-web.md](player-web.md).

## Adresses

| Adresse | Ce qui repond |
|---|---|
| `https://www.vassi.click/session` | la page d'ecoute publique |
| `wss://live.vassi.click/publisher` | le relais, cote device |
| `wss://live.vassi.click/listener` | le relais, cote page |
| `https://live.vassi.click/health` | la route de sante du relais |

Le relais porte son propre sous-domaine parce qu'un service Sliplane porte son propre domaine et que
`www.vassi.click` appartient deja au service du site. Cette separation evite aussi qu'un redemarrage
du relais coupe la navigation sur le site.

L'adresse `live.vassi.click/session` — celle qu'il serait plus simple de donner au professeur —
demande une regle de routage qui n'est pas posee : `live.vassi.click` pointe sur le relais, pas sur
le site. Tant qu'elle n'existe pas, la page s'ouvre a `www.vassi.click/session`.

La mise en ligne du relais est decrite dans [deploiement-sliplane.md](deploiement-sliplane.md). Pour
verifier un relais deploye de l'exterieur, sans token :

```powershell
npm.cmd run relay:check -- https://live.vassi.click
```
