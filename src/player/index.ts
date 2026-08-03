// Ce fichier est la seule surface publique du moteur audio. Le bloc 9 n'importe rien d'autre :
// les composants Svelte restent ainsi separes du fonctionnement interne du player.

export { AudioPlayer, type PlayerUrls } from "./audio-player.ts";
export { PlayerStateMachine, type PlayerState, type PlayerStatus } from "./player-state.ts";
export { targetBufferMs, type LiveSession, type StreamState } from "./player-protocol.ts";
export { ListenerSocket, backoffDelayMs } from "./listener-socket.ts";
