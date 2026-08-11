# Validation courte - Bloc 8

Date : 2026-08-03.

## Resultat

Le moteur audio navigateur existe. Il recoit le flux du relais, valide chaque paquet, decode l'Opus
dans un worker, remplit une file PCM bornee et la joue par un AudioWorklet. La conception complete
est dans `docs/player-web.md`.

Le bloc ne produit aucune interface : c'est le bloc 9 qui fabrique la page. Tout ce qui se calcule
sans navigateur est teste sous Node ; l'ecoute reelle reste a faire avec Vassi.

## Fichiers du bloc

- `src/player/pcm-worklet.js` : file PCM partagee et processeur AudioWorklet.
- `src/player/pcm-worklet.d.ts` : types de la file pour le code TypeScript.
- `src/player/decode-worker.js` : validation, decodage Opus, discontinuites.
- `src/player/decode-worker.d.ts` : types du decodeur.
- `src/player/player-protocol.ts` : lecture des messages recus par un auditeur, seuils de latence.
- `src/player/player-state.ts` : machine d'etats, sans dependance au navigateur.
- `src/player/listener-socket.ts` : connexion, separation JSON / binaire, reconnexion.
- `src/player/audio-player.ts` : assemblage, contexte audio, Play et Pause.
- `src/player/index.ts` : seule surface publique utilisee par le bloc 9.
- `scripts/native/make_opus_fixture.cpp` : fabrique la fixture avec l'encodeur reel du device.
- `scripts/make-opus-fixture.cmd` : construit et lance cet outil.
- `scripts/player-fixture.js` et `scripts/fixture-publisher.js` : page de test et direct local.
- `tests/browser/player-fixture.html` : page de verification a l'oreille.
- `tests/fixtures/stereo-440-880-256k.vsa1` : dix secondes, 500 paquets, 256 kbit/s.

## Recherche Internet

- `opus-decoder`, API et sortie PCM : https://github.com/eshaz/wasm-audio-decoders/tree/main/src/opus-decoder
- Version, licence et dependances exactes : https://registry.npmjs.org/opus-decoder/latest
- `AudioWorklet` et file sans verrou : https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor
- `SharedArrayBuffer` et isolation de page : https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer

Decisions venues de cette recherche :

- **`opus-decoder` plutot que `ogg-opus-decoder` ou `opus-stream-decoder`.** Ces deux dernieres
  attendent un conteneur Ogg. Le protocole v1 transporte des frames brutes : il faudrait fabriquer
  un conteneur pour le defaire aussitot. `opus-decoder` decode directement une frame, expose
  `reset()`, qui applique `OPUS_RESET_STATE`, et fonctionne aussi sous Node, ce qui permet de tester
  le decodage sans navigateur.
- **Le WebAssembly est inclus dans le JavaScript du paquet.** Aucun fichier `.wasm` separe n'est a
  heberger, et rien ne vient d'un CDN.
- **Le fichier de l'AudioWorklet ne contient aucun `import`.** Safari ne les supporte pas dans un
  module de worklet, et le professeur est sur macOS. La file PCM est donc definie dans ce fichier et
  exportee : le worker et les tests importent le meme fichier, donc il n'existe qu'une seule
  implementation de la file. `registerProcessor` est place derriere une garde, ce qui rend le fichier
  importable sous Node.
- **Le processeur audio ne consomme pas la file pendant la bufferisation.** Sans ce drapeau, il
  reviderait la file aussi vite qu'elle se remplit et le seuil ne serait jamais atteint.

## Verification executee

```powershell
npm.cmd run check
```

Resultat :

```text
TypeScript errors 0
tests 207
pass 207
fail 0
OK: tous les tests natifs de la queue audio passent
OK: tous les tests natifs Opus passent
OK: tous les tests natifs du pont loopback passent
```

Le bloc ajoute 46 tests aux 161 existants. La suite complete a ete lancee trois fois de suite sans
echec, pour verifier que les tests qui mesurent des delais reels ne dependent pas de la charge de la
machine.

## Ce que les tests couvrent

**File PCM**, `tests/player-pcm-ring.test.ts` : ordre des echantillons et separation des canaux,
retour au debut de la memoire, refus d'un bloc entier quand la place manque, silence et comptage
quand la file se vide, vidage complet, conversion en millisecondes.

**Decodage reel**, `tests/player-decode.test.ts` : la fixture de dix secondes est decodee par le vrai
decodeur, et les echantillons sont mesures. Le canal gauche ressort a 440 Hz, le droit a 880 Hz : le
son est bien stereo et les canaux ne sont pas inverses. Les autres cas verifient qu'un paquet d'une
autre session est jete, qu'un paquet abime ne coupe pas la lecture, qu'un trou de sequence et que le
bit de discontinuite produisent le meme traitement, que les paquets recus pendant une pause sont
jetes, et qu'une nouvelle session vide tout.

**Machine d'etats**, `tests/player-state.test.ts` : le parcours complet jusqu'a la lecture, le seuil
du profil annonce, la pause qui coupe reellement, le rebuffer apres un manque de donnees et apres
une discontinuite, la reprise automatique apres une coupure quand le son etait demande, l'absence de
reprise quand l'auditeur avait mis en pause, le doublon d'etat sans effet, et le blocage en erreur.

**Socket listener**, `tests/player-socket.test.ts` : branche sur le vrai relais du bloc 7, avec le
`WebSocket` de Node, qui suit la meme specification que celui du navigateur. Il verifie l'etat hors
ligne puis en direct, les paquets recus octet pour octet en `ArrayBuffer`, la coupure suivie d'une
reconnexion reelle, l'arret qui ne laisse aucune reconnexion en cours, et l'escalier de backoff.

**Chaine complete**, dans `tests/player-decode.test.ts` : cent paquets de la fixture traversent le
decodeur, la file partagee et la lecture, avec le vrai code des trois pieces. Le son relu ressort a
440 Hz a gauche et 880 Hz a droite, sans un seul manque de donnees. C'est le seul test qui relie les
trois, et ce qui en sort est ce que le navigateur jouera.

**Assemblage**, `tests/player-assembly.test.ts` : le vrai player est pilote avec de fausses pieces de
navigateur, branche sur le vrai relais. Il verifie que la session part au worker avant le premier
paquet, l'ordre du demarrage, le seuil qui lance la lecture, la pause qui coupe des deux cotes, la
discontinuite qui fait rebufferiser, et les deux chemins de transport : memoire partagee quand la
page est isolee, port transfere sinon.

**Page de test**, `tests/player-fixture-page.test.ts` : le graphe complet des modules que la page
charge est parcouru et verifie. Chaque module existe, aucune adresse restante n'est un nom de paquet
que le navigateur ne saurait pas resoudre, aucun module n'est reste en CommonJS, les fichiers
TypeScript arrivent sans annotation de type, et les en-tetes d'isolation sont bien poses. Sans ce
test, la page de verification pourrait cesser de se charger sans que personne le remarque avant d'en
avoir besoin.

## La fixture

`npm.cmd run fixture:opus` construit `scripts/native/make_opus_fixture.cpp` et le lance sur
`assets/audio/vassi-stereo-test-48k-24bit.wav`.

Cet outil utilise `source/audio_encoder.cpp`, c'est-a-dire le meme resampler et le meme encodeur que
le device. La fixture contient donc exactement ce que le navigateur recevra pendant un vrai live, et
non des octets fabriques pour l'occasion.

Sortie : 500 paquets, 335 140 octets, 256 kbit/s, dix secondes. Le fichier est commite, pour que les
tests n'aient pas besoin du compilateur.

## Defauts trouves en verifiant l'assemblage

Trois defauts n'apparaissaient dans aucun test, parce qu'aucun test ne touchait `audio-player.ts` :
le fichier qui relie le socket, le worker et le processeur audio. Chacun aurait empeche le son de
sortir, sans message d'erreur.

1. **Le worker n'apprenait jamais l'identifiant de session.** La connexion s'ouvre avant le premier
   clic sur Play, donc une session est deja connue quand le worker naît. Le player notait cette
   session comme « annoncee » alors qu'il n'avait personne a qui l'annoncer. Le worker gardait donc
   la session zero, refusait chaque paquet pour session etrangere, et la page restait bloquee en
   bufferisation. C'est le defaut qui empechait toute ecoute.

2. **Le port du worker ne pouvait pas atteindre le processeur audio.** Il etait place dans les
   options de construction du noeud, qui sont copiees et non transferees ; un `MessagePort` ne se
   copie pas. Le premier clic sur Play echouait, mais seulement quand la page n'est pas isolee,
   c'est-a-dire exactement dans le cas ou `SharedArrayBuffer` manque. Le port part maintenant par le
   port du noeud, avec une liste de transfert.

3. **Vider la file ecrasait la position du lecteur.** Le producteur remettait les deux index a zero,
   alors que l'index de lecture appartient au consommateur, qui tourne sur le thread audio. Vider
   ramene maintenant l'index d'ecriture sur celui de lecture, sans y toucher. Le cas se produisait a
   chaque discontinuite pendant une lecture, c'est-a-dire au pire moment.

`tests/player-assembly.test.ts` pilote desormais le vrai player avec de fausses pieces de navigateur,
branche sur le vrai relais. Il verrouille l'ordre de demarrage, les deux chemins de transport, et le
fait que la session parte avant le premier paquet.

## Defaut trouve au premier lancement reel

Le premier essai de la page par Vassi a arrete le serveur de test avant toute ecoute :

```text
Error: ENOENT: no such file or directory, open '...\vassi-stream\favicon.ico'
Emitted 'error' event on ReadStream instance
```

Un navigateur demande `/favicon.ico` tout seul sur chaque page. Le serveur essayait de lire ce
fichier absent, et un flux de lecture signale un fichier absent par un **evenement**, pas par une
exception : le `try` qui entourait l'appel ne pouvait pas le voir, donc Node terminait le processus.
N'importe quelle adresse inconnue produisait le meme arret.

`scripts/player-fixture.js` repond maintenant `204` a `/favicon.ico`, branche un gestionnaire
d'erreur sur chaque flux de lecture, et n'ecrit l'en-tete `200` qu'apres l'ouverture reussie du
fichier. Le defaut ne touchait que l'outil de verification, jamais le moteur audio.

## Verification a l'oreille, a faire avec Vassi

### Ableton n'intervient pas dans ce test

Ce test se fait **Ableton ferme**. La question « comment ecouter le navigateur si le son vient du
master d'Ableton » ne se pose pas ici : le bloc 8 ne verifie pas la chaine complete, il verifie la
moitie navigateur toute seule.

`npm.cmd run player:fixture` fabrique un direct entier sans Ableton et sans reseau :

```text
tests/fixtures/stereo-440-880-256k.vsa1     le son enregistre a l'avance
        │  rejoue a 50 paquets par seconde par scripts/fixture-publisher.js
        ▼
relais local du bloc 7, sur 127.0.0.1        le vrai relais, pas une imitation
        ▼
page de test dans le navigateur              le vrai moteur audio du bloc 8
```

La fixture remplace le device pour trois raisons :

- **Ce sont les memes octets.** Elle est produite par `scripts/native/make_opus_fixture.cpp`, qui
  utilise `source/audio_encoder.cpp`, c'est-a-dire le resampler et l'encodeur du device. Le
  navigateur recoit exactement ce qu'un vrai live lui enverrait.
- **Le signal est connu.** 440 Hz a gauche, 880 Hz a droite. Une inversion des canaux, un canal
  perdu ou un flux devenu mono s'entendent en une seconde. Sur de la musique, ces trois pannes
  passeraient inapercues.
- **Le signal est identique a chaque essai.** Firefox, Safari et le mode sans `SharedArrayBuffer`
  entendent la meme chose, donc une difference vient du navigateur et de rien d'autre.

Rien d'autre n'est requis : ni Ableton, ni Max, ni le VPS, ni Internet. Un navigateur suffit.

### Le vrai cas du son double, a partir du bloc 10

La question reste juste des que le device envoie vraiment le master, c'est-a-dire au bloc 10 puis au
bloc 11. Le son direct d'Ableton et le son du navigateur sortent alors des memes enceintes, decales
d'environ 400 ms : on entend un echo, et plus aucun jugement de qualite n'est possible. Trois
facons de separer les deux sons, de la plus simple a la plus realiste.

**1. Baisser le fader Master d'Ableton.** Sur une piste, la chaine de devices passe *avant* le
volume de la piste. Le device est sur le Master, donc il capte le signal avant le fader Master :
mettre ce fader a `-inf` coupe les enceintes sans rien changer a ce que le device encode.

L'erreur a eviter : **couper les pistes, elles, coupe aussi le stream.** Un clic sur l'activateur
jaune d'une piste, sur son Mute ou sur un Solo ailleurs retire le son avant le Master, donc avant le
device. Seul le fader Master convient.

Cette regle se confirme en dix secondes avec les compteurs deja affiches par le device : fader
Master a `-inf`, `Signal L/R`, `Encodees` et `Envoyees` doivent continuer de monter. Si elles se
figent, la regle ne s'applique pas a cette version de Live et il faut passer au point 2.

**2. Deux sorties audio separees.** Ableton sur l'interface audio en ASIO, le navigateur sur la
sortie Windows ordinaire. C'est souvent deja le cas sans rien faire : un pilote ASIO prend
l'interface en exclusivite, donc Windows envoie Firefox ailleurs. Le choix par application se fait
dans **Parametres → Systeme → Son → Mixeur de volume**. Ecouter l'un ou l'autre devient alors
physique : le casque sur l'interface pour Ableton, les enceintes pour le navigateur.

**3. Une deuxieme machine.** Un telephone ou une tablette sur le meme Wi-Fi ouvre la page pendant
qu'Ableton joue. C'est la situation reelle du professeur, et c'est la seule des trois qui verifie
aussi que le flux sort bien de la machine. C'est la methode du bloc 11.

Deux remarques qui evitent des inquietudes inutiles :

- **Aucun risque de larsen.** La capture est interne au device, sur le master ; aucun micro
  n'intervient. Les deux sons peuvent cohabiter sans jamais s'auto-alimenter.
- **Le decalage se mesure.** Au bloc 11, laisser les deux sons audibles et
  declencher une percussion seche donne la latence a l'oreille ; un telephone qui enregistre les
  deux coups la donne au chiffre pres. C'est prevu la, pas ici.

### Marche a suivre

Ouvrir un terminal dans le dossier du projet et lancer :

```powershell
npm.cmd run player:fixture
```

Le `.cmd` compte. Sous Windows, `npm` tout court est un script PowerShell, et PowerShell refuse par
defaut d'executer des scripts : `npm run player:fixture` echoue avec « l'execution de scripts est
desactivee sur ce systeme ». `npm.cmd` est le meme programme par son autre entree, toujours acceptee.

Quelques lignes s'affichent. Laisser cette fenetre ouverte :

```text
Page de test : http://127.0.0.1:8123/
Relais local : ws://127.0.0.1:51956/listener
Sans SharedArrayBuffer : $env:VASSI_NO_ISOLATION = "1"; npm.cmd run player:fixture
Depuis une autre machine : $env:VASSI_HOST = "0.0.0.0"; npm.cmd run player:fixture
```

Le script demarre un relais, y branche un publisher qui rejoue la fixture en boucle, et sert la page
de test. **Ouvrir `http://127.0.0.1:8123/` dans Firefox**, avec le son allume.

Quatre observations, dans cet ordre :

1. l'etat passe a `READY` au chargement, et « Paquets recus » monte ;
2. Play affiche `BUFFERING` puis `PLAYING` en moins d'une seconde, et le son sort en stereo, le grave
   a gauche et l'aigu a droite ;
3. Pause coupe le son immediatement et affiche `PAUSED` ;
4. le bouton de coupure donne `OFFLINE` puis un retour automatique en `BUFFERING` et `PLAYING`, avec
   un numero de session different.

Arreter le script avec `Ctrl+C` dans la fenetre du terminal.

### Les trois passages a faire

| Passage | Commande | Ce qu'il prouve |
|---|---|---|
| Firefox, mode partage | `npm.cmd run player:fixture` | le chemin normal : `SharedArrayBuffer`, le worker ecrit directement dans la file lue par le thread audio |
| Firefox, mode messages | `$env:VASSI_NO_ISOLATION = "1"; npm.cmd run player:fixture` | la page reste utilisable sur un site non isole, ou `SharedArrayBuffer` n'existe pas |
| Safari | voir ci-dessous | le navigateur du professeur, le plus strict sur le demarrage du son et sur les modules de worklet |

Le deuxieme passage retire les en-tetes COOP et COEP : la page affiche alors
« SharedArrayBuffer : absent, mode messages ». Les quatre observations doivent donner le meme
resultat.

### Comment atteindre Safari

Safari n'existe pas sous Windows, et la page n'est servie qu'a la machine qui lance le script. Deux
chemins, et ils ne verifient pas la meme chose.

**Depuis le Mac lui-meme, si le depot peut y etre copie.** `git clone`, `npm install`, puis
`npm run player:fixture` — sans `.cmd`, macOS n'a pas le probleme des scripts PowerShell. C'est le
seul chemin qui verifie les deux modes sous Safari.

**Depuis le Mac vers cette machine, sur le meme Wi-Fi.** Lancer ici :

```powershell
$env:VASSI_HOST = "0.0.0.0"; npm.cmd run player:fixture
```

Le script affiche alors une adresse en `http://192.168.x.x:8123/` a ouvrir sur le Mac. Une seule
chose est a savoir : une page servie en `http://` depuis une autre machine **n'est pas un contexte
securise**, donc `SharedArrayBuffer` y est absent quoi qu'il arrive. Ce chemin verifie Safari en
mode messages seulement — ce qui reste l'essentiel, puisque c'est le mode dans lequel la page
publique tournera si le site n'est pas isole.

### Si le son ne sort pas

La page affiche des compteurs faits pour cela.

| Ce que la page montre | Ou est le probleme |
|---|---|
| « Paquets recus » reste a 0 | rien n'arrive du relais ; verifier que la fenetre du terminal est toujours ouverte |
| Paquets qui montent, « Son en attente » a 0 | le decodage ne rend rien ; regarder la console du navigateur |
| Les deux montent, etat bloque sur `BUFFERING` | le seuil n'est jamais atteint ; noter la valeur de « Son en attente » |
| Etat `ERROR` | la ligne « Derniere erreur » donne la raison |

Le bloc 8b ajoute a cette page un verdict et un journal horodate, qui rangent la panne d'eux-memes
entre reseau, decodage et contexte audio. La marche a suivre complete de l'essai long est dans
`docs/validation/blocs/bloc-8b.md`.

## Bloc precedent

Le relais du bloc 7 fonctionne sans aucune modification de comportement. Les corrections apportees
pendant sa revue ne touchent que ses compteurs et une garde interne ; ses 160 tests passent toujours,
et le socket du player s'y branche tel quel.

## Limites reportees

- Le son n'a pas encore ete entendu. Tout ce qui precede la sortie audio est verifie, mais
  `AudioContext` et `AudioWorklet` n'existent pas sous Node.
- Safari n'a pas ete teste. C'est le navigateur le plus strict sur le demarrage du son et sur les
  modules de worklet, et c'est celui du professeur. Atteint depuis le reseau local, il ne peut etre
  verifie qu'en mode messages : une page en `http://` venue d'une autre machine n'est pas un
  contexte securise.
- Le mode sans `SharedArrayBuffer` est ecrit et servi, mais son comportement sous charge reelle n'est
  pas mesure.
- La page de test n'est pas la page publique. Elle sert les fichiers du projet en effacant les
  annotations de type et en reecrivant les noms de paquets ; le bloc 9 remplacera tout cela par le
  bundler du site.
- Le seuil de buffer est une valeur d'attente, pas une garantie de latence. La latence reelle se
  mesure au bloc 11.

## Decision

Le code du bloc 8 est termine et teste. Le bloc reste ouvert jusqu'a l'ecoute dans Firefox et dans
Safari.
