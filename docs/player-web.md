# Moteur audio navigateur du bloc 8

Ce document decrit la partie navigateur qui recoit le flux du relais, le decode et le joue. Le
contrat public reste `docs/protocol-v1.md`. Le bloc 8 ne produit aucune interface visible : il
produit un moteur que le bloc 9 branchera sur la page Svelte `/live`.

## Chaine complete

```text
relais Sliplane
   │ wss://<domaine>/listener
   ▼
thread principal : ListenerSocket
   ├── messages JSON  → stream_state → machine d'etats
   └── messages binaires (ArrayBuffer) ──transfert──┐
                                                    ▼
                                        Worker : DecodeWorker
                                          ├── inspectAudioPacket : en-tete verifie
                                          ├── OpusDecoder.decodeFrame : 960 x 2 flottants
                                          └── ecriture dans la file PCM
                                                    │
                                                    ▼
                                        AudioWorklet : vassi-pcm
                                          lit la file, remplit la sortie,
                                          produit du silence quand elle est vide
                                                    │
                                                    ▼
                                             sortie audio du navigateur
```

Le thread principal ne decode jamais et ne touche jamais a un echantillon. Il ouvre la connexion,
lit les messages JSON, transfere les octets binaires au worker et pilote la machine d'etats.

## Fichiers

| Fichier | Responsabilite |
|---|---|
| `src/player/pcm-worklet.js` | file PCM partagee et processeur AudioWorklet |
| `src/player/pcm-worklet.d.ts` | types de la file PCM pour le code TypeScript |
| `src/player/decode-worker.js` | decodage Opus hors du thread principal |
| `src/player/decode-worker-host.ts` | creation, ordres et destruction du worker, vus du thread principal |
| `src/player/player-protocol.ts` | lecture des messages JSON recus par un listener |
| `src/player/player-state.ts` | machine d'etats, sans dependance au navigateur |
| `src/player/player-diagnostics.ts` | rangement d'une panne entre reseau, decodage et audio |
| `src/player/listener-socket.ts` | connexion WebSocket, separation JSON / binaire, reconnexion |
| `src/player/browser-audio.ts` | contexte audio, processeur, worker : les pieces du navigateur |
| `src/player/audio-player.ts` | assemblage, compteurs, Play et Pause |
| `src/player/index.ts` | seule surface publique utilisee par le bloc 9 |

Un seul fichier a besoin d'un navigateur, `browser-audio.ts`, et il ne prend aucune decision. Tout
ce qui decide — la machine d'etats, la lecture du protocole, le rangement des pannes — se teste sous
Node.

La validation de l'en-tete binaire n'est pas reecrite : elle vient de `src/protocol/audio-packet.ts`,
le module deja partage par le device et le relais. Une seule definition d'un paquet valide existe
donc dans tout le projet.

## Pourquoi `pcm-worklet.js` contient la file PCM

Un module charge par `audioWorklet.addModule()` ne peut pas dependre d'un `import` : Safari ne le
supporte pas, et le professeur est sur macOS. Le fichier du processeur ne contient donc aucun
`import`.

La file PCM y est definie et exportee. Le worker et les tests l'importent depuis ce meme fichier :
il n'existe qu'une seule implementation de la file, ecrite une fois, utilisee par le producteur
comme par le consommateur. L'appel `registerProcessor` est place derriere une garde
`typeof AudioWorkletProcessor !== "undefined"`, donc importer ce fichier hors d'un AudioWorklet ne
declenche rien.

## Bibliotheque Opus

`opus-decoder` en version exacte `0.7.11`, licence MIT, construite sur libopus.

Raisons du choix :

- elle decode des **frames Opus brutes**, ce que le protocole v1 transporte ; les autres
  bibliotheques repandues (`ogg-opus-decoder`, `opus-stream-decoder`) attendent un conteneur Ogg que
  le projet n'utilise pas, ce qui obligerait a fabriquer un conteneur pour le defaire aussitot ;
- le WebAssembly est **inclus dans le JavaScript** du paquet, donc rien n'est telecharge depuis un
  CDN et rien n'est a copier a la main ; le bundler du site embarque le tout ;
- elle expose `reset()`, qui applique `OPUS_RESET_STATE`, exactement ce que le protocole demande
  apres un bit de discontinuite ;
- elle fonctionne aussi sous Node, ce qui permet de tester le decodage reellement, sans navigateur.

La sortie est `{ channelData: [Float32Array, Float32Array], samplesDecoded, sampleRate }`. Une frame
de 20 ms donne `samplesDecoded === 960` et `sampleRate === 48000`.

Le decodeur est cree avec `channels: 2`, `streamCount: 1`, `coupledStreamCount: 1` : c'est la
description exacte d'un flux stereo couple, le seul que la v1 produit.

## File PCM

Une seule file relie le worker et l'AudioWorklet. Elle est circulaire, de taille fixe, et ne grandit
jamais.

Disposition memoire :

| Zone | Type | Contenu |
|---|---|---|
| octets 0 a 31 | `Int32Array` de 8 cases | `writeIndex`, `readIndex`, `underruns`, `overflows` |
| ensuite | `Float32Array` | `capacity * 2` flottants, canaux entrelaces `L, R, L, R` |

Les deux index vivent entre `0` et `capacity - 1` et sont lus et ecrits avec `Atomics`. Une case
reste toujours libre : c'est ce qui distingue une file pleine d'une file vide sans troisieme
compteur. La capacite est de trois secondes, soit plus du triple du plus grand buffer cible.

Le producteur est le worker, le consommateur est le processeur audio, et il n'y en a jamais qu'un de
chaque : c'est une file SPSC, le seul cas ou deux threads peuvent se passer des donnees sans verrou.
Le thread audio ne prend donc aucun verrou et n'alloue rien.

### Deux transports pour la meme file

`SharedArrayBuffer` n'existe que si la page est isolee, c'est-a-dire si elle envoie les en-tetes
`Cross-Origin-Opener-Policy: same-origin` et `Cross-Origin-Embedder-Policy: require-corp`. Ces
en-tetes bloquent toute ressource externe de la page, ce qui n'est pas toujours acceptable sur un
site existant. Le moteur fonctionne donc dans les deux cas.

| Mode | Condition | Chemin des echantillons |
|---|---|---|
| partage | `crossOriginIsolated === true` | le worker ecrit directement dans la memoire lue par le processeur audio |
| messages | sinon | le worker transfere chaque bloc par un `MessagePort`, et le processeur l'ecrit dans sa propre file |

Le mode messages utilise un `MessageChannel` cree par le thread principal : un port part vers le
worker, l'autre vers l'AudioWorklet. Les deux blocs `Float32Array` sont **transferes**, pas copies.
La file, la lecture et la production de silence sont identiques dans les deux modes : seule change
la facon dont les echantillons entrent dans la file.

Le mode partage est prefere parce qu'il evite un evenement par bloc sur le thread audio, ou la
regularite compte plus que le debit.

## Machine d'etats

| Etat | Sens | Sortie de cet etat |
|---|---|---|
| `OFFLINE` | pas de direct, ou connexion perdue | `stream_state live: true` → `READY` |
| `READY` | un direct existe, le son n'est pas demande | appel a `play()` → `BUFFERING` |
| `BUFFERING` | le son est demande, la file se remplit | seuil du profil atteint → `PLAYING` |
| `PLAYING` | le son sort | file vide → `REBUFFERING` ; `pause()` → `PAUSED` ; fin du direct → `OFFLINE` |
| `REBUFFERING` | le son etait lance, la file s'est videe | seuil atteint → `PLAYING` |
| `PAUSED` | l'auditeur a coupe le son | `play()` → `BUFFERING` |
| `ERROR` | panne | un nouveau `play()` demonte tout et rebatit |

`READY` et `PAUSED` sont deux etats differents pour l'auditeur : le premier veut dire « le direct est
la, cliquez sur Play », le second « vous avez coupe le son vous-meme ».

Un `AudioContext` n'est cree qu'au premier `play()`, jamais avant : tous les navigateurs refusent de
demarrer le son sans un geste de l'auditeur, et Safari le refuse le plus strictement.

Pendant `READY` et `PAUSED`, le moteur **jette** les paquets recus au lieu de les accumuler. Reprendre
la lecture doit repartir du direct, pas d'un retard egal au temps de pause.

## Seuils de latence

Le seuil vient du `latencyProfile` annonce par la session, comme le fixe `docs/protocol-v1.md` :

| `latencyProfile` | PCM attendu avant de jouer |
|---|---:|
| `low` | 200 ms |
| `balanced` | 400 ms |
| `stable` | 800 ms |

Le player ne choisit pas un autre seuil pour un nom donne. Un profil inconnu est traite comme
`balanced` : mieux vaut un direct un peu long a demarrer qu'un direct qui ne demarre pas.

## Nouvelle session

Un `stream_state` en direct dont le `sessionId` differe du precedent remet tout a zero : file PCM
videe, decodeur Opus remis a son etat initial, numero de sequence oublie. Les paquets dont le
`sessionId` ne correspond pas au dernier etat recu sont jetes sans etre decodes ; c'est ce qui evite
qu'un paquet en retard d'une session precedente entre dans le son de la nouvelle.

## Discontinuite

Deux evenements produisent une discontinuite, et ils recoivent le meme traitement :

- le bit `discontinuite` pose par le device apres une perte locale d'audio ;
- un trou dans les numeros de sequence, cause par le relais quand il abandonne les paquets d'un
  auditeur en retard. Le relais ne modifie jamais les octets d'un paquet, donc il ne peut pas poser
  le bit lui-meme : le player doit reconnaitre le trou.

Traitement, dans cet ordre :

1. vider le PCM encore en attente ;
2. remettre le decodeur Opus a son etat initial ;
3. decoder la frame marquee ;
4. repasser en `REBUFFERING` jusqu'au seuil du profil.

Aucun silence et aucun PLC ne remplacent la duree abandonnee : le but est de reprendre sur l'audio le
plus recent, pas de conserver la duree du direct.

## Manque de donnees

Quand la file se vide pendant `PLAYING`, le processeur audio ecrit du silence et compte un
`underrun`. Il n'invente rien et ne repete pas le dernier bloc : une repetition s'entend plus qu'un
court silence. Le thread principal voit le compteur avancer et repasse en `REBUFFERING`.

## Derive de retard

Le manque de donnees a un symetrique moins visible : la file qui grossit.

Un contexte audio peut s'arreter sans que la page le demande — onglet mis en arriere-plan, appel
telephonique sur un appareil Apple, peripherique de sortie debranche. Le processeur audio cesse
alors d'etre appele, mais le decodeur, lui, continue de remplir la file. Quand le thread audio
revient, la file contient plusieurs secondes de son : l'auditeur reprendrait la lecture en retard de
tout ce temps, definitivement, et rien ne le signalerait.

Au-dela du seuil du profil plus une seconde, le player considere donc que la file contient du son
trop vieux pour un direct. Il demande au decodeur de la vider, puis rebufferise. La reprise se fait
sur le son du moment.

Cet ordre passe par un compteur, `flushId`, et non par un evenement : le moteur compare la valeur
recue a la derniere appliquee. Un ordre perdu ou double n'a donc aucun effet.

## Panne et seconde chance

Une panne definitive qui oblige a recharger la page est une mauvaise reponse a un incident
passager : un `AudioContext` refuse par le systeme, un peripherique change en cours de route, un
WebAssembly qui n'a pas voulu se compiler du premier coup. Un nouveau clic sur Play demonte tout ce
qui a ete construit — worker, noeud, contexte — puis recommence a neuf.

Trois pannes sont surveillees en plus du demarrage :

- **le worker meurt pendant le direct.** Le branchement d'erreur pose au demarrage ne sert plus une
  fois la promesse resolue ; un second branchement le remplace, sinon la page resterait en lecture
  sans le moindre son et sans message.
- **la fermeture arrive pendant le chargement.** `close()` attend le demarrage en cours avant de
  demonter. Sans cette attente, un contexte audio et un worker naitraient apres la fermeture et
  personne ne les fermerait ; le son continuerait de sortir d'une page disparue.
- **le contexte est suspendu.** Le player tente de le reprendre. Safari annonce `interrupted` la ou
  les autres annoncent `suspended` : les deux sont traites de la meme facon.

## Diagnostics

De l'exterieur, les trois pannes possibles se ressemblent : le son ne sort pas. `diagnostics()` rend
les compteurs, et `explainPlayer()` les range en une phrase.

| Famille | Ce qui la designe |
|---|---|
| `network` | la connexion est perdue, ou un direct est annonce sans qu'aucun paquet n'arrive depuis deux secondes |
| `decode` | les paquets arrivent et sont acceptes, mais aucune frame n'en sort |
| `audio` | le contexte n'est pas `running`, ou le processeur n'a plus annonce de niveau depuis une demi-seconde |
| `idle` | le moteur attend : pas de direct, son pas encore demande, ou pause |
| `ok` | rien a signaler |

L'ordre des regles compte : la cause la plus en amont l'emporte. Un relais muet produit forcement
une file vide, donc il faut le reconnaitre avant de conclure a une panne de decodage.

`explainPlayer` est une fonction pure. Chaque famille se verifie sous Node, panne par panne, dans
`tests/player-diagnostics.test.ts`.

Les compteurs viennent de trois endroits, chacun le seul a savoir ce qu'il compte :

| Compteur | Origine |
|---|---|
| paquets recus, date du dernier | thread principal, a la reception du socket |
| paquets acceptes, frames decodees, refus, discontinuites | worker, remontes une fois par seconde |
| son en attente, manques de donnees, blocs abandonnes | processeur audio, avec chaque niveau annonce |

Les blocs abandonnes sont la mesure directe du mode messages sous charge : un `MessagePort` qui
n'arrive plus a suivre les fait monter, la memoire partagee non.

## Reconnexion

Le socket listener applique le meme escalier que le publisher : `1, 2, 4, 8, 16, 30` secondes, avec
un ecart aleatoire, pour que plusieurs auditeurs ne reviennent pas tous a la meme seconde.

Une coupure ramene l'etat `OFFLINE` mais n'annule pas la demande de son. Si l'auditeur avait clique
sur Play, le direct retrouve repart seul en bufferisation puis en lecture. Seul un clic sur Pause
annule cette demande. C'est la difference entre une panne, que l'auditeur n'a pas choisie, et une
pause, qu'il a choisie : une coupure de deux secondes ne doit pas obliger le professeur a revenir
cliquer sur le bouton.

Le navigateur repond seul aux pings WebSocket du relais. Le player n'a rien a faire pour cela.

## Ce que le bloc 8 ne fait pas

- Il n'affiche rien : pas de bouton, pas de texte, pas de style. C'est le bloc 9.
- Il ne pose pas les en-tetes COOP/COEP : c'est la configuration du site, donc le bloc 9.
- Il ne mesure pas la latence totale. Le seuil de buffer est une valeur d'attente, pas une garantie.

## Verification

Les parties calculables sont testees sous Node avec `node --test` :

- la file PCM : ecriture, lecture, file pleine, file vide, comptage des manques ;
- la lecture des messages JSON du relais et les seuils de latence ;
- le decodage d'une vraie fixture Opus produite par l'encodeur du device, jusqu'aux echantillons ;
- le socket listener branche sur le vrai relais du bloc 7 ;
- le rangement d'une panne entre reseau, decodage et contexte audio ;
- les pannes elles-memes : fermeture pendant le chargement, decodeur qui ne demarre pas, worker qui
  meurt en cours de direct, contexte suspendu, derive de retard.

Le reste, `AudioContext` et `AudioWorklet`, n'existe pas sous Node. Il se verifie dans un navigateur
avec `npm.cmd run player:fixture`, qui sert une page de test et rejoue la fixture Opus a travers un vrai
relais local. Cette page couvre les quatre verifications courtes du bloc — son stereo, attente du
buffer avant lecture, pause reelle, coupure simulee suivie d'un rebuffer — et l'essai long du bloc
8b, avec son verdict, ses compteurs par famille et son journal horodate.

Ableton n'intervient dans aucune de ces verifications : la fixture porte les octets du vrai
encodeur du device, donc le navigateur recoit exactement ce qu'un direct lui enverrait.
