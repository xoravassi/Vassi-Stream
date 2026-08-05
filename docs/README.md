# Documentation de Vassi Stream

Ce dossier contient tout ce qui explique le projet. Le point d'entrée général reste le
[README](../README.md) à la racine ; les documents ci-dessous entrent dans le détail d'une partie.

## Le contrat commun

| Document | Ce qu'il fixe |
|---|---|
| [protocol-v1.md](protocol-v1.md) | le format exact des messages JSON et des paquets audio binaires |

C'est le seul document que les trois parties du système lisent toutes. Le device, le relais et la
page web ne peuvent pas diverger sans que ce document change d'abord.

## Les trois parties

| Document | Ce qu'il décrit |
|---|---|
| [device-max.md](device-max.md) | le device Max for Live : ce qu'il affiche, comment il est construit, comment l'installer |
| [bridge-vsf1.md](bridge-vsf1.md) | le pont interne entre l'objet natif `vassi.encoder~` et Node, à l'intérieur du device |
| [publisher-node.md](publisher-node.md) | le côté Node du device : connexion au relais, états, reconnexion, configuration |
| [relay-node.md](relay-node.md) | le relais : authentification du publisher, diffusion aux auditeurs, route de santé |
| [player-web.md](player-web.md) | le moteur audio du navigateur : décodage Opus, file d'attente, lecture |

## Mettre en ligne

| Document | Ce qu'il permet |
|---|---|
| [deploiement-sliplane.md](deploiement-sliplane.md) | déployer le relais de zéro : service, domaine, token, vérification |
| [pont-site-web.md](pont-site-web.md) | comment le moteur audio écrit ici arrive dans le dépôt du site `vassi.click` |

## Références

| Document | Ce qu'il contient |
|---|---|
| [environment.md](environment.md) | les versions relevées sur la machine de développement et les cibles retenues |
| [Roadmap-v2.md](Roadmap-v2.md) | le plan pour publier le projet en open source |

La roadmap de la version actuelle est [Roadmap.md](../Roadmap.md), à la racine.

## `validation/`

Ce sous-dossier est un journal, pas une documentation. Chaque note enregistre ce qui a été vérifié
à la fin d'un bloc de la roadmap, avec la date, les commandes lancées et les défauts trouvés. Ces
notes décrivent l'état du projet au moment où elles ont été écrites et ne sont jamais réécrites
ensuite : pour savoir comment le système fonctionne aujourd'hui, lire les documents du tableau
ci-dessus, pas ces notes.
