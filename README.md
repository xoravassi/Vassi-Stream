# Vassi Stream

## À quoi sert ce projet

Vassi Stream diffuse en direct le son de la piste Master d'un projet Ableton Live sur une page web
publique. Un device Max for Live capture le son, l'encode en Opus et l'envoie à un relais qui le
redistribue à toute personne connectée à la page.

Le premier usage est de faire écouter une session Ableton Live à un professeur de production
musicale, en direct, pendant un appel vidéo (Google Meet ou équivalent). Le son est stéréo, sans
coupure, sans compression audible et avec la latence la plus basse possible.

## Architecture globale

```text
Ableton Live (poste de Vassi)                Internet                  Navigateur (n'importe qui)
┌──────────────────────────┐                                        ┌──────────────────────────┐
│ piste Master               │                                       │ page www.vassi.click/     │
│  └─ device Max for Live    │   wss://.../publisher   ┌──────────┐   session                     │
│      vassi.encoder~        │ ───────────────────────▶│  relais  │──▶ wss://.../listener         │
│      (capture + Opus)      │                          │ Sliplane │   décodage + lecture audio    │
│      node.script            │                          └──────────┘                              │
│      (connexion WebSocket) │                                       │                              │
└──────────────────────────┘                                        └──────────────────────────┘
```

Trois parties, trois cycles de vie différents :

| Partie | Rôle | Où elle tourne | Documentation |
|---|---|---|---|
| **Device Max for Live** | capture le son du Master, l'encode en Opus, l'envoie au relais | l'ordinateur de Vassi, dans Ableton | [docs/device-max.md](docs/device-max.md), [docs/publisher-node.md](docs/publisher-node.md), [docs/bridge-vsf1.md](docs/bridge-vsf1.md) |
| **Relais** | reçoit le flux du device et le redistribue à tous les auditeurs | serveur Sliplane, en continu | [docs/relay-node.md](docs/relay-node.md), [docs/deploiement-sliplane.md](docs/deploiement-sliplane.md) |
| **Page web** | reçoit le flux du relais, le décode et le joue | navigateur de l'auditeur, sur `vassi.click` | [docs/player-web.md](docs/player-web.md), [docs/pont-site-web.md](docs/pont-site-web.md) |

Le contrat qui relie ces trois parties — le format exact des messages et des paquets audio — est fixé
une seule fois dans [docs/protocol-v1.md](docs/protocol-v1.md). Le device, le relais et la page web
lisent tous ce même document ; ils ne peuvent pas diverger sans que le protocole change.

Le relais ne décode jamais l'audio : il vérifie la structure d'un paquet et renvoie les mêmes octets
à chaque auditeur. Le décodage se fait uniquement dans le navigateur.

Ce dépôt (`vassi-stream`) contient le device et le relais. Le site `vassi.click` est un second dépôt,
séparé ; voir « Le lien avec le site web » plus bas.

## Comment utiliser les différentes parties

### Développement et vérification

```powershell
npm.cmd run check
```

Lance tous les tests du projet : typecheck, tests unitaires, tests de l'objet natif, de l'encodeur,
du pont interne, et vérification que la copie du moteur audio sur le site est à jour.

### Le relais

Le relais tourne en continu sur Sliplane, il n'y a rien à lancer à la main une fois déployé. La
marche à suivre complète pour le mettre en ligne (création du service, domaine, token, vérification)
est dans [docs/deploiement-sliplane.md](docs/deploiement-sliplane.md).

Pour vérifier qu'un relais déployé répond correctement :

```powershell
npm.cmd run relay:check -- https://live.vassi.click
```

Pour fabriquer un nouveau token de publication :

```powershell
npm.cmd run token:new
```

### Le device Max for Live

```powershell
npm.cmd run device:build
```

Régénère le device (`device/Vassi Stream.amxd` et `patchers/vassi-stream.maxpat`) à partir du code
de `scripts/device-patcher/`, puis l'installe dans la bibliothèque Ableton. **Une fois le device
ouvert et retouché dans Max, c'est le `.maxpat` qui fait foi** : relancer `device:build` écraserait
ces retouches. Voir « Setup du device » ci-dessous pour l'installation sur un poste.

Pour voir la mise en page du device sans ouvrir Ableton :

```powershell
npm.cmd run device:preview
```

### La page web

Le moteur audio du navigateur (décodage, lecture) vit dans ce dépôt, dans `src/player/`. Il est
copié dans le dépôt du site avant chaque déploiement :

```powershell
npm.cmd run player:sync
```

Ce n'est jamais dans le dépôt du site qu'il faut modifier ce code : toute modification se fait ici,
puis se recopie avec cette commande. Détail complet dans
[docs/pont-site-web.md](docs/pont-site-web.md).

## Setup du device Max for Live

**Sur un nouvel ordinateur**, une seule commande installe le device au bon endroit :

```powershell
npm.cmd run device:install
```

Ensuite, dans Ableton :

1. Catégories > Audio Effects > Max Audio Effect > Vassi Stream, déposer le device sur la piste
   Master.
2. Cliquer sur l'onglet **Réglages**.
3. Dans le champ **Relais**, coller l'adresse WebSocket du relais déployé, par exemple
   `wss://live.vassi.click/publisher`. L'adresse doit commencer par `wss://` dès qu'elle sort de la
   machine locale ; `ws://` transporterait le token en clair et est refusé.
4. Dans le champ **Token**, coller le token de publication (produit par `npm.cmd run token:new`,
   propre au relais déployé).
5. Cliquer sur **Enregistrer**, puis sur **Tester le relais**. La ligne du bas doit afficher
   l'adresse, les quatre derniers caractères du token, puis `relais joignable`. Si elle affiche autre
   chose, elle dit quoi corriger.

Un champ laissé vide garde sa valeur précédente : corriger l'adresse ne demande pas de recoller le
token, et l'inverse. Le champ du token se vide dès que l'enregistrement réussit.

Une fois configuré, l'onglet **Direct** sert au quotidien : bouton **Lancer** / **Arrêter**, choix de
la qualité (Stable 128 / Haute 192 / Studio 256) et de la latence (Faible 200 ms / Équilibrée 400 ms
/ Stable 800 ms / Longue 1500 ms). Ces deux réglages se verrouillent pendant un direct.

L'onglet **Journal** garde 400 lignes datées de ce qui s'est passé pendant un direct. Trois boutons :
**Copier**, **Exporter** vers `%APPDATA%\Vassi Stream\journaux\`, et **Vider**. C'est ce qu'il faut
envoyer quand un direct s'est mal passé ; il ne contient aucun secret.

Détail complet, y compris ce qui est enregistré avec le projet Ableton et ce qui ne l'est jamais :
[docs/device-max.md](docs/device-max.md).

## Points importants

- **Le token de publication ne doit jamais entrer dans Git, dans un message ou dans un projet
  Ableton.** Il vit uniquement dans les variables d'environnement de Sliplane et dans
  `%APPDATA%\Vassi Stream\publisher.json`, propre à chaque ordinateur. Le device n'en affiche jamais
  que les quatre derniers caractères.
- **Un seul publisher actif à la fois.** Une nouvelle connexion avec un token valide remplace la
  précédente ; cela évite qu'une connexion coupée mais pas encore détectée bloque un nouveau direct.
- **Le relais ne garde aucun historique.** Un auditeur qui rejoint pendant un direct entend la suite,
  jamais ce qui précède.
- **Le format des messages et des paquets audio n'est défini qu'une fois**, dans
  `docs/protocol-v1.md`, et un seul module (`src/protocol/audio-packet.ts`) valide un paquet audio
  pour le device, le relais et la page web.
- **Le moteur audio du navigateur est dupliqué dans le dépôt du site**, pas partagé par un lien ou un
  paquet npm. `npm run check` échoue si la copie n'est pas à jour ; la commande à relancer est
  `npm run player:sync`.
- **Le `.maxpat` fait foi après une première ouverture dans Max.** `device:build` sert à poser la
  première version du device, pas à écraser des retouches faites ensuite dans Max.
- **État actuel du projet** (voir [Roadmap.md](Roadmap.md)) : la chaîne complète fonctionne de bout
  en bout — Ableton, relais déployé, page `/session` — et `npm.cmd run check` passe. Reste la série
  de tests précis sur les cas limites (direct long, coupure réseau, écran de téléphone éteint,
  second auditeur), puis le gel du device : c'est l'objet du bloc 11 de la roadmap. Deux chantiers
  distincts sont décrits à part : partager le device avec le professeur, dans
  [docs/partage-device.md](docs/partage-device.md), et publier le projet en open source, dans
  [docs/Roadmap-v2.md](docs/Roadmap-v2.md).
