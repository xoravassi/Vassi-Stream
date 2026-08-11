# Incident du 2026-08-06 — le direct s'effondre pendant un appel Google Meet

Ce document analyse un direct dégradé, en donne la cause mesurée, et fixe le plan de travail qui en
découle. Il est écrit après vérification du code et interrogation du relais en service.

## 1. Ce qui s'est passé

Direct de longue durée. Vers 12:56 (heure du journal), un appel Google Meet avec caméra et partage
d'écran s'ouvre entre le poste d'écoute et le poste Ableton. Les deux postes sont sur la même box
4G. Le poste Ableton monte en charge processeur.

Relevés du journal de l'auditeur, sur 3 min 20 s :

| Mesure | Valeur | Attendu |
|---|---|---|
| Débit reçu | 1 à 35 paquets/s, moyenne ≈ 17 | 50 |
| Transitions REBUFFERING | 51 | 0 ou 1 |
| Manques de données | ~73 | 0 |
| Discontinuités (somme des `+N`) | ~59 | 0 |
| `sauts` du filet, `overflows` de la file | 0 | 0 |

Environ **deux tiers de l'audio n'est jamais arrivé**. Ce n'est pas une dérive : `sauts` et
`overflows` restent à zéro, la file n'a jamais été trop pleine, elle a été constamment vide.

## 2. La cause, mesurée

Le transport est WebSocket, donc TCP. **TCP ne perd pas de paquets**, il les retarde. Tout audio
manquant a donc été jeté volontairement par un composant du système. Il fallait savoir lequel.

La réponse était dans le relais, qui compte déjà ce qu'il jette (`relay/server.ts:150-155`).
Interrogé le jour même, `uptimeSeconds` couvrant l'incident et `lastPacketAgeMs` correspondant à
l'arrêt du direct :

```json
{ "framesRelayed": 785391, "listenerFramesDropped": 0,
  "listenersClosedSlow": 0, "listenersClosedSilent": 0 }
```

**Le relais n'a jamais jeté une seule trame, ni fermé un seul auditeur.** Trois conclusions
immédiates :

1. **Le relais est hors de cause.** Le seuil `DROP_BYTES` n'a jamais été atteint.
2. **Le poste d'écoute est hors de cause.** Si son navigateur avait tardé à vider sa socket, la
   file d'envoi du relais aurait grossi et `listenerFramesDropped` serait non nul. Il vaut zéro.
3. **Le relais n'a reçu que ~17 trames/s.** Il rediffuse tout ce qu'il reçoit, et l'auditeur en a
   reçu 17 : le publisher n'en a donc envoyé que 17.

**Toute la perte est sur le poste Ableton.**

### L'hypothèse de l'onglet caché est écartée

L'onglet était en arrière-plan depuis 60 minutes. Ce n'est pas la cause, et deux preuves
indépendantes le disent :

- `listenerFramesDropped: 0` prouve que le navigateur vidait sa socket assez vite ;
- la cadence de la sonde était normale. Les lignes repliées du journal — `(x4 sur 0.7 s)`,
  `(x5 sur 1.0 s)` — comptent des relevés identiques successifs. Quatre relevés en 0,7 s font une
  cadence de 175 à 250 ms, celle du panneau ouvert (`PERIODE_OUVERT_MS = 250`). Les minuteurs
  n'étaient pas ralentis.

Le retour du débit à 49 paquets/s douze secondes après le retour au premier plan coïncide avec la
fin de l'appel Meet et l'arrêt du direct, à 13:00:00. C'est une coïncidence, pas une causalité.

### Reste à départager : le lien montant ou le processeur

Cinq endroits jettent de l'audio sur le poste Ableton, et le journal de l'auditeur ne les distingue
pas — ils produisent tous le même bit de discontinuité.

| # | Où | Code | Ce qui le déclenche |
|---|---|---|---|
| 1 | File audio de l'external (1000 ms) | `audio_queue.cpp:125-138`, `vassi.encoder.cpp:9` | le thread d'encodage ne consomme plus assez vite : **processeur saturé** |
| 2 | Pont loopback vers Node | `frame_sender.cpp:196-201` | `send()` échoue → **la connexion se ferme**, reconnexion 250 ms plus tard au plus tôt |
| 3 | Publisher hors LIVE | `publisher.js:247-251` | pendant `CONNECTING` / `RECONNECTING` |
| 4 | Publisher congestionné | `publisher.js:255` | `bufferedAmount > 8192` : **lien montant saturé** |
| 5 | Trame non encodable | `publisher.js:264` | payload hors bornes |

Le point 3 est écarté pour cet incident : aucune ligne « nouveau direct annoncé » n'apparaît dans
le journal pendant les 3 min 20 s, donc aucune reconnexion publisher n'a eu lieu.

**Le point 4 est le plus probable.** Le motif observé le désigne : ~59 épisodes de discontinuité
pour ~33 trames perdues par seconde, soit environ 2,2 s d'audio perdu par épisode, séparés par
environ une seconde de flux correct. C'est la signature d'un tampon d'envoi noyau qui se remplit,
bloque tout, puis se vide — l'oscillation classique d'un lien montant saturé. Une saturation
processeur produirait un motif différent : la file de l'external tient 1000 ms et se vide dès que
le processeur se libère.

Ordres de grandeur du lien montant du poste Ableton pendant l'appel :

| Flux | Débit montant |
|---|---|
| Meet, caméra 720p | 1 à 1,5 Mbit/s |
| Meet, partage d'écran | 1 à 2,5 Mbit/s |
| Vassi Stream, Studio 256 k, encapsulation comprise | ~300 kbit/s |

Le seuil de rejet du publisher vaut 8192 octets, soit **242 ms d'audio en Studio** (640 octets de
payload + 28 d'en-tête VSA1 + 8 d'en-tête WebSocket masqué = 676 octets par trame). Dès que le lien
hoquette plus de 242 ms — ce qui est ordinaire en 4G — **toutes** les trames suivantes sont jetées
jusqu'à ce que le tampon se vide.

**Ce qui manque pour trancher définitivement :** les compteurs du device. Ils sont tous déjà
calculés — `audio_queue.overflow_count`, `worker.lost_frame_count`, `frame_sender.dropped_count`,
`publisher.stats.framesDropped` — et **aucun n'est affiché**. C'est le premier travail à faire.

### Mesure complémentaire tirée du relais

`bytesRelayed / framesRelayed = 461,7` octets par trame, toutes sessions confondues. Moins les 28
octets d'en-tête, cela fait un payload moyen de 434 octets, soit **173 kbit/s d'Opus réel**. Le VBR
d'Opus livre donc nettement moins que le débit nominal annoncé. Ce chiffre est à garder en tête :
il change le calcul de tout réglage de débit.

## 3. Pourquoi le player a transformé une perte en effondrement

La perte de deux tiers de l'audio est la cause. Le player a fait le reste, et c'est un défaut de
conception indépendant du réseau.

`src/player/decode-worker.js:167-174` :

```js
if (marked || gap) {
  this.sink.clear();          // jette tout le son déjà décodé
  await this.resetDecoder();
  this.discontinuities += 1;
  this.notify({ type: "discontinuity", ... });
}
```

**Ce vidage s'exécute quel que soit l'état du player.** La machine d'états, elle, ne réagit que
depuis `PLAYING` (`player-state.ts:279-284`). Donc **pendant une rebufférisation, chaque nouvelle
discontinuité efface le tampon que la rebufférisation est en train de reconstruire.**

C'est le mécanisme de l'incident. À 17 paquets/s il arrive 340 ms d'audio par seconde de temps
réel : remplir 400 ms demande plus d'une seconde sans le moindre trou. Un trou toutes les 3,4 s
laisse à peine la place. Le player passe son temps à reconstruire un tampon qu'on lui efface.

Que la file ait bien atteint 400 ms 51 fois est démontrable : toute transition vers `REBUFFERING`
part obligatoirement de `PLAYING` (`player-state.ts:225`, `:270`, `:280`), et `PLAYING` exige
`availableMs >= targetBufferMs` (`:239`). Les 51 transitions sont 51 remplissages réussis, aussitôt
détruits.

### Le vidage n'est jamais justifié dans ce cas

Vider la file après une discontinuité ne fait pas avancer la lecture : le consommateur trouve la
file vide et écrit du silence (`pcm-worklet.js:226-229`). La latence n'est pas réduite, elle est
payée en silence pendant la rebufférisation, puis retrouve exactement sa valeur d'avant. Le vidage
coûte le son déjà décodé et ne rend rien.

Le seul cas où la file contient réellement du son périmé est la dérive — le thread audio s'est
arrêté et la file a grossi sans être consommée — et ce cas est **déjà traité séparément**
(`player-state.ts:215`). Le vidage sur discontinuité est redondant avec lui et nuisible seul.

### Mais le supprimer sans rien mettre à la place crée une fuite

Le player n'a **aucune notion de continuité temporelle** : le champ `timestampMicros` de l'en-tête
est lu par `inspectAudioPacket` et n'est utilisé nulle part dans `src/player/`. La file PCM est un
sac d'échantillons sans horloge.

Conséquence : si l'on cesse de vider **sans combler la durée manquante**, le trou disparaît de la
chronologie et le niveau du tampon baisse définitivement de la durée du trou. Production et
consommation étant toutes deux à 48 kHz, **rien ne le fait jamais remonter**. Après cinq trous de
100 ms, il ne reste plus de marge anti-gigue et le moindre soubresaut produit un manque.

Le correctif complet est donc en deux parties, indissociables :

1. ne plus vider ;
2. **combler le trou avec exactement sa durée**, connue sans ambiguïté par l'écart de numéros de
   séquence × 20 ms.

C'est le modèle standard de RTP et de NetEq. C'est aussi ce que `docs/protocol-v1.md:250` interdit
explicitement aujourd'hui — cohérent avec le vidage, incohérent sans lui. Ce document doit changer.

### Et les deux causes de discontinuité demandent des traitements différents

| Cas | Ce qu'a fait l'encodeur | Ce que doit faire le décodeur |
|---|---|---|
| `flag` — perte locale sur le poste Ableton | `OPUS_RESET_STATE` (`audio_encoder.cpp:194`) | remise à zéro cohérente |
| `sequence_gap` — abandon par le relais | **rien**, il a gardé son état | **ne pas remettre à zéro** : cela détruirait un état encore aligné sur l'encodeur et allongerait l'artefact |

`decode-worker.js:167` traite les deux identiquement. La distinction existe pourtant déjà, ligne
173, et elle est jetée par `decode-worker-host.ts:150-152`, qui appelle `onDiscontinuity()` sans la
raison.

## 4. Trois autres défauts trouvés en vérifiant

**Le contexte audio demande le plus gros tampon possible.** `browser-audio.ts:219` :

```ts
new AudioContext({ sampleRate: PCM_SAMPLE_RATE, latencyHint: "playback" })
```

`"playback"` demande au navigateur de **maximiser le tampon de sortie pour économiser la batterie**.
La documentation MDN donne, pour son propre exemple, `baseLatency ≈ 0,00 s` en `"interactive"` et
`≈ 0,15 s` en `"playback"`. Sur un projet dont le profil le plus rapide vaut 200 ms, ce seul réglage
peut ajouter autant que le tampon entier. `context.outputLatency` et `context.baseLatency` existent
et ne sont lus nulle part : la latence réelle du système n'a jamais été mesurée.

**Le diagnostic ralentit exactement quand l'incident arrive.** `decode-worker.js:300-306` envoie les
compteurs **tous les 50 paquets reçus**, pas sur une minuterie. À 50 paquets/s cela fait bien une
fois par seconde ; à 17 paquets/s, une fois toutes les 2,9 s. Les lignes de journal se raréfient au
pire moment. Les deltas `+N` restent justes, mais la résolution temporelle s'effondre.

**Les deux seuils de rejet sont aveugles au débit.** 8192 octets valent 242 ms en Studio et 460 ms
en Stable ; 65536 octets valent 1,95 s en Studio et 3,9 s en Stable. Et le seuil du relais (1,95 s)
est plus haut que la tolérance du player lui-même (1,4 s, soit `target + LATE_MARGIN_MS`) : une
rafale libérée par le relais après congestion pousse mécaniquement le player au-dessus de son propre
seuil de vidage. Les deux mécanismes travaillent l'un contre l'autre.

## 5. Ce qui est écarté, et pourquoi

**Le FEC en bande d'Opus** (`OPUS_SET_INBAND_FEC`) n'existe qu'en mode SILK, donc pour de la parole à
bas débit. À 128–256 kbit/s en stéréo 48 kHz, libopus est en CELT et le FEC est court-circuité.
Vérifié dans la source vendue, `opus-1.5.2/src/opus_encoder.c:814`. De toute façon TCP ne perd pas
de paquets : le FEC répond à un problème que ce système n'a pas.

**Le PLC neuronal d'Opus 1.5** (Deep PLC, DRED) ne s'applique qu'à la parole mono. Sans objet ici.

**Le remplacement de la bibliothèque de décodage** n'est pas nécessaire pour combler un trou :
`opus-decoder@0.7.11` fait bien du PLC — vérifié en l'exécutant, `decodeFrame(new Uint8Array(0))`
rend 5760 échantillons — mais toujours par blocs de 120 ms, sa taille de trame étant figée à la
construction (`OpusDecoder.js:233`, `_outputChannelSize = 120 * 48`). Pour un trou de 20 ms c'est
faux. Le silence de durée exacte est un premier remplissage correct et ne coûte rien.
`libopus-wasm`, qui expose `maxFrameSize` par appel et accepte `null` comme paquet perdu, ne se
justifie qu'après avoir mesuré que le silence s'entend trop.

**WebTransport** est devenu Baseline en mars 2026 (Safari 26.4) : datagrammes non fiables, pas de
blocage de tête de ligne. C'est la bonne réponse à long terme, mais elle demande HTTP/3 chez
l'hébergeur et une réécriture du transport des trois côtés. À noter dans la Roadmap v2.

## 6. Plan de travail

### La priorité, fixée par Vassi le 2026-08-06

> « Le plus important c'est la continuité du stream, donc on peut descendre assez bas par moment, du
> moment que ça remonte sans artefact audio, sans coupure, sans rattrapage brutal du stream. »

Cette phrase tranche tous les arbitrages de ce plan, et elle en réordonne deux :

- **la continuité passe avant la qualité.** Le plancher de débit descend à 32 kbit/s au lieu des
  96 initialement proposés, et le débit varie de façon continue et lissée plutôt que par crans ;
- **« sans rattrapage brutal » est une exigence en soi.** Elle vise trois mécanismes existants qui
  sautent tous du son sans prévenir : le vidage sur discontinuité (étape 3), le vidage sur dérive
  (`player-state.ts:215`) et le filet du processeur audio (`pcm-worklet.js:333`, compteur `skips`).
  Le premier disparaît ; les deux autres restent des filets de sécurité, mais ils ne doivent plus
  être le régime normal.

### Étape 0 — Ce qui n'attend aucune ligne de code

Ces quatre gestes ont plus d'effet immédiat que tout le reste du plan :

- **Couper la caméra du poste Ableton pendant un direct.** Elle libère 1 à 2 Mbit/s de lien montant,
  soit cinq à dix fois le flux audio entier à n'importe quel réglage.
- Profil **Stable 128 kbit/s** et latence **Stable 800 ms** pendant un appel.
- Meet sur une autre machine que celle qui streame, si c'est possible.
- Ethernet plutôt que Wi-Fi sur le poste Ableton.

Et un réflexe : **au moindre trou signalé par un auditeur, interroger `/health` du relais.**
`listenerFramesDropped` distingue en une requête un problème de réception chez l'auditeur d'un
problème entre Ableton et le relais. Le code le dit déjà en commentaire ; l'habitude manquait.

### Étape 1 — Rendre visible ce qui est déjà compté

Sans cela, tout ce qui suit est de la devinette. Aucun compteur n'est à créer, seulement à afficher.

- **Dans le device :** `audio_queue.overflow_count` (processeur saturé), `frame_sender.dropped_count`
  (pont coupé), `publisher.stats.framesDropped` (lien montant saturé), et `bufferedAmount`. Ces
  quatre chiffres départagent le processeur du lien montant en un coup d'œil, ce que l'incident n'a
  pas permis de faire.
- **Dans le journal de l'auditeur :** porter la raison de la discontinuité (`flag` / `sequence_gap`)
  jusqu'à la ligne, et compter le **nombre exact de paquets manquants** depuis l'écart de séquence.
- **Cadence de rapport du worker sur minuterie**, pas tous les 50 paquets.
- **Relever `context.outputLatency` et `context.baseLatency`** dans les diagnostics.
- Ajouter `framesSent` à `/health` — le seul compteur du relais réellement absent.

*Fichiers :* `externals/vassi.encoder~/source/vassi.encoder.cpp`, `device/node/vassi-stream-device.js`,
`scripts/device-patcher/`, `src/player/decode-worker.js`, `decode-worker-host.ts`, `audio-player.ts`,
`player-diagnostics.ts`, `browser-audio.ts`, `relay/server.ts`, et le panneau du site.
*Risque :* faible. `decode-worker.js` est dans le chemin de décodage, il reste couvert par ses tests.

### Étape 2 — Vérifier `latencyHint`

Une ligne, mesurable en une minute avec l'étape 1 : relever `outputLatency` en `"playback"`, puis en
`"interactive"`, sur le navigateur du professeur. Si l'écart est de l'ordre de 100 ms, c'est le
meilleur gain de latence du projet, gratuit. Décider ensuite, chiffres en main.

*Risque :* faible, mais à mesurer avant de changer : `"interactive"` réveille le thread audio plus
souvent, ce qui coûte du processeur sur un portable.

### Étape 3 — Supprimer la falaise du player

Le changement au meilleur rapport gain sur effort. Il vaut quelle que soit la cause réseau, et il
transforme un silence total en audio dégradé mais continu.

- **Trou de séquence :** ni vidage, ni remise à zéro du décodeur.
- **Bit de discontinuité :** remise à zéro du décodeur (l'encodeur a fait la même), sans vidage.
- **Dans les deux cas, combler la durée exacte du trou** — silence d'abord, dissimulation Opus plus
  tard si la mesure le justifie — pour que le tampon ne s'érode pas.
- **Au-delà d'un plafond** (de l'ordre de 500 ms, à fixer par la mesure), garder le comportement
  actuel : vidage et rebufférisation. Un trou d'une seconde n'a pas à être comblé.
- Ne plus vider depuis le worker quand le player n'est pas en `PLAYING` : c'est la ligne précise qui
  a détruit les 51 remplissages.

*Fichiers :* `src/player/decode-worker.js`, `player-state.ts`, `docs/protocol-v1.md:248-250`,
`docs/player-web.md:192-209`.
*Risque :* moyen. Change un comportement normatif du protocole, donc le document change avec le
code, avec sa raison écrite.

### Étape 4 — Le publisher cesse de produire ce que le lien ne peut pas porter

C'est le correctif de la cause la plus probable de l'incident. Il se fait en deux morceaux.

**4a. Une file d'envoi applicative, bornée en temps.** Aujourd'hui la file vit dans le noyau et dans
`ws`, où elle est ingérable : quand elle déborde, `publisher.js:255` jette la trame **la plus
récente** et garde les anciennes, alors que dans un direct ce sont les anciennes qui ne valent plus
rien. Une petite file dans `publisher.js`, bornée en millisecondes d'audio et vidée par l'ancien,
inverse cela. C'est ce que fait OBS avec sa file RTMP (`drop_threshold_ms`).

**4b. Le débit s'adapte au lien.** La qualité choisie par Vassi devient le **plafond** et non une
valeur figée ; le débit descend librement entre ce plafond et 32 kbit/s.

**Le débit varie de façon continue, pas par crans.** Vassi a fixé la priorité : la continuité passe
avant la qualité, et le débit peut descendre bas « du moment que ça remonte sans artefact ». Une
grille discrète — 256, puis 192, puis 128 — fait entendre chaque changement comme une marche. Opus
accepte n'importe quelle valeur entière : le régulateur produit donc un débit continu, et chaque
variation est en outre **lissée sur environ une seconde**, par petits pas de quelques pour cent
appliqués à chaque trame. Une rampe de 5 % par 100 ms est inaudible ; un saut de 256 à 128 ne l'est
pas.

Cinq points à respecter, tous vérifiés :

- **Le signal est un temps, pas un nombre d'octets.** `ws.bufferedAmount` vaut
  `_socket._writableState.length + _sender._bufferedBytes` (`ws/lib/websocket.js:120-124`), et avec
  `perMessageDeflate: false` le second terme est toujours nul. Il ne reste que les octets refusés
  par le noyau : un signal binaire, nul tant que le tampon noyau n'est pas plein, avec un temps mort
  égal à son temps de vidange. Le bon signal est **l'âge de la plus vieille trame encore dans la
  file applicative** : une durée, comparable directement au budget de latence.
- **Descente multiplicative, remontée additive, et un état de maintien** après chaque changement
  pendant lequel aucune décision n'est prise. C'est cet état, plus que l'hystérésis, qui empêche
  l'oscillation. Une rafale de retransmissions de 200 à 500 ms est ordinaire en 4G : le pas minimal
  en descente doit être de l'ordre de 2 s, pas de 200 ms.
- **Plancher à 32 kbit/s, et trois réglages d'encodeur qui le rendent sûr.** Les seuils réels de
  libopus, lus dans la source vendue, sont beaucoup plus bas qu'on ne le croit couramment. Pour du
  stéréo, `equiv_rate` valant ici le débit lui-même (`compute_equiv_rate`, `opus_encoder.c:898` :
  trames de 20 ms, VBR, complexité 9 ⇒ correction inférieure à 1 %) :

  | Décision de libopus | Seuil | Source |
  |---|---:|---|
  | bande pleine → superwideband | ~12,3 kbit/s | `stereo_music_bandwidth_thresholds`, `:163` |
  | **stéréo → mono** | **~17,3 kbit/s** | `stereo_music_threshold`, `:171` et `:1311` |
  | largeur stéréo réduite en dessous de | 32 kbit/s | `:2142-2147` |

  La vraie falaise n'est donc pas la bande passante, c'est **la bascule en mono**. Sur un mix, elle
  s'entend immédiatement et brutalement — exactement ce que le cahier des charges interdit.

  Trois réglages la suppriment définitivement, et doivent être posés avant tout débit adaptatif :

  - `OPUS_SET_FORCE_CHANNELS(2)` — le stéréo ne peut plus basculer en mono, quel que soit le débit
    (`:1303`, `st->stream_channels = st->force_channels` court-circuite la décision) ;
  - `OPUS_SET_SIGNAL(OPUS_SIGNAL_MUSIC)` — sans lui, `voice_est` vaut 48 par défaut
    (`:1289`, branche `else` de `OPUS_APPLICATION_AUDIO`) et libopus garde ouverte la possibilité de
    basculer en mode SILK sur un passage de voix seule. Un mix n'est jamais de la parole ;
  - `OPUS_SET_VBR_CONSTRAINT(1)` — le VBR contraint borne la variation par trame, ce qui donne un
    débit plus régulier sur un lien saturé, sans le coût de 8 % du CBR (`compute_equiv_rate`, `:906`).

  Le plancher de 32 kbit/s garde alors la bande pleine et la largeur stéréo intactes, avec une marge
  de presque deux fois sur la bascule mono.
- **Le débit courant s'affiche**, dans le device et dans la page. Un réglage qui bouge tout seul
  sans se voir est un piège.
- **Cinq pièges d'implémentation**, tous vérifiés dans le code :
  1. `class_addmethod` s'exécute sur le thread message de Max, l'encodeur vit sur le thread worker
     (`encoder_worker.cpp:85-139`) : il faut un atomique lu dans la boucle, libopus n'étant pas
     réentrant sur un état d'encodeur.
  2. `audio_encoder.cpp:197` réapplique `encoder->bitrate` après **chaque** `OPUS_RESET_STATE` : si
     le changement n'écrit pas ce champ, la première discontinuité venue rétablit l'ancien débit,
     sans erreur et sans trace.
  3. `audio_encoder_bitrate_is_valid` (`:45-49`) n'accepte que trois valeurs, et
     `protocol.ALLOWED_BITRATES` non plus. 96 kbit/s est bloqué par ces gardes.
  4. `encoder_worker_configure` refuse toute reconfiguration tant que le thread tourne
     (`encoder_worker.cpp:225`) : le chemin `quality` existant ne peut structurellement pas servir
     en direct.
  5. `OPUS_SET_BITRATE` lui-même est inoffensif — simple affectation bornée,
     `opus_encoder.c:2572-2585`, aucune réallocation, aucune remise à zéro.

**Le câblage Max existe déjà** : `NODE_MESSAGES[2] === "encoder"` et
`connect("node-route", 2, "encoder", 0)` (`scripts/device-patcher/wiring.js:28`, `:151`). Un
`send("encoder", "bitrate", n)` arrive directement dans l'external.

**Protocole :** le champ `bitrate` de `stream_start` devient « le plafond choisi ». Le relais ne le
vérifie qu'à l'ouverture, les paquets audio ne le portent pas : rien ne casse. À écrire dans
`docs/protocol-v1.md`.

*Risque :* moyen. Touche l'objet natif. Le régulateur se teste sous Node comme fonction pure.

### Étape 5 — Marge de processeur sur le poste Ableton

**Ableton tourne à 44,1 kHz** (confirmé par Vassi le 2026-08-06). Le rééchantillonneur SpeexDSP est
donc actif à chaque trame (`audio_encoder.cpp:132`), réglé à `RESAMPLER_QUALITY = 10`, le maximum
(`:17`).

**Ne pas passer Ableton à 48 kHz pour autant.** Le raisonnement paraît séduisant — à 48 kHz le
rééchantillonneur disparaît entièrement du chemin — mais il coûte plus qu'il ne rapporte : tout le
graphe DSP de Live tournerait 8,8 % plus vite, donc 8,8 % plus cher, pour supprimer un seul
rééchantillonnage stéréo. Sur une machine déjà saturée par Meet, c'est le mauvais sens. La fréquence
d'échantillonnage est de plus un réglage du périphérique audio dans Live, pas du projet : le changer
s'applique à tous les projets ouverts ensuite, et certains greffons se comportent différemment selon
la fréquence.

Passer à 48 kHz reste un choix défendable **pour d'autres raisons** — c'est la fréquence native
d'Opus, du web et de la vidéo, donc plus aucune conversion nulle part dans la chaîne de diffusion.
Si Vassi veut le faire, c'est pour de nouveaux projets, jamais au milieu d'un mix en cours.

Le bon levier est de notre côté, pas du sien :

1. **Baisser `RESAMPLER_QUALITY`.** De 10 à 5, sur du 44,1 → 48 kHz d'un mix qui part ensuite dans
   un codec avec perte, la différence est inaudible et le coût baisse nettement. À mesurer avec
   `npm run test:encoder`, qui existe déjà.
2. **Ensuite `OPUS_SET_COMPLEXITY`.** La valeur par défaut de la version vendue est 9
   (`opus_encoder.c:244`) ; 5 à 7 est l'usage temps réel. Le gain est de l'ordre du pourcent d'un
   cœur : réel, mais négligeable devant l'encodage vidéo de Meet.

*Risque :* faible.

### Étape 6 — Faire remonter une information de l'auditeur

Tant que rien ne remonte, le publisher régule sur son seul lien montant et ne sait rien du chemin
relais → auditeur. Avec plusieurs auditeurs, le problème devient structurel : un seul mauvais lien
ferait baisser la qualité pour tous, et le relais ne peut rien faire d'autre que jeter, puisqu'il ne
décode jamais.

C'est un protocole v1.1 : aujourd'hui un auditeur qui envoie quoi que ce soit est fermé avec le code
1003 (`listener-hub.ts:101-103`, `docs/protocol-v1.md:46`). À concevoir explicitement, pas à
improviser.

### Étape 7 — Plus tard, avec leurs mesures

- **Dérive d'horloge.** Le contexte est bien créé à 48 kHz explicites, mais rien ne compense la
  dérive entre l'horloge d'Ableton et celle de l'auditeur. À 50 ppm, 400 ms de marge partent en
  2 h ; à 200 ppm, en 33 min. Un direct d'une heure est à la limite ; un direct de trois heures
  produira des rebufférisations sans aucune cause réseau. À mesurer sur un direct long sans incident
  réseau : la pente du niveau de tampon donne la dérive.
- **Trames de 40 ou 60 ms.** L'encapsulation coûte environ 110 octets fixes par trame — 28 VSA1,
  8 WebSocket masqué, ~22 TLS, 40 à 52 TCP/IP — soit **~40 kbit/s indépendants du débit Opus**.
  À 96 kbit/s, c'est 30 % de surcoût. Passer à 40 ms le divise par deux. Et surtout, cela réduit le
  **nombre de paquets par seconde**, que le débit adaptatif ne change pas : sur un lien 4G où
  l'ordonnancement se fait par paquet, c'est un levier différent et complémentaire. Mais
  `frameDurationMs` est figé à 20 dans le protocole v1.
- **WebTransport**, voir section 5.

## 7. Ce que ce plan ne prétend pas

Le débit adaptatif de l'étape 4 n'aurait probablement **pas** rendu ce direct parfait. Le flux
complet représentait environ 8 % de la demande montante ; le descendre à 96 kbit/s en aurait
économisé la moitié. Ce n'est pas ce qui décongestionne un lien saturé d'un facteur deux ou trois.

Mais ce n'est pas ce qu'on lui demande. **Le flux n'a pas à réparer la congestion, il a à tenir dans
la part qui lui revient.** TCP converge de lui-même vers une part équitable ; le rôle du débit
adaptatif est de ne jamais produire plus que cette part, quelle qu'elle soit. C'est exactement la
différence entre un flux qui se dégrade et un flux qui s'effondre, et c'est la définition de la
robustesse recherchée ici.

Ce qui aurait sauvé *ce* direct-là est en étape 0, et cela s'appelle couper la caméra.
