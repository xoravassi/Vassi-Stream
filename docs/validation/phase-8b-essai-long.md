# Essai long du moteur audio - fiche a suivre

Cette fiche decrit un essai de quarante-cinq minutes destine a faire sortir des pannes que les tests
automatiques ne peuvent pas jouer. Elle se suit en cliquant : aucune commande n'est necessaire une
fois le serveur lance.

## Ce que cet essai mesure, et ce qu'il ne mesure pas

Il mesure **le moteur d'ecoute** — celui qui tournera chez le professeur — sous la charge reelle
d'une seance : Ableton, Google Meet, changements de casque, veille, WiFi.

Il ne mesure pas :

- **La latence.** C'est le bloc 11. Le son de la fixture est un sinus continu : un retard d'une
  seconde ne s'entend pas. Seul le compteur `Son en attente` le montre.
- **Le chemin Ableton vers l'encodeur.** Ableton tourne pendant l'essai, mais son son n'entre pas
  dans le direct : la fixture est un fichier enregistre a l'avance. Ableton sert ici de charge.
- **Safari.** Il sera teste par le professeur quand le projet sera termine.

La charge d'Ableton et de Meet est pourtant la bonne : dans une seance reelle, ces programmes se
disputent la carte son et le processeur avec le moteur audio. C'est exactement ce qui est reproduit.

## Preparation

L'essai se fait **sur le portable uniquement**, en deux passages successifs.

Aucun autre appareil ne peut y participer tant que le serveur de test ne sert pas la page en
`https://`. `BaseAudioContext.audioWorklet` n'existe que dans un contexte securise, et une page en
`http://` venue d'une autre machine n'en est pas un : le processeur audio ne se charge pas, et la
page annonce `panne definitive : audioworklet_unavailable`. Ce n'est pas une limite du telephone —
Firefox Android fournit cette API depuis 2021, mais seulement en HTTPS. `127.0.0.1` echappe a la
regle : les navigateurs traitent `localhost` comme securise.

### Passage 1 - memoire partagee (le passage principal)

```powershell
npm.cmd run player:fixture
```

Ouvrir `http://127.0.0.1:8123/` dans Firefox. `SharedArrayBuffer` doit afficher **disponible**.
C'est ce passage qui porte tout le scenario ci-dessous.

### Passage 2 - mode messages (quinze minutes suffisent)

```powershell
$env:VASSI_NO_ISOLATION = "1"; npm.cmd run player:fixture
```

Meme adresse. `SharedArrayBuffer` doit afficher **absent, mode messages**. Refaire seulement les
phases 1, 3 et 4 — celles qui arretent le thread audio. C'est le seul mode ou la file d'attente du
port n'a pas d'autre borne que la correction du premier defaut de l'essai precedent, et il n'a jamais
tenu quinze minutes. Le compteur a surveiller est **Blocs abandonnes**.

Dans les deux passages : **Play**, verifier le son en stereo — le grave a gauche, l'aigu a droite —
puis activer **Coupures automatiques**.

## Le scenario, phase par phase

Laisser les coupures automatiques actives du debut a la fin. Noter l'heure du journal au debut de
chaque phase : le journal est horodate, donc chaque incident se rattache ensuite a sa cause.

### Phase 1 - Ableton en charge (10 min)

1. Ouvrir la session la plus lourde, la lancer en lecture.
2. Geler une piste, puis la degeler.
3. Charger un plugin lourd sur une piste pendant la lecture.
4. Changer la taille du buffer d'Ableton en cours de route.

Ce que cela provoque : des pointes de processeur, et une carte son que deux programmes se disputent.

### Phase 2 - Google Meet (10 min)

1. Demarrer une reunion, seul, micro et camera actives.
2. Partager l'ecran **avec le son de l'onglet**.
3. Couper puis remettre le micro deux ou trois fois.
4. Quitter la reunion, puis en redemarrer une.

Ce que cela provoque : Windows bascule sur son peripherique de communication et baisse le volume des
autres programmes. C'est la manipulation la plus susceptible de suspendre le contexte audio sans le
dire.

### Phase 3 - Peripheriques de sortie (5 min)

1. Brancher un casque filaire pendant la lecture, puis le debrancher.
2. Connecter un casque Bluetooth, attendre le son, le deconnecter.
3. Changer la sortie par defaut dans les reglages de Windows, puis revenir.

Ce que cela provoque : le contexte audio perd son peripherique. C'est le cas le plus frequent d'une
seance reelle, et celui ou un moteur mal ecrit reste muet sans rien annoncer.

### Phase 4 - Veille et verrouillage (8 min)

1. `Win+L`, attendre deux minutes, deverrouiller.
2. Fermer le capot, attendre trois minutes, rouvrir.
3. Laisser l'ecran s'eteindre tout seul, puis revenir.

Ce que cela provoque : le thread audio s'arrete alors que le contexte se dit toujours `running`.
C'est la panne trouvee lors du premier essai. **Le point le plus important a verifier de toute la
fiche** : le retour doit donner un seul `REBUFFERING` puis `PLAYING`, pas une serie de bascules.

### Phase 5 - Arriere-plan (5 min)

1. Reduire la fenetre du navigateur trois minutes.
2. Passer sur un autre bureau virtuel.
3. Mettre Ableton en plein ecran par-dessus.

Ce que cela provoque : le navigateur ralentit les minuteurs d'un onglet cache. Le son doit continuer
sans retard accumule.

### Phase 6 - Reseau (5 min)

1. Cliquer **Coupure de 30 s**, attendre le retour complet.
2. Couper le WiFi du portable dix secondes, le remettre. Le relais tourne en local, donc la
   connexion tient : ce qui est teste ici est le reste du systeme pendant que la pile reseau bouge.
3. Activer puis desactiver un VPN, s'il y en a un.

Le vrai reseau sans fil entre le relais et l'auditeur ne se teste pas ici : il demanderait un
serveur de test en `https://`. Il sera verifie au bloc 9, sur le site deploye, qui est en `https://`
par construction. C'est la limite assumee de cet essai.

### Phase 7 - Martelement (2 min)

1. Cliquer Pause puis Play dix fois de suite, vite.
2. Cliquer **Coupure de 3 s**, puis Play pendant la bufferisation.
3. Cliquer Play plusieurs fois d'affilee sans passer par Pause.

Ce que cela provoque : des ordres qui se croisent. C'est le seul endroit ou l'auditeur peut mettre la
machine d'etats en difficulte lui-meme.

## Comment lire le resultat

A la fin, cliquer **Copier le journal** sur chacune des deux pages.

### Ce qui est normal

| Compteur | Valeur attendue |
|---|---|
| Paquets refuses | **0**, toujours |
| Derniere erreur | **aucune**, toujours |
| Blocs abandonnes | 0 en memoire partagee ; en messages, une valeur qui se stabilise |
| Manques de donnees | quelques-uns, chacun rattachable a une phase |
| Discontinuites | environ une par coupure et par trou reseau |
| Son en attente | proche du seuil affiche, sans montee continue |
| Verdict | revient sur **rien a signaler** apres chaque incident |

Un verdict qui passe au rouge pendant une manipulation n'est pas un defaut : c'est le diagnostic qui
fait son travail. Ce qui compte est qu'il **revienne**.

### Ce qui est un defaut a signaler

- **Paquets refuses different de zero.** Aucune manipulation de cette fiche ne doit en produire.
- **Le verdict reste rouge** plus de quelques secondes apres la fin d'une manipulation.
- **Le son ne revient pas** alors que le verdict dit `rien a signaler`. C'est le cas le plus grave :
  le moteur se croit sain.
- **L'etat reste sur BUFFERING** alors que `Paquets recus` continue de monter.
- **`Frames decodees` se fige** pendant que `Paquets acceptes` continue de monter.
- **`Son en attente` monte sans redescendre** : le retard s'installe, et rien ne le rattrape.
- **Plus d'un aller-retour `REBUFFERING` / `PLAYING`** pour un seul incident.
- **La ligne `retard detecte`** apparait alors qu'il ne s'est rien passe : le seuil est trop etroit.
- **`Blocs abandonnes` monte encore** en memoire partagee.

### Le piege a connaitre

Sous forte charge processeur, le publisher de test peut prendre du retard et repartir du direct, ce
qui laisse un trou dans les numeros de sequence. Le player compte alors une discontinuite et
rebufferise : **c'est le bon comportement, et la cause est l'outil de test, pas le moteur.** Le signe
qui distingue les deux : dans ce cas, `Paquets refuses` reste a zero et le verdict revient seul.

## Quoi rendre

Le journal copie de chaque passage, et pour chacun la ligne des compteurs finale. Preciser a quelle
phase correspond chaque anomalie : l'horodatage du journal suffit a la retrouver.
