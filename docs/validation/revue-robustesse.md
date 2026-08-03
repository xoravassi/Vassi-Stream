# Revue de robustesse des blocs 0 a 5

Date : 2026-08-03.

Cette revue relit tout le code existant, sans ajouter de fonctionnalite. Elle cherche les defauts qui
peuvent arreter le live, corrompre la chronologie audio ou cacher un probleme a Vassi. Chaque point
corrige est verifie par `npm run check`.

## Defauts corriges

### 1. Un compteur de pertes remis a zero produisait un timestamp impossible

`encoder_worker.cpp` calculait la duree d'audio perdue avec `current - *known_dropped` sur des entiers
non signes. `audio_queue_reset` et `audio_queue_resize` remettent ce compteur a zero. Si le worker
observait cette remise a zero alors qu'il avait deja memorise une valeur plus grande, la soustraction
passait sous zero et donnait environ 18 milliards de milliards de frames perdues. Le timestamp de la
session avancait alors de plusieurs siecles en une seule frame, et le player n'aurait jamais pu se
resynchroniser.

L'ordre actuel des appels rendait ce cas inatteignable, parce que chaque vidage de queue est precede
d'un arret du worker. La correction du point 4 supprimait justement cet arret. La soustraction n'est
maintenant faite que lorsque le compteur avance, et le sample rate utilise comme diviseur est verifie.

### 2. L'arret du thread d'encodage restait invisible dans Max

Quand `audio_encoder_process` echouait, le worker posait `error` puis sortait de sa boucle. Plus aucune
frame n'etait produite, mais Max continuait d'afficher `status connected` : le socket vers Node restait
ouvert. Vassi voyait un live normal et un silence total, sans aucune indication.

Le worker previent maintenant Max des que `error` change, par le meme `qelem` que la connexion.
`vassi.encoder~` sort `status error`, qui prime sur l'etat de connexion.

### 3. Un Node absent affichait zero frame perdue

`frame_sender_send` sortait sans rien compter quand aucun socket n'etait ouvert. Un port annonce mais
injoignable faisait donc disparaitre cinquante frames par seconde pendant que le diagnostic du device
affichait `0` perte. La procedure de test manuel demande explicitement de lire ce nombre.

Le comptage distingue les deux situations : un pont sans port annonce reste a zero, un pont attendu
mais injoignable compte chaque frame jetee.

### 4. Chaque reconstruction de chaine DSP arretait le worker

`vassi_encoder_prepare_queue` arretait le worker, attendait sa fin par un `join`, redimensionnait la
queue et redemarrait le thread a chaque appel de `dsp64`. Live reconstruit sa chaine DSP a chaque ajout
ou suppression de device sur n'importe quelle piste, meme sans changement de sample rate. Chaque
manipulation dans Live coutait donc une attente pouvant atteindre les 50 ms du delai d'envoi du socket,
plus une reallocation de 768 Ko, plus la perte de l'audio deja en attente dans la queue.

`prepare_queue` sort maintenant immediatement quand le sample rate et la capacite ne changent pas. Le
chemin complet ne sert plus qu'a un vrai changement de sample rate.

### 5. La lecture de la queue pouvait boucler sans fin

`audio_queue_pop` recommencait sa copie tant que l'echange atomique echouait, dans un `while (true)`.
Cet echange echoue quand la routine audio deborde pendant la copie. Un debordement continu aurait donc
retenu le thread du worker dans cette boucle, et `encoder_worker_stop` attend ce thread par un `join`
appele depuis Max : le blocage se serait propage jusqu'a l'interface d'Ableton.

Le nombre de tentatives est borne a huit. Au-dela, la lecture rend zero frame et le worker reessaie
apres sa pause d'une milliseconde.

### 6. `WSACleanup` pouvait etre appele sans `WSAStartup` reussi

`frame_sender_construct` ignorait le resultat de `WSAStartup` et `frame_sender_destruct` appelait
toujours `WSACleanup`. Winsock compte les initialisations par processus. Un `WSACleanup` en trop
decremente donc le compteur d'un autre composant charge dans Max et peut arreter ses sockets.

Le resultat de `WSAStartup` est retenu. `WSACleanup` n'est appele qu'apres un demarrage reussi, et
`frame_sender_service` n'essaie plus d'ouvrir de socket sans couche reseau disponible.

### 7. Une promesse rejetee arretait `node.script`

`Max.outlet` rend une promesse. Depuis Node 15, une promesse rejetee sans gestionnaire arrete le
processus. Le canal vers Max se ferme pendant l'arret du script, donc un appel en cours pouvait tuer le
pont au lieu de le laisser se fermer proprement. Tous les envois passent maintenant par une fonction
`send` qui absorbe ce rejet.

### 8. Une erreur du consommateur de frames arretait `node.script`

`FrameBridge.receive` est appele depuis un evenement de socket. Une exception levee par `onFrame` y
devenait une exception non capturee et arretait tout le processus Node, donc le pont et le futur
publisher WebSocket du bloc 6. L'erreur est maintenant publiee comme `status error` et la connexion
reste ouverte.

## Points laisses en l'etat, avec leur raison

- `vassi_encoder_prepare_queue` alloue toujours la queue depuis `dsp64` lors d'un vrai changement de
  sample rate. C'est l'usage documente par le Max SDK : la routine `perform` n'est pas appelee pendant
  la construction de la chaine DSP. Le cas ne se produit plus qu'une fois par changement de reglage
  audio, et non a chaque manipulation dans Live.
- La queue est ecrite par la routine audio et lue par le worker, mais la routine audio deplace aussi
  l'index de lecture pour abandonner l'audio ancien. Ce n'est donc pas une file a producteur et
  consommateur strictement separes. Le comportement est voulu et correct : l'echange atomique fait
  recommencer toute lecture dont les samples viennent d'etre ecrases.
- `frame_sender.cpp` reste ecrit avec Winsock. La cible du bloc 0 est Windows x64. Un portage macOS
  demandera la variante BSD des memes appels.
- Le worker demarre a la creation de l'objet et non au lancement du live. L'ordre demande par le bloc
  10, connexion puis authentification puis `stream_start` puis encodeur, sera mis en place avec le
  publisher du bloc 6.

## Verification executee

```powershell
npm.cmd run check
npm.cmd run build:external
node scripts/measure-bridge.js 1500 20
```

`npm run check` passe : 68 tests Node, les tests natifs de la queue, de l'encodeur Opus et du pont.
L'external `vassi.encoder~.mxe64` compile sans avertissement. La mesure du pont reste stable :
1500 frames sur 1500, zero trou de sequence, 49,6 frames par seconde.

Cinq tests ont ete ajoutes : la garde contre le compteur de pertes remis a zero, la remontee de
l'erreur du worker, l'absence d'arret du worker sans changement de sample rate, la borne des
tentatives de lecture, et la survie du pont Node a un consommateur qui echoue. Le test natif du pont
verifie en plus qu'un port injoignable compte bien ses frames perdues.
