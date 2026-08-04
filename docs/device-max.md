# Le device Max for Live

Ce document decrit le device depose sur la piste Master d'Ableton : ce qu'il affiche, ce qu'il
enregistre, et ce qu'il faut verifier a la premiere ouverture.

## Les fichiers

| Fichier | Role |
|---|---|
| `device/Vassi Stream.amxd` | le device depose sur le Master |
| `patchers/vassi-stream.maxpat` | le meme patcher, lisible et modifiable dans Max |
| `device/node/index.js` | le script Node lance par le device |
| `externals/vassi.encoder~` | l'objet natif de capture et d'encodage |

Le `.amxd` est un conteneur : trois blocs de tete, puis le patcher en JSON. `npm.cmd run
device:build` regenere les deux fichiers a partir du code de `scripts/device-patcher/`.

**Une fois le device ouvert dans Max, c'est le `.maxpat` qui fait foi.** Vassi peut y deplacer les
objets et enregistrer. Relancer `device:build` ecraserait ces retouches : ce script sert a poser la
premiere version, pas a entretenir le device.

**`device:build` installe aussi le device.** Chaque construction recopie le `.amxd` et le dossier
`node/` dans la bibliotheque d'Ableton : ce qui est dans le depot et ce qu'Ableton ouvre ne peuvent
pas diverger sans qu'on l'ait voulu. Fermer Live avant de reconstruire, sinon la copie echoue et le
script le dit.

## Voir le device sans ouvrir Ableton

```
npm.cmd run device:preview
```

Cette commande ecrit `device-preview.html` : les deux pages dessinees a l'echelle 2, dans le theme
clair et dans le theme sombre de Live. Elle lit les positions dans le `.maxpat`, donc elle ne peut
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

Trois regles font tout le travail, et aucune n'est une question de gout.

**Aucune couleur n'est ecrite nulle part.** Les objets dont le nom commence par `live.` designent
deja une couleur du theme de Live : `live.line` dessine sa barre en `live_surface_frame`, le fond
LCD d'un `live.text` est `live_lcd_bg`, un onglet choisi est `live_control_selection`. Ecrire une
couleur, meme celle du theme du moment, remplacerait ce lien par une valeur fixe. Les libelles sont
donc des `live.comment`, qui suivent le theme, et non des `comment` ordinaires, qui ne le suivent
pas.

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

Le seul objet du device qui ne soit pas un objet `live.*` est le champ de saisie : Max n'en offre
aucun qui suive le theme. C'est la raison de la seconde page — les deux champs ne sont visibles que
le temps d'un collage, jamais pendant un direct.

Ces regles viennent des [recommandations de production Max for Live
d'Ableton](https://github.com/Ableton/maxdevtools/blob/main/m4l-production-guidelines/m4l-production-guidelines.md),
et `tests/device-patcher.test.ts` echoue si l'une d'elles est enfreinte.

## Ce qui est enregistre dans le morceau, et ce qui ne l'est pas

| Element | Enregistre avec le morceau | Pourquoi |
|---|---|---|
| Qualité, Latence | oui | Vassi retrouve ses reglages en rouvrant le projet |
| Bouton Lancer | non | rouvrir un projet ne doit jamais relancer un direct tout seul |
| Onglet ouvert | non | le device s'ouvre sur le direct, c'est ce qu'on vient y voir |
| Adresse du relais | non | elle vit dans le fichier de configuration de la machine |
| Token | **jamais** | un projet se partage et se sauvegarde en ligne |

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

Elle copie le device dans `Documents\Ableton\User Library\Presets\Audio Effects\Max Audio
Effect\Vassi Stream\`, et l'external dans la bibliotheque de Max. Elle refuse d'installer un device
plus ancien que le patcher, et dit quoi relancer.

Le sous-dossier n'est pas un choix d'ordre. Le device lance `node/index.js` par un chemin relatif a
lui-meme : le dossier `device/node/` doit se trouver a cote du `.amxd`, `node_modules` compris. Un
`.amxd` pose seul s'ouvrirait sans parler a rien. Le gel du device, au bloc 11, emportera le script
et supprimera ce besoin.

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

1. **Le fond du device.** Aucune couleur de fond n'est posee, pour que Live donne la sienne. Si le
   device apparait sur un rectangle gris clair dans un theme sombre, il faut poser une couleur
   dynamique de fond.
2. **Les accents.** Les libelles et les positions des deux menus portent des accents. Ils doivent
   s'afficher tels quels ; des caracteres abimes signalent un probleme d'encodage.
3. **La largeur des textes.** La maquette calcule ses largeurs avec la police du navigateur, pas
   avec Ableton Sans. Un mot serre dans la maquette peut deborder dans Live : « Équilibrée 400 ms »
   dans son menu et « Tester le relais » dans son bouton sont les deux a regarder.
4. **Le trait des separateurs.** `live.line` dessine dans le sens de sa plus grande dimension et
   centre son trait. Un trait qui n'apparait pas au bon endroit se corrige par `justification`.
5. **Le chemin du script Node.** Il est relatif : `node/index.js`. Le device doit donc rester a
   cote d'un dossier `node/`, ce dont `device:install` se charge. Le gel du device, au bloc 11,
   emportera le script avec lui.
6. **Les deux boutons de la page de reglages.** Ils sont en mode bouton. S'ils envoyaient deux
   messages par clic au lieu d'un, l'enregistrement se ferait deux fois — sans consequence, la
   seconde ecriture posant les memes valeurs.

## Ce que les tests couvrent deja

`tests/device-patcher.test.ts` lit le fichier livre et verifie dix-huit choses qu'un oeil ne voit
pas a l'ouverture : chaque cable relie des prises qui existent, chaque message envoye au script Node
possede un handler, chaque mot attendu par le patcher est bien envoye par Node, aucun objet ne
depasse la surface accordee par Live, aucun objet n'en recouvre un autre sur une meme page, les
marges et les tailles sont celles d'Ableton, chaque libelle a la hauteur de boite de sa police,
aucune couleur n'est figee, le verrou des reglages suit bien l'etat du publisher, l'onglet atteint
les deux pages, le bouton du direct ne peut pas se rallumer a l'ouverture d'un projet, et le fichier
depose contient bien le patcher livre.

Ces tests portent sur le fichier, pas sur le code qui l'a produit : ils restent valables apres une
retouche faite dans Max, ce qui est le moment ou ils servent le plus.
