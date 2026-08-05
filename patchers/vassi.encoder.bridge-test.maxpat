{
	"patcher": {
		"fileversion": 1,
		"appversion": {
			"major": 8,
			"minor": 5,
			"revision": 8,
			"architecture": "x64",
			"modernui": 1
		},
		"classnamespace": "box",
		"rect": [100.0, 100.0, 1180.0, 860.0],
		"bglocked": 0,
		"openinpresentation": 1,
		"bgcolor": [0.85, 0.85, 0.85, 1.0],
		"default_fontsize": 10.0,
		"default_fontface": 0,
		"default_fontname": "Arial",
		"gridonopen": 1,
		"gridsize": [15.0, 15.0],
		"gridsnaponopen": 1,
		"objectsnaponopen": 1,
		"statusbarvisible": 2,
		"toolbarvisible": 1,
		"lefttoolbarpinned": 0,
		"toptoolbarpinned": 0,
		"righttoolbarpinned": 0,
		"bottomtoolbarpinned": 0,
		"toolbars_unpinned_last_save": 0,
		"tallnewobj": 0,
		"boxanimatetime": 200,
		"enablehscroll": 1,
		"enablevscroll": 1,
		"devicewidth": 480.0,
		"description": "",
		"digest": "",
		"tags": "",
		"style": "",
		"subpatcher_template": "",
		"boxes": [
			{
				"box": {
					"id": "title",
					"maxclass": "comment",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 10.0,
					"patching_rect": [30.0, 10.0, 464.0, 17.0],
					"presentation": 1,
					"presentation_rect": [8.0, 2.0, 464.0, 17.0],
					"text": "VASSI STREAM - test du pont Opus (bloc 5) - les compteurs se rafraichissent seuls"
				}
			},
			{
				"box": {
					"id": "head-encoder",
					"maxclass": "comment",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 10.0,
					"patching_rect": [1000.0, 40.0, 150.0, 17.0],
					"presentation": 1,
					"presentation_rect": [8.0, 21.0, 150.0, 17.0],
					"text": "ENCODEUR (objet Max)"
				}
			},
			{
				"box": {
					"id": "head-node",
					"maxclass": "comment",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 10.0,
					"patching_rect": [1000.0, 60.0, 150.0, 17.0],
					"presentation": 1,
					"presentation_rect": [250.0, 21.0, 150.0, 17.0],
					"text": "NODE (script du device)"
				}
			},
			{
				"box": {
					"id": "label-encoder-state",
					"maxclass": "comment",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 10.0,
					"patching_rect": [1000.0, 80.0, 64.0, 17.0],
					"presentation": 1,
					"presentation_rect": [8.0, 39.0, 64.0, 17.0],
					"text": "Etat"
				}
			},
			{
				"box": {
					"id": "display-encoder-state",
					"maxclass": "message",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [""],
					"fontsize": 10.0,
					"patching_rect": [1080.0, 80.0, 168.0, 17.0],
					"presentation": 1,
					"presentation_rect": [74.0, 39.0, 168.0, 17.0],
					"text": "en attente"
				}
			},
			{
				"box": {
					"id": "label-node-state",
					"maxclass": "comment",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 10.0,
					"patching_rect": [1000.0, 100.0, 64.0, 17.0],
					"presentation": 1,
					"presentation_rect": [250.0, 39.0, 64.0, 17.0],
					"text": "Etat"
				}
			},
			{
				"box": {
					"id": "display-node-state",
					"maxclass": "message",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [""],
					"fontsize": 10.0,
					"patching_rect": [1080.0, 100.0, 156.0, 17.0],
					"presentation": 1,
					"presentation_rect": [316.0, 39.0, 156.0, 17.0],
					"text": "en attente"
				}
			},
			{
				"box": {
					"id": "label-encoded",
					"maxclass": "comment",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 10.0,
					"patching_rect": [1000.0, 120.0, 64.0, 17.0],
					"presentation": 1,
					"presentation_rect": [8.0, 57.0, 64.0, 17.0],
					"text": "Encodees"
				}
			},
			{
				"box": {
					"id": "display-encoded",
					"maxclass": "number",
					"numinlets": 1,
					"numoutlets": 2,
					"outlettype": ["", "bang"],
					"fontsize": 10.0,
					"triangle": 0,
					"patching_rect": [1080.0, 120.0, 62.0, 17.0],
					"presentation": 1,
					"presentation_rect": [74.0, 57.0, 62.0, 17.0]
				}
			},
			{
				"box": {
					"id": "label-received",
					"maxclass": "comment",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 10.0,
					"patching_rect": [1000.0, 140.0, 64.0, 17.0],
					"presentation": 1,
					"presentation_rect": [250.0, 57.0, 64.0, 17.0],
					"text": "Recues"
				}
			},
			{
				"box": {
					"id": "display-received",
					"maxclass": "number",
					"numinlets": 1,
					"numoutlets": 2,
					"outlettype": ["", "bang"],
					"fontsize": 10.0,
					"triangle": 0,
					"patching_rect": [1080.0, 140.0, 62.0, 17.0],
					"presentation": 1,
					"presentation_rect": [316.0, 57.0, 62.0, 17.0]
				}
			},
			{
				"box": {
					"id": "label-sent",
					"maxclass": "comment",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 10.0,
					"patching_rect": [1000.0, 160.0, 64.0, 17.0],
					"presentation": 1,
					"presentation_rect": [8.0, 75.0, 64.0, 17.0],
					"text": "Envoyees"
				}
			},
			{
				"box": {
					"id": "display-sent",
					"maxclass": "number",
					"numinlets": 1,
					"numoutlets": 2,
					"outlettype": ["", "bang"],
					"fontsize": 10.0,
					"triangle": 0,
					"patching_rect": [1080.0, 160.0, 62.0, 17.0],
					"presentation": 1,
					"presentation_rect": [74.0, 75.0, 62.0, 17.0]
				}
			},
			{
				"box": {
					"id": "label-gaps",
					"maxclass": "comment",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 10.0,
					"patching_rect": [1000.0, 180.0, 64.0, 17.0],
					"presentation": 1,
					"presentation_rect": [250.0, 75.0, 64.0, 17.0],
					"text": "Trous"
				}
			},
			{
				"box": {
					"id": "display-gaps",
					"maxclass": "number",
					"numinlets": 1,
					"numoutlets": 2,
					"outlettype": ["", "bang"],
					"fontsize": 10.0,
					"triangle": 0,
					"patching_rect": [1080.0, 180.0, 62.0, 17.0],
					"presentation": 1,
					"presentation_rect": [316.0, 75.0, 62.0, 17.0]
				}
			},
			{
				"box": {
					"id": "label-lost",
					"maxclass": "comment",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 10.0,
					"patching_rect": [1000.0, 200.0, 64.0, 17.0],
					"presentation": 1,
					"presentation_rect": [8.0, 93.0, 64.0, 17.0],
					"text": "Perdues"
				}
			},
			{
				"box": {
					"id": "display-lost",
					"maxclass": "number",
					"numinlets": 1,
					"numoutlets": 2,
					"outlettype": ["", "bang"],
					"fontsize": 10.0,
					"triangle": 0,
					"patching_rect": [1080.0, 200.0, 62.0, 17.0],
					"presentation": 1,
					"presentation_rect": [74.0, 93.0, 62.0, 17.0]
				}
			},
			{
				"box": {
					"id": "label-discontinuities",
					"maxclass": "comment",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 10.0,
					"patching_rect": [1000.0, 220.0, 64.0, 17.0],
					"presentation": 1,
					"presentation_rect": [250.0, 93.0, 64.0, 17.0],
					"text": "Discont."
				}
			},
			{
				"box": {
					"id": "display-discontinuities",
					"maxclass": "number",
					"numinlets": 1,
					"numoutlets": 2,
					"outlettype": ["", "bang"],
					"fontsize": 10.0,
					"triangle": 0,
					"patching_rect": [1080.0, 220.0, 62.0, 17.0],
					"presentation": 1,
					"presentation_rect": [316.0, 93.0, 62.0, 17.0]
				}
			},
			{
				"box": {
					"id": "label-overflows",
					"maxclass": "comment",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 10.0,
					"patching_rect": [1000.0, 240.0, 64.0, 17.0],
					"presentation": 1,
					"presentation_rect": [8.0, 111.0, 64.0, 17.0],
					"text": "Overflows"
				}
			},
			{
				"box": {
					"id": "display-overflows",
					"maxclass": "number",
					"numinlets": 1,
					"numoutlets": 2,
					"outlettype": ["", "bang"],
					"fontsize": 10.0,
					"triangle": 0,
					"patching_rect": [1080.0, 240.0, 62.0, 17.0],
					"presentation": 1,
					"presentation_rect": [74.0, 111.0, 62.0, 17.0]
				}
			},
			{
				"box": {
					"id": "label-port",
					"maxclass": "comment",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 10.0,
					"patching_rect": [1000.0, 260.0, 64.0, 17.0],
					"presentation": 1,
					"presentation_rect": [250.0, 111.0, 64.0, 17.0],
					"text": "Port"
				}
			},
			{
				"box": {
					"id": "display-port",
					"maxclass": "number",
					"numinlets": 1,
					"numoutlets": 2,
					"outlettype": ["", "bang"],
					"fontsize": 10.0,
					"triangle": 0,
					"patching_rect": [1080.0, 260.0, 62.0, 17.0],
					"presentation": 1,
					"presentation_rect": [316.0, 111.0, 62.0, 17.0]
				}
			},
			{
				"box": {
					"id": "label-blocks",
					"maxclass": "comment",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 10.0,
					"patching_rect": [1000.0, 280.0, 64.0, 17.0],
					"presentation": 1,
					"presentation_rect": [8.0, 129.0, 64.0, 17.0],
					"text": "Signal L/R"
				}
			},
			{
				"box": {
					"id": "display-blocks-left",
					"maxclass": "number",
					"numinlets": 1,
					"numoutlets": 2,
					"outlettype": ["", "bang"],
					"fontsize": 10.0,
					"triangle": 0,
					"patching_rect": [1080.0, 280.0, 54.0, 17.0],
					"presentation": 1,
					"presentation_rect": [74.0, 129.0, 54.0, 17.0]
				}
			},
			{
				"box": {
					"id": "display-blocks-right",
					"maxclass": "number",
					"numinlets": 1,
					"numoutlets": 2,
					"outlettype": ["", "bang"],
					"fontsize": 10.0,
					"triangle": 0,
					"patching_rect": [1145.0, 280.0, 54.0, 17.0],
					"presentation": 1,
					"presentation_rect": [132.0, 129.0, 54.0, 17.0]
				}
			},
			{
				"box": {
					"id": "button-reset",
					"maxclass": "message",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [""],
					"fontsize": 10.0,
					"patching_rect": [1000.0, 310.0, 56.0, 17.0],
					"presentation": 1,
					"presentation_rect": [250.0, 129.0, 56.0, 17.0],
					"text": "reset"
				}
			},
			{
				"box": {
					"id": "button-restart",
					"maxclass": "message",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [""],
					"fontsize": 10.0,
					"patching_rect": [1070.0, 310.0, 110.0, 17.0],
					"presentation": 1,
					"presentation_rect": [312.0, 129.0, 110.0, 17.0],
					"text": "script restart"
				}
			},
			{
				"box": {
					"id": "comment-audio",
					"maxclass": "comment",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 10.0,
					"patching_rect": [30.0, 340.0, 480.0, 17.0],
					"text": "Chemin audible direct : plugin~ va vers plugout~. vassi.encoder~ ne fait qu'ecouter."
				}
			},
			{
				"box": {
					"id": "plugin",
					"maxclass": "newobj",
					"numinlets": 0,
					"numoutlets": 2,
					"outlettype": ["signal", "signal"],
					"patching_rect": [30.0, 370.0, 60.0, 22.0],
					"text": "plugin~"
				}
			},
			{
				"box": {
					"id": "encoder",
					"maxclass": "newobj",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [""],
					"patching_rect": [30.0, 470.0, 110.0, 22.0],
					"text": "vassi.encoder~"
				}
			},
			{
				"box": {
					"id": "plugout",
					"maxclass": "newobj",
					"numinlets": 2,
					"numoutlets": 0,
					"patching_rect": [280.0, 780.0, 65.0, 22.0],
					"text": "plugout~"
				}
			},
			{
				"box": {
					"id": "comment-poll",
					"maxclass": "comment",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 10.0,
					"patching_rect": [30.0, 40.0, 480.0, 17.0],
					"text": "Le rafraichissement demarre 1,5 s apres l'ouverture : node.script a besoin de ce delai."
				}
			},
			{
				"box": {
					"id": "loadbang",
					"maxclass": "newobj",
					"numinlets": 1,
					"numoutlets": 1,
					"outlettype": ["bang"],
					"patching_rect": [30.0, 70.0, 60.0, 22.0],
					"text": "loadbang"
				}
			},
			{
				"box": {
					"id": "poll-delay",
					"maxclass": "newobj",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": ["bang"],
					"patching_rect": [30.0, 100.0, 70.0, 22.0],
					"text": "delay 1500"
				}
			},
			{
				"box": {
					"id": "poll-on",
					"maxclass": "message",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [""],
					"patching_rect": [30.0, 130.0, 32.0, 22.0],
					"text": "1"
				}
			},
			{
				"box": {
					"id": "poll-metro",
					"maxclass": "newobj",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": ["bang"],
					"patching_rect": [30.0, 160.0, 70.0, 22.0],
					"text": "metro 500"
				}
			},
			{
				"box": {
					"id": "poll-split",
					"maxclass": "newobj",
					"numinlets": 1,
					"numoutlets": 2,
					"outlettype": ["bang", "bang"],
					"patching_rect": [30.0, 190.0, 50.0, 22.0],
					"text": "t b b"
				}
			},
			{
				"box": {
					"id": "ask-stats",
					"maxclass": "message",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [""],
					"patching_rect": [95.0, 220.0, 42.0, 22.0],
					"text": "stats"
				}
			},
			{
				"box": {
					"id": "ask-port",
					"maxclass": "message",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [""],
					"patching_rect": [150.0, 220.0, 58.0, 22.0],
					"text": "getport"
				}
			},
			{
				"box": {
					"id": "comment-node",
					"maxclass": "comment",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 10.0,
					"patching_rect": [560.0, 40.0, 560.0, 17.0],
					"text": "Le chemin du script est absolu : le device fonctionne depuis n'importe quel dossier."
				}
			},
			{
				"box": {
					"id": "node",
					"maxclass": "newobj",
					"numinlets": 1,
					"numoutlets": 2,
					"outlettype": ["", ""],
					"patching_rect": [560.0, 70.0, 560.0, 22.0],
					"text": "node.script C:/Users/LENOVO/Documents/VASSI/vassi-stream/device/node/vassi-stream-device.js @autostart 1"
				}
			},
			{
				"box": {
					"id": "node-route",
					"maxclass": "newobj",
					"numinlets": 1,
					"numoutlets": 4,
					"outlettype": ["", "", "", ""],
					"patching_rect": [560.0, 110.0, 180.0, 22.0],
					"text": "route port status stats"
				}
			},
			{
				"box": {
					"id": "node-print",
					"maxclass": "newobj",
					"numinlets": 1,
					"numoutlets": 0,
					"patching_rect": [880.0, 110.0, 80.0, 22.0],
					"text": "print node"
				}
			},
			{
				"box": {
					"id": "port-to-encoder",
					"maxclass": "newobj",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [""],
					"patching_rect": [560.0, 150.0, 90.0, 22.0],
					"text": "prepend port"
				}
			},
			{
				"box": {
					"id": "node-state-text",
					"maxclass": "newobj",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [""],
					"patching_rect": [665.0, 150.0, 80.0, 22.0],
					"text": "prepend set"
				}
			},
			{
				"box": {
					"id": "node-stats-unpack",
					"maxclass": "newobj",
					"numinlets": 1,
					"numoutlets": 5,
					"outlettype": ["int", "int", "int", "int", "int"],
					"patching_rect": [760.0, 150.0, 180.0, 22.0],
					"text": "unpack 0 0 0 0 0"
				}
			},
			{
				"box": {
					"id": "comment-encoder",
					"maxclass": "comment",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 10.0,
					"patching_rect": [30.0, 510.0, 560.0, 17.0],
					"text": "L'objet natif ne parle que sur demande : chaque bang sort blocks, queue, encoder et bridge."
				}
			},
			{
				"box": {
					"id": "encoder-route",
					"maxclass": "newobj",
					"numinlets": 1,
					"numoutlets": 6,
					"outlettype": ["", "", "", "", "", ""],
					"patching_rect": [30.0, 540.0, 300.0, 22.0],
					"text": "route status blocks queue encoder bridge"
				}
			},
			{
				"box": {
					"id": "encoder-print",
					"maxclass": "newobj",
					"numinlets": 1,
					"numoutlets": 0,
					"patching_rect": [700.0, 540.0, 130.0, 22.0],
					"text": "print vassi.encoder"
				}
			},
			{
				"box": {
					"id": "encoder-state-text",
					"maxclass": "newobj",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [""],
					"patching_rect": [30.0, 580.0, 80.0, 22.0],
					"text": "prepend set"
				}
			},
			{
				"box": {
					"id": "blocks-unpack",
					"maxclass": "newobj",
					"numinlets": 1,
					"numoutlets": 4,
					"outlettype": ["float", "float", "float", "float"],
					"patching_rect": [125.0, 580.0, 150.0, 22.0],
					"text": "unpack 0. 0. 0. 0."
				}
			},
			{
				"box": {
					"id": "queue-unpack",
					"maxclass": "newobj",
					"numinlets": 1,
					"numoutlets": 8,
					"outlettype": ["float", "float", "float", "float", "float", "float", "float", "float"],
					"patching_rect": [290.0, 580.0, 260.0, 22.0],
					"text": "unpack 0. 0. 0. 0. 0. 0. 0. 0."
				}
			},
			{
				"box": {
					"id": "encoder-unpack",
					"maxclass": "newobj",
					"numinlets": 1,
					"numoutlets": 7,
					"outlettype": ["int", "float", "float", "int", "int", "int", "float"],
					"patching_rect": [565.0, 580.0, 210.0, 22.0],
					"text": "unpack 0 0. 0. 0 0 0 0."
				}
			},
			{
				"box": {
					"id": "bridge-unpack",
					"maxclass": "newobj",
					"numinlets": 1,
					"numoutlets": 4,
					"outlettype": ["int", "int", "float", "float"],
					"patching_rect": [30.0, 640.0, 160.0, 22.0],
					"text": "unpack 0 0 0. 0."
				}
			},
			{
				"box": {
					"id": "comment-reconnect",
					"maxclass": "comment",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 10.0,
					"patching_rect": [110.0, 690.0, 480.0, 17.0],
					"text": "Tant que le pont est ferme, le port est redemande : le device se repare seul."
				}
			},
			{
				"box": {
					"id": "bridge-closed",
					"maxclass": "newobj",
					"numinlets": 2,
					"numoutlets": 2,
					"outlettype": ["bang", ""],
					"patching_rect": [65.0, 690.0, 40.0, 22.0],
					"text": "sel 0"
				}
			}
		],
		"lines": [
			{ "patchline": { "source": ["plugin", 0], "destination": ["plugout", 0] } },
			{ "patchline": { "source": ["plugin", 1], "destination": ["plugout", 1] } },
			{ "patchline": { "source": ["plugin", 0], "destination": ["encoder", 0] } },
			{ "patchline": { "source": ["plugin", 1], "destination": ["encoder", 1] } },

			{ "patchline": { "source": ["loadbang", 0], "destination": ["poll-delay", 0] } },
			{ "patchline": { "source": ["poll-delay", 0], "destination": ["poll-on", 0] } },
			{ "patchline": { "source": ["poll-on", 0], "destination": ["poll-metro", 0] } },
			{ "patchline": { "source": ["poll-metro", 0], "destination": ["poll-split", 0] } },
			{ "patchline": { "source": ["poll-split", 0], "destination": ["ask-stats", 0] } },
			{ "patchline": { "source": ["poll-split", 1], "destination": ["encoder", 0] } },
			{ "patchline": { "source": ["ask-stats", 0], "destination": ["node", 0] } },
			{ "patchline": { "source": ["ask-port", 0], "destination": ["node", 0] } },

			{ "patchline": { "source": ["node", 0], "destination": ["node-route", 0] } },
			{ "patchline": { "source": ["node-route", 0], "destination": ["port-to-encoder", 0] } },
			{ "patchline": { "source": ["node-route", 0], "destination": ["display-port", 0] } },
			{ "patchline": { "source": ["node-route", 1], "destination": ["node-state-text", 0] } },
			{ "patchline": { "source": ["node-route", 1], "destination": ["node-print", 0] } },
			{ "patchline": { "source": ["node-route", 2], "destination": ["node-stats-unpack", 0] } },
			{ "patchline": { "source": ["node-route", 3], "destination": ["node-print", 0] } },
			{ "patchline": { "source": ["port-to-encoder", 0], "destination": ["encoder", 0] } },
			{ "patchline": { "source": ["node-state-text", 0], "destination": ["display-node-state", 0] } },
			{ "patchline": { "source": ["node-stats-unpack", 0], "destination": ["display-received", 0] } },
			{ "patchline": { "source": ["node-stats-unpack", 2], "destination": ["display-discontinuities", 0] } },
			{ "patchline": { "source": ["node-stats-unpack", 3], "destination": ["display-gaps", 0] } },

			{ "patchline": { "source": ["encoder", 0], "destination": ["encoder-route", 0] } },
			{ "patchline": { "source": ["encoder-route", 0], "destination": ["encoder-state-text", 0] } },
			{ "patchline": { "source": ["encoder-route", 0], "destination": ["encoder-print", 0] } },
			{ "patchline": { "source": ["encoder-route", 1], "destination": ["blocks-unpack", 0] } },
			{ "patchline": { "source": ["encoder-route", 2], "destination": ["queue-unpack", 0] } },
			{ "patchline": { "source": ["encoder-route", 3], "destination": ["encoder-unpack", 0] } },
			{ "patchline": { "source": ["encoder-route", 4], "destination": ["bridge-unpack", 0] } },
			{ "patchline": { "source": ["encoder-route", 5], "destination": ["encoder-print", 0] } },
			{ "patchline": { "source": ["encoder-state-text", 0], "destination": ["display-encoder-state", 0] } },
			{ "patchline": { "source": ["blocks-unpack", 1], "destination": ["display-blocks-left", 0] } },
			{ "patchline": { "source": ["blocks-unpack", 2], "destination": ["display-blocks-right", 0] } },
			{ "patchline": { "source": ["queue-unpack", 3], "destination": ["display-overflows", 0] } },
			{ "patchline": { "source": ["encoder-unpack", 1], "destination": ["display-encoded", 0] } },
			{ "patchline": { "source": ["bridge-unpack", 1], "destination": ["bridge-closed", 0] } },
			{ "patchline": { "source": ["bridge-unpack", 2], "destination": ["display-sent", 0] } },
			{ "patchline": { "source": ["bridge-unpack", 3], "destination": ["display-lost", 0] } },
			{ "patchline": { "source": ["bridge-closed", 0], "destination": ["ask-port", 0] } },

			{ "patchline": { "source": ["button-reset", 0], "destination": ["encoder", 0] } },
			{ "patchline": { "source": ["button-reset", 0], "destination": ["node", 0] } },
			{ "patchline": { "source": ["button-restart", 0], "destination": ["node", 0] } }
		]
	}
}
