# Validation courte - Bloc 8b

Date : 2026-08-03.

## Resultat

Le moteur audio du bloc 8 fonctionne dans le chemin normal. Le bloc 8b s'occupe de ce qui arrive
quand quelque chose tourne mal : une panne doit se nommer, se ranger dans la bonne famille, et le
direct doit reprendre proprement apres.

Le premier essai reel de la page par Vassi a d'ailleurs trouve trois defauts en quelques minutes.
Aucun n'etait dans le moteur ; tous les trois etaient dans l'outil qui devait le verifier.

## Les trois defauts trouves par le premier essai

### 1. Le serveur de test mourait sur la premiere adresse inconnue

```text
Error: ENOENT: no such file or directory, open '...\vassi-stream\favicon.ico'
Emitted 'error' event on ReadStream instance
```

Un navigateur demande `/favicon.ico` tout seul sur chaque page. Un flux de lecture signale un
fichier absent par un **evenement**, pas par une exception : le `try` qui entourait l'appel ne
pouvait pas le voir, et Node terminait le processus.

`scripts/player-fixture.js` repond maintenant `204` a cette adresse, branche un gestionnaire
d'erreur sur chaque flux, et n'ecrit l'en-tete `200` qu'apres l'ouverture reussie du fichier. Les
pannes imprevues sont affichees sans arreter le serveur : un essai de trente minutes ne doit pas
s'interrompre sur un incident de l'outil.

### 2. Le publisher de test envoyait 32 paquets par seconde au lieu de 50

Symptome vu par Vassi : le son sort, mais l'etat oscille entre `PLAYING` et `BUFFERING` environ une
fois par seconde.

Mesure, avec un auditeur branche sur le relais local :

```text
paquets : 318
duree : 9.99 s
debit : 31.8 paquets/s (attendu 50,0)
audio produit : 6.36 s pour 9.99 s ecoulees
deficit : 3.63 s
```

`setInterval(send, 20)` envoyait un paquet par reveil. Windows n'accorde pas mieux que 15,6 ms a un
minuteur ordinaire, donc un delai de 20 ms donne en realite un reveil toutes les 31,2 ms. Le
publisher produisait 6,4 secondes d'audio pour 10 secondes ecoulees, soit 36 % de deficit. Avec un
buffer de 400 ms, la file se vide en un peu plus d'une seconde — exactement la periode observee.

**Le moteur audio se comportait correctement : on l'affamait.** Un manque de donnees suivi d'une
rebufferisation est la bonne reponse a une file vide.

Le rythme suit maintenant l'horloge et non le minuteur : a chaque reveil, le publisher envoie tous
les paquets dus depuis le debut de la session. Un retard de plus d'une seconde fait repartir du
direct au lieu de deverser l'arriere.

Apres correction :

```text
paquets : 750
duree : 14.98 s
debit : 50.1 paquets/s (attendu 50,0)
audio produit : 15.00 s pour 14.98 s ecoulees
deficit : -0.02 s
```

### 3. La coupure simulee lancait deux reconnexions concurrentes

Symptome vu par Vassi : la coupure de trois secondes durait une seconde, puis plus rien ne
fonctionnait, avec du son par tres courts intervalles.

`cut()` appelait `terminate()` puis programmait une reconnexion a la duree demandee. Mais
`terminate()` declenche l'evenement `close`, dont le gestionnaire programmait **aussi** une
reconnexion, a 500 ms. Deux publishers finissaient donc vivants en meme temps. Le relais donne la
place au dernier authentifie et ferme le precedent ; le precedent voyait sa fermeture, se
reconnectait, reprenait la place, et ainsi de suite sans fin. Chaque tour ouvrait une nouvelle
session, donc le player vidait tout et rebufferisait en boucle.

Une coupure demandee detache maintenant les evenements de la connexion avant de la fermer, et une
seule reconnexion peut etre programmee a la fois.

Verification, un auditeur branche sur le relais local :

```text
0.02s  live   session 3846388681
3.02s  hors ligne
6.03s  live   session 1356214344

sessions ouvertes : 2 (attendu 2 : la premiere, puis celle d'apres la coupure)
```

## Decoupage des fichiers

`audio-player.ts` atteignait 480 lignes, bien au-dela de la limite d'environ 300 lignes fixee par
`Agents.md`. Il est decoupe en trois responsabilites :

| Fichier | Lignes | Responsabilite |
|---|---:|---|
| `src/player/audio-player.ts` | 266 | assemblage, compteurs, surface publique |
| `src/player/browser-audio.ts` | 292 | contexte audio et processeur : les pieces du navigateur |
| `src/player/decode-worker-host.ts` | 170 | creation, ordres et destruction du worker |
| `src/player/player-diagnostics.ts` | 136 | rangement d'une panne, fonction pure |
| `src/player/fill-gate.ts` | 70 | « le decodeur doit-il remplir la file ? », fonction pure |

La memoire de ce qui a deja ete dit au worker vit avec le worker, dans `decode-worker-host.ts`. Ce
n'est pas un detail de rangement : un worker neuf ne connait ni la session ni les ordres precedents.
Si cette memoire survivait a la destruction des pieces, le demarrage suivant sauterait l'annonce de
session, le worker refuserait chaque paquet, et aucun son ne sortirait sans le moindre message.

## Ce que le bloc ajoute au moteur

### Diagnostics

`AudioPlayer.diagnostics()` rend tout ce que le moteur sait de lui-meme, et `explainPlayer()` le
range en une phrase. C'est une fonction pure, donc chaque famille se verifie sous Node.

| Famille | Ce qui la designe |
|---|---|
| `network` | connexion perdue, ou direct annonce sans aucun paquet depuis deux secondes |
| `decode` | les paquets arrivent et sont acceptes, mais aucune frame n'en sort |
| `audio` | contexte pas `running`, ou aucun niveau annonce depuis une demi-seconde |
| `idle` | pas de direct, son pas encore demande, ou pause |
| `ok` | rien a signaler |

L'ordre compte : la cause la plus en amont l'emporte. Un relais muet produit forcement une file
vide, donc il faut le reconnaitre avant de conclure a une panne de decodage.

Les compteurs viennent chacun du seul endroit qui sait les tenir : le thread principal compte les
paquets recus, le worker remonte les frames acceptees et decodees une fois par seconde, le
processeur audio annonce le son en attente, les manques de donnees et les blocs abandonnes.

### Derive de retard

Cette panne ne produit ni erreur ni message : rien ne la signale.

Un contexte audio arrete par le systeme — onglet en arriere-plan, appel telephonique sur un
appareil Apple, peripherique debranche — cesse de consommer la file, mais le decodeur continue de
la remplir. Au retour, la file contient plusieurs secondes de son, et l'auditeur reprend la lecture
en retard de tout ce temps, definitivement.

Au-dela du seuil du profil plus une seconde, le son en attente est desormais jete et la lecture
repart du direct. L'ordre passe par un compteur compare a la derniere valeur appliquee, jamais par
un evenement : un ordre perdu ou double n'a aucun effet.

### Transitions durcies

| Panne | Ce qui se passait | Ce qui se passe |
|---|---|---|
| fermeture pendant le chargement | un contexte audio et un worker naissaient apres la fermeture, sans personne pour les fermer | `close()` attend le demarrage en cours, puis demonte tout |
| `play()` apres `close()` | un contexte audio repartait sur un player ferme | l'appel ne fait rien |
| worker qui meurt en direct | rien du tout : la promesse de demarrage etait deja resolue, donc son `reject` ne declenchait plus rien | panne nommee `worker_failed`, rangee dans le decodage |
| decodeur qui ne compile pas | erreur affichee, mais le contexte audio a moitie construit restait ouvert | tout est demonte avant d'annoncer la panne |
| page bloquee sur `ERROR` | il fallait recharger | un nouveau clic sur Play rebatit tout a neuf |
| contexte suspendu | rien | reprise tentee, etat visible dans le diagnostic, file videe au retour |

Safari annonce `interrupted` la ou les autres annoncent `suspended` : les deux recoivent le meme
traitement.

## Revue des blocs 8 et 8b

Cette revue relit les deux blocs apres le premier essai reel reussi. Elle a trouve six defauts.
Aucun ne se voit dans le chemin normal : c'est precisement pour cela qu'ils avaient survecu aux
tests. Chacun est corrige, et chacun a maintenant un test qui echoue si la correction disparait.

### 1. Une session annoncee pendant une panne etait perdue

`PlayerStateMachine.setStream()` sortait sans rien faire tant que l'etat etait `ERROR`. Or le relais
n'annonce un direct qu'au moment ou il **change**. Si le direct s'arretait et repartait pendant la
panne, la machine gardait l'ancienne session ; le clic sur Play suivant reconstruisait tout, puis
annoncait au worker neuf une session terminee. Le decodeur refusait alors chaque paquet pour session
etrangere, la page restait en `BUFFERING`, et plus aucune annonce ne venait la debloquer : seul un
rechargement en sortait.

C'est la seconde chance du bloc 8b qui devenait inutile des que la panne durait plus qu'un direct.
La machine enregistre desormais la session annoncee pendant l'erreur, sans changer d'etat.

### 2. Les compteurs de decodage survivaient au worker

Le thread principal ne connait les paquets acceptes et les frames decodees que par le message que le
worker envoie une fois par seconde. Apres la mort d'un worker et la construction du suivant, ces
compteurs gardaient les valeurs du precedent. Deux consequences : la page affichait des frames
decodees par un worker mort, et surtout la regle « des paquets acceptes mais rien de decode » ne
pouvait plus jamais se declencher, puisque le nombre de frames decodees restait non nul.

Le diagnostic le plus utile du bloc 8b s'eteignait donc apres la premiere panne. Le worker annonce
maintenant des compteurs vides a sa naissance et a sa mort.

### 3. Un direct annonce sans le moindre paquet n'etait pas reconnu

La regle « direct annonce mais aucun paquet depuis deux secondes » mesurait le silence depuis le
dernier paquet recu. Tant qu'aucun paquet n'etait jamais arrive, il n'y avait aucune duree a
comparer, et la panne reseau la plus franche — le relais annonce un direct et n'envoie rien —
donnait le verdict « rien a signaler ».

Le silence se mesure desormais depuis l'annonce du direct tant qu'aucun paquet n'est arrive. Le
compteur de paquets repart a chaque nouvelle session : les paquets du direct precedent ne disent
rien du direct en cours.

### 4. Vider la file PCM pouvait la remplir de son perime

`PcmRing.clear()` lit l'index de lecture, puis ecrit l'index d'ecriture. Ces deux operations sont
chacune indivisibles, mais **leur suite ne l'est pas** : le thread audio peut avancer entre les deux.
L'index d'ecriture se retrouve alors derriere celui de lecture, et la file, qui compte a l'envers
dans ce cas, se croit pleine a trois secondes. Le seuil de lecture est atteint immediatement, et
l'auditeur entend jusqu'a trois secondes de memoire perimee.

L'intervalle dure quelques nanosecondes contre 2,7 ms entre deux avances du consommateur : le cas
est rare, mais il se presente a chaque pause, a chaque discontinuite et a chaque vidage, c'est-a-dire
plusieurs centaines de fois dans un long direct. La valeur ecrite est maintenant relue : si le
consommateur a bouge, la remise est refaite sur sa nouvelle position, quatre essais au plus.

### 5. La file d'attente du mode messages n'avait aucune limite

En memoire partagee, la file bute sur ses trois secondes et compte des abandons. En mode messages,
rien ne borne la file d'attente du port : quand le thread audio s'arrete — contexte suspendu par le
systeme, appel telephonique, peripherique debranche — le decodeur continue d'y deverser 384 ko par
seconde, sans qu'aucun compteur ne le montre. Une interruption de cinq minutes accumule une centaine
de megaoctets, delivres d'un coup au retour.

Le decodeur cesse desormais de remplir la file des que le contexte audio n'est plus `running`, et
reprend a son retour. La meme regle borne les deux modes, et le passage par l'arret jette le son
perime : la reprise se fait sur du direct.

### 6. Une frame pouvait doubler la session suivante

Le traitement d'une frame contient une seule attente : la remise a zero du decodeur apres une
discontinuite. Une coupure produit les deux evenements ensemble et dans cet ordre — la frame marquee,
puis l'annonce de la session suivante. La frame reprenait ensuite son chemin sans rien verifier et
deposait vingt millisecondes du direct precedent en tete de la file que la session neuve venait de
vider. C'est le seul endroit du moteur ou du son perime pouvait passer devant du son neuf.

La session et la pause sont maintenant revues apres l'attente ; une frame devenue etrangere est
abandonnee.

### Ce que la revue n'a pas change

`AudioContext` est cree avec `latencyHint: "playback"`, qui demande au navigateur des tampons de
sortie larges. C'est le choix le plus sur contre les craquements, et le plus couteux en latence :
selon la machine, il ajoute quelques dizaines a quelques centaines de millisecondes **apres** le
seuil de buffer du player. `"interactive"` demanderait le contraire. Le choix ne se tranche pas sans
mesure, et la mesure est au bloc 11 : la valeur reste `"playback"` jusque-la.

## L'essai long, et les quatre defauts qu'il a montres

Vassi a laisse la page tourner 16 min 28 s en mode partage sous Firefox, coupures automatiques
activees, avec une coupure de 30 s demandee deux fois. Le portable a ete ferme au milieu de l'essai :
la machine est restee en veille environ une minute.

Compteurs a la fin :

```text
paquets recus       39150      paquets refuses     0
paquets acceptes    38949      discontinuites      1
frames decodees     38949      derniere erreur     aucune
son en attente      423 ms     manques de donnees  161
                               blocs abandonnes    557
```

Le chemin normal tient : aucun refus, aucune panne, la reprise apres chacune des dix coupures donne
bien `OFFLINE`, puis une nouvelle session, puis `PLAYING`. Deux compteurs, en revanche, sont hors de
ce que le bloc attendait — zero bloc abandonne en memoire partagee, quelques manques de donnees au
plus — et le journal montre une bascule qui n'a rien a y faire :

```text
12:20  verdict audio : le thread audio ne rend plus la main depuis 0.5 s
12:20  etat REBUFFERING          13:54  etat PLAYING
12:20  etat PLAYING              13:54  etat REBUFFERING
12:22  verdict audio : ...       13:55  etat PLAYING
13:50  etat REBUFFERING          14:06  etat REBUFFERING
13:54  etat PLAYING              14:06  etat PLAYING
```

Le trou de 12:22 a 13:50 est la mise en veille. Les quatre defauts ci-dessous expliquent ensemble
les deux compteurs et cette bascule.

### 1. Le thread audio peut s'arreter sans que le contexte le dise

Le bloc 8b avait pose une regle : le decodeur cesse de remplir la file des que le contexte audio
n'est plus `running`. Elle repose entierement sur l'evenement `onstatechange`.

Or un thread audio peut cesser de rendre la main alors que le contexte se dit toujours `running` :
mise en veille de la machine, onglet gele, peripherique de sortie qui bafouille. Aucun evenement
n'arrive. Le diagnostic, lui, voyait la panne — c'est le verdict `le thread audio ne rend plus la
main` des lignes 12:20 et 12:22 — mais il ne faisait que l'afficher.

Pendant ces arrets, le decodeur a continue de remplir : **la file a bute sur ses trois secondes 557
fois**. En memoire partagee c'est borne, et le compteur le montre. En mode messages il n'y a aucune
borne : c'est exactement le defaut 5 de la revue ci-dessus, qui n'etait donc corrige que pour les
arrets annonces par le contexte.

Le moteur mesure desormais lui-meme ce que le diagnostic mesurait deja : le processeur audio annonce
son niveau toutes les quarante millisecondes, donc une demi-seconde sans niveau veut dire qu'il ne
tourne plus. Le remplissage s'arrete alors, et reprend au premier niveau suivant. Le controle se
fait a l'arrivee d'un paquet, cinquante fois par seconde : c'est le flux qu'il s'agit de retenir, et
le moteur n'a ainsi aucune horloge a lui.

Trois signaux repondent desormais ensemble a la question « le decodeur doit-il remplir la file ? » —
le son est-il souhaite, le contexte tourne-t-il, le thread audio rend-il la main — et ils arrivent de
trois endroits differents. La question a donc son propre fichier, `src/player/fill-gate.ts`, qui ne
touche a aucune piece du navigateur et se verifie signal par signal sous Node.

### 2. Une bufferisation pouvait se terminer sur du son deja trop vieux

Le bloc 8b jette le son en attente quand la file depasse le seuil du profil plus une seconde. Cette
regle n'existait que dans l'etat `PLAYING`. En bufferisation, une seule regle s'appliquait : la file
atteint le seuil, donc on joue.

Au retour de veille, la machine etait en rebufferisation et la file portait trois secondes de son
que personne n'avait consommees. La bufferisation s'est donc terminee sur ce son ancien, la lecture
a repris dessus, et quarante millisecondes plus tard la regle de derive concluait au retard et
rebufferisait. D'ou `REBUFFERING`, `PLAYING`, `REBUFFERING`, `PLAYING` a 13:54 pour un seul incident,
et une bouffee de son perime a chaque aller-retour.

La verification du retard vient maintenant avant toute decision de jouer, et vaut pour les trois
etats ou la file se remplit. Un vidage demande pendant une bufferisation ne change pas l'etat : il
voyage quand meme jusqu'au decodeur, parce que la machine previent son appelant meme sans
changement d'etat.

### 3. Un creux comptait quinze fois

`Manques de donnees : 161` pour une dizaine d'incidents visibles au journal. Le compteur montait
d'une unite par bloc non servi, et la carte son demande un bloc toutes les 2,7 ms : un seul creux de
quarante millisecondes — la duree qui separe deux rapports au thread principal — en ajoutait une
quinzaine.

Ce n'est pas seulement un chiffre trompeur. La machine d'etats decide de rebufferiser sur « le
compteur a monte depuis le dernier rapport » : elle comptait quinze fois le meme evenement.

Un creux compte desormais une fois, du premier bloc non servi jusqu'au retour d'une lecture
complete. Le nombre affiche devient le nombre de trous entendus.

### 4. La file etait videe pendant que le processeur audio la lisait

`applyCommands` transmettait les trois ordres dans un ordre fixe : remplir, vider, lire. Un vidage
partait donc vers le worker avant que le processeur audio soit prevenu de s'arreter. Le worker vide
la file en quelques microsecondes ; le processeur, lui, ne lit son port qu'au bloc suivant. Entre les
deux, il lisait une file qu'on venait de lui retirer, rendait du silence, et comptait des manques de
donnees qui n'en etaient pas — lesquels pouvaient a leur tour faire rebufferiser.

Un arret de lecture part maintenant en premier, une reprise en dernier.

### Ce que l'essai ne remet pas en cause

Les 39150 paquets recus pour 38949 acceptes ne signalent rien : l'ecart est celui des paquets
arrives pendant les dix coupures, alors que le decodeur ne remplissait pas. Aucun refus, aucune
erreur, et une seule discontinuite — celle du trou de sequence laisse par le relais devant un
auditeur que la veille avait mis en retard.

## Verification executee

```powershell
npm.cmd run check
```

Resultat :

```text
TypeScript errors 0
tests 263
pass 263
fail 0
OK: tous les tests natifs de la queue audio passent
OK: tous les tests natifs Opus passent
OK: tous les tests natifs du pont loopback passent
```

Le bloc ajoute 56 tests aux 207 du bloc 8 : 41 pour le bloc lui-meme et la revue, 14 pour les quatre
defauts de l'essai long, et un pour la page non securisee. La suite complete a ete lancee trois fois
de suite sans echec, et la suite Node seule dix fois de suite.

Le dernier vient d'un essai reel : ouvrir la page depuis un telephone sur le reseau local donnait
`can't access property addModule, context.audioWorklet is undefined`. La propriete n'existe que dans
un contexte securise. Le moteur nomme desormais cette panne `audioworklet_unavailable` et la range
dans l'audio, au lieu de laisser remonter une erreur de propriete indefinie qui dit ou le code s'est
arrete mais pas ce qu'il faut corriger.

Les tests de l'essai long : le thread audio arrete alors que le contexte se dit `running`, dans les
deux modes, et le silence trop court pour couper quoi que ce soit, dans
`tests/player-hardening.test.ts` ; l'ordre des ordres autour d'un vidage, dans le meme fichier, qui
compare le rang des deux messages dans une suite unique ; la bufferisation qui ne se termine pas sur
du son vieux, en rebufferisation et au premier remplissage, dans `tests/player-state.test.ts` ; le
creux compte une fois et non par bloc, dans `tests/player-pcm-ring.test.ts`.

### Un test instable, trouve en verifiant

Lancer la suite dix fois de suite a fait echouer une fois sur trois un test du bloc 7,
`reconnecte apres une coupure et cree une nouvelle session`. Le defaut etait dans le test, pas dans
le publisher : il coupait la connexion des que l'etat du publisher passait a `LIVE`, c'est-a-dire
juste apres l'ecriture de `stream_start` et avant que le relais l'ait lu. La coupure emportait alors
ce message, et le compte de deux `stream_start` attendu plus loin n'etait jamais atteint.

Le test attend maintenant que le relais ait recu le premier `stream_start` avant de couper. Un test
qui echoue une fois sur trois sans raison est pire qu'un test absent : il apprend a ne plus lire les
echecs.

**`tests/player-fill-gate.test.ts`** : les trois signaux du remplissage, un par un puis ensemble.
Le credit fait au thread audio tant qu'aucun niveau n'est arrive — sans lui, la toute premiere
bufferisation ne partirait jamais — et la remise a neuf qui accompagne la destruction des pieces,
sans laquelle le moteur suivant resterait muet.

Les tests de la revue : la session apprise pendant une panne et la connexion perdue pendant une
panne, dans `tests/player-state.test.ts` et `tests/player-hardening.test.ts` ; les compteurs oublies
avec le worker et la file bornee quand le contexte s'arrete, dans `tests/player-hardening.test.ts` ;
le direct qui n'envoie jamais rien, dans `tests/player-hardening.test.ts` ; le vidage concurrent,
dans `tests/player-pcm-ring.test.ts`, qui place l'avance du consommateur exactement dans
l'intervalle ; la frame abandonnee, dans `tests/player-decode.test.ts`, qui place le changement de
session exactement pendant la remise a zero.

**`tests/player-diagnostics.test.ts`** : chaque famille est verifiee sur un cas reel — connexion
perdue, direct muet, paquets acceptes sans frame decodee, contexte suspendu, thread audio arrete. Un
test verifie que la cause la plus en amont l'emporte quand plusieurs symptomes coexistent, un autre que
l'attente n'est pas confondue avec une panne.

**`tests/player-hardening.test.ts`** : le vrai player, avec de fausses pieces de navigateur, branche
sur le vrai relais. Fermeture pendant le chargement du processeur, clic sur Play apres fermeture,
fermeture pendant une reconnexion, decodeur qui refuse de demarrer, worker qui meurt en direct,
seconde chance apres une panne, derive de retard, suspension du contexte, comptage de bout en bout,
et les memes pannes en mode messages.

**`tests/player-state.test.ts`** : six tests de plus sur la machine seule — sortie d'erreur, seuil de
derive mesure a partir du profil annonce, et absence de vidage pour un simple manque de donnees.

**`tests/player-fixture-page.test.ts`** : un test de plus verifie que chaque champ rempli par la
page existe reellement. Un identifiant mal ecrit ne provoque aucune erreur visible — le compteur
reste fige — et pendant une ecoute cela ressemble a une panne du moteur alors que seul l'affichage
est casse.

## Verification a l'oreille, a faire avec Vassi

Ableton n'intervient pas. La marche a suivre et la raison de ce choix sont dans
`docs/validation/phase-8.md`.

**Les pannes decrites plus haut ne sont pas a provoquer a la main.** Un worker qui meurt, un
decodeur qui refuse de compiler, un contexte suspendu par le systeme, une page fermee pendant le
chargement : ces situations sont jouees par `tests/player-hardening.test.ts` avec de fausses pieces
de navigateur, et elles tournent a chaque `npm.cmd run check`. Aucune ne demande un navigateur, et
aucune ne se declenche depuis la page. Ce qui reste a faire a la main est ce qu'aucun test ne peut
faire : ecouter, et laisser tourner longtemps.

```powershell
npm.cmd run player:fixture
```

La page affiche maintenant un verdict, les compteurs ranges en trois familles — reseau, decodage,
audio — et un journal horodate.

### Les quatre premieres observations

Elles sont inchangees : `READY` au chargement, Play qui donne `BUFFERING` puis `PLAYING` avec le
grave a gauche et l'aigu a droite, Pause qui coupe, coupure qui donne `OFFLINE` puis un retour
automatique avec une nouvelle session.

Le verdict doit revenir a **rien a signaler** apres chaque coupure.

### L'essai long

Le scenario complet, phase par phase, avec ce qui compte comme defaut, est dans
`docs/validation/phase-8b-essai-long.md`. La marche a suivre minimale reste celle-ci :

1. Cliquer sur **Play**, puis sur **Coupures automatiques**.
2. Laisser tourner quinze a trente minutes, en cliquant de temps en temps sur **Pause** puis sur
   **Play**, et en essayant une **coupure de 30 s** au moins une fois.
3. Passer l'onglet en arriere-plan quelques minutes, puis revenir : la lecture doit reprendre au
   direct, sans retard accumule. C'est la limite de derive qui se verifie la.
4. Cliquer sur **Copier le journal** et coller le resultat dans la note.

Ce qu'il faut regarder a la fin :

| Compteur | Valeur attendue |
|---|---|
| Manques de donnees | quelques-uns au plus, tous explicables par une coupure |
| Blocs abandonnes | zero en mode partage ; en mode messages, une valeur qui ne monte pas continuellement |
| Discontinuites | une par coupure environ |
| Derniere erreur | aucune |

### Les trois passages

Firefox en mode partage, Firefox sans isolation, puis Safari. Le detail de chacun, et la facon
d'atteindre Safari depuis une autre machine, sont dans `docs/validation/phase-8.md`.

Le mode sans `SharedArrayBuffer` se juge sur un seul compteur : **Blocs abandonnes**. C'est la
mesure directe de la stabilite du transport par `MessagePort` — un port qui n'arrive plus a suivre
les fait monter, la memoire partagee non.

## Bloc precedent

Le bloc 8 fonctionne toujours : ses 207 tests passent sans modification. Les seuls changements de
comportement sont ceux decrits ci-dessus, et aucun ne touche le chemin normal du son.

## Limites reportees

- Safari n'a pas ete teste, et **aucun navigateur d'une autre machine ne peut l'etre par
  `http://`**. Une telle page n'est pas un contexte securise, et `BaseAudioContext.audioWorklet`
  n'existe que dans un contexte securise : le processeur audio ne se charge pas du tout, quel que
  soit le mode. Ce n'est pas seulement `SharedArrayBuffer` qui manque, comme ce document l'affirmait.
  Le mode messages se verifie donc sur la machine du serveur, par `http://127.0.0.1` — que les
  navigateurs traitent comme securise — avec `VASSI_NO_ISOLATION=1`. Faire tester une autre machine
  demande de servir la page en `https://`, ce que le serveur de test ne sait pas faire.

  **Decision : le serveur de test n'apprendra pas le HTTPS.** Safari et le comportement sur un vrai
  reseau sans fil seront verifies au bloc 9, sur le site deploye chez Sliplane, qui est en `https://`
  par construction. Un certificat auto-signe sur l'outil de test couterait une heure et un
  avertissement de securite a accepter sur chaque appareil, pour verifier le moteur dans des
  conditions qui ne sont deja plus celles du produit. La contrepartie est acceptee : le mode messages
  n'aura pas ete vu sur un vrai reseau avant le bloc 9.
- Le mode sans `SharedArrayBuffer` n'a pas encore ete tenu quinze minutes dans un navigateur. C'est
  le seul mode ou la file d'attente du port n'a pas d'autre borne que le premier defaut ci-dessus, et
  c'est le compteur « blocs abandonnes » qui le dira.
- Les quatre corrections de l'essai long n'ont pas encore ete entendues dans un navigateur. Un
  second essai long en mode partage doit maintenant donner zero bloc abandonne, quelques manques de
  donnees seulement, et une seule bascule `REBUFFERING` par incident. La ligne
  `retard detecte : le son en attente est jete` du journal dit desormais quand la limite de derive se
  declenche.
- Le seuil de derive, une seconde au-dessus du profil, est une valeur choisie. Le premier essai long
  ne l'a pas mise en defaut : elle ne s'est declenchee qu'apres des arrets reels du thread audio,
  jamais sur la respiration normale de la file.
- La latence reelle ne se mesure toujours pas ici. C'est le bloc 11.

## Decision

Le code du bloc 8b est termine et teste. Le bloc reste ouvert jusqu'a l'essai long et jusqu'aux
trois passages navigateur.
