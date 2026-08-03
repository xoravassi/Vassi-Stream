# Validation courte - Bloc 4

Date : 2026-08-03.

## Resultat technique

Le resampling et l'encodage Opus sont implementes, compiles et testes nativement sur Windows x64.

Vassi a confirme l'ecoute Studio dans Ableton : aucune coupure et une transparence suffisante pour son usage. Le bloc est termine.

## Implementation

- SpeexDSP 1.2.1 reechantillonne le PCM stereo flottant vers 48 kHz.
- libopus 1.5.2 encode des frames stereo de 960 samples avec `OPUS_APPLICATION_AUDIO`.
- Les profils fixes sont Stable 128, Haute 192 et Studio 256 kbit/s.
- Studio 256 kbit/s est le profil par defaut.
- Le buffer de sortie Opus fait 1276 octets, comme le maximum autorise par le protocole v1.
- Un nouveau live remet la sequence et le timestamp a zero avec `audio_encoder_reset_session`.
- Une perte locale appelle `audio_encoder_reset_after_loss` : elle conserve la sequence, marque la frame suivante avec le flag de discontinuite et avance le timestamp de la duree reellement abandonnee.
- La queue compte les frames perdues dans `dropped_frames` ; le worker convertit ce nombre en microsecondes au sample rate d'entree et y ajoute la frame partielle jetee.
- Les deux bibliotheques sont liees statiquement dans `vassi.encoder~.mxe64`.

## Review du bloc

La relecture du bloc a trouve deux ecarts avec le contrat gele du bloc 1, tous les deux corriges :

- le timestamp ne sautait pas apres une perte locale, alors que `docs/protocol-v1.md` impose de conserver le temps audio ecoule ;
- le buffer de sortie Opus faisait 1275 octets au lieu des 1276 octets du protocole.

Limites connues, traitees dans les blocs suivants :

- le worker demarre des la creation de l'objet et encode donc du silence hors live ; le bloc 10 le pilote avec `start` et `stop` ;
- une erreur d'encodage arrete le worker sans message spontane ; le bloc 5 remonte les etats `ready`, `error` et `stopped`.

## Recherche Internet

Sources officielles consultees :

- API encodeur Opus : https://www.opus-codec.org/docs/opus_api-1.3.1/group__opus__encoder.html
- Controles encodeur Opus : https://www.opus-codec.org/docs/html_api/group__encoderctls.html
- Version stable SpeexDSP : https://www.speex.org/downloads/
- API resampler SpeexDSP : https://www.speex.org/docs/manual/speex-manual/node7.html
- Release Opus 1.5.2 : https://github.com/xiph/opus/releases/tag/v1.5.2

## Verification executee

Commande principale :

```powershell
npm.cmd run check
```

Resultat :

```text
TypeScript errors 0
tests 48
pass 48
fail 0
tests natifs de queue passes
tests natifs Opus passes
```

Les tests Opus verifient :

- 48 kHz produit exactement 50 frames de 20 ms par seconde ;
- 44,1 kHz est reechantillonne vers 49 ou 50 frames de 20 ms par seconde ;
- chaque paquet est decode en 960 samples stereo par libopus ;
- un signal gauche seul reste a gauche et un signal droite seul reste a droite, a 48 kHz comme a 44,1 kHz ;
- les trois profils produisent des paquets decodables ;
- un nouveau live recommence la sequence et le timestamp a zero ;
- une discontinuite conserve la sequence, pose le flag sur la frame suivante et avance le timestamp de la duree perdue ;
- la frame partielle jetee au moment de la perte compte aussi dans le trou de temps.

Les tests de queue verifient en plus que `dropped_frames` compte exactement les frames abandonnees et repart a zero au reset.

Compilation de l'external :

```powershell
cmd.exe /c scripts\build-vassi-encoder.cmd
```

Resultat : `.local/artifacts/vassi.encoder~.mxe64`, lie statiquement.

`dumpbin /dependents` confirme que le binaire ne depend d'aucune DLL Opus ou SpeexDSP. Il depend seulement des API Max et de Windows.

## Validation manuelle

- Ecoute de quelques minutes dans Ableton avec le profil Studio : aucune coupure.
- Vassi confirme que le profil Studio est assez transparent pour son usage.
