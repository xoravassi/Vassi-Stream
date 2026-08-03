But du projet :

Réaliser un patch max for live pouvant être inséré sur la piste master d'un projet Ableton Live qui, lorsqu'activé, permet de streamer le son du master sur une page du site web www.vassi.click pour pouvoir être écouté en direct par n'importe qui.

Cette interface sera dans un premier temps utilisée par mon prof de production musicale pour écouter ma session Ableton Live et donner des conseils de mixage tout en étant en conversation vidéo sur une interface comme google meet. Il faut donc que la qualité audio soit la plus haute possible tout en minimisant la latence.

On doit pouvoir entendre le flux audio en stéréo, sans coupure, sans compression audible et avec une latence la plus basse possible.


Architecture du site vassi.click :
- VPS sur Sliplane
- Vite, Svelte 5, tailwind


Affichage sur la page web :
- affichage du statut du live (prêt / pas prêt)
- bouton play/pause


Affichage sur le plugin max4live 
- bouton lancer / stopper le live
- choix de la qualité du stream via dial ableton
- choix de la latence via dial ableton


