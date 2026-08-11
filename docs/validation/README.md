# Journal de validation

Ce dossier est un **journal**, pas une documentation. Chaque note enregistre ce qui a été vérifié à
une date donnée : les commandes lancées, les mesures relevées, les défauts trouvés.

**Ces notes ne sont jamais réécrites.** Elles décrivent l'état du projet au moment où elles ont été
écrites, et vieillissent donc volontairement. Pour savoir comment le système fonctionne
*aujourd'hui*, lire les documents de [`docs/`](../README.md), jamais ces notes.

Trois familles :

| Dossier | Ce qu'il contient |
|---|---|
| [`blocs/`](blocs/) | une note par bloc de [Roadmap.md](../../Roadmap.md), écrite à sa clôture |
| [`incidents/`](incidents/) | les analyses de pannes réelles et les revues de code, datées |
| [`procedures/`](procedures/) | les fiches de test manuel, à suivre pour rejouer une vérification |

## `blocs/`

| Note | Date | Ce qui a été validé |
|---|---|---|
| [bloc-0.md](blocs/bloc-0.md) | 2026-08-02 | versions relevées, cible Windows x64, fichier audio de test |
| [bloc-1.md](blocs/bloc-1.md) | 2026-08-02 | protocole spécifié, en-tête binaire encodé et relu |
| [bloc-2.md](blocs/bloc-2.md) | 2026-08-02 | objet MSP `vassi.encoder~` en capture passive |
| [bloc-3.md](blocs/bloc-3.md) | 2026-08-02 | queue audio bornée et worker hors du thread audio |
| [bloc-4.md](blocs/bloc-4.md) | 2026-08-03 | rééchantillonnage 48 kHz et encodage Opus |
| [bloc-5.md](blocs/bloc-5.md) | 2026-08-03 | pont loopback `VSF1` entre l'objet natif et Node |
| [bloc-6.md](blocs/bloc-6.md) | 2026-08-03 | publisher Node : connexion WSS, états, reconnexion |
| [bloc-7.md](blocs/bloc-7.md) | 2026-08-03 | relais : authentification, diffusion, route de santé |
| [bloc-8.md](blocs/bloc-8.md) | 2026-08-03 | moteur audio navigateur : décodage et lecture |
| [bloc-8b.md](blocs/bloc-8b.md) | 2026-08-03 | durcissement du moteur audio, diagnostics, dérive de retard |
| [bloc-9.md](blocs/bloc-9.md) | 2026-08-05 | page `/session` sur le site et pont de synchronisation du moteur |
| [bloc-10.md](blocs/bloc-10.md) | 2026-08-04 | interface du device Max for Live |

Le bloc 11 n'a pas de note : c'est lui qui est en cours.

## `incidents/`

| Note | Date | Sujet |
|---|---|---|
| [2026-08-03-revue-robustesse.md](incidents/2026-08-03-revue-robustesse.md) | 2026-08-03 | relecture complète des blocs 0 à 5, défauts corrigés |
| [2026-08-06-incident-meet.md](incidents/2026-08-06-incident-meet.md) | 2026-08-06 | le direct s'effondre pendant un appel Google Meet : cause mesurée et plan |
| [2026-08-06-continuite-direct.md](incidents/2026-08-06-continuite-direct.md) | 2026-08-06 | analyse de deux journaux du soir, après les correctifs de la matinée |

## `procedures/`

| Fiche | Ce qu'elle fait rejouer |
|---|---|
| [test-pont-ableton.md](procedures/test-pont-ableton.md) | vérifier dans un vrai Max que les trames Opus passent de `vassi.encoder~` à `node.script` |
| [essai-long-moteur-audio.md](procedures/essai-long-moteur-audio.md) | essai de quarante-cinq minutes du moteur d'écoute sous charge réelle |
