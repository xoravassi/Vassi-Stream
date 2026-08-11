# Validation courte - Bloc 5

Date : 2026-08-03.

## Resultat technique

Les frames Opus produites par `vassi.encoder~` arrivent dans `node.script` sous forme de `Buffer`, octet
pour octet, par un socket TCP loopback. Une seule solution de transport existe dans le code.

## Decision de transport

Le pont par messages Max prevu initialement est ecarte avant implementation, pour trois raisons verifiees
dans les sources locales et la documentation officielle :

1. Node for Max serialise chaque message en JSON. `Node for Max/source/lib/communication/socket.js`
   documente un flux de messages precedes d'une longueur `UInt32BE` et convertis avec `JSON.parse` et
   `JSON.stringify`. Une frame de 640 octets couterait environ 640 `t_atom`, un tableau JSON en texte, un
   tableau de nombres JavaScript puis une copie vers `Buffer`, cinquante fois par seconde.
2. Cycling '74 a confirme et reproduit une croissance memoire sans limite du processus Max, proportionnelle
   au volume envoye a `node.script`. Aucun correctif n'est publie.
3. `max-api` est resolu par la variable `NODE_PATH` posee dans `nsProcess.js` et reste un module CommonJS.
   Le script du device doit donc etre en CommonJS ; c'est le cas de `device/node/`.

UDP loopback est ecarte a son tour : pertes silencieuses quand le tampon de reception est plein, aucun etat
de connexion utilisable pour `ready`, `error` et `stopped`, et le comportement Windows ou un ICMP port
unreachable fait echouer l'operation suivante avec `WSAECONNRESET`.

Le choix final est un socket TCP sur `127.0.0.1`. Le format de frame et les regles de perte sont decrits
dans `docs/bridge-vsf1.md`.

## Implementation

- `externals/vassi.encoder~/source/frame_sender.cpp` : client TCP Winsock, `TCP_NODELAY`, tampon d'envoi
  limite a 8192 octets, delai d'envoi de 50 ms, reconnexion toutes les 250 ms.
- L'envoi se fait dans le thread du worker, appele depuis la sortie de l'encodeur. La routine audio ne
  contient aucun appel socket ; le test statique interdit `send`, `socket` et `connect` dans `perform64`.
- Une perte de transmission, une reconnexion ou un overflow de queue remettent l'encodeur Opus a zero et
  marquent la frame suivante avec le bit de discontinuite.
- L'etat de connexion remonte a Max par un `qelem`, seul mecanisme du SDK autorise depuis un thread cree
  par l'objet, comme dans l'exemple `simplethread.c`.
- `device/node/frame-reader.js` reassemble les frames depuis un flux TCP decoupe n'importe comment et se
  resynchronise sur le magic `VSF1`. Son tampon est borne a 64 Ko.
- `device/node/index.js` annonce le port a Max et publie `status ready`, `status stopped` ou `status error`.

## Recherche Internet

- Threading Max API : https://sdk.cdn.cycling74.com/max-sdk-8.0.3/chapter_threading.html
- Inlets et outlets Max API : https://sdk.cdn.cycling74.com/max-sdk-8.0.3/chapter_inout.html
- Croissance memoire de node.script : https://cycling74.com/forums/node-for-max-memory-issue
- Module max-api : https://docs.cycling74.com/nodeformax/api/module-max-api.html
- Piege WSAECONNRESET en UDP sous Windows : https://www.betaarchive.com/wiki/index.php?title=Microsoft_KB_Archive/263823

Sources locales lues : `Node for Max/source/lib/communication/socket.js`, `nsProcess.js`,
`lib/exposed/max-api.js` et l'exemple `simplethread.c` du Max SDK.

## Verification executee

```powershell
npm.cmd run check
```

Le format ne peut pas diverger entre les deux langages : la meme frame de reference en octets est ecrite
dans `tests/native/frame_sender.test.cpp` et dans `tests/frame-reader.test.ts`.

Tests natifs du pont : octets de reference, en-tete champ par champ, aller-retour sur un vrai socket
loopback, coupure de Node signalee comme perte locale, port absent sans blocage.

Test de bout en bout `tests/bridge-e2e.test.ts` : le binaire natif envoie 250 frames sur le port ouvert par
`FrameBridge`, et Node verifie la sequence, le timestamp, les flags et chaque octet du payload.

## Mesure des cinq minutes a 50 paquets par seconde

```powershell
node scripts/measure-bridge.js 15000 20
```

Resultat :

```text
frames 15000 / 15000
octets 1342500
trous de sequence 0
frames marquees discontinues 300
duree 300.2 s, debit 50.0 frames/s
rss 34.7 Mo puis 42.2 Mo
RESULTAT: stable
```

Les 300 frames marquees sont le motif du generateur de test, qui pose le bit toutes les cinquante frames :
la mesure prouve donc aussi que les flags traversent le pont sans etre perdus.

La memoire a ete verifiee separement avec un ramasse-miettes force :

```powershell
node --expose-gc scripts/measure-bridge.js 3000 20
```

```text
duree 60.2 s, debit 49.8 frames/s
rss 35.2 Mo puis 41.6 Mo
tas utilise 5.0 Mo puis 4.7 Mo
buffers 0.1 Mo puis 0.2 Mo
```

Le tas utilise ne grandit pas et la `rss` plafonne au meme niveau apres une minute et apres cinq minutes.
Il s'agit de pages conservees par V8, pas d'une accumulation. Le defaut memoire de `node.script` ne
s'applique pas ici, puisque l'audio ne passe jamais par un message Max.

Premiere mesure ecartee : lancee avec `Sleep(20)`, elle tournait a 31,5 frames/s a cause de la granularite
de 15,6 ms des minuteurs Windows. Le generateur attend maintenant une echeance absolue, ce qui donne la
cadence reelle de 50 frames par seconde demandee par la roadmap.

## Correctifs apportes apres relecture

La relecture du bloc a trouve cinq points corriges depuis :

1. Le patch de test envoyait le port annonce a l'encodeur mais ne l'affichait nulle part. La
   verification demandee par la roadmap etait donc impossible a lire. Le port et les messages non
   reconnus de Node vont maintenant aussi vers `print node`.
2. `device/node/frame-reader.js` appliquait sa limite de 64 Ko au tampon complet avant lecture. Un
   morceau TCP plus grand que cette limite mais entierement valide etait jete. La limite s'applique
   maintenant au reste non lu, qui vaut au plus une frame incomplete.
3. `device/node/frame-bridge.js` refusait une connexion neuve tant que l'evenement de fermeture de la
   precedente n'etait pas recu. Une reconnexion rapide de l'encodeur pouvait donc etre rejetee. La
   connexion la plus recente remplace maintenant la precedente.
4. `device/node/index.js` comparait la sequence a travers une reconnexion. Un redemarrage de l'encodeur
   repart de la sequence zero et comptait un faux trou. Le suivi repart de zero a chaque changement
   d'etat.
5. L'external compile n'etait installe nulle part automatiquement : le fichier lu par Max datait du
   bloc 2 et ne contenait pas le pont. `scripts/install-vassi-encoder.cmd` copie desormais l'artefact
   vers `externals/` et vers la Library de Max.

Le patch de test gagne aussi les messages `getport`, `script start` et `script stop`, qui permettent de
relancer Node et de redemander le port sans recharger le device.

## Verification manuelle executee

Test du 2026-08-03 dans Ableton Live 11, device sur la piste Master, procedure de
`docs/validation/procedures/test-pont-ableton.md`.

Resultat rapporte par Vassi : `Etat` gauche `connected`, `Etat` droite `ready`, port annonce,
`Encodees`, `Envoyees` et `Recues` en hausse ensemble, `Perdues` et `Trous` a zero, son du master
inchange. Un seul champ ne suivait pas : les compteurs par canal restaient a zero alors que les deux
canaux passaient bien dans le master.

## Correctif du compteur par canal

Cause : les compteurs `left_block_count` et `right_block_count` n'avancaient que si les drapeaux
`left_connected` et `right_connected` valaient 1. Ces drapeaux etaient ecrits une seule fois, dans
`dsp64`, a partir du tableau `count` fourni par MSP, et le message `reset` les remettait a zero.
Le bouton `reset` du device suffisait donc a bloquer les deux compteurs jusqu'a la prochaine
reconstruction de la chaine DSP par Live, sans rien casser d'autre.

Correction : les deux drapeaux sont supprimes. `perform64` compte maintenant, pour chaque canal, les
blocs qui contiennent au moins un echantillon different de zero, avec une sortie de boucle des le
premier echantillon non nul. Cette mesure ne depend plus d'un etat pose ailleurs, elle survit a
`reset`, et elle dit quelque chose de plus utile : un canal cable mais muet est desormais visible,
alors que l'ancien compteur l'aurait affiche comme normal.

Le champ du device s'appelle `Signal L/R`. Deux tests statiques verrouillent le comportement :
`compte les blocs par canal a partir du signal recu` et `garde reset limite aux compteurs`.

Cout dans la routine audio : une comparaison par echantillon, sans allocation, sans branchement vers
Max et sans appel bloquant. La routine reste conforme aux regles du bloc 2.
