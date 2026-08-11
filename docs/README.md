# Documentation de Vassi Stream

Ce dossier contient tout ce qui explique le projet. Le point d'entrée général reste le
[README](../README.md) à la racine ; les documents ci-dessous entrent dans le détail d'une partie.

## Le contrat commun

| Document | Ce qu'il fixe |
|---|---|
| [protocol-v1.md](protocol-v1.md) | le format exact des messages JSON et des paquets audio binaires |

C'est le seul document que les trois parties du système lisent toutes. Le device, le relais et la
page web ne peuvent pas diverger sans que ce document change d'abord. Aucun autre document ne
recopie ses tables.

## Les trois parties

| Document | Ce qu'il décrit |
|---|---|
| [device-max.md](device-max.md) | le device Max for Live : ce qu'il affiche, comment il est construit, ce qu'il enregistre |
| [bridge-vsf1.md](bridge-vsf1.md) | le pont interne entre l'objet natif `vassi.encoder~` et Node, à l'intérieur du device |
| [publisher-node.md](publisher-node.md) | le côté Node du device : connexion au relais, états, reconnexion, configuration |
| [relay-node.md](relay-node.md) | le relais : authentification du publisher, diffusion aux auditeurs, route de santé |
| [player-web.md](player-web.md) | le moteur audio du navigateur : décodage Opus, file d'attente, lecture |

## Installer et mettre en ligne

| Document | Ce qu'il permet |
|---|---|
| [../INSTALLATION.md](../INSTALLATION.md) | installer le device sur une machine, et dépanner l'installation |
| [deploiement-sliplane.md](deploiement-sliplane.md) | déployer le relais de zéro : service, domaine, token, vérification |
| [pont-site-web.md](pont-site-web.md) | comment le moteur audio écrit ici arrive dans le dépôt du site `vassi.click` |

## Références

| Document | Ce qu'il contient |
|---|---|
| [environment.md](environment.md) | les plateformes, navigateurs et adresses sur lesquels le projet compte |

## Ce qui reste à faire

| Document | Le chantier |
|---|---|
| [../Roadmap.md](../Roadmap.md) | la roadmap de la version actuelle — le bloc 11 est le seul encore ouvert |
| [partage-device.md](partage-device.md) | ce qu'il faut construire pour qu'une deuxième personne puisse diffuser |
| [Roadmap-v2.md](Roadmap-v2.md) | ce qu'il faudrait pour publier le projet en open source |

## `validation/`

Un journal, pas une documentation : chaque note enregistre ce qui a été vérifié à une date donnée et
n'est jamais réécrite ensuite. Pour savoir comment le système fonctionne aujourd'hui, lire les
documents des tableaux ci-dessus, pas ces notes. L'index est dans
[validation/README.md](validation/README.md), qui range les notes en trois familles :
`blocs/`, `incidents/` et `procedures/`.
