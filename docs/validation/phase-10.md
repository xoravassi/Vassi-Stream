# Validation courte - Bloc 10

Date : 2026-08-04.

## Resultat

Le device Max for Live existe. Les blocs 5 et 6 avaient deja construit tout ce qui parle au relais ;
ce bloc construit ce que Vassi voit et touche, plus les deux fonctions qui manquaient au script
Node : enregistrer l'adresse et le token depuis le device, et demander au relais s'il repond.

Le bloc reste ouvert jusqu'a la premiere ouverture dans Ableton. Ce qui suit dit exactement ce qui
est verifie et ce qui ne peut pas l'etre sans Max.

## Ce que le bloc ajoute

### Le device

`device/Vassi Stream.amxd`, 66 objets, 85 cables, 320 pixels de large. Deux pages se partagent la
surface : le direct et les reglages. La conception complete est dans `docs/device-max.md`.

Le patcher est decrit par du code, dans `scripts/device-patcher/`, et ecrit par
`npm.cmd run device:build`. Ce choix demandait une justification, parce qu'il introduit deux
representations du meme objet.

Un device complet compte plusieurs milliers de lignes de JSON. Ecrit a la main, ce fichier ne se
relit pas, et une position fausse ne se verrait qu'a l'ouverture. Le code, lui, tient en trois
fichiers courts et se verifie. Mais Vassi ouvrira le device dans Max, et c'est la seule facon de
juger l'aspect : **apres cette premiere ouverture, c'est le `.maxpat` qui fait foi**, et le
generateur ne sert plus qu'a repartir de zero.

C'est pour cela que les tests portent sur le fichier livre et non sur le generateur. Ils survivent
a une retouche faite dans Max, ce qui est precisement le moment ou une erreur peut apparaitre.

### Le theme de couleur

La regle qui fait suivre le theme d'Ableton est negative : aucune couleur n'est ecrite nulle part.

Les objets `live.*` utilisent des couleurs dynamiques par defaut dans un device Max for Live, et
ces couleurs suivent le theme choisi dans les preferences. La seule facon de casser ce suivi est
d'ecrire une couleur, meme celle du theme du moment. Un test relit le fichier livre et echoue si un
attribut dont le nom contient `color` apparait sur un objet ou sur le fond du patcher.

Les libelles sont des `live.comment`. Sa documentation dit exactement ce qu'il faut :
« The text follows Ableton Live's color scheme, if used in a Max for Live device ». Un `comment`
ordinaire garderait sa couleur et se verrait au premier theme sombre.

### Les deux fonctions manquantes du script Node

`device/node/config-editor.js` tient les deux champs tapes dans le device. Un champ laisse vide
garde sa valeur precedente : corriger l'adresse ne doit pas obliger a recoller le token.

`device/node/relay-health.js` interroge la route publique `/health` et traduit le resultat en une
phrase. Node for Max fournit Node 16, ou `fetch` n'existe pas : la requete passe par les modules
`http` et `https` integres.

## Deux defauts trouves par la revue finale

### 1. Le verrou des reglages suivait le bouton, pas le direct

Les deux dials se verrouillaient sur la position du bouton Lancer. Or le publisher s'arrete parfois
tout seul : un token refuse, une adresse illisible, une configuration absente le font passer en
`ERROR`, et il cesse alors toute tentative.

Le bouton, lui, restait allume. Le device montrait donc un direct qui n'existait plus, les deux
reglages restaient gris, et il fallait cliquer deux fois pour repartir.

Le verrou suit desormais l'etat annonce par le publisher : ferme en `CONNECTING`, `LIVE` et
`RECONNECTING`, ouvert en `STOPPED` et `ERROR`. Le meme signal repose le bouton, par le message
`set` qui change sa position sans la renvoyer — sans cela, l'arret annonce aurait relance un arret,
qui aurait relance l'annonce, sans fin.

### 2. La page des reglages restait visible pendant l'ouverture

Les deux pages occupent la meme surface, et la page du direct etait affichee par le meme signal que
les questions posees au script Node, apres l'attente d'une seconde et demie. Les deux pages se
superposaient donc pendant tout ce temps a chaque ouverture d'un projet.

L'affichage de la page part maintenant du chargement du device, et l'attente ne concerne plus que
ce qui s'adresse a Node.

## Une revue qui a change la conception

Le premier `config-editor.js` lisait la configuration enregistree pour completer les champs vides,
donc il manipulait la valeur du token. Un test du bloc 6 l'a refuse aussitot :

```text
✖ limite l'usage du token au message d'authentification
  AssertionError : config-editor.js ne doit pas lire le token
```

Ce test garde une frontiere posee au bloc 6 : seuls le module de stockage et le message
d'authentification touchent a la valeur du token. Un troisieme fichier qui la manipule est un
troisieme endroit ou elle peut fuir dans un log, un message d'erreur ou une valeur de retour.

La fusion des champs a donc ete deplacee dans `publisher-config.js`, avec le reste de ce qui touche
au token. Le panneau de reglages ne connait plus ni le nom des champs du fichier, ni la valeur deja
en place : il transmet deux textes. C'est une meilleure conception que la premiere, et c'est un
test ecrit deux blocs plus tot qui l'a imposee.

## Ce que les tests couvrent

`npm.cmd run check` : **303 tests, 0 echec**, contre 263 au bloc 8b. Le bloc en ajoute 40.

### Le device, sans ouvrir Max — `tests/device-patcher.test.ts`

Un patcher est un objet JSON : ses objets, ses cables et ses positions se verifient comme n'importe
quelle donnee. Dix-huit tests couvrent ce qu'un oeil ne voit pas a l'ouverture. Le tableau liste ce
qui est verifie, plus finement que le decoupage en tests : la taille du device et ses positions
entieres, par exemple, tiennent dans un seul test.

| Ce qui est verifie | Ce qui arriverait sinon |
|---|---|
| chaque cable relie des prises qui existent | Max supprime le cable en silence : le device s'ouvre sans erreur et sans fonctionner |
| les identifiants et les noms des objets sont uniques | Max ne garde qu'un objet sur deux, sans rien signaler |
| chaque message envoye a Node possede un handler | le bouton ne fait rien, sans aucun message |
| chaque mot attendu par le patcher est envoye par Node | un libelle reste vide |
| aucune couleur n'est ecrite | le device jure des le premier changement de theme |
| tout tient dans 320 x 169 pixels | un objet est coupe par le bord du device |
| les positions sont des nombres entiers | les bords sont flous sur un ecran ordinaire |
| les dials ont trois positions et les bons defauts | Vassi diffuse dans une qualite qu'il n'a pas choisie |
| le bouton Lancer n'est pas un parametre | rouvrir un projet relance un direct tout seul |
| le champ du token ne contient rien | le token part avec le projet |
| le fichier `.amxd` ne contient aucun token | le token part avec le projet |
| le chemin du script Node est relatif | le device ne fonctionne que sur la machine qui l'a construit |
| chaque objet visible appartient a une page | une page se superpose a l'autre |
| l'onglet des deux pages retient sa position | la page des reglages ne se referme plus jamais |
| aucun objet n'en recouvre un autre sur une meme page | un objet en cache un autre, ce qu'une relecture de coordonnees ne montre pas |
| les marges et les tailles sont celles d'Ableton | le device se voit comme un corps etranger a cote des devices natifs |
| chaque libelle a la hauteur de boite de sa police | le texte est coupe en haut ou en bas |
| le verrou des reglages suit l'etat du publisher | apres une erreur, les reglages restent gris pour toujours |
| le `.amxd` contient bien le patcher livre | le fichier depose et le fichier lu divergent sans que cela se voie |

Le test des messages a d'ailleurs trouve un vrai oubli pendant l'ecriture : le patcher attendait un
message `urlfield` pour pre-remplir le champ d'adresse, et le script Node ne l'envoyait jamais.

### Les deux fonctions Node

`tests/device-config-editor.test.ts`, onze tests : l'enregistrement des deux champs, la valeur
gardee quand un seul champ est rempli, le brouillon efface apres l'ecriture, un symbole coupe par
Max et recolle, une adresse refusee sans exception, la phrase affichee qui ne porte jamais le
token, et chaque code d'erreur traduit en francais.

`tests/relay-health.test.ts`, dix tests contre un vrai serveur HTTP local : un relais qui repond,
un relais deja en direct, une adresse qui rend autre chose, un JSON etranger, un code d'erreur
repete tel quel, un serveur muet abandonne, une connexion refusee traduite, une adresse illisible,
et une reponse enorme coupee au lieu d'etre gardee en memoire.

### Le double clic

`tests/publisher.test.ts` gagne un test : trois demandes de lancement n'ouvrent qu'une seule
session, et la seconde ne change ni la qualite, ni l'encodeur, ni l'etat affiche.

Le refus vit dans `publisher.js` et non dans le patch. Un interrupteur clique deux fois vite donne
1, 0, 1 — ce qui est une demande legitime — mais une commande MIDI repetee ou une automation
peuvent envoyer deux fois la meme demande. Le relais donne la place au dernier publisher
authentifie : deux sessions ouvertes par erreur feraient perdre sa place a la premiere.

## Ce qui ne peut pas etre verifie ici

Max n'est pas ouvrable depuis un script. Cinq points restent a voir a la premiere ouverture,
classes du plus probable au moins probable. Ils sont repris dans `docs/device-max.md`.

1. **Le fond du device.** Aucune couleur de fond n'est posee, pour que Live donne la sienne. Si le
   device apparait sur un rectangle gris clair dans un theme sombre, il faut poser une couleur
   dynamique de fond.
2. **Les accents.** Les libelles et les trois positions des dials en portent. Des caracteres abimes
   signaleraient un probleme d'encodage.
3. **La bascule entre les deux pages.** Elle passe par `thispatcher` et les noms des objets.
4. **Le chemin relatif du script Node.** Le device doit trouver `node/index.js` a cote de lui.
5. **Les deux boutons de la page de reglages.** S'ils envoyaient deux messages par clic, la
   configuration serait ecrite deux fois — sans consequence, la seconde ecriture posant les memes
   valeurs.

Aucun de ces cinq points ne touche au son. Le chemin audio est celui du bloc 2, inchange :
`plugin~` va directement a `plugout~`, et `vassi.encoder~` n'a aucune sortie audio.

## Bloc precedent

Les blocs 5 a 8b fonctionnent toujours : leurs tests passent sans modification. Le seul changement
de comportement hors du device est le deplacement de la fusion de configuration dans
`publisher-config.js`, decrit plus haut.

## Ce qui reste avant le bloc 11

Le device ne peut pas etre essaye de bout en bout tant que le relais n'est pas deploye : sans
adresse `wss://` reelle, le bouton Lancer ne peut aboutir qu'a une erreur de connexion. Le premier
essai avec Ableton se fait donc en deux temps — l'aspect et les reglages tout de suite, le direct
apres le deploiement Sliplane.

## Decision

Le code du bloc 10 est termine et teste. Le bloc reste ouvert jusqu'a la premiere ouverture du
device dans Ableton.

## Ajout : l'installation

Le `.amxd` etait construit mais restait dans le depot ; rien ne le portait dans les dossiers
d'Ableton. `npm.cmd run device:install` le fait, sur le modele du bloc 5.

Une difference avec le device de test : celui-ci n'est pas gele et lance `node/index.js` par un
chemin relatif. Le device est donc installe dans un sous-dossier `Vassi Stream\` qui contient aussi
le dossier `node/` et son `node_modules`. Le script refuse d'installer un `.amxd` plus ancien que
`patchers/vassi-stream.maxpat`, et ne recopie pas l'external quand la version installee est deja la
bonne : Max le verrouille des qu'il est charge, et l'echec de copie n'aurait rien signale d'utile.
