# Validation courte - Phase 0

Date : 2026-08-02.

## Points valides

- Les versions Windows, Ableton Live, Max, Node for Max, Node et npm sont notees dans `docs/environment.md`.
- La premiere cible est Windows x64.
- Le sample rate observe dans Ableton est 44100 Hz.
- Un fichier audio stereo de test existe dans `assets/audio/vassi-stereo-test-48k-24bit.wav`.
- Le fichier audio de test est lisible dans Ableton.
- Vassi utilise Firefox.
- Le professeur est sur macOS, avec Safari comme navigateur probable.
- La cible navigateur est definie comme tous les navigateurs modernes compatibles WebSocket, Web Worker, WebAssembly et AudioWorklet.
- Le site public cible est `https://www.vassi.click`.

## Points non valides

- L'URL WebSocket exacte du relais reste a definir quand le relais existe.
- WSS doit etre teste sur le relais reel pendant le bloc serveur ou le bloc site.

## Decision

La phase 0 est suffisante pour lancer le Bloc 1. La validation WSS reste reportee au moment ou le relais existe.
