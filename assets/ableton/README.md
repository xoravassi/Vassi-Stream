# Projets Ableton Live de test

`Test-file Project` est le projet Live utilise pour les tests manuels du device.

Il contient le set `Test-file.als` : le device Vassi Stream est place sur la piste Master et des
pistes audio fournissent le son a capturer.

Ce projet reference le fichier `assets/audio/vassi-stereo-test-48k-24bit.wav` par la copie deposee
dans la User Library d'Ableton par `npm run prepare:ableton`. Lancer cette commande avant d'ouvrir
le set sur une machine neuve, sinon Live signale un fichier manquant.

Le set est ouvert directement depuis ce dossier : Live ne demande pas que ses projets vivent dans
un emplacement particulier.

Seul le fichier `.als` est suivi par Git. Live recree tout seul, au premier enregistrement, le
dossier `Ableton Project Info` et le dossier `Backup` de ses sauvegardes automatiques : ces deux
dossiers ne decrivent rien du projet et pesaient a eux seuls un demi-megaoctet.
