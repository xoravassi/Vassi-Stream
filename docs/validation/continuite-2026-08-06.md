# Continuite du direct — chantier du 2026-08-06 (soiree)

Ce document fait suite a `incident-meet-2026-08-06.md`. Il analyse deux journaux pris le soir du
meme jour, apres les correctifs de la matinee, et decrit ce qui a ete change en consequence.

## 1. Les deux journaux

| | **256k / 400 ms** (appel Meet 20h42–20h49) | **128k / 800 ms** (sans appel) |
|---|---|---|
| Duree observee | 5 min 49 (dont 2 min 26 d'appel) | 28 min 41 |
| REBUFFERING | **46 pendant l'appel**, 2 apres | **27** |
| Manques de donnees | **45 pendant**, 2 apres | 16 |
| Rattrapages brutaux | 1 | **11** |
| Sauts du filet | 0 | 2 |
| Audio comble | **33,3 s en 2 min 26** (≈ 23 % manquant) | 40 ms |

Le premier journal ne fait que confirmer le diagnostic de la matinee : l'appel Meet noie le lien
montant, et a 20:49:23 — fin de l'appel — tout redevient normal en une ligne. L'etape 0 du plan
precedent, couper la camera, reste la bonne reponse et rien n'y a ete ajoute.

**Le second journal est celui qui a tout appris.** Reseau sain, pas d'appel, et pourtant onze
rattrapages brutaux en vingt-neuf minutes, soit un toutes les deux minutes quarante. C'est exactement
ce que le cahier des charges interdit — « sans rattrapage brutal du stream » — et la cause n'etait
pas le reseau.

## 2. Ce que le second journal a montre : le player fabriquait sa propre latence

Niveau du tampon au fil de la seance, seuil 800 ms :

```
20:53:53   972          ← demarre deja 170 ms au-dessus
20:56:24   825
20:56:50   ✗ manque de donnees
20:56:54  1189          ← +364 ms, definitifs
20:59:24  1197  } stable 4 min
21:01:05   ⚡ RATTRAPAGE BRUTAL ×3
21:02:25  1339
21:06:56  1343  } stable 5 min
21:07:59   ✗ manque de donnees
21:08:56  1588
21:09:28   ⚡ RATTRAPAGE BRUTAL ×2
21:14:21   ⚡ filet worklet (reconnexion publisher)
21:19:28   941  } stable 5 min — le seul palier sain du journal
21:19:54   ✗ manque de donnees
21:19:58  1467          ← +526
21:21:57   ⚡ RATTRAPAGE BRUTAL ×2
```

**Chaque manque de donnees remontait le tampon de 150 a 530 ms, et rien ne le redescendait jamais.**

Le mecanisme, verifie dans le code : un blocage TCP vide le tampon, le player passe en `REBUFFERING`
et cesse de consommer, puis TCP relache d'un coup ce qu'il retenait — les reperes montrent des
pointes a 80 et 96 paquets par seconde pour une cadence nominale de 50. Le decodeur ecrit toute la
rafale dans une file que personne ne consomme, et `player-state.ts` reprenait la lecture **au niveau
qu'il trouvait**, pas au niveau vise.

L'echelle etait : seuil 800 → vidage de derive a 1800 → filet du worklet a 2666. Le regime observe,
1300–1590 ms, tombait exactement dans la zone morte ou rien n'agissait — jusqu'a ce qu'une rafale un
peu plus forte franchisse 1800 et coupe le son.

La preuve que la correction est la bonne etait deja dans le journal : apres le saut du filet a
21:14:21, le tampon s'est pose a 940 ms et y est reste cinq minutes.

## 3. Ce qui a ete mesure et ecarte

**La derive d'horloge n'existe pas.** Deux fenetres propres du second journal :

- 21:02:25 → 21:06:56 (271 s) : 1339 → 1343 ms ;
- 21:16:27 → 21:19:28 (181 s) : 941 → 941 ms.

Plat a ±5 ms pres, ce qui borne la derive **sous 30 ppm**, soit plus de sept heures pour consommer
800 ms de marge. L'etape 7 du plan precedent est rayee. Le regulateur de vitesse (§4.2) la corrigerait
de toute facon sans avoir jamais eu a la nommer.

**Le comblement fonctionne, mais ne peut pas empecher un manque.** 33 secondes comblees dans le
premier journal, `sauts 0`, la chronologie tient. Sa limite est structurelle : le trou n'est decouvert
qu'a l'arrivee du paquet *suivant*, donc le tampon s'est deja vide pendant le blocage. Le comblement
empeche l'erosion a long terme — ce pour quoi il a ete ecrit — pas le manque.

## 4. Ce qui a ete change

### 4.1 Ebarber le tampon a la reprise — `pcm-worklet.js`

A chaque passage en lecture, si la file depasse le seuil, l'exces le plus ancien est jete. Cela ne
coute rien : le son vient d'etre interrompu, l'oreille est deja au milieu d'une coupure. Le compteur
est distinct de celui des sauts du filet — `trims` contre `skips` — parce qu'un saut est une anomalie
et qu'un ebarbage est le fonctionnement normal.

C'est le changement au meilleur rapport gain sur effort de tout le chantier : il supprime a lui seul
les onze rattrapages brutaux.

### 4.2 Consommation a vitesse variable — `pcm-worklet.js`

La file se lit avec un pointeur fractionnaire et une interpolation lineaire. Au-dela de 15 % d'ecart
au seuil, la consommation s'ecarte de la vitesse nominale de cinq pour mille au plus,
proportionnellement a l'ecart.

Cinq pour mille valent 8,6 cents de desaccord : inaudible sur un mix, et transitoire. C'est ce que
fait NetEq dans WebRTC et dash.js en basse latence, a ceci pres qu'ils vont jusqu'a dix pour cent sur
de la parole — un mix ne le supporterait pas, et n'en a pas besoin puisque l'ebarbage reprend les
grandes marches a un instant deja rompu.

Les quatre regimes sont strictement emboites, et c'est ce qui les empeche de travailler l'un contre
l'autre :

| niveau vs seuil | mecanisme | audible |
|---|---|---|
| seuil ±15 % | rien | — |
| au-dela, jusqu'a +1000 ms | rampe de vitesse ≤ 5 ‰ | non |
| a la reprise de lecture | ebarbage au seuil | non |
| > seuil + 1000 ms | vidage de derive (existant) | oui |
| > seuil + 2000 ms | filet du worklet (existant) | oui |

### 4.3 Seuil de tampon adaptatif — `buffer-target.ts`

Le profil de latence choisi devient le **plancher** du seuil, comme la qualite choisie etait devenue
un plafond de debit. Au-dessus, c'est le lien qui decide : le seuil vaut le plus long blocage
d'arrivee observe, majore de moitie, borne a deux secondes.

Montee immediate, descente lente — cinq millisecondes par seconde de calme. Se tromper en gardant
trop de tampon coute de la latence ; se tromper en n'en gardant pas assez coute une coupure. Un
manque de donnees fait autorite sur la mesure et releve le seuil d'un quart.

Aucune valeur fixe ne convenait : 46 rebufferisations en 2 min 26 a 400 ms sur un lien noye, 27 en
29 min a 800 ms sur un lien sain.

### 4.4 File d'envoi applicative — `publisher.js`

Le publisher jetait la frame **la plus recente** quand `bufferedAmount` depassait 8192 octets, en
gardant les anciennes. C'est le bon reflexe pour un fichier et le mauvais pour un direct. Le journal
en montre le prix : un trou de 2920 ms d'un seul tenant a 21:14:21.

Une file bornee a 500 ms d'audio, videe par l'ancien, plus une fenetre d'envoi de quatre trames qui
borne ce qui est confie au noyau. Cette fenetre est ce qui donne son sens a la file : Node n'expose
aucun reglage de `SO_SNDBUF`, donc sans elle le retard s'accumulerait dans le noyau, invisible.

Le regulateur de debit y gagne : `oldestPendingMs` commence a croitre des que la fenetre se ferme, la
ou l'ancienne mesure ne voyait rien tant que le tampon du noyau n'etait pas plein.

`CALM_MS` passe de 15 a 10 secondes. Le journal montre 95 secondes pour remonter de 44 a 109 kbit/s
apres une reconnexion, sur un lien qui allait deja tres bien. Ce n'est pas cette duree qui empeche
l'oscillation, c'est `HOLD_MS`.

### 4.5 Trames de 40 ms — protocole v1.1

Voir `docs/protocol-v1.md`. Le gain n'est pas dans le codec mais dans l'encapsulation — environ
44 kbit/s de surcout fixe a 50 paquets par seconde, quel que soit le debit Opus — et dans la cadence,
puisque sur un lien mobile l'ordonnancement se fait par paquet.

**Ce changement casse la compatibilite : device, relais et site se deploient ensemble.**

### 4.6 Diagnostics

- Fenetre de mesure des debits : 1 s → 2 s, et une ligne par mesure au lieu d'une par releve. Les
  deux journaux comptaient 380 lignes « debit recu … au lieu de », presque toutes pendant que tout
  allait bien.
- Le niveau du tampon est note des qu'il bouge de 200 ms, au lieu de n'apparaitre que dans les
  reperes toutes les trente secondes. C'est ce qui a rendu la montee en cliquet invisible pendant des
  semaines.
- Le seuil est note quand il change, avec le blocage qui l'explique.
- Le niveau annonce lors d'un vidage est presente comme « dernier niveau connu » : un journal
  annoncait « ~0 ms en attente » pour un vidage qui, par construction, n'a pu se declencher
  qu'au-dessus du seuil. Le chiffre n'etait pas faux, sa legende l'etait.

## 5. Ce qui n'a pas ete fait

**WebTransport.** Tout le lot 1 traite des symptomes du blocage de tete de ligne de TCP — les rafales
a 96 paquets par seconde en sont la signature exacte. WebTransport est Baseline depuis Safari 26.4
(mars 2026) : datagrammes non fiables sur QUIC, pas de retransmission d'un audio deja perime. C'est
le remede et non le pansement, et pour un flux Opus dont les trous sont deja combles, la non-fiabilite
est le contrat qu'on veut.

Ecarte pour ce chantier sur decision de Vassi. A reprendre en gardant WebSocket en repli : le
protocole VSA1 ne changerait pas, seul le tuyau changerait.

## 6. Ce qui reste a mesurer

Le prochain direct doit repondre a trois questions, et les diagnostics sont faits pour :

1. **Le tampon reste-t-il au seuil ?** La ligne `tampon … ms pour un seuil de … ms` doit osciller
   autour du seuil, sans palier qui monte. Zero rattrapage brutal attendu.
2. **Le seuil adaptatif trouve-t-il la bonne valeur ?** `blocage max` dans les reperes dit pourquoi.
   S'il reste a zero sur un lien sain, le seuil reste au plancher et c'est le resultat voulu.
3. **Que gagnent reellement les trames de 40 ms ?** Comparer les kbit/s recus a debit Opus egal avec
   les journaux du 6 aout : le surcout d'encapsulation doit avoir baisse d'une vingtaine de kbit/s.

---

# Deuxieme passe — journal du 6 aout, 23h18

Premier direct avec le moteur `e35127d`. 10 min 17 s, profil **400 ms / 256 kbit/s** sur 4G,
`SharedArrayBuffer` absent (mode port de messages). La combinaison la plus dure du systeme, sur un
lien franchement mauvais : dix creux reels a 10-18 paquets par seconde, 1596 ms comblees, et trois
episodes ou le poste Ableton a perdu de l'audio chez lui.

## Ce que le correctif a rendu

| | 128k/800 ms, 29 min | 23h18, 256k/400 ms, 10 min |
|---|---:|---:|
| Rattrapages brutaux | 11 | **0** |
| Montee en cliquet | +150 a +530 ms par manque | **aucune** |
| Manques de donnees | 0,55/min | 0,39/min |
| Lignes « debit recu… » | 139 | 10 |

Cinq ebarbages, cinq retours au seuil. Le regulateur de vitesse travaille en continu et
visiblement — `-5000 ppm` quand la file se vide, `+5000 ppm` quand elle deborde. Les trames de 40 ms
rendent ce qui etait calcule : **261 kbit/s recus pour 256 kbit/s d'Opus**, soit les 5,6 kbit/s
d'en-tetes VSA1 attendus a 25 paquets par seconde, contre 11,2 a cinquante.

## Ce qu'il a revele, et qui est corrige ici

### Le seuil descendait plus vite que la lecture ne pouvait suivre

```
23:23:38  tampon 2023  seuil 2000   ecart   +23
23:24:38  tampon 2013  seuil 1550   ecart  +463
23:25:08  tampon 1977  seuil 1300   ecart  +677
23:26:39  tampon 1641  seuil  900   ecart  +741
```

Le seuil descend de 6,1 ms/s mesures, le tampon de 2,1 ms/s. L'ecart grandit au lieu de se refermer.

L'arithmetique le disait d'avance : `DECAY_MS_PER_SECOND` (5) x `TARGET_SAFETY` (1,5) fait descendre
le seuil de **7,5 ms/s**, alors que `RATE_MAX` (0,005) ne permet de resorber un exces qu'a **5 ms/s**
au maximum absolu — et bien moins tant que l'ecart reste dans la partie proportionnelle de la pente.
Le seuil fuyait plus vite que la lecture ne courait, et affichait 900 ms quand l'auditeur en
entendait 1641.

**Correctif :** la decroissance est suspendue tant que la file est au-dessus du seuil, la comparaison
se faisant a la zone morte du regulateur de vitesse. Le seuil descend alors au rythme que la lecture
tient reellement, par construction. La porte ne ferme que par le haut, et l'horloge avance meme
fermee — garder le temps pour plus tard rendrait la marche d'un seul coup a la reouverture.

Deux autres pistes ont ete ecartees. Baisser `DECAY_MS_PER_SECOND` ne suffit pas : a 2 ms/s le seuil
descendrait encore de 3 ms/s, et l'equilibre s'etablirait a un ecart de 45 % du seuil, soit 450 ms a
un seuil de 1000. Monter `RATE_MAX` a 1 % ferait 17 cents de desaccord, audible sur un son tenu.

### La hierarchie des mecanismes s'etait inversee

Le vidage de derive se declenche a `seuil + 1000`, le filet du worklet a
`min(seuil + 2000, NET_CEILING_MAX_MS)`. Avec quatre secondes de file, cette borne valait 2666 ms :
**au-dessus d'un seuil de 1666 ms, le vidage passait au-dessus du filet et devenait inatteignable.**
Le journal le confirme — trois sauts du filet, zero vidage, les deux episodes a seuil 2000.

Le hasard a bien fait les choses, ce qui merite d'etre note : le filet est en realite le plus doux
des deux. Il jette l'ancien et garde le seuil, la lecture continue ; le vidage jette tout *et* impose
une rebufferisation, donc un silence. Mais la marge se retrecissait quand elle aurait du grandir : a
seuil 800 il y avait 1866 ms entre le seuil et le filet, a seuil 2000 il n'en restait que 666.

**Correctif :** la file passe de quatre a six secondes, ce qui porte le plafond du filet a 4000 ms.
L'ordre tient alors pour tout seuil jusqu'a 3000 ms, donc pour tout ce que `MAX_TARGET_MS` autorise.
Cout : 2,3 Mo de memoire au lieu de 1,5.

Ce qui a declenche ces sauts merite d'etre garde en tete : a 23:22:30 le decodeur a ecrit **734 ms de
silence d'un seul coup** pour combler un trou, par-dessus une rafale TCP. La file a franchi son
plafond entre deux releves espaces de quarante millisecondes.

### « le device a baissé son débit à 7 kbit/s » : ce n'etait pas le regulateur

Les deux premieres mesures du journal annoncent 6 a 7 kbit/s avec un flux complet a 25 paquets par
seconde. C'est **35 octets par paquet**, a peine plus que les 28 octets d'en-tete.

Ce n'est pas un defaut de mesure : c'est Opus qui n'avait presque rien a encoder. Le master d'Ableton
etait silencieux pendant les six premieres secondes, et le VBR d'Opus reduit une trame de silence a
quelques octets. A 23:18:37 le flux est a 261 kbit/s. Le plancher du regulateur du device est a
32 kbit/s : un flux complet au-dessous ne peut donc structurellement pas venir de lui.

**Correctif :** sous 30 kbit/s, le journal ecrit « flux quasi silencieux » au lieu d'attribuer la
baisse au regulateur. Depuis le poste d'ecoute, rien ne permet de distinguer les deux autrement, et
affirmer une cause qu'on ne peut pas etablir est pire que ne rien dire.

### Deux defauts de journal

**65 lignes « seuil abaisse » en dix minutes.** La decroissance franchit un pas de 50 ms toutes les
sept secondes environ, et chaque franchissement ecrivait une ligne. Les baisses ne sont desormais
notees qu'au franchissement d'une bande de 200 ms ; les hausses le restent toujours, ce sont elles
qui portent l'information.

**« plus long blocage observe 2000 ms »** alors qu'aucun blocage de deux secondes n'avait eu lieu :
la valeur melange le plus long blocage mesure et ce qu'un manque de donnees a impose apres coup, puis
bute sur `MAX_TARGET_MS`. Elle s'appelle maintenant **besoin estime**.

## Ce qui reste ouvert

Les 1596 ms comblees de cette seance portent toutes la mention `l'encodeur ou le pont du poste
Ableton a perdu du son`. **Ce n'est pas le reseau : c'est le poste Ableton qui perd de l'audio chez
lui**, file de l'external pleine ou pont loopback en retard. C'est la seule cause de perte reelle du
direct, et l'etape 1 du plan de la matinee — afficher `audio_queue.overflow_count`,
`frame_sender.dropped_count` et `publisher.stats.framesDropped` dans le device — reste a faire. Sans
ces trois chiffres, on ne peut pas departager le processeur du pont.
