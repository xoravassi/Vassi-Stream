# Essai en condition de cours — 11 aout 2026

Session de 41 min. Ableton Live 12 en boucle, device en 256 kbit/s / latence 400 ms, VPN ProtonVPN
par Montreal, appel Google Meet simultane **sur la machine Ableton** (partage d'ecran, deux cameras,
deux micros), ecoute du direct sur le portable pendant le Meet, usage normal de la machine a cote.

Journaux : `tests/export-max-2026-08-11.txt` (device), `tests/export-web-2026-08-11.txt` (player).

> **Contrainte de conception, posee apres coup et non negociable.**
>
> **Tout tient sur une seule machine.** Le partage d'ecran doit partir de la machine Ableton, sinon
> le professeur ne voit pas la session ; et repartir la camera ou le micro sur un second poste
> imposerait deux casques a la fois. Le cours reel n'a donc qu'un ordinateur, qui fait tourner
> Ableton, l'encodeur, et un Meet complet — partage d'ecran, camera, micro et son.
>
> Le portable de l'essai n'existait que pour tenir le role du professeur, qui est au Canada.
>
> Cette contrainte retire du jeu la solution la plus simple — alleger la machine — et rend la
> correction d'horloge du device **indispensable plutot qu'optionnelle** : le systeme doit encaisser
> un moteur audio qui decroche, puisqu'on ne peut pas l'empecher de decrocher.

> Ce document a ete revu par un relecteur independant qui a invalide sa premiere conclusion. La
> section « Ce que la premiere analyse a rate » garde la trace de l'erreur : elle explique pourquoi
> les compteurs actuels permettaient de se tromper, ce qui est en soi une chose a corriger.

## Le resultat

| | |
|---|---|
| coupures du son | **40**, soit une toutes les ~62 s |
| silence total | **93 s, 3,8 % du cours** (2,3 s en moyenne, 4,2 s au pire) |
| latence payee | seuil au plafond de **2000 ms pendant 89 % du temps** |
| niveau de file reel median | **982 ms** pour un seuil de 2000 |
| paquets perdus sur le reseau | aucun **mesurable** — voir plus bas, la mesure ne vaut rien |

## La cause : la source n'a produit que 96,3 % du son

Une trame vaut 40 ms, donc 25 trames par seconde. Le device en a produit **24,08**.

Verifie par trois chemins independants :

| source | mesure |
|---|---|
| `bilan` du device | 59 420 trames en 2468 s → **24,076 tr/s** |
| lignes `sante` (compteur distinct) | 30 357 trames en 1261 s → **24,074 tr/s** |
| REPERE du player (autre machine, autre horloge) | 246,8 kbit/s recus ; 59 420 trames font 246,6 kbit/s |

**Deficit de 3,70 %. Sur 41 min, 91 s de musique n'ont jamais ete encodees.**

Et le silence entendu par l'auditeur vaut **93 s**. Ce n'est pas une correlation, c'est une
conservation : le player n'a pas fabrique ce silence, il a restitue un trou qui existait deja a la
source.

**La charge processeur en est la cause**, et le journal du device le montre directement :

| processeur machine | debit de trames |
|---|---|
| < 60 % | **24,94 tr/s** — nominal |
| ≥ 80 % | **21,53 tr/s** — deficit de 14 % |

Correlation charge x debit : **−0,755** sur 126 releves. Creux les plus profonds a 16,4 tr/s, entre
10:22 et 10:26 — exactement la ou le player coupe cinq fois en trois minutes.

Le moteur audio a decroche sous la charge du Meet. Deux cameras, un partage d'ecran et un encodage
video tournaient sur la machine qui faisait tourner Ableton. Le flux a transporte fidelement un
signal deja abime.

Ce n'est pas un decalage d'horloge ni une erreur de reechantillonnage : ceux-la donneraient un
rapport constant. Un deficit qui suit la charge et revient a 24,94 tr/s des que la machine respire
est un decrochage du moteur audio.

## Pourquoi une coupure toutes les 62 secondes exactement

Le player consomme 1000 ms d'audio par seconde. La source en livre 963. La file se vide donc de
37 ms par seconde, et le seul mecanisme de remontee est le regulateur de vitesse, plafonne par
`RATE_MAX = 0.005` ([pcm-worklet.js:71](../../../src/player/pcm-worklet.js#L71)) a 0,5 % — soit
**5 ms regagnes par seconde**.

```
  deficit de la source     37,0 ms/s
  rattrapage du player    − 5,0 ms/s
  ─────────────────────────────────
  vidange nette            32,0 ms/s   →  2000 ms de tampon tiennent 62 s
```

**Predit : 62 s. Observe : 60 s de mediane** sur 33 intervalles.

Le modele est ferme. Il explique le nombre de coupures, leur periode, et la derive du niveau de file
(median 982 ms au lieu de 2000) sans aucun parametre ajuste.

Il dit aussi une chose qu'il faut entendre : **aucun reglage du player n'aurait sauve ce cours.**
Un tampon deux fois plus grand aurait double la latence pour reculer la premiere coupure a 124 s.
On ne fabrique pas de l'audio qui n'a pas ete produit.

## Le defaut qui transforme un decrochage local en panne du direct

C'est le point central du plan, et il est reparable.

L'external avance son horloge d'une trame par trame produite :
`timestamp_us += FRAME_DURATION_US` ([audio_encoder.cpp:101](../../../externals/vassi.encoder~/source/audio_encoder.cpp#L101)).
Quand Ableton saute un bloc DSP, `perform64` n'est pas appele, aucun sample n'arrive — et l'horloge
du device **ne s'en apercoit pas**. Elle recolle les deux morceaux comme s'ils etaient contigus.

Le mecanisme correct existe pourtant deja, juste a cote : quand c'est la file interne qui deborde,
`audio_encoder_note_loss` avance le timestamp de la duree perdue et pose le bit de discontinuite. Le
protocole l'exige explicitement ([protocol-v1.md](../../protocol-v1.md)) : *« une perte locale
conserve le temps audio ecoule »*. Ce chemin-la est juste. Il ne couvre simplement pas ce cas.

Consequence : le trou devient invisible a **tous** les compteurs — ni `gaps`, ni `framesDropped`, ni
saut de sequence, ni ecart de timestamp — et ressort trois minutes plus tard, ailleurs, sous la forme
d'un tampon vide et d'une coupure de 2,3 s.

**Un decrochage de 40 ms chez Ableton coute aujourd'hui 2,3 s de silence a l'auditeur, avec 60 s de
retard, et personne ne peut faire le lien.** C'est cette amplification qu'il faut supprimer.

## Les autres defauts du player, a leur vraie place

Ils ne causent pas les coupures. Ils decident de leur **cout**.

### 1. La reprise coute 2,3 s au lieu de quelques dizaines de ms

`rebufferingThresholdMs = seuil − max(50, 20 %)` = 1600 ms a seuil 2000
([player-state.ts:324](../../../src/player/player-state.ts#L324)). Un manque sous cette barre fait
passer en REBUFFERING, et la lecture reste **muette jusqu'a ce que la file ait rejoint le seuil
complet** ([player-state.ts:275](../../../src/player/player-state.ts#L275)). Le remplissage se fait
a ~0,8x le temps reel (194 pentes mesurees, mediane 800 ms/s), d'ou les 2,3 s.

### 2. Le seuil se nourrit de lui-meme et reste colle au plafond

`noteUnderrun` fait `observedMs = boundedTarget() × 1.25`
([buffer-target.ts:138](../../../src/player/buffer-target.ts#L138)), et `boundedTarget()` vaut deja
`observedMs × 1.5`. Chaque manque multiplie donc `observedMs` par **1,875** : retroaction positive.

Verification sur le journal : a 09:48:51, `besoin 382` → seuil 550. 12 s d'oubli a 5 ms/s → 322.
A 09:49:03, `322 × 1,5 × 1,25 = 604` — **le journal affiche « besoin estime 604 »**. Puis
400 → 750 → 900 → 1300 → 1400 → **2000 en cinq manques et trois minutes**. Redescendre demanderait
133 s de calme ; les manques arrivaient toutes les 62 s.

**L'auditeur a paye 2000 ms de latence a cause d'une multiplication, pas d'une mesure du reseau.**

### 3. La zone morte est proportionnelle au seuil

`RATE_DEADBAND = 0.15` en part du seuil ([pcm-worklet.js:503](../../../src/player/pcm-worklet.js#L503))
= 300 ms a seuil 2000. Le regulateur ne corrige rien au-dessus de 1700 ms. Il devient d'autant plus
paresseux que la situation est mauvaise.

### 4. Le regulateur de seuil lit un reseau qui n'existe pas

`notePacket` calcule `drained = at − previous − 40` ([buffer-target.ts:127](../../../src/player/buffer-target.ts#L127)).
Avec un device qui emet une trame toutes les **41,5 ms**, ce calcul voit un blocage reseau permanent.
**Le seuil de 2000 ms a ete fabrique par la sous-production de la source**, pas par le lien.

### 5. L'entree des paquets passe par le thread principal

`ListenerSocket` vit sur le thread principal ([audio-player.ts:142](../../../src/player/audio-player.ts#L142)).
Un blocage de 7 s y est journalise a 09:48:00. **Contribution inconnue** : 1,31 manque/min onglet
visible contre 0,84 cache, mais p = 0,12 et « visible » recouvre exactement le debut et la fin de
session. Ces chiffres ne prouvent rien, dans aucun sens.

## Ce que la premiere analyse a rate, et pourquoi

**« Aucun paquet perdu » ne veut rien dire sur TCP.** Le flux est ordonne et complet par
construction : `sauts 0` et `comble 0 ms` **ne peuvent pas** prendre d'autre valeur en l'absence de
reconnexion ou de drop du relais. Zero bit d'information sur la perte reseau.

**Les 55 lignes « le device a baisse son debit » avaient raison.** J'ai cru le contraire parce que le
device affiche `256 sur 256 kbit/s` — mais `applied` est le **reglage de l'encodeur**, pas le debit
atteint ([vassi-stream-device.js:528](../../../device/node/vassi-stream-device.js#L528)). Le device
annonce sa consigne, le player mesure le resultat, et **l'ecart entre les deux etait la
sous-production**. C'est ma lecture qui les a opposes.

**Les manques ne sont pas declares « avec de l'audio en file ».** `CONTROL_UNDERRUNS` n'avance que
sous 128 echantillons ([pcm-worklet.js:344](../../../src/player/pcm-worklet.js#L344)) : la file etait
vide. Les 112 ms medians sont un artefact de latence de mesure.

**Le journal du device est tronque** : 400 lignes, les 20 premieres minutes sur 41 sont absentes.

---

# Etat d'avancement

| | etat |
|---|---|
| Phase 0 — mesure de la production | **fait** (device) ; relais et player restent a faire |
| Phase 1 — horloge de source honnete | **fait** |
| Phase 2 — corrections du player | **fait** |
| Phase 3 — reception hors thread principal | non fait, gain non demontre |
| Phase 4 — masquer les trous mieux que par du silence | **devenue la suite logique**, voir plus bas |

Ce qui a ete ecrit :

- `device/node/source-clock.js` — mesure l'ecart entre le temps audio produit et le temps reel, et
  rend le decalage a annoncer. Pur, sans socket ni protocole, teste sous Node.
- `device/node/publisher.js` — mesure l'ecart a l'arrivee de chaque trame et applique le decalage aux
  timestamps sortants. Le decalage voyage avec la trame dans la file d'envoi, pour qu'un trou ne soit
  jamais attribue a une trame arrivee avant lui.
- `device/node/vassi-stream-device.js` — ligne `source` au journal, toutes les dix secondes.
- `src/player/buffer-target.ts` — croissance additive du seuil sur manque de donnees.
- `src/player/pcm-worklet.js` — zone morte et pente du regulateur de vitesse en millisecondes fixes.
- `src/player/player-state.ts` — reprise a la moitie du seuil au lieu du seuil entier.
- Tests : `tests/source-clock.test.ts` (8 cas), un cas de bout en bout dans `tests/publisher.test.ts`,
  un cas de regulateur a seuil eleve dans `tests/player-worklet-net.test.ts`.

408 tests, 407 passent, 1 ignore. Les sept erreurs de `tsc` restantes sont anterieures a ce travail
et portent sur `tests/journal.test.ts` et `tests/device-patcher.test.ts`.

# Le plan

## Phase 0 — voir la sous-production

C'est la mesure qui manquait, et elle est presque gratuite : le device connait son compte de trames
et l'heure ; le rapport des deux est le taux de production.

1. **Device** : journaliser `trames/s reelles vs 25`, et alerter au-dela de 1 % de deficit —
   « le moteur audio ne fournit que 96 % du temps reel : la machine ne suit pas ». Aucun compteur
   actuel ne voit ce cas.
2. **Device** : lever la troncature a 400 lignes, ou exporter le fichier complet deja ecrit dans
   `journaux/`.
3. **Relais** : exporter `stats.framesDropped` et `closedSlow` ([listener-hub.ts:198](../../../relay/listener-hub.ts#L198)).
   Le relais jette au-dela de `dropThresholdMs` = 1400 ms ici, alors que le player tenait 2000 ms.
   Ce desalignement n'a pas tire cette fois, mais personne ne le surveille.
4. **Player** : mesurer l'arrivee dans le worker en **separant la pente de la variation autour de la
   pente**. La pente est la sous-production, la variation est la gigue reseau. Les confondre est
   exactement l'erreur de `notePacket`.

**Cette phase est le banc d'essai de la phase 1** : elle transforme chaque reglage a essayer en une
mesure de cinq minutes, sans avoir besoin d'un vrai cours.

## Phase 1 — le device doit dire la verite sur son horloge

**C'est la correction structurante, et elle est la seule de ce plan a s'attaquer au probleme du
11 aout. Elle ne demande rien a Ableton, rien au Meet, rien a la machine.**

> **Le perimetre de ce plan est le systeme de stream, pas l'environnement de travail.** 
>
> La consequence est claire et il faut l'assumer : **la sous-production ne sera pas supprimee.** Le
> son qu'Ableton n'a pas calcule n'existe pas, et aucun code ne le fera exister. Ce que le systeme
> peut faire, c'est cesser de transformer ce manque en panne — et c'est exactement ce que fait cette
> phase.

Detecter que la timeline audio prend du retard sur le temps reel, et declarer ce retard comme un vrai
trou : avancer le timestamp de la duree manquante, exactement comme le fait deja
`audio_encoder_note_loss` pour le debordement de file.

Le player sait deja quoi en faire : `MAX_CONCEAL_MICROS = 500 ms`
([decode-worker.js:22](../../../src/player/decode-worker.js#L22)) — un trou declare sous 500 ms est
comble par la duree exacte de silence, **sans rebufferisation**. Le code existe et il est teste.

Ce que ca change :

| | aujourd'hui | apres |
|---|---|---|
| audio manquant | 91 s | 91 s — **rien ne le recupere** |
| ou l'auditeur l'entend | 40 blackouts de 2,3 s, jusqu'a 60 s plus tard | la ou le decrochage a eu lieu, en trous courts |
| niveau de file | se vide de 32 ms/s jusqu'a zero | **reste juste** |
| latence | montee a 2000 ms et bloquee | reste au plancher du profil |
| diagnostic | invisible a tous les compteurs | compte et nomme |

Le gain n'est pas de recuperer le son : c'est de **supprimer l'amplification**. L'auditeur entend les
vrais decrochages, la ou ils sont, au lieu des vrais decrochages **plus** un blackout par minute
**plus** deux secondes de latence permanente.

**Ou l'implementer.** D'abord dans le publisher Node (~40 lignes, aucune recompilation de l'external) :
il recoit les trames avec leur timestamp et connait l'horloge murale ; sur une fenetre glissante de
5 a 10 s, un deficit de 3,7 % vaut 200 a 400 ms, tres au-dessus de la gigue d'ordonnancement de Node.
Ensuite seulement, si la precision le demande, dans l'external, ou `perform64` peut comparer les
samples recus au temps ecoule bloc par bloc.

*Detail tranche a l'implementation* : avancer le timestamp suffit a faire combler la bonne duree
([decode-worker.js:269](../../../src/player/decode-worker.js#L269)). Le bit de discontinuite n'est
**pas** pose : sa semantique est « l'encodeur a ete remis a zero », ce qui est faux ici — les samples
de part et d'autre du trou sont contigus pour Opus, et reinitialiser le decodeur allongerait
l'artefact au lieu de l'ecourter ([decode-worker.js:235](../../../src/player/decode-worker.js#L235)).

## Phase 2 — les corrections bon marche du player (~10 lignes)

Independantes de la phase 1, et a faire de toute facon : elles font chuter la latence et le cout des
coupures **meme si la source reste defaillante**.

1. `noteUnderrun` : croissance **additive et bornee** (p. ex. `+250 ms`) au lieu du `×1,875` compose.
   Supprime la boucle qui epingle le seuil au plafond.
2. Zone morte **absolue** (p. ex. 150 ms) au lieu de proportionnelle.
3. Reprise apres REBUFFERING : repartir des qu'il y a de quoi jouer, pas au seuil complet.

## Phase 3 — recevoir le son ailleurs que dans la page

*(Ce que ca veut dire, en clair.)* Dans un navigateur, une page a **un seul fil d'execution
principal** : il dessine l'interface, repond aux clics, et — aujourd'hui — recoit aussi les paquets
audio avant de les passer au decodeur. Tant qu'il est occupe, les paquets attendent. Le journal du
11 aout montre un blocage de 7 s de ce fil.

Un *worker* est un second fil, invisible, qui tourne a cote. Le decodeur y est deja. Il s'agit de
**deplacer aussi la reception** dedans, pour que le chemin du son n'ait plus jamais a attendre
derriere l'interface.

~100 lignes, faible risque. **Mais je ne peux pas chiffrer le gain** : les donnees du 11 aout ne
permettent ni de le prouver ni de l'ecarter. A faire comme une assurance, pas en attendant un chiffre.

## Phase 4 — masquer les trous mieux que par du silence

**Cette phase a change de statut, et c'est une consequence directe du perimetre.** Puisqu'on ne
touchera pas a l'environnement, la sous-production restera. Les trous sont donc **permanents et
inevitables**, et la seule question qui reste ouverte est : *a quoi ressemblent-ils ?*

Aujourd'hui, un trou annonce est comble par du **silence numerique** exact
([decode-worker.js:288](../../../src/player/decode-worker.js#L288)). C'est le bon choix par defaut —
la chronologie est juste a l'echantillon pres — mais ce n'est plus le meilleur possible maintenant
que ces trous sont la pour rester. Le commentaire du code le dit deja : une dissimulation produite
par le decodeur prolongerait le son au lieu de le couper, et elle n'a ete ecartee que parce que
`opus-decoder` fige sa taille de frame a 120 ms alors qu'un trou ordinaire en vaut 40.

Deux voies, par cout croissant :

1. **Prolonger la derniere periode du signal en fondu** sur la duree du trou, au lieu d'ecrire des
   zeros. C'est l'`Expand` de NetEq dans sa forme la plus simple. Sur des trous de 40 ms, c'est la
   difference entre un clic et rien du tout.
2. **Etirer le son sans changer sa hauteur** (WSOLA/PSOLA), qui recolle des periodes du signal. Plus
   ambitieux, 500 a 900 lignes, et il faut une recherche de periode commune aux deux canaux pour ne
   pas detruire l'image stereo.

**C'est maintenant le meilleur gain restant sur la qualite d'ecoute**, et il faut mesurer l'essai
avec les phases 1 et 2 avant de choisir laquelle des deux voies merite l'effort.

## Reporte

**Calculer la marge de securite autrement.** Aujourd'hui le player dimensionne son tampon sur *le pire
hoquet qu'il ait jamais vu, multiplie par 1,5*. Un seul mauvais moment fixe donc la latence pour
plusieurs minutes. L'alternative (celle de WebRTC) est de la dimensionner sur *« la marge qui a suffi
pour 95 % des hoquets des dernieres minutes »*, ce qui ignore les accidents isoles. A reprendre apres
la phase 3 : ce calcul est alimente par des mesures prises sur le thread principal, donc fausses tant
que la phase 3 n'est pas faite.

**Donner au regulateur de vitesse une vraie autorite de rattrapage.** Pour remonter le tampon, le
player ralentit la lecture — ce qui baisse la hauteur, comme un disque qui tourne moins vite. A
0,5 % c'est 8,6 cents, deja a la limite du perceptible sur une tenue ; il faudrait 3 a 5 % pour
rattraper vraiment, soit presque un demi-ton. **Toute loi continue assez rapide pour remonter la file
est donc audible** : c'est une multiplication, pas un avis. Sortir de cette impasse demande
l'etirement a hauteur constante de la phase 4 — raison de plus pour la traiter la-bas, et non ici.

Ceci dit, avec l'horloge de source en place la file ne se vide plus toute seule : ce rattrapage n'a
plus a etre rapide. Le sujet perd son urgence en meme temps qu'il trouve sa solution.

**Changer de transport.** Le direct passe aujourd'hui par une WebSocket, donc par TCP : si un paquet
se perd, TCP le redemande et **bloque tout ce qui suit** en attendant, ce qui transforme une perte en
attente. QUIC (WebTransport) sait livrer sans attendre le paquet manquant. J'avais ecarte cette piste
au motif qu'aucun paquet n'avait ete perdu — c'etait un raisonnement vide, puisque sur TCP une perte
ne se voit jamais comme un trou. **Dossier rouvert.** Ce qui reste vrai pour cette session : aucune
rafale de rattrapage (194 pentes, mediane 800 ms/s, max 1400) — pas de signature de blocage TCP ce
jour-la. A trancher sur la mesure de gigue de la phase 0.

## Comment on saura que ca marche

Rejouer le meme scenario qu'aujourd'hui — VPN Montreal, Meet complet avec partage d'ecran sur la
machine Ableton, boucle Ableton, duree comparable — **sans rien changer a la machine**. C'est le
point : le test doit rester hostile.

| mesure | reference 11 aout | cible | depend de |
|---|---|---|---|
| cycles de rebufferisation | 40 | **< 5** | phase 1 |
| seuil median | 2000 ms | **< 1000 ms** | phase 2 |
| seuil au plafond | 89 % du temps | **< 10 %** | phase 2 |
| niveau median de file / seuil | 982 / 2000 = 49 % | > 85 % | phases 1 + 2 |
| debit de trames du device | 24,08 / 25 | **inchange, et desormais visible au journal** | phase 0 |
| silence total | 93 s (3,8 %) | ~ duree reellement non produite | — |

**Ces quatre premieres lignes doivent s'ameliorer alors meme que la machine continue de decrocher.**
C'est tout le pari de ce travail, et c'est ce qui le rend falsifiable : si elles ne bougent pas, le
diagnostic est faux et il faut revenir ici avant d'ecrire une ligne de plus.

La derniere ligne n'est pas une cible mais une identite a verifier. **Le silence ne descendra pas
sous la duree que la machine n'a pas produite** — 91 s ce jour-la — parce qu'aucun code ne fabrique
du son qui n'existe pas. Ce qui doit changer, c'est *ou* et *comment* il s'entend : reparti en trous
courts la ou le decrochage a eu lieu, au lieu de quarante blackouts de 2,3 s jusqu'a une minute plus
tard, avec deux secondes de latence permanente par-dessus. Le rapprocher de zero est le sujet de la
phase 4, pas de celle-ci.
