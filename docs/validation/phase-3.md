# Validation courte - Bloc 3

Date : 2026-08-02.

## Resultat

Le bloc 3 est compile, teste nativement et charge dans Max Runtime 8.5.8 sur Windows x64.

## Fichiers du bloc

- `externals/vassi.encoder~/source/audio_queue.h` declare la queue stereo bornee.
- `externals/vassi.encoder~/source/audio_queue.cpp` gere l'ecriture, la lecture complete, le reset monotone et les overflows.
- `externals/vassi.encoder~/source/encoder_worker.h` declare le worker et ses buffers prealloues.
- `externals/vassi.encoder~/source/encoder_worker.cpp` demarre, execute et arrete le thread de lecture.
- `externals/vassi.encoder~/source/vassi.encoder.cpp` relie la queue et le worker a MSP.
- `tests/native/audio_queue.test.cpp` execute les cas fonctionnels et concurrents en C++.
- `scripts/test-audio-queue.cmd` compile les tests natifs avec MSVC x64.
- `scripts/build-vassi-encoder.cmd` compile l'external dans `.local/artifacts`.

## Decisions techniques verifiees

- `perform64` reste sans allocation, log, reseau, sortie Max, thread, attente ou verrou explicite.
- Les atomiques utilises dans le callback sont controles avec `is_lock_free()` avant le demarrage.
- La queue est dimensionnee dans `dsp64`, avant le traitement audio, avec le sample rate reel.
- La duree logique reste de 1000 ms : 44100 frames a 44,1 kHz et 48000 frames a 48 kHz.
- Le worker copie chaque frame gauche et droite dans des buffers fixes de 960 frames.
- Une queue pleine abandonne l'audio le plus ancien et compte l'evenement.
- `reset` avance la lecture avec une operation compare-and-exchange et ne peut jamais la faire reculer.
- Le worker est joint avant la liberation de la queue.

Sources consultees :

- Max SDK, anatomie d'un objet MSP : https://sdk.cdn.cycling74.com/max-sdk-8.2.0/chapter_msp_anatomy.html
- Max SDK, migration `dsp64` 64 bits : https://sdk.cdn.cycling74.com/max-sdk-7.1.0/chapter_appendix_d.html
- Max SDK Base, configuration CMake : https://github.com/Cycling74/max-sdk-base/blob/main/script/max-pretarget.cmake
- Microsoft, operations atomiques C++ : https://learn.microsoft.com/en-us/cpp/standard-library/atomic

## Verification executee

Commande principale :

```powershell
npm.cmd run check
```

Resultat :

```text
TypeScript errors 0
tests 44
pass 44
fail 0
tests natifs C++ passes
```

Compilation de l'external :

```powershell
cmd.exe /c scripts\build-vassi-encoder.cmd
```

Resultat :

```text
vassi.encoder~.mxe64 produit dans .local/artifacts
compilation x64 reussie
```

Validations renforcees :

- 20 executions consecutives des tests natifs : reussies.
- AddressSanitizer sur les tests natifs : aucune erreur.
- Test concurrent de 1 000 000 ecritures et 1 000 000 resets : aucun recul de `read_frame`.
- Chargement du binaire dans Max Runtime 8.5.8 : reussi.
- 1000 cycles `start`/`stop` suivis d'une fermeture normale de Max : reussis.
- Test DSP a 44,1 kHz : queue `0/44100`, duree `1000 ms`, aucun overflow.
- Motif DSP connu : gauche `0.25`, droite `-0.5`, ordre stereo correct.

## Limite reportee au bloc 4

Le worker fournit maintenant toutes les frames PCM ordonnees. Le reechantillonnage et l'encodage Opus restent volontairement dans le perimetre du bloc 4.

## Decision

Le bloc 3 est valide localement. Les criteres courts sont couverts par des tests natifs et par Max Runtime.
