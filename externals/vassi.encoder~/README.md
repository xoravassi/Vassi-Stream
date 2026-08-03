# vassi.encoder~

`vassi.encoder~` est l'objet MSP natif du device Max for Live.

## Choix technique

Le bloc 2 utilise le Max SDK direct, pas Min-DevKit.

Raison :
- Max integre cible : Max 8.5.8 dans Ableton Live 11 Suite.
- L'objet doit seulement creer deux entrees signal et une routine `dsp64`.
- Le Max SDK expose directement `dsp_setup`, `class_dspinit` et `dsp_add64`.
- Le code reste court et lisible sans couche C++ supplementaire.

## Comportement

- L'objet a deux entrees signal.
- L'objet ne cree aucune sortie audio.
- L'objet cree une sortie message pour le diagnostic.
- Le message `bang` sort `blocks <total> <left> <right> <samples>`.
- Le message `bang` sort aussi `queue <frames> <capacity_frames> <capacity_ms> <overflows> <worker_samples> <last_left> <last_right> <worker_running>`.
- Le message `bang` sort aussi `encoder <bitrate> <frames> <discontinuities> <payload_bytes> <flags> <error>`.
- Le message `reset` remet les compteurs a zero.
- Le message `active 0` suspend les compteurs.
- Le message `active 1` reprend les compteurs.
- Le message `start` demarre le worker si aucun worker n'est actif.
- Le message `stop` arrete le worker proprement.
- Le message `quality 0` selectionne Stable a 128 kbit/s pour le prochain demarrage.
- Le message `quality 1` selectionne Haute a 192 kbit/s pour le prochain demarrage.
- Le message `quality 2` selectionne Studio a 256 kbit/s pour le prochain demarrage.
- Le message `port <numero>` enregistre le port loopback annonce par `node.script`.
- Le message `port 0` ferme la connexion vers `node.script`.
- Le message `bang` sort aussi `bridge <port> <connecte> <envoyees> <perdues>`.
- L'objet sort `status connected` ou `status disconnected` quand la connexion vers Node change.

## Regle audio

La routine `perform64` compte les blocs audio recus et copie les deux canaux vers une queue stereo preallouee.

Elle ne fait pas :
- allocation memoire ;
- log Max ;
- appel reseau ;
- attente ou verrou explicite.

Le worker lit toutes les frames de la queue dans deux buffers stereo prealloues hors routine audio.

Le worker convertit le signal en 48 kHz stereo avec SpeexDSP quand l'entree n'est pas deja a 48 kHz. Il accumule ensuite 960 samples par canal et encode une frame Opus de 20 ms avec `OPUS_APPLICATION_AUDIO`.

Le profil par defaut est Studio a 256 kbit/s. Une nouvelle commande `start` remet l'encodeur et la sequence a zero. Un overflow remet les etats audio a zero, conserve la sequence de la session et marque la premiere frame suivante comme discontinue.

Quand la queue est pleine, l'objet abandonne les samples les plus anciens et incremente le compteur `overflows`.

La queue contient toujours 1000 ms au sample rate d'entree annonce par `dsp64`.

Elle contient donc :
- 44100 samples par canal a 44,1 kHz ;
- 48000 samples par canal a 48 kHz.

## Build attendu

Les outils locaux attendus se trouvent dans `.local` et restent ignores par le projet.

Pour compiler sur Windows x64 :

1. Verifier que le Max SDK, CMake et Visual Studio Build Tools existent dans les chemins documentes.
2. Executer `scripts\build-vassi-encoder.cmd` depuis la racine du projet. Le script verifie puis telecharge si necessaire libopus 1.5.2 et SpeexDSP 1.2.1 dans `.local/deps`.
3. Verifier la sortie `.local\artifacts\vassi.encoder~.mxe64`.
4. Fermer Ableton Live et Max, qui verrouillent le fichier tant qu'ils sont ouverts.
5. Executer `scripts\install-vassi-encoder.cmd`. Ce script copie l'artefact vers `externals/` et vers
   `%USERPROFILE%\Documents\Max 8\Library\Vassi Stream\externals`, le dossier lu par Max et par Max for Live.

Sans cette derniere etape, Max continue de charger la version compilee precedente.

Le patch `patchers/vassi.encoder.passive-test.maxpat` sert ensuite a verifier le chargement et le comptage dans Max/Ableton.

## Guide debutant : faire fonctionner vassi.encoder~ dans Ableton Live 11

Cette partie explique le chemin complet depuis le code source jusqu'au test dans Ableton Live 11.

### 1. Comprendre les fichiers

Les fichiers `source/vassi.encoder.cpp`, `source/audio_queue.cpp` et `source/encoder_worker.cpp` composent le code source.

Max ne charge pas directement ce fichier `.cpp`.

Sur Windows, Max charge un fichier compile avec l'extension `.mxe64`.

Le fichier attendu apres compilation est donc :

```text
vassi.encoder~.mxe64
```

Tant que ce fichier `.mxe64` n'existe pas, l'objet `vassi.encoder~` ne peut pas fonctionner dans Max ou dans Ableton.

### 2. Installer les outils de compilation

Pour compiler l'objet sur cet ordinateur Windows, il faut :

- le Max SDK compatible Max 8 ;
- Visual Studio avec les outils C++ Windows x64 ;
- CMake si le projet de build du SDK l'utilise.

Ableton Live 11 et Max for Live permettent d'utiliser l'objet une fois compile, mais ils ne compilent pas le fichier `.cpp`.

### 3. Compiler l'external

Le but de cette etape est de transformer :

```text
externals/vassi.encoder~/source/vassi.encoder.cpp
```

en :

```text
vassi.encoder~.mxe64
```

Procedure generale :

1. Ouvrir un terminal a la racine du projet.
2. Executer `scripts\build-vassi-encoder.cmd`.
3. Attendre le message `Build termine.`.
4. Verifier que `.local\artifacts\vassi.encoder~.mxe64` existe.

Si le fichier final a un autre nom, Max ne trouvera pas l'objet avec le texte `vassi.encoder~`.

### 4. Installer le fichier compile pour Max

Max trouve les externals dans ses dossiers de recherche.

Pour un test simple sur cet ordinateur, creer ce dossier si besoin :

```text
C:\Users\LENOVO\Documents\Max 8\Library\Vassi Stream\externals
```

Copier ensuite le fichier compile ici :

```text
C:\Users\LENOVO\Documents\Max 8\Library\Vassi Stream\externals\vassi.encoder~.mxe64
```

Fermer puis rouvrir Max apres la copie.

Si Max etait deja ouvert, il peut ne pas voir le nouveau fichier tout de suite.

### 5. Tester dans Max avant Ableton

Ouvrir Max.

Creer un nouveau patch.

Creer un objet avec ce texte :

```text
vassi.encoder~
```

Resultat attendu :

- l'objet apparait normalement ;
- le texte ne devient pas rouge ;
- la console Max ne signale pas que l'objet est introuvable.

Si l'objet est introuvable, verifier :

- le fichier `.mxe64` existe ;
- le fichier est dans un dossier du Search Path de Max ;
- le nom du fichier est exactement `vassi.encoder~.mxe64` ;
- l'external est compile en Windows x64.

### 6. Tester dans Ableton Live 11

Ouvrir Ableton Live 11.

Ajouter un device Max for Live de type Audio Effect sur une piste audio ou sur le master.

Ouvrir le device dans Max.

Le patch de test du depot est :

```text
patchers/vassi.encoder.passive-test.maxpat
```

Ce patch contient trois objets importants :

- `plugin~` recoit le son venant d'Ableton ;
- `plugout~` renvoie le son vers Ableton ;
- `vassi.encoder~` recoit une copie du son pour compter les blocs audio.

Le routage attendu est :

```text
plugin~ sortie gauche  -> plugout~ entree gauche
plugin~ sortie droite  -> plugout~ entree droite

plugin~ sortie gauche  -> vassi.encoder~ entree gauche
plugin~ sortie droite  -> vassi.encoder~ entree droite
```

Le son audible passe donc directement de `plugin~` a `plugout~`.

`vassi.encoder~` ecoute une copie du signal et ne renvoie pas de son.

### 7. Verifier le compteur

Lancer la lecture dans Ableton.

Dans le patch, cliquer sur le bouton connecte a `vassi.encoder~`.

La console Max doit afficher un message de cette forme :

```text
blocks 120 120 120 61440
```

Les nombres exacts peuvent changer.

Le sens des nombres est :

- premier nombre : nombre total de blocs audio recus ;
- deuxieme nombre : nombre de blocs recus sur l'entree gauche ;
- troisieme nombre : nombre de blocs recus sur l'entree droite ;
- quatrieme nombre : nombre total de samples par canal comptabilises.

Le message `queue` suit le message `blocks`.

Exemple :

```text
queue 0 44100 1000 0 61440 0.12 -0.08 1
```

Le sens des nombres est :

- premier nombre : samples stereo en attente dans la queue ;
- deuxieme nombre : capacite de la queue en samples par canal ;
- troisieme nombre : capacite de la queue en millisecondes ;
- quatrieme nombre : nombre de fois ou la queue a abandonne de l'audio ancien ;
- cinquieme nombre : samples lus par le worker ;
- sixieme nombre : dernier sample gauche lu par le worker ;
- septieme nombre : dernier sample droit lu par le worker ;
- huitieme nombre : `1` si le worker tourne, `0` sinon.

Pour valider ce bloc, les compteurs gauche et droite doivent augmenter pendant que l'audio tourne.

### 8. Verifier que le son n'est pas modifie

Le son doit rester audible quand `vassi.encoder~` est present.

Pour ce test, ne pas utiliser les messages `active 0` et `active 1`.

Le test se fait avec deux versions du patch :

Version A, avec capture :

```text
plugin~ sortie gauche  -> plugout~ entree gauche
plugin~ sortie droite  -> plugout~ entree droite

plugin~ sortie gauche  -> vassi.encoder~ entree gauche
plugin~ sortie droite  -> vassi.encoder~ entree droite
```

Version B, sans capture :

```text
plugin~ sortie gauche  -> plugout~ entree gauche
plugin~ sortie droite  -> plugout~ entree droite
```

Dans les deux versions, le chemin audible reste uniquement `plugin~` vers `plugout~`.

Le son doit donc rester identique quand les deux cables vers `vassi.encoder~` sont ajoutes ou retires.

Si le son change, verifier d'abord que les cables directs entre `plugin~` et `plugout~` sont toujours presents.

### 9. Erreurs courantes

`vassi.encoder~` est rouge ou introuvable :

- le fichier `.mxe64` n'est pas compile ;
- le fichier `.mxe64` n'est pas dans le Search Path de Max ;
- Max n'a pas ete relance apres la copie ;
- le nom du fichier ne correspond pas exactement au nom de l'objet.

Max indique une architecture incorrecte :

- l'external n'est pas compile pour Windows x64 ;
- il faut recompiler avec une cible 64 bits.

Le compteur reste a zero :

- l'audio n'est pas active dans Ableton ;
- la lecture Ableton est arretee ;
- les sorties de `plugin~` ne sont pas connectees aux deux entrees de `vassi.encoder~` ;
- le message `active 0` a ete envoye et il faut envoyer `active 1`.

Le son ne sort plus :

- verifier que `plugin~` est connecte directement a `plugout~` ;
- `vassi.encoder~` ne remplace pas `plugout~` ;
- `vassi.encoder~` doit seulement recevoir une copie des deux signaux.
