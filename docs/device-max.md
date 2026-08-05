# Le device Max for Live

Ce document decrit le device depose sur la piste Master d'Ableton : ce qu'il affiche, ce qu'il
enregistre, et ce qu'il faut verifier a la premiere ouverture.

## Les fichiers

| Fichier | Role |
|---|---|
| `device/Vassi Stream.amxd` | le device depose sur le Master |
| `patchers/vassi-stream.maxpat` | le meme patcher, lisible et modifiable dans Max |
| `device/node/vassi-stream-device.js` | le script Node lance par le device |
| `externals/vassi.encoder~` | l'objet natif de capture et d'encodage |

Le `.amxd` est un conteneur : trois blocs de tete, puis le patcher en JSON. `npm.cmd run
device:build` regenere les deux fichiers a partir du code de `scripts/device-patcher/`.

**Une fois le device ouvert dans Max, c'est le `.maxpat` qui fait foi.** Vassi peut y deplacer les
objets et enregistrer. Relancer `device:build` ecraserait ces retouches : ce script sert a poser la
premiere version, pas a entretenir le device.

**`device:build` installe aussi le device.** Chaque construction recopie le `.amxd` dans la
bibliotheque d'Ableton et le dossier `node/` dans celle de Max : ce qui est dans le depot et ce
qu'Ableton ouvre ne peuvent pas diverger sans qu'on l'ait voulu. Les deux destinations sont
expliquees plus bas, dans « Installer sur un nouvel ordinateur ». Fermer Live avant de reconstruire,
sinon la copie echoue et le script le dit.

## Voir le device sans ouvrir Ableton

```
npm.cmd run device:preview
```

Cette commande ecrit `device-preview.html` : les deux pages dessinees a l'echelle 2. Le device
impose son propre fond, fixe, plutot que de suivre le theme de Live : il n'y a donc qu'un seul
rendu a regarder. La maquette lit les positions et les couleurs dans le `.maxpat`, donc elle ne peut
pas mentir sur la mise en page.

C'est une maquette, pas un rendu : Max dessine les vrais objets, avec ses arrondis et ses degrades.
Ce qui se verifie la, ce sont les alignements, les textes trop longs et l'equilibre general — et
c'est precisement ce qu'on ne voit pas en relisant des coordonnees.

## Les deux pages

Le device tient dans 320 pixels de large. La hauteur ne se choisit pas : Live donne 169 pixels a
tous les devices. Deux onglets en haut a gauche partagent cette surface.

Deux choses restent en place quel que soit l'onglet : les onglets eux-memes et l'adresse du relais
tout en bas.

La page du direct suit la coupe de Wavetable et d'EQ Eight : **un ecran occupe le haut, une bande de
commandes serrees tient le bas**. L'ecran porte ce qu'on regarde, la bande porte ce qu'on touche.
La page des reglages pose ses champs et ses boutons aux memes hauteurs, pour que passer d'un onglet
a l'autre ne deplace aucun repere.

### Page du direct

```text
[ Direct | Réglages ]
──────────────────────────────────────────────────
                                              ▮ ▮
 Arrêté                                       ▮ ▮
 device prêt                                  ▮ ▮
──────────────────────────────────────────────────
 Diffusion    Qualité          Latence
 [ LANCER ]   [Studio 256 ▾]   [Équilibrée 400 ms ▾]
──────────────────────────────────────────────────
wss://live.vassi.click/publisher - token ...4f2a
```

L'etat vient du script Node — Arrêté, Connexion, Live, Reconnexion, Erreur — et le detail sous lui
est celui que le publisher fournit deja depuis le bloc 6. Ils sont dans l'ecran parce que c'est ce
qu'on vient lire sur ce device.

Le bouton lance et arrete le direct. Il est dessine en style LCD, celui que Live donne a ses
interrupteurs, et son texte dit ce qu'un clic va faire : **Lancer** quand rien ne tourne, **Arrêter**
pendant un direct. Il garde la hauteur des deux menus : dans Live, un interrupteur ne depasse pas de
sa bande, c'est son fond sombre qui le distingue.

Max 8 n'a pas d'objet d'ecran qui suive le theme — `live.scope~` n'existe qu'a partir de Max 8.6 —
donc la bande d'affichage est delimitee par deux traits plutot que par un cadre.

Les deux reglages sont des menus deroulants a trois positions. C'est ce que Live pose devant un
choix nomme ; un bouton rotatif sert a parcourir une plage, et « Équilibrée 400 ms » ne tient pas
dans les 44 pixels d'un dial d'Ableton. Ils se grisent pendant un direct : changer la qualite en
cours de route n'existe pas dans cette version, et un reglage qui ne repond pas doit se voir plutot
que d'etre ignore en silence.

Le verrou suit l'etat annonce par le publisher, jamais la position du bouton : ferme en Connexion,
Live et Reconnexion, ouvert en Arrêté et Erreur. Le publisher s'arrete parfois de lui-meme — un
token refuse, une adresse illisible — et le bouton retombe alors avec le verrou. Sans cette regle,
le device montrerait un direct qui n'existe plus et il faudrait cliquer deux fois pour repartir.

Les deux vumetres ne pilotent rien. Ils repondent a la seule question qu'on se pose devant un
device de diffusion muet : est-ce que du son arrive jusqu'ici. Ils sont branches sur l'entree, en
parallele de l'encodeur, et s'eteignent avec le device.

### Page des reglages

```text
[ Direct | Réglages ]
──────────────────────────────────────────────────
Relais   [wss://live.vassi.click/publisher       ]
Token    [                                       ]
         [ Enregistrer ]   [ Tester le relais ]
relais joignable, 0 auditeur(s)
Encodeur connected
──────────────────────────────────────────────────
wss://live.vassi.click/publisher - token ...4f2a
```

Un champ laisse vide garde sa valeur precedente : corriger l'adresse ne demande pas de recoller le
token, et l'inverse. Le champ du token se vide des que l'enregistrement reussit.

**Tester le relais** interroge la route publique `/health`, jamais le chemin publisher. Aucun token
ne circule pour cette verification : une adresse mal collee se voit sans qu'un secret parte sur le
reseau.

## Ressembler a un device d'Ableton

### Wavetable n'est pas un device Max for Live

Vassi a demande un rendu proche de Wavetable : fond presque noir, onglets et menus dans le style
LCD des devices Ableton. Un point compte avant de decrire les regles : **Wavetable n'est pas un
device Max for Live**. C'est un device natif d'Ableton, ecrit dans son propre moteur graphique, qui
reste sombre en permanence, quel que soit le theme choisi dans les preferences de Live. Un device
Max for Live, lui, est construit avec des objets `live.*` generiques et ne peut pas reproduire au
pixel pres le rendu de Wavetable — la cible realiste, documentee par les [Max for Live Production
Guidelines](https://github.com/Ableton/maxdevtools/blob/main/m4l-production-guidelines/m4l-production-guidelines.md)
d'Ableton, est le niveau de finition des devices Max for Live qu'Ableton livre elle-meme avec Live
(LFO, Shaper, Envelope Follower, Align Delay, Convolution Reverb Pro).

Un device Max for Live ne peut suivre qu'un theme a la fois : soit celui de Live, soit un theme qui
lui est propre. Vassi a choisi le second, en connaissance des deux options, pour se rapprocher du
rendu de Wavetable.

### La palette

Six couleurs, et six seulement, sont ecrites en dur dans le device. Elles vivent a un seul endroit,
`PALETTE` dans `scripts/device-patcher/parts.js`, et rien dans le code ne recopie une valeur a la
main : `tests/device-patcher.test.ts` verifie que toute couleur trouvee dans le fichier livre vient
bien de cette palette.

Ces six couleurs ne sont pas choisies a l'oeil. Ce sont celles qu'Ableton applique lui-meme dans
son theme Sombre, relevees dans le fichier reel de l'application —
`C:\ProgramData\Ableton\Live 11 Suite\Resources\Themes\03Dark.ask`.

| Role dans le device | Cle Ableton (`03Dark.ask`) | Valeur |
|---|---|---|
| Fond du device | `RetroDisplayBackground` | `#050505` |
| Traits de separation | `RetroDisplayBackgroundLine` | `#424242` |
| Texte principal (l'etat du direct) | `SurfaceAreaForeground` | `#a0a0a0` |
| Texte secondaire / legendes | `RetroDisplayForegroundDisabled` | `#808080` |
| Accent (onglet actif, LCD allume) | `RetroDisplayForeground` | `#f39420` |
| Texte pose sur un fond accent | `ControlOnForeground` | `#000000` |

`RetroDisplayBackground` est la cle qu'Ableton utilise pour ses propres ecrans a l'ancienne (LCD,
VU) : c'est la valeur la plus proche, sourcee, du presque-noir de l'ecran de Wavetable.

### Le mode LCD

L'apparence par defaut de `live.tab` et `live.menu` dessine chaque position comme un bouton separe
— c'est ce qui donnait au device un air de « deux boutons » plutot que d'onglets. Le mode LCD
(`appearance: 1` pour `live.tab` et `live.menu`, `appearance: 2` pour `live.text`) est celui que le
patch d'aide officiel de Max nomme lui-meme « LCD mode » : une barre plate, l'item actif en
surbrillance. C'est ce mode qui est utilise partout dans le device : les deux onglets, les deux
menus, le bouton du direct et les deux boutons de la page de reglages.

En mode LCD, deux attributs seulement peignent un `live.text` : `lcdbgcolor` donne le fond a
l'arret et la couleur du texte pendant le clic, `lcdcolor` fait l'inverse. `textcolor`, malgre son
nom, ne sert qu'a un objet rendu inactif. Les trois boutons posent donc leur `lcdcolor` : l'accent
pour le bouton du direct, le gris du texte pour les deux boutons de reglages, qui sont des actions
secondaires.

Les recommandations de production Max for Live d'Ableton demandent que l'**Output Mode** de
`live.text` soit **Mouse Up** (`outputmode: 1`), *« since it will match Live's native button
behavior »*. Cet attribut n'agit que sur un interrupteur — la page de reference de Max l'ecrit noir
sur blanc : *« Sets the output mode for the live.text object when it's mode attribute is set to 1
(toggle) »* — et aucun des 138 boutons `live.text` livres avec Live ne le pose. Le bouton du direct,
qui est un interrupteur, le garde ; les deux boutons de la page de reglages ne le posent pas.

**Les tailles sont mesurees, pas choisies.** Les 78 devices Max for Live livres avec Live 11 sont
lisibles : leur bloc `ptch` n'est pas chiffre, contrairement aux devices d'Ableton. Les compter
donne des regles nettes, et le device les suit.

| Regle | Releve sur les devices livres |
|---|---|
| Police des libelles et des commandes | 10 points (453 cas contre 122 en 9) |
| Hauteur de boite d'un libelle | police + 8 pixels, sans exception |
| Hauteur d'un `live.menu` | 15 pixels (68 cas sur 68) |
| Hauteur d'un `live.text` | 15 pixels (82 cas), puis 16 (38) |
| Hauteur d'un `live.meter~` | 54 pixels (62 cas sur 68) |
| Marge gauche des commandes | 8 pixels (28 devices, le plus frequent) |

La regle de la hauteur de boite est celle qui compte le plus, parce qu'elle ne se voit pas
autrement : un libelle de 10 points dans une boite de 12 pixels rogne son texte, et ni le code ni la
maquette ne le montrent. La deuxieme version du device avait ce defaut partout.

**Les marges sont egales des deux cotes.** Huit pixels a gauche, huit a droite ; c'est une
recommandation d'Ableton, et le test la verifie sur le fichier livre.

Le seul objet du device qui ne soit pas un objet `live.*` est le champ de saisie (`textedit`) : Max
n'en offre aucune version `live.*`. Ses couleurs viennent de la meme `PALETTE`, posees a la main
puisque l'objet n'a pas de mode LCD a activer. C'est aussi la raison de la seconde page — les deux
champs ne sont visibles que le temps d'un collage, jamais pendant un direct.

Ces regles viennent des [recommandations de production Max for Live
d'Ableton](https://github.com/Ableton/maxdevtools/blob/main/m4l-production-guidelines/m4l-production-guidelines.md),
et `tests/device-patcher.test.ts` echoue si l'une d'elles est enfreinte.

## Ce qui est enregistre dans le morceau, et ce qui ne l'est pas

| Element | Enregistre avec le morceau | Pourquoi |
|---|---|---|
| Qualité, Latence | oui | Vassi retrouve ses reglages en rouvrant le projet |
| Bouton Lancer | non | rouvrir un projet ne doit jamais relancer un direct tout seul |
| Onglet ouvert | non | le device s'ouvre sur le direct, c'est ce qu'on vient y voir |
| Enregistrer, Tester le relais | non | un clic est une action, pas un reglage |
| Adresse du relais | non | elle vit dans le fichier de configuration de la machine |
| Token | **jamais** | un projet se partage et se sauvegarde en ligne |

**Toutes les commandes du device sont des parametres Live, y compris celles qui ne retiennent
rien.** Ce n'est pas un choix : un `live.text` en mode bouton tire son bang de la transition 0 vers
1 de son parametre — la page de reference de Max le dit a l'attribut `transition` — donc un bouton
sans parametre ne sort rien. Les deux boutons de la page de reglages etaient dans ce cas a la
premiere ouverture dans Ableton : ils ne faisaient rien, sans message ni erreur. Leur parametre est
cache (`parameter_invisible: 2`), comme les recommandations d'Ableton le demandent pour un bouton,
si bien que rien n'entre dans l'historique d'annulation ni dans le morceau. Un test le verifie
maintenant sur les trois commandes du fichier livre.

Le bouton du direct retient sa position, sinon il ne pourrait pas s'allumer. Trois choses
l'empechent de la rapporter d'un projet a l'autre : le parametre est cache, donc Live ne le range
pas dans le morceau ; sa valeur de depart est posee a zero ; et l'ouverture du device lui renvoie
`set 0`, qui repose le bouton sans rien emettre. La derniere suffirait — un `set` ne declenche
aucun cable — mais les deux autres evitent qu'il s'affiche allume le temps du chargement.

Le token vit dans `%APPDATA%\Vassi Stream\publisher.json`, propre au compte Windows. Le device n'en
affiche jamais que les quatre derniers caracteres. Trois tests gardent cette frontiere : le champ de
saisie ne contient rien dans le fichier livre, le fichier `.amxd` ne contient aucun token, et aucun
module du device en dehors du stockage et du message d'authentification ne touche a sa valeur.

## L'ordre des operations

**A l'ouverture du device**, `live.thisdevice` annonce que tout est charge. La page du direct
s'affiche aussitot : les deux pages occupent la meme surface, et celle des reglages resterait sinon
visible par-dessus. Le device attend ensuite une seconde et demie — Node for Max met environ ce
temps a demarrer — puis demande le port du pont, renvoie les deux reglages et demande l'etat de la
configuration. Rien ne se connecte au relais : ouvrir un projet ne lance pas de direct.

**Au clic sur Lancer**, l'ordre est celui du bloc 6, tenu par `publisher.js` : connexion,
authentification, `stream_start`, puis seulement l'encodeur. Le relais refuse toute frame audio
recue avant son `stream_start`.

**Au clic sur Arreter**, l'ordre s'inverse : encodeur, `stream_stop`, puis fermeture de la session.

Une seconde demande de lancement pendant un direct est ignoree, et un test le verifie : le relais
donne la place au dernier publisher authentifie, deux sessions ouvertes par erreur feraient donc
perdre sa place a la premiere.

## Installer sur un nouvel ordinateur

Une seule commande met le device la ou Ableton le cherche :

```
npm.cmd run device:install
```

Elle pose les trois morceaux du device a deux endroits :

| Morceau | Ou | Pourquoi la |
|---|---|---|
| `Vassi Stream.amxd` | `Documents\Ableton\User Library\Presets\Audio Effects\Max Audio Effect\Vassi Stream\` | c'est ce dossier qu'Ableton montre dans son navigateur |
| `node/` et son `node_modules` | `Documents\Max 8\Library\Vassi Stream\node\` | c'est un dossier que **Max** indexe |
| `vassi.encoder~.mxe64` | `Documents\Max 8\Library\Vassi Stream\externals\` | idem, et c'est deja par la qu'il etait trouve |

Elle refuse d'installer un device plus ancien que le patcher, et dit quoi relancer.

**Les deux dossiers ne sont pas interchangeables.** Le device demande son script par un nom de
fichier seul, `vassi-stream-device.js`, et c'est Max qui doit le retrouver. Or Max n'indexe pas la
bibliotheque d'Ableton : **pas un fichier** de `Documents\Ableton\User Library` n'entre dans sa base
de recherche. Un dossier `node/` pose a cote du `.amxd` y est invisible — c'est ce qui laissait le
device entierement muet a la premiere ouverture. La bibliotheque de Max, elle, est indexee, et le
nom du fichier y est unique : un `index.js` y designerait un exemple livre avec Node for Max.

**Max ne relit sa bibliotheque qu'a son demarrage.** Installer pendant que Live tourne ne suffit
donc pas : il faut fermer Live et le rouvrir. Le gel du device, au bloc 11, emportera le script dans
le `.amxd` et supprimera ce second depot.

**Le device installe est une copie.** Une retouche faite dans Max depuis Live modifie cette copie,
pas le depot : il faut la rapporter dans `patchers/vassi-stream.maxpat`.

Ensuite, dans Live, aucun terminal n'est necessaire.

1. Categories > Audio Effects > Max Audio Effect > Vassi Stream, deposer le device sur le Master.
2. Cliquer sur l'onglet **Réglages**.
3. Coller l'adresse du relais, par exemple `wss://live.vassi.click/publisher`.
4. Coller le token de publication.
5. Cliquer sur **Enregistrer**, puis sur **Tester le relais**.

La ligne du bas doit indiquer l'adresse et les quatre derniers caracteres du token, puis
`relais joignable`. Si elle dit autre chose, elle dit quoi corriger.

L'adresse doit commencer par `wss://` en dehors de la machine : un `ws://` distant transporterait
le token en clair, et la configuration le refuse.

## A verifier a la premiere ouverture dans Ableton

Ces points ne se verifient pas sans Max. Ils sont classes du plus probable au moins probable.

1. **Le fond du device.** Il est fixe a `PALETTE.bg`, presque noir : il doit s'afficher identique
   dans les deux themes de Live, clair et sombre — c'est voulu, voir « Ressembler a un device
   d'Ableton » plus haut. Ce qui reste a verifier a l'oeil, c'est le contraste : que l'etat du
   direct, les legendes et les traits de separation restent lisibles sur ce fond.
2. **Les accents.** Les libelles et les positions des deux menus portent des accents. Ils doivent
   s'afficher tels quels ; des caracteres abimes signalent un probleme d'encodage.
3. **La largeur des textes.** La maquette calcule ses largeurs avec la police du navigateur, pas
   avec Ableton Sans. Un mot serre dans la maquette peut deborder dans Live : « Équilibrée 400 ms »
   dans son menu et « Tester le relais » dans son bouton sont les deux a regarder.
4. **Le trait des separateurs.** `live.line` dessine dans le sens de sa plus grande dimension et
   centre son trait. Un trait qui n'apparait pas au bon endroit se corrige par `justification`.
5. **Le script Node demarre.** Le device le demande par son nom seul, `vassi-stream-device.js`, et
   Max le cherche dans sa bibliotheque. Si la ligne du bas reste a « configuration inconnue » et
   que l'etat ne bouge pas, c'est ce maillon qui manque : `device:install` puis un redemarrage de
   Live remettent le script la ou Max regarde.
6. **Les deux boutons de la page de reglages.** Ils sont en mode bouton, et un clic doit envoyer un
   seul message. Deux clics de suite sur **Enregistrer** sont sans consequence : la seconde ecriture
   pose les memes valeurs.

## Les deux defauts trouves a la premiere ouverture

Ils se ressemblaient a l'ecran — un clic sans effet — et n'avaient rien a voir. Le premier empechait
les boutons d'emettre quoi que ce soit ; le second empechait le script Node de demarrer, donc rendait
le device entier muet. Le premier cachait le second : tant qu'aucun bang ne partait, rien ne
montrait que personne n'ecoutait a l'autre bout.

### 1. Un bouton sans parametre n'emet rien

**Les deux boutons de la page de reglages ne faisaient rien.** Aucun message, aucune erreur dans la
fenetre Max : un clic partait dans le vide.

Ils etaient poses avec `parameter_enable: 0`, c'est-a-dire sans parametre Live. Or un `live.text` en
mode bouton ne fabrique pas son bang tout seul : il le tire de la transition 0 vers 1 de son
parametre. C'est la page de reference de Max qui le dit, a l'attribut `transition` — *« The
parameter automation of live.text stores 0 and 1 values. The transition attribute specifies when a
bang will be sent to the outlet. »* Sans parametre, pas de transition, donc pas de bang.

Le releve des devices livres avec Live dit la meme chose autrement : sur leurs **411 objets
`live.*`, aucun** n'a `parameter_enable` a 0, et les 138 boutons `live.text` portent tous un
parametre, cache dans deux cas sur trois.

Les deux boutons sont donc devenus des parametres caches. Deux autres reglages sont tombes avec :
`outputmode` a disparu des boutons, ou il n'agit pas, et `lcdcolor` est desormais pose, sans quoi
les deux libelles prenaient l'orange par defaut de Max au milieu d'un device gris — la maquette ne
le montrait pas, parce qu'elle dessinait le texte avec `textcolor`. Les deux corrections sont
decrites plus haut, dans « Le mode LCD ».

Ce defaut ne pouvait pas etre attrape par les tests de cablage : les cables etaient justes, les
messages existaient, le script Node avait ses handlers. Il manquait la question qu'aucun test ne
posait — **est-ce que cette commande peut seulement emettre quelque chose ?** C'est maintenant un
test, sur les trois commandes du fichier livre.

### 2. Max ne voyait pas le script Node

Les boutons corriges, plus rien ne se passait toujours : ni **Enregistrer**, ni **Tester le
relais**, ni **LANCER**. Un seul soupcon explique les trois d'un coup — le script Node ne tournait
pas — et il se verifie sans Max : Live lance un gestionnaire de processus Node for Max des qu'un
objet `node.script` existe, et ce gestionnaire tournait bien, **sans aucun processus enfant**.
L'objet existait donc, et son script n'avait jamais demarre.

Le patcher demandait `node/index.js`. Max resout ce genre de nom dans sa base de recherche, un index
de fichiers qu'il construit a son demarrage. Cette base se lit — c'est une base SQLite dans
`%APPDATA%\Cycling '74\Max 8\Database\` — et elle repond sans ambiguite :

| Question posee a la base | Reponse |
|---|---|
| fichiers indexes sous `Documents\Ableton\User Library` | **0** |
| fichiers indexes sous `Documents\Max 8` | dont `vassi.encoder~.mxe64`, trouve par la depuis le bloc 5 |
| fichiers nommes `index.js` dans toute la base | **un seul**, un exemple livre avec Node for Max |

Le dossier `node/` etait pose a cote du `.amxd`, dans la bibliotheque d'Ableton : un endroit ou Max
ne regarde pas. Le script etait invisible, l'objet ne demarrait rien, et le device restait muet.

Deux corrections, pour les deux moities du probleme :

- **Le script est installe dans la bibliotheque de Max**, `Documents\Max 8\Library\Vassi Stream\`,
  a cote de l'external. C'est un dossier indexe, et c'est deja par la que `vassi.encoder~` est
  trouve depuis le bloc 5 — le mecanisme etait donc deja prouve sur cette machine.
- **Le point d'entree s'appelle `vassi-stream-device.js`**, plus `index.js`. Un nom unique dans la
  base ne peut pas designer le fichier d'un autre : l'exemple de Node for Max porte deja ce nom, et
  il a d'ailleurs ete ecrase par accident pendant le bloc 5.

Un test garde les trois conditions du nom : pas de chemin absolu, qui ne survivrait pas a un
changement de machine ; pas de dossier, que Max ne resout pas ici ; et le meme nom que le fichier du
depot.

**Max ne relit sa bibliotheque qu'a son demarrage.** Apres `device:install`, il faut donc fermer
Live et le rouvrir, sinon le script reste introuvable pour la session en cours.

## Ce que les tests couvrent deja

`tests/device-patcher.test.ts` lit le fichier livre et verifie vingt choses qu'un oeil ne voit
pas a l'ouverture : chaque cable relie des prises qui existent, chaque message envoye au script Node
possede un handler, chaque mot attendu par le patcher est bien envoye par Node, aucun objet ne
depasse la surface accordee par Live, aucun objet n'en recouvre un autre sur une meme page, les
marges et les tailles sont celles d'Ableton, chaque libelle a la hauteur de boite de sa police,
toute couleur figee vient de la palette unique du device, chaque commande est un parametre Live avec
un nom long qui lui est propre, les deux boutons de reglages sont des boutons sans etat qui
atteignent le script Node, le device demande son script par un nom de fichier seul qui existe dans
le depot, le verrou des reglages suit bien l'etat du publisher, l'onglet atteint
les deux pages, le bouton du direct ne peut pas se rallumer a l'ouverture d'un projet, et le fichier
depose contient bien le patcher livre.

Ces tests portent sur le fichier, pas sur le code qui l'a produit : ils restent valables apres une
retouche faite dans Max, ce qui est le moment ou ils servent le plus.
