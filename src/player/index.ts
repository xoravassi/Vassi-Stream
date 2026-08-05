// Ce fichier est la seule surface publique du moteur audio. Le bloc 9 n'importe rien d'autre :
// les composants Svelte restent ainsi separes du fonctionnement interne du player.

export { AudioPlayer, DEFAULT_TITLE, type PlayerDeps, type PlayerSetup } from "./audio-player.ts";
export { BackgroundAudio, WAKE_RETRY_DELAYS_MS, type BackgroundAudioTitle } from "./background-audio.ts";
export { PlayerStateMachine, LATE_MARGIN_MS, type PlayerState, type PlayerStatus } from "./player-state.ts";
export {
  explainPlayer,
  type AudioStage,
  type DiagnosticArea,
  type PlayerDiagnostics,
  type PlayerVerdict,
} from "./player-diagnostics.ts";
export { targetBufferMs, type LiveSession, type StreamState } from "./player-protocol.ts";
export { ListenerSocket, backoffDelayMs } from "./listener-socket.ts";
