# Phase 0 - Environnement

Date du releve : 2026-08-02.

## Resultat

La premiere cible de developpement est Windows x64 avec Ableton Live 11 Suite et Max 8 integre.

## Versions relevees

| Element | Valeur | Source locale |
|---|---:|---|
| Windows | Windows 10 Pro | `Get-ComputerInfo` |
| Architecture cible | Windows x64 | cible locale Windows, Ableton Live x64 |
| Ableton Live | 11.3.43 | `Ableton Live 11 Suite.exe`, log Ableton |
| Build Ableton Live | 2025-10-06_b466d4f56c | log Ableton |
| Max integre | 8.5.8 | `Max.exe`, log Ableton |
| Node for Max core | 2.0.5 | `Node for Max/source/package.json` |
| Node integre a Node for Max | 16.6.0 | `node.exe --version` |
| npm integre a Node for Max | 7.19.1 | `Node for Max/source/bin/npm/package.json` |
| Node systeme | 24.18.0 | `node --version` |
| npm systeme | 11.16.0 | `npm.cmd --version` |

## Audio Ableton observe

| Element | Valeur | Source locale |
|---|---:|---|
| Driver | MME/DirectX | log Ableton |
| Entree | No Device | log Ableton |
| Sortie | Haut-parleur/Ecouteurs Realtek DX | log Ableton |
| Sample rate observe | 44100 Hz | log Ableton |
| Taille buffer observee | 4096 samples | log Ableton |
| Latence globale observee | 92.9 ms | log Ableton |

Le developpement doit donc gerer au minimum une entree Ableton a 44,1 kHz et convertir le flux vers 48 kHz avant Opus, comme prevu par la roadmap.

## Fichier audio de test

Fichier cree : `assets/audio/vassi-stereo-test-48k-24bit.wav`.

Caracteristiques :
- duree : 10 secondes ;
- format : WAV PCM ;
- sample rate : 48 kHz ;
- resolution : 24 bit ;
- canaux : stereo ;
- canal gauche : sinus 440 Hz ;
- canal droit : sinus 880 Hz.

Ce fichier sert a verifier rapidement que Live lit le fichier, que le flux reste stereo et que les canaux gauche/droite ne sont pas inverses.

## Navigateurs

Vassi utilise Firefox.

Le professeur est sur macOS. Son navigateur probable est Safari, mais le projet ne doit pas dependre d'un navigateur precis.

Cible navigateur pour la page `/live` :
- Firefox recent ;
- Safari recent sur macOS ;
- Chrome recent ;
- Edge recent.

La page doit rester simple cote navigateur, mais elle utilise quand meme des fonctions modernes :
- WebSocket pour recevoir le flux ;
- Web Worker pour decoder sans bloquer l'interface ;
- WebAssembly pour le decodeur Opus ;
- AudioWorklet pour jouer l'audio avec une latence stable.

Ces fonctions existent dans les navigateurs modernes, mais Safari doit etre teste explicitement quand la page audio existe, car son comportement audio peut etre plus strict que Firefox ou Chrome.

## Relais Sliplane et WSS

Site public cible : `https://www.vassi.click`.

URL exacte du relais WebSocket : a definir quand le relais existe.

Le Bloc 1 peut avancer sans relais deploye, car il definit seulement le format des messages. Le relais devient necessaire a partir des blocs serveur et site, parce que Max doit envoyer vers une adresse WebSocket publisher et la page `/live` doit recevoir depuis une adresse WebSocket listener.

Choix propose : **sous-domaine dedie**, `wss://live.vassi.click/publisher` et `wss://live.vassi.click/listener`.

Un service Sliplane porte son propre domaine, et `www.vassi.click` appartient deja au service du site : le relais ne peut donc pas s'y glisser, il lui faut son propre nom. Un sous-domaine separe aussi les deux trafics, ce qui evite qu'un redemarrage du relais coupe la navigation sur le site.

Le relais se configure comme service HTTP public derriere le proxy TLS de Sliplane : c'est ce qui rend les adresses `wss://` disponibles. La marche a suivre complete est dans `docs/deploiement-sliplane.md`.

Verification restante :
- tester une route WebSocket `wss://...` une fois le relais deploye, avec `npm run relay:check -- https://live.vassi.click`.

## Recherche Internet effectuee

Sources consultees :
- Node for Max - Cycling '74 : https://docs.cycling74.com/legacy/max8/vignettes/00_N4M_index
- `node.script` - Cycling '74 : https://docs.cycling74.com/reference/node.script
- Demarrage et arret Node for Max - Cycling '74 : https://docs.cycling74.com/legacy/max8/vignettes/05_n4m_startstop
- Sliplane docs : https://docs.sliplane.io/introduction/getting-started/
- Sliplane API : https://ctrl.sliplane.io/

Points retenus :
- `node.script` lance un processus Node separe depuis Max.
- `node.script` peut demarrer automatiquement avec l'attribut `@autostart`.
- la version de Node for Max depend de Max/Ableton local ; la version locale relevee prime sur la documentation generale.
- Sliplane expose les services publics via HTTP et domaines ; la validation WSS demande le relais reel.

## A confirmer par Vassi

- La confirmation du sous-domaine `live.vassi.click` pour le relais.
- Le test Safari quand la page `/live` existe. Le moteur audio du bloc 8 se teste des maintenant avec `npm run player:fixture`.
