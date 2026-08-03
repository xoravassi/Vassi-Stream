# Bloc 5 - Test manuel du pont dans Ableton Live

Ce document decrit la seule verification du bloc 5 qui demande un vrai Max : le passage des frames
Opus de `vassi.encoder~` vers `node.script`. Tout le reste du bloc est deja verifie automatiquement
par `npm run check`.

La preparation est faite par un script. Il ne reste ensuite qu'a lancer Ableton Live et deposer le
device : aucun copier-coller de patch, aucune ouverture de Max, aucune lecture de la Max Console.

## 1. Preparer (une seule commande)

Fermer Ableton Live et Max, puis, dans PowerShell a la racine du projet :

```powershell
npm.cmd run build:external
npm.cmd run prepare:ableton
```

`build:external` compile l'objet natif. `prepare:ableton` fait le reste :

- copie `vassi.encoder~.mxe64` dans `externals` et dans la Library de Max, lue par Max et par
  Max for Live ;
- construit `patchers/vassi.encoder.bridge-test.amxd` a partir du patcher `.maxpat` ;
- copie ce device dans la User Library d'Ableton, sous le nom `Vassi Stream - Test pont.amxd` ;
- copie le fichier audio de test dans la User Library d'Ableton.

Le script affiche une ligne `OK` par etape. Une ligne `STOP` signale presque toujours qu'Ableton
Live ou Max est reste ouvert : Windows verrouille alors les fichiers. Les fermer et relancer la
commande.

## 2. Tester dans Ableton Live

1. Lancer Ableton Live 11.
2. Dans le navigateur, colonne de gauche, ouvrir `User Library`, puis
   `Presets` > `Audio Effects` > `Max Audio Effect`.
3. Deposer `Vassi Stream - Test pont` sur la piste **Master**.
4. Toujours dans `User Library`, ouvrir `Samples` > `Vassi Stream`, et deposer
   `vassi-stereo-test-48k-24bit.wav` sur une piste audio.
5. Lancer la lecture du clip.

Le device affiche ses compteurs tout seul et les rafraichit deux fois par seconde. Il n'y a rien a
cliquer.

## 3. Lire le device

Le device montre deux colonnes. A gauche l'objet natif dans Max, a droite le script Node du device.

| Champ | Sens |
|---|---|
| Etat (gauche) | `connected` quand le pont vers Node est ouvert |
| Etat (droite) | `ready` quand Node voit l'encodeur connecte |
| Encodees | frames Opus produites par le worker |
| Envoyees | frames remises a Node par le socket loopback |
| Perdues | frames que le pont n'a pas pu remettre |
| Recues | frames reassemblees par Node |
| Trous | ruptures de numero de sequence vues par Node |
| Discont. | frames marquees apres une perte audio locale |
| Overflows | fois ou la queue audio pleine a jete du son ancien |
| Port | port loopback annonce par Node |
| Signal L/R | blocs audio contenant du son sur chaque canal |

Deux boutons restent disponibles : `reset` remet tous les compteurs a zero des deux cotes,
`script restart` relance Node.

## 4. Ce qui valide le test

- `Etat` gauche affiche `connected` et `Etat` droite affiche `ready`.
- `Port` affiche un numero non nul. Il change a chaque demarrage : Node demande un port libre au
  systeme, c'est normal.
- Pendant la lecture, `Encodees`, `Envoyees` et `Recues` augmentent ensemble d'environ 50 par
  seconde. Un ecart d'une seule frame est normal : elle est en cours de transmission.
- `Perdues` reste a `0`.
- `Trous` reste a `0`.
- `Signal L/R` augmentent tous les deux pendant la lecture : les deux canaux du master portent
  vraiment du son. Ces deux compteurs s'arretent pendant un silence complet, c'est normal.
- Le son du Master ne change pas, que le device soit actif ou desactive.

`Discont.` peut afficher une ou deux unites au demarrage. Une connexion neuve marque toujours sa
premiere frame, parce que Node n'a pas recu ce qui precede, et le demarrage du DSP peut remplir la
queue une fois avant que le worker prenne son rythme. Une valeur qui continue de monter pendant une
lecture reguliere n'est pas normale : la noter et la signaler.

## 5. Si quelque chose ne fonctionne pas

Le device s'affiche en rouge dans Live, ou les champs restent vides :

- l'objet natif n'est pas charge ; relancer `npm.cmd run prepare:ableton` avec Live ferme, puis
  rouvrir Live.

`Port` reste a `0` :

- Node n'a pas demarre. Cliquer sur `script restart`. Si le port reste a zero, ouvrir l'editeur Max
  du device avec l'icone crayon, puis `Window` > `Max Console` : l'erreur exacte de `node.script`
  y est ecrite.
- Le patch designe le script par un chemin absolu. Deplacer ou renommer le dossier du projet casse
  ce chemin ; il faut alors regenerer le device avec `npm.cmd run prepare:ableton`.

`Etat` gauche reste `disconnected` alors que `Port` est rempli :

- le device redemande le port deux fois par seconde tant que le pont est ferme, donc l'etat doit se
  reparer seul en une seconde ;
- s'il ne se repare pas, un pare-feu bloque une connexion locale sur `127.0.0.1`.

`Encodees` reste a `0` alors que `Signal L/R` augmentent :

- le worker d'encodage est arrete ; `Etat` gauche affiche alors `error`. Cliquer sur `reset`.
- si l'erreur revient, noter le sample rate du projet Live et le signaler.

`Signal L/R` restent a `0` pendant la lecture :

- aucun son ne traverse le Master ; verifier que la lecture est lancee et que la piste n'est pas
  coupee. Ces compteurs mesurent le contenu audio reel recu par l'objet, pas la presence d'un cable :
  s'ils restent a zero pendant que le master sonne, l'objet ne recoit que du silence et il faut le
  signaler.

`Perdues` augmente :

- Node ne suit pas le debit, ou le port annonce n'est plus ecoute ;
- noter la valeur et la signaler : ce cas ne doit pas se produire a 50 frames par seconde.

## 6. Note sur le device

`patchers/vassi.encoder.bridge-test.amxd` est genere, jamais edite a la main. La source est
`patchers/vassi.encoder.bridge-test.maxpat` et la conversion est faite par
`scripts/build-test-device.js`.

Ce device n'est pas gele : il charge l'objet natif depuis la Library de Max. C'est voulu pendant le
developpement, parce qu'une recompilation devient active sans regenerer le device. Le gel avec
l'objet natif inclus est prevu au bloc 11.
