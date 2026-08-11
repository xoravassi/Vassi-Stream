# Plan de continuite — 11 aout 2026, revision mesuree

Ce plan prend la suite de [l'analyse du cours reel](2026-08-11-analyse-cours-reel.md) et remplace la
premiere version du plan de continuite. La difference entre les deux n'est pas une question de gout :
**la premiere version a ete passee au banc de rejeu, et trois de ses six lots ne survivent pas a la
mesure.**

> **Objectif, et il n'y en a qu'un : le moins de coupures possibles, et une ecoute agreable.**
>
> Une **coupure** est un blanc qui interrompt le direct — rebufferisation, vidage de la file,
> reprise. Elle se compte. Une **ecoute agreable**, c'est ce que l'auditeur entend entre les
> coupures : les clics aux bords des trous, le grain des micro-trous. Ca ne se comptait pas ; ce plan
> montre que si.

## Regle de ce plan

**Aucun lot n'est retenu sans un chiffre qui le prouve.** Chaque affirmation ci-dessous renvoie soit
a une execution de `scripts/bench-continuite.mjs`, soit a une ligne de code, soit a une source
externe citee en fin de document. Les lots dont la mesure ne montre aucun gain sont ecrits ici comme
**abandonnes**, avec le chiffre qui les abandonne — pas supprimes en silence.

---

## Lot 0 — le banc de rejeu — **fait**

`scripts/bench-continuite.mjs` pousse un profil de production a travers `SourceClock`, le decodeur,
la file PCM, le regulateur de vitesse, `BufferTarget` et `PlayerStateMachine`, avec une horloge
injectee. Une session de 41 minutes se rejoue en quelques secondes.

Le profil reproduit la correlation charge x debit du 11 aout — 24,94 tr/s machine au repos, 21,5
au-dela de 80 % de processeur, creux a 16,4, moyenne 24,08 tr/s.

Le banc **rejoue** l'algorithme de `source-clock.js` au lieu de l'importer, pour pouvoir comparer un
reglage candidat au code en place dans la meme execution. La section `horloge` fait tourner le module
reel en parallele et signale toute divergence ; elle ne se declenche pas aujourd'hui.

    node scripts/bench-continuite.mjs            toutes les sections
    node scripts/bench-continuite.mjs arrets     une seule

**Ce qu'il ne fait pas** : il ne connait ni le VPN, ni le navigateur, ni Opus, ni le Meet. Il trie les
hypotheses avant de payer un essai reel ; il ne le remplace pas.

---

## Ce que la mesure confirme : le travail deja fait etait le bon

L'horloge de source est de tres loin le gain principal, et le banc le chiffre pour la premiere fois.
Meme profil de production, meme code player, seule l'horloge de source change :

| | coupures | vidages du decodeur | silence total | seuil median |
|---|---|---|---|---|
| sans horloge de source | **117** | 0 | **84,6 s** | 950 ms |
| code actuel | **3** | 0 | **1,5 s** | 400 ms |

Le silence residuel de 1,5 s est ce qui reste apres que 91,5 s de trous ont ete combles sans
interrompre la lecture. **La phase 1 fait ce qu'elle promettait, et le banc le montre sur les six
mesures du tableau de validation.** Rien dans la suite ne remet cela en cause.

---

## Ce que la mesure infirme

### Le mecanisme decrit par le lot 1.1 de la premiere version n'existe pas

La premiere version annoncait le lot 1.1 comme « le lot le plus rentable du plan », sur ce
raisonnement : dans les creux a 16,4 tr/s, la fenetre de 2 s de `SourceClock` accumule ~688 ms de
retard non declare, sortis en un seul pas, que le player refuse de combler.

**C'est faux, et c'est une propriete du code, pas une question de reglage.** `lag = smallest -
this.shiftMicros` ([source-clock.js:135](../../../device/node/source-clock.js#L135)) retranche le
decalage deja applique : chaque trame ne declare que l'**increment** de retard, jamais le cumul. Le
minimum glissant suit la derive de facon continue.

Mesure, sur un creux a 16,4 tr/s soutenu pendant trois minutes :

| | valeur |
|---|---|
| nombre de pas declares | 1551 |
| pas median | **40 ms** |
| pas maximum | **40 ms** |
| vidages du decodeur | **0** |
| deficit reel / declare | 62 064 ms / 62 040 ms |

Sur la session complete, borner le pas a 400 ms donne **exactement les memes chiffres** que le code
actuel — 3 coupures, 0 vidage, 1,5 s de silence — dans toutes les conditions de reseau essayees.

### La zone morte proportionnelle du lot 2 degrade les profils courts

Le lot 2 proposait `deadbandMs = min(RATE_DEADBAND_MS, keepMs * 0.15)` pour rendre au regulateur son
autorite sur les profils courts. Le raisonnement — a 200 ms de seuil, 150 ms de zone morte ne
laissent que 50 ms exploitables — est arithmetiquement juste. **Sa conclusion est fausse**, parce
qu'elle traite comme un defaut ce qui est une protection : sur un profil court, une file plus grasse
que son seuil est ce qui absorbe le trou suivant.

| profil 200 ms | coupures | silence | niveau median |
|---|---|---|---|
| code actuel | **6** | 1,6 s | 342 ms |
| zone morte proportionnelle | **14** | 3,1 s | 234 ms |

Le regulateur proportionnel fait effectivement ce qu'on lui demande — il ramene la file de 342 a
234 ms, soit 108 ms de latence gagnes — et il **double le nombre de coupures pour les obtenir**.
Contre l'objectif pose en tete de ce plan, c'est un mauvais echange.

A 400 ms de plancher, l'effet est nul a legerement negatif. **Lot 2 abandonne.**

Reste vraie, en revanche, la remarque de detail : le texte de la premiere version annonce `+250 ms`
pour le pas de croissance du seuil, le code applique 150
([buffer-target.ts:88](../../../src/player/buffer-target.ts#L88)). **C'est le texte qu'il faut
aligner sur le code, pas l'inverse** — et c'est fait ici.

### Le lot 5 n'a rien a corriger

Monter le plafond de dissimulation de 500 ms a 1500 ms ne change aucune mesure, dans aucun scenario.
La raison est simple : une fois le lot 1 en place, **aucun trou de plus de 500 ms n'atteint jamais le
decodeur**. Le lot 5 corrigeait une politique qui ne se declenche plus. **Abandonne, absorbe par le
lot 1.**

---

## Ce que la mesure decouvre, et que la premiere version n'avait pas vu

### Le vrai declencheur des vidages est l'arret franc, pas le deficit lisse

Le deficit du 11 aout a ete traite partout comme une **baisse de cadence**. Le banc montre que la
distinction entre une baisse de cadence et un **arret franc** — le moteur audio qui s'arrete net puis
repart — est la seule qui compte, parce que les deux ont des consequences opposees.

Un arret franc produit **un seul pas egal a toute sa duree**. Au-dela de ~520 ms, ce pas depasse
`MAX_CONCEAL_MICROS` et le decodeur vide sa file
([decode-worker.js:215](../../../src/player/decode-worker.js#L215)) :

| arret franc | pas declare | vidage |
|---|---|---|
| 400 ms | 400 ms | non |
| 500 ms | 480 ms | non |
| **600 ms** | **600 ms** | **oui** |
| 2000 ms | 2000 ms | oui |

Sur une session de 41 minutes contenant des arrets francs, l'effet est massif :

| arrets varies (600 ms/30 s et 2 s/300 s) | coupures | vidages | silence |
|---|---|---|---|
| code actuel | **98** | **89** | **102,4 s** |
| pas borne a 400 ms | **8** | **0** | **4,4 s** |

**C'est le meme correctif que le lot 1.1 de la premiere version, et il faut le faire.** Mais il faut
le faire pour cette raison-la, parce que la raison decide du reglage : ce n'est pas la fenetre de
mesure qu'il faut raccourcir, ni le deficit moyen qu'il faut surveiller, c'est le pas isole qu'il
faut borner.

Le reliquat s'ecoule vite, et c'est ce qui rend la borne sans danger : un arret de 1000 ms est
entierement declare en 3 pas, sur 80 ms de temps reel ; un arret de 5000 ms en 13 pas sur 480 ms.

### La sortie de veille coute 36 vidages, pas 1

La premiere version affirmait qu'une veille produit « un seul pas, superieur a 5 s, et le player vide
une fois ». **Le code ne fait pas cela.** `MAX_STEP_MICROS` borne chaque pas a 5 s
([source-clock.js:61](../../../device/node/source-clock.js#L61)), et le reliquat redeclare a la
trame suivante :

| veille | vidages du decodeur d'affilee |
|---|---|
| 60 s | **12** |
| 180 s | **36** |
| 600 s | **120** |

Chacun est un `sink.clear()` suivi d'un `resetDecoder()` asynchrone, tires en rafale sur une seconde
et demie. C'est un defaut reel, que ni l'analyse ni le plan n'avaient vu, et le correctif est le
meme geste que ci-dessus pris par l'autre bout : **au-dela du seuil de resynchronisation, un seul
saut de toute la duree**, et non un train de pas bornes.

### Le journal du device ne permet pas de savoir si des arrets francs ont eu lieu

C'est la conclusion la plus importante de ce plan, et elle porte sur la mesure, pas sur le code.

Les lignes `sante` sont ecrites toutes les dix secondes. A cette granularite, **une baisse de cadence
et un arret franc sont indistinguables** — et le banc vient de montrer qu'ils valent respectivement
0 et 89 vidages. Sur les 126 intervalles du 11 aout :

| deficit dans un intervalle de 10 s | intervalles |
|---|---|
| median | 160 ms |
| > 500 ms | 31 |
| > 1000 ms | 13 |
| > 2000 ms | 4 |
| pire | **3440 ms** (10:22:15) |

Ces 3440 ms sont soit un creux a 16,4 tr/s pendant dix secondes — sans consequence aujourd'hui — soit
trois arrets francs d'une seconde — trois coupures. **Le journal ne tranche pas, et le journal du
player non plus** : ses 82 releves `REPERE` sont espaces de 30 s, `comble 0 ms` et `sauts 0` partout,
ce qui est attendu puisque le device ne declarait alors aucun trou.

Consequence directe sur l'ordre des travaux : **la mesure qui tranche vient avant tout arbitrage**,
et elle est presque gratuite puisque `SourceClock` calcule deja `lag`.

---

## Ce que le fondu aux bords rapporte, en chiffres

La premiere version proposait un fondu aux bords des trous en le presentant comme inverifiable
autrement qu'a l'oreille. Il se mesure.

Un trou comble par du silence commence et finit sur une discontinuite d'echantillon. Un clic est
exactement cela : de l'energie large bande qui n'etait pas dans le signal. Sur un accord de synthese
sans rien au-dessus de 880 Hz, l'energie au-dessus de 2 kHz mesure donc directement ce que la
discontinuite a fabrique :

| | bord d'entree | bord de sortie |
|---|---|---|
| signal intact, sans trou | −64,3 dB | — |
| **silence nu (code actuel)** | **−27,7 dB** | **−17,1 dB** |
| fondu de 0,5 ms | −28,6 dB | −33,8 dB |
| fondu de 1 ms | −45,6 dB | −47,9 dB |
| **fondu de 2 ms** | **−56,0 dB** | −60,1 dB |
| **fondu de 3 ms** | **−57,1 dB** | **−63,7 dB** |
| fondu de 5 ms | −53,4 dB | −63,6 dB |
| fondu de 8 ms | −51,7 dB | −62,8 dB |

**Le silence nu fabrique 37 dB de bruit large bande a l'entree du trou et 47 dB a la sortie.** Un
fondu en cosinus surelevee de 3 ms en retire 29 et 47 : le bord de sortie redevient indistinguable du
signal intact.

Deux corrections a la premiere version, que ce tableau impose :

- **La bonne duree est 2 a 3 ms, pas 3 a 5.** Au-dela de 3 ms le fondu retire du signal utile et le
  chiffre se degrade. En dessous de 1 ms il ne sert a rien.
- **Le bord de sortie est le plus bruyant des deux**, de 10 dB. La premiere version les traitait
  comme symetriques et placait l'effort sur le bord d'entree, qui demande de conserver une copie de
  la queue du dernier bloc decode. **Le bord de sortie ne demande rien de tel** — il porte sur la tete
  du premier bloc decode apres le trou, deja disponible — et il rapporte davantage. **C'est par lui
  qu'il faut commencer.**

Une verification de l'essai a montre pourquoi cet ordre compte : une dissimulation par prolongation
du signal, ecrite sans fondu de sortie, ramene le bord d'entree a −50 dB et **laisse le bord de
sortie a −15 dB**, soit plus mauvais que le silence nu. La prolongation ne dispense pas du fondu de
sortie ; elle s'ajoute a lui.

---

## Le lot 6 change de nature : libopus sait deja le faire

La premiere version ecartait la dissimulation par le decodeur au motif que « `opus-decoder` fige sa
taille de frame a 120 ms alors qu'un trou ordinaire en vaut 40 : elle rendrait six fois trop
d'echantillons », et concluait qu'il fallait ecrire ~200 lignes d'`Expand`.

**Les deux moities de cet argument sont fausses.**

`_outputChannelSize = 120 * 48` dans `node_modules/opus-decoder/src/OpusDecoder.js` est la **taille
d'allocation du tampon de sortie**, pas une taille de trame imposee :
`opus_frame_decode_float_deinterleaved` rend le nombre d'echantillons reellement decodes. La vraie
raison est plus simple, et plus dirimante : **le paquet n'expose aucun chemin pour un paquet nul.**
`decodeFrame` exige un `Uint8Array` et le refuse autrement. La dissimulation integree de libopus
existe, elle est simplement inatteignable a travers cette API.

Or elle existe et elle est specifiee : `opus_decode` appele avec un pointeur nul et une longueur
nulle produit la dissimulation, `frame_size` devant valoir **exactement** la duree manquante et etre
un multiple de 2,5 ms. C'est ce que NetEq utilise pour Opus. Et `libopus-wasm` — libopus 1.6.1, ESM
d'un seul fichier, navigateur et Node, stereo 48 kHz — l'expose directement sous
`decodePacketLoss(frameSize)`.

Un trou du protocole vaut 40 ms, soit un multiple de 2,5 ms : **la contrainte de libopus tombe
exactement juste.**

Cela ne rend pas le changement gratuit — c'est un changement de decodeur, donc du worker, des
options (`streamCount`, `coupledStreamCount`, `preSkip`), du format rendu (entrelace au lieu de
deinterleave) et de la fixture de test. **Ce lot devient donc une verification, pas un engagement** :
une maquette qui decode la fixture existante et compare, et la decision se prend sur son resultat.
Ce qui est acquis, c'est qu'**ecrire 200 lignes de DSP n'est plus la seule option, et probablement
plus la bonne.**

---

## Les lots, dans l'ordre, avec ce qui les justifie

| | lot | etat | preuve | gain mesure |
|---|---|---|---|---|
| **1** | compteurs : arrets du device, vidages du player | **fait** | journal a 10 s indistinguable | tranche le lot 2 |
| **2** | borner le pas, et sauter en une fois au-dela | **fait** | 98 → 8 coupures | eleve ou nul, jamais negatif |
| **3** | fondu de 3 ms au bord de **sortie** | **fait** | −17,1 → −63,7 dB | eleve |
| **4** | fondu de 3 ms au bord d'entree | **fait** | −27,7 → −57,1 dB | moyen |
| **5** | horloge monotone dans le publisher | **fait** | 1 vidage par saut NTP | faible, gratuit |
| **6** | compteurs du relais | **deja fait** | `health()` les exporte deja | mesure d'abord |
| **7** | maquette `libopus-wasm` | non fait | PLC integree accessible | a decider apres |
| **8** | reception hors du thread principal | non fait | 1 evenement en 41 min | inconnu |

Les lots 1 a 6 sont dans le code. Les lots 7 et 8 restent volontairement dehors : le premier est une
decision a prendre sur le resultat d'une maquette, le second une assurance dont le gain n'est pas
chiffre. Les ecrire maintenant serait exactement ce que ce plan reproche a sa premiere version.

### Lot 1 — savoir ce qu'on corrige

`SourceClock` retient desormais `stalls`, `largestStallMs` et `resyncs`. Un arret compte pour **un**
quelle que soit sa taille : le reliquat s'ecoule sur les trames suivantes et ne doit pas se lire
comme autant d'arrets.

Le device n'ecrit une ligne `arrets` que lorsqu'il y en a eu, et se tait sinon — une ligne par
battement pour dire « rien » noierait celle qui compte :

    10:22:15 arrets    3 arret(s) franc(s) du moteur audio, le pire de 1240 ms

C'est la mesure qui manquait : elle dit en une session si les arrets francs existent sur cette
machine, donc si le lot 2 corrige quelque chose de reel ou seulement une possibilite.

**Cote player**, `discontinuities` comptait ensemble les trous combles et les vidages. Ce sont deux
evenements de nature opposee — l'un est encaisse, l'autre est une coupure — et `flushes` les separe
desormais, de `FrameDecoder.stats()` jusqu'a `PlayerDiagnostics`. C'est ce qui rend la ligne
« vidages du decodeur » du tableau final observable.

> **Reste a faire, et ce n'est pas dans ce depot** : afficher `flushes` dans le journal de la page.
> Le rendu des lignes `REPERE` vit dans le depot du site, pas ici. Le compteur y est disponible, il
> n'est pas encore montre.

### Lot 2 — borner le pas, et assumer le saut

Trois regimes au lieu d'un, et c'est le troisieme qui est nouveau :

| retard non declare | ce qu'on en fait | ce que le player fait |
|---|---|---|
| < 40 ms | rien | — |
| 40 ms a 5 s | pas borne a **400 ms**, le reste part aux trames suivantes | comble, **sans interrompre** |
| ≥ 5 s | **un seul saut de toute la duree**, non borne | vide **une fois** et repart du direct |

Le troisieme regime est ce qui ramene la sortie de veille de 36 vidages a 1. Le code actuel borne
aussi ce cas-la a 5 s, et c'est precisement ce qui fabrique le train.

> **Ce plafond de 400 ms est un contrat entre le device et le player, et rien ne le relie
> aujourd'hui.** `MAX_STEP_MICROS` vit dans le device, `MAX_CONCEAL_MICROS` dans le player ; baisser
> la seconde casserait le premier en silence. A inscrire dans
> [protocol-v1.md](../../protocol-v1.md) : *un trou annonce jusqu'a 500 ms est comble sans
> interruption ; un emetteur qui declare davantage en un pas demande une resynchronisation.*

Le banc montre que ce lot ne coute rien quand les arrets francs n'existent pas : chiffres identiques
au code precedent, a la mesure pres. **C'est une assurance dont la prime est nulle**, ce qui la rend
justifiable meme avant le resultat du lot 1.

`MAX_STEP_MICROS` vaut donc 400 ms et `RESYNC_MICROS` 5 s
([source-clock.js](../../../device/node/source-clock.js)). La section `horloge` du banc fait tourner
le module reel en parallele de son rejeu et signale toute divergence : elle ne se declenche pas.

### Lots 3 et 4 — les fondus

Les deux bords sont faits, et le prix n'est pas le meme.

Le **bord de sortie** rapporte 47 dB et ne coute rien : il porte sur la tete du premier bloc decode
apres un trou, et l'ordre du code s'y prete deja — `fillGap` est appele avant `decode`, donc l'etat
« on sort d'un trou » est connu au bon moment.

Le **bord d'entree** rapporte 29 dB et demande une retenue. Une fois ecrite dans la file partagee, la
fin d'un bloc est hors de portee : le processeur audio peut la lire a tout instant, et la reprendre
serait une course. Le decodeur garde donc les trois dernieres millisecondes de chaque bloc et ne les
ecrit qu'a l'arrivee du suivant — telles quelles si le son continue, en fondu si un trou le precede.

**Le prix est trois millisecondes de latence constante**, sur un seuil qui vaut entre 200 et 2000 ms.
La chronologie ne bouge pas : les memes echantillons sortent dans le meme ordre, decales une fois
d'un bloc de fondu. C'est visible dans les tests, ou tous les comptes d'echantillons ecrits perdent
ces 144 echantillons.

Deux proprietes a ne pas perdre, et un test les tient : **la chronologie reste exacte a l'echantillon
pres** — le trou fait exactement sa duree, en silence exact — et **le meme gain s'applique aux deux
canaux**, sans quoi l'image stereo se deplace.

La forme du fondu est une cosinus surelevee et non une rampe droite : une rampe laisse une
discontinuite de *pente* a chacune de ses extremites, qui s'entend encore, plus faiblement.

### Lot 5 — l'horloge monotone

[publisher.js:72](../../../device/node/publisher.js#L72) prend `Date.now`. Le recul est traite
([source-clock.js:104](../../../device/node/source-clock.js#L104)), **l'avance ne l'est pas** : une
resynchronisation NTP de +1 s est lue comme une seconde de son jamais produite, et comme elle depasse
500 ms elle fait vider la file. Le banc le confirme : un vidage, pour rien.

`process.hrtime.bigint()` supprime la classe entiere, l'horloge de test reste injectable, les tests
ne bougent pas. Trois lignes.

### Lots 6, 7, 8 — ce qui attend une mesure

- **Compteurs du relais — deja la.** Le relais jette au-dela du seuil du profil plus une seconde
  ([listener-hub.ts:40](../../../relay/listener-hub.ts#L40)) — 1400 ms pour `balanced` — alors que le
  regulateur du player peut demander 2000 ms. Ce desalignement n'a pas tire le 11 aout, et la
  premiere version du plan demandait d'exporter les compteurs pour le surveiller. **Ils le sont
  deja** : `listenerFramesDropped` et `listenersClosedSlow` sortent dans `health()`
  ([server.ts:151](../../../relay/server.ts#L151)). Il reste a les relever pendant l'essai, ce qui ne
  demande aucun code.
- **Maquette `libopus-wasm`.** Voir plus haut. A ne lancer qu'apres les fondus, qui sont acquis et
  dont elle ne dispense pas.
- **Reception hors du thread principal.** Le journal du 11 aout contient **un seul** evenement de
  blocage, de 7 s, a 09:48:00. Un evenement en 41 minutes ne demontre ni n'ecarte rien. ~100 lignes,
  faible risque, gain non chiffre : a faire comme une assurance, apres tout ce qui precede.

---

## Reporte, et pourquoi

**Le seuil au centile plutot qu'au pire cas.** NetEq ne dimensionne pas son tampon sur le pire hoquet
vu mais sur un centile eleve — typiquement le 95e — lu dans un histogramme a oubli. C'est la bonne
forme, et elle reste la cible. **Mais l'essayer au banc a produit un contre-exemple instructif** : un
histogramme construit sur l'ecart entre l'heure d'arrivee et le temps audio se remplit de la
**sous-production**, pas de la gigue, et epingle le seuil a son plafond de 2000 ms. C'est exactement
l'erreur de `notePacket` ([buffer-target.ts:140](../../../src/player/buffer-target.ts#L140)), reprise
sous une autre forme.

La lecon a garder : **toute statistique de gigue doit se construire sur la chronologie corrigee par
l'horloge de source, jamais sur l'heure d'arrivee brute.** La pente est la sous-production, la
variation autour de la pente est le reseau. Ce prealable n'est pas ecrit ; tant qu'il ne l'est pas,
le centile n'est pas abordable.

**L'autorite de rattrapage du regulateur.** A 0,5 % la correction vaut 8,6 cents ; il en faudrait 3 a
5 % pour rattraper vraiment, soit presque un demi-ton. dash.js retient 5 % par defaut et va jusqu'a
20 %, et DVB-DASH interdit explicitement le rattrapage par la vitesse **sans correction de hauteur**.
La sortie passe donc par l'etirement a hauteur constante, et l'urgence a baisse : avec l'horloge de
source, la file ne se vide plus toute seule — le banc le montre, niveau median a 523 ms pour un seuil
de 400.

**QUIC/WebTransport.** Le dossier reste ouvert et il reste sans preuve. Rien dans les donnees du
11 aout ne montre de signature de blocage TCP — 194 pentes de remplissage, mediane 800 ms/s, max
1400. **A trancher sur la mesure de gigue ci-dessus**, qui n'existera pas avant que la chronologie
corrigee serve de reference.

---

## Comment on saura que ca marche

Le meme scenario hostile que le 11 aout : VPN Montreal, Meet complet avec partage d'ecran sur la
machine Ableton, boucle Ableton, duree comparable, **sans rien changer a la machine**.

| mesure | 11 aout | banc, code actuel | cible reelle | ou la lire |
|---|---|---|---|---|
| cycles de rebufferisation | 40 | 3 | **< 5** | etats du journal de la page |
| **vidages du decodeur** | non mesure | 0 | **0 hors veille** | `flushes`, nouveau |
| **arrets francs du moteur audio** | **non mesurable** | — | a etablir | ligne `arrets`, nouvelle |
| seuil median | 2000 ms | 400 ms | **< 1000 ms** | `REPERE` |
| seuil au plafond | 89 % | 0 % | **< 10 %** | `REPERE` |
| niveau median / seuil | 49 % | 131 % | **> 85 %** | `REPERE` |
| paquets jetes par le relais | non mesure | — | **0** | `health()` du relais |
| duree comblee | non mesure | 91,5 s | **≈ deficit reel** | `concealedMs` |
| debit de trames du device | 24,08 / 25 | — | **inchange** | ligne `source` |

**La ligne des arrets francs n'a pas de cible, et c'est voulu.** Elle n'est pas un objectif a
atteindre mais la mesure qui dira, pour la premiere fois, laquelle des deux formes de deficit cette
machine produit. Si elle reste vide, le lot 2 n'aura rien corrige et il n'aura rien coute. Si elle se
remplit, elle donne le nombre de coupures que le code precedent aurait produites.

La colonne « banc » n'est pas une prediction de l'essai reel : le banc ignore le reseau, le
navigateur et Opus. **Elle sert a une seule chose — si l'essai reel s'ecarte franchement d'elle, la
difference vient de ce que le banc ignore, et c'est la qu'il faut chercher.** C'est ce qui rend
l'essai lisible au lieu d'etre un simple verdict.

Pour l'ecoute, les fondus ont maintenant une metrique : **l'energie hors bande aux bords d'un trou**,
que le banc mesure en une seconde. Elle ne remplace pas l'oreille, elle lui evite d'arbitrer ce qui
se calcule. Un enregistrement A/B du meme passage reste la verification finale, et la seule chose
promise d'avance est que le nombre de trous ne bougera pas — c'est leur son qui doit changer.

**Si les lignes du haut ne bougent pas alors que la machine continue de decrocher, le diagnostic est
faux et il faut revenir a [l'analyse](2026-08-11-analyse-cours-reel.md) avant d'ecrire une ligne de
plus.**

---

## Sources externes

- NetEq — cible de retard lue au 95e centile d'un histogramme a oubli (facteur 0,983) :
  [webrtcHacks](https://webrtchacks.com/how-webrtcs-neteq-jitter-buffer-provides-smooth-audio/),
  [documentation NetEq, Chromium](https://chromium.googlesource.com/external/webrtc/+/master/modules/audio_coding/neteq/g3doc/index.md)
- dash.js — rattrapage par la vitesse de lecture, 5 % par defaut, 0 a 20 % ; DVB-DASH l'exclut sans
  correction de hauteur :
  [Low Latency Streaming, dash.js](https://dashif.org/dash.js/pages/usage/low-latency.html),
  [issue 2600](https://github.com/Dash-Industry-Forum/dash.js/issues/2600)
- libopus — dissimulation par paquet nul, `frame_size` egal a la duree manquante et multiple de
  2,5 ms : [opus_decoder(3)](https://man.archlinux.org/man/extra/opus/opus_decoder.3.en)
- `libopus-wasm` — `decodePacketLoss(frameSize)`, libopus 1.6.1, ESM navigateur et Node :
  [api-reference](https://libopus-wasm.dev/api-reference.html),
  [depot](https://github.com/openclaw/libopus-wasm)
- WebCodecs — la dissimulation Opus n'est pas exposee par l'API navigateur :
  [w3c/webcodecs issue 558](https://github.com/w3c/webcodecs/issues/558)
