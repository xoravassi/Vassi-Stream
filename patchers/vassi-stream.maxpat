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
		"rect": [
			100,
			100,
			1400,
			800
		],
		"bglocked": 0,
		"bgcolor": [
			0.019608,
			0.019608,
			0.019608,
			1
		],
		"openinpresentation": 1,
		"default_fontsize": 10,
		"default_fontface": 0,
		"default_fontname": "Ableton Sans",
		"gridonopen": 1,
		"gridsize": [
			5,
			5
		],
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
		"devicewidth": 320,
		"description": "Diffuse le master d'Ableton en direct sur vassi.click",
		"digest": "",
		"tags": "",
		"style": "",
		"subpatcher_template": "",
		"boxes": [
			{
				"box": {
					"id": "page-tabs",
					"maxclass": "live.tab",
					"varname": "page-tabs",
					"numinlets": 1,
					"numoutlets": 3,
					"patching_rect": [
						40,
						20,
						120,
						17
					],
					"presentation": 1,
					"presentation_rect": [
						8,
						4,
						120,
						17
					],
					"outlettype": [
						"",
						"",
						"float"
					],
					"livemode": 1,
					"appearance": 1,
					"lcdbgcolor": [
						0.019608,
						0.019608,
						0.019608,
						1
					],
					"lcdcolor": [
						0.952941,
						0.580392,
						0.12549,
						1
					],
					"textcolor": [
						0.501961,
						0.501961,
						0.501961,
						1
					],
					"textoncolor": [
						0,
						0,
						0,
						1
					],
					"bordercolor": [
						0.258824,
						0.258824,
						0.258824,
						1
					],
					"parameter_enable": 1,
					"saved_attribute_attributes": {
						"valueof": {
							"parameter_enum": [
								"Direct",
								"Réglages"
							],
							"parameter_type": 2,
							"parameter_unitstyle": 10,
							"parameter_mmin": 0,
							"parameter_mmax": 1,
							"parameter_initial": [
								0
							],
							"parameter_initial_enable": 1,
							"parameter_shortname": "Page",
							"parameter_longname": "Page",
							"parameter_invisible": 2,
							"parameter_modmode": 0,
							"parameter_modmin": 0,
							"parameter_modmax": 127,
							"parameter_linknames": 0,
							"parameter_order": 0,
							"parameter_speedlim": 0,
							"parameter_steps": 0,
							"parameter_exponent": 1,
							"parameter_annotation_name": "",
							"parameter_info": "",
							"parameter_units": ""
						}
					}
				}
			},
			{
				"box": {
					"id": "head-rule",
					"maxclass": "live.line",
					"varname": "head-rule",
					"numinlets": 1,
					"numoutlets": 0,
					"patching_rect": [
						40,
						50,
						160,
						8
					],
					"presentation": 1,
					"presentation_rect": [
						8,
						26,
						304,
						8
					],
					"justification": 1,
					"linecolor": [
						0.258824,
						0.258824,
						0.258824,
						1
					]
				}
			},
			{
				"box": {
					"id": "state-label",
					"maxclass": "live.comment",
					"varname": "state-label",
					"numinlets": 1,
					"numoutlets": 0,
					"patching_rect": [
						340,
						20,
						200,
						24
					],
					"presentation": 1,
					"presentation_rect": [
						8,
						44,
						200,
						24
					],
					"text": "Arrêté",
					"fontsize": 16,
					"textcolor": [
						0.627451,
						0.627451,
						0.627451,
						1
					]
				}
			},
			{
				"box": {
					"id": "state-detail",
					"maxclass": "live.comment",
					"varname": "state-detail",
					"numinlets": 1,
					"numoutlets": 0,
					"patching_rect": [
						340,
						50,
						250,
						18
					],
					"presentation": 1,
					"presentation_rect": [
						8,
						72,
						250,
						18
					],
					"text": "device prêt",
					"fontsize": 10,
					"textcolor": [
						0.501961,
						0.501961,
						0.501961,
						1
					]
				}
			},
			{
				"box": {
					"id": "meter-left",
					"maxclass": "live.meter~",
					"varname": "meter-left",
					"numinlets": 1,
					"numoutlets": 2,
					"patching_rect": [
						560,
						20,
						14,
						60
					],
					"presentation": 1,
					"presentation_rect": [
						288,
						40,
						10,
						54
					],
					"outlettype": [
						"float",
						"int"
					],
					"bgcolor": [
						0.019608,
						0.019608,
						0.019608,
						1
					]
				}
			},
			{
				"box": {
					"id": "meter-right",
					"maxclass": "live.meter~",
					"varname": "meter-right",
					"numinlets": 1,
					"numoutlets": 2,
					"patching_rect": [
						580,
						20,
						14,
						60
					],
					"presentation": 1,
					"presentation_rect": [
						302,
						40,
						10,
						54
					],
					"outlettype": [
						"float",
						"int"
					],
					"bgcolor": [
						0.019608,
						0.019608,
						0.019608,
						1
					]
				}
			},
			{
				"box": {
					"id": "band-rule",
					"maxclass": "live.line",
					"varname": "band-rule",
					"numinlets": 1,
					"numoutlets": 0,
					"patching_rect": [
						340,
						80,
						160,
						8
					],
					"presentation": 1,
					"presentation_rect": [
						8,
						96,
						304,
						8
					],
					"justification": 1,
					"linecolor": [
						0.258824,
						0.258824,
						0.258824,
						1
					]
				}
			},
			{
				"box": {
					"id": "live-title",
					"maxclass": "live.comment",
					"varname": "live-title",
					"numinlets": 1,
					"numoutlets": 0,
					"patching_rect": [
						340,
						110,
						84,
						18
					],
					"presentation": 1,
					"presentation_rect": [
						8,
						104,
						84,
						18
					],
					"text": "Diffusion",
					"fontsize": 10,
					"textcolor": [
						0.501961,
						0.501961,
						0.501961,
						1
					]
				}
			},
			{
				"box": {
					"id": "quality-label",
					"maxclass": "live.comment",
					"varname": "quality-label",
					"numinlets": 1,
					"numoutlets": 0,
					"patching_rect": [
						440,
						110,
						88,
						18
					],
					"presentation": 1,
					"presentation_rect": [
						100,
						104,
						88,
						18
					],
					"text": "Qualité",
					"fontsize": 10,
					"textcolor": [
						0.501961,
						0.501961,
						0.501961,
						1
					]
				}
			},
			{
				"box": {
					"id": "latency-label",
					"maxclass": "live.comment",
					"varname": "latency-label",
					"numinlets": 1,
					"numoutlets": 0,
					"patching_rect": [
						540,
						110,
						116,
						18
					],
					"presentation": 1,
					"presentation_rect": [
						196,
						104,
						116,
						18
					],
					"text": "Latence",
					"fontsize": 10,
					"textcolor": [
						0.501961,
						0.501961,
						0.501961,
						1
					]
				}
			},
			{
				"box": {
					"id": "start-toggle",
					"maxclass": "live.text",
					"varname": "start-toggle",
					"numinlets": 1,
					"numoutlets": 2,
					"patching_rect": [
						340,
						132,
						84,
						15
					],
					"presentation": 1,
					"presentation_rect": [
						8,
						124,
						84,
						15
					],
					"outlettype": [
						"",
						""
					],
					"mode": 1,
					"outputmode": 1,
					"appearance": 2,
					"lcdbgcolor": [
						0.019608,
						0.019608,
						0.019608,
						1
					],
					"lcdcolor": [
						0.952941,
						0.580392,
						0.12549,
						1
					],
					"textcolor": [
						0.501961,
						0.501961,
						0.501961,
						1
					],
					"textoncolor": [
						0,
						0,
						0,
						1
					],
					"fontsize": 10,
					"text": "LANCER",
					"texton": "ARRÊTER",
					"automation": "Arrete",
					"automationon": "Direct",
					"parameter_enable": 1,
					"saved_attribute_attributes": {
						"valueof": {
							"parameter_enum": [
								"Arrete",
								"Direct"
							],
							"parameter_type": 2,
							"parameter_unitstyle": 10,
							"parameter_mmin": 0,
							"parameter_mmax": 1,
							"parameter_initial": [
								0
							],
							"parameter_initial_enable": 1,
							"parameter_shortname": "Direct",
							"parameter_longname": "Direct",
							"parameter_invisible": 2,
							"parameter_modmode": 0,
							"parameter_modmin": 0,
							"parameter_modmax": 127,
							"parameter_linknames": 0,
							"parameter_order": 0,
							"parameter_speedlim": 0,
							"parameter_steps": 0,
							"parameter_exponent": 1,
							"parameter_annotation_name": "",
							"parameter_info": "",
							"parameter_units": ""
						}
					}
				}
			},
			{
				"box": {
					"id": "quality-menu",
					"maxclass": "live.menu",
					"varname": "quality-menu",
					"numinlets": 1,
					"numoutlets": 3,
					"patching_rect": [
						440,
						132,
						88,
						15
					],
					"presentation": 1,
					"presentation_rect": [
						100,
						124,
						88,
						15
					],
					"outlettype": [
						"",
						"",
						"float"
					],
					"fontsize": 10,
					"appearance": 1,
					"lcdbgcolor": [
						0.019608,
						0.019608,
						0.019608,
						1
					],
					"textcolor": [
						0.627451,
						0.627451,
						0.627451,
						1
					],
					"bordercolor": [
						0.258824,
						0.258824,
						0.258824,
						1
					],
					"parameter_enable": 1,
					"saved_attribute_attributes": {
						"valueof": {
							"parameter_enum": [
								"Stable 128",
								"Haute 192",
								"Studio 256"
							],
							"parameter_type": 2,
							"parameter_unitstyle": 10,
							"parameter_mmin": 0,
							"parameter_mmax": 2,
							"parameter_initial": [
								2
							],
							"parameter_initial_enable": 1,
							"parameter_shortname": "Qualite",
							"parameter_longname": "Qualite",
							"parameter_invisible": 1,
							"parameter_modmode": 0,
							"parameter_modmin": 0,
							"parameter_modmax": 127,
							"parameter_linknames": 0,
							"parameter_order": 0,
							"parameter_speedlim": 0,
							"parameter_steps": 0,
							"parameter_exponent": 1,
							"parameter_annotation_name": "",
							"parameter_info": "",
							"parameter_units": ""
						}
					}
				}
			},
			{
				"box": {
					"id": "latency-menu",
					"maxclass": "live.menu",
					"varname": "latency-menu",
					"numinlets": 1,
					"numoutlets": 3,
					"patching_rect": [
						540,
						132,
						116,
						15
					],
					"presentation": 1,
					"presentation_rect": [
						196,
						124,
						116,
						15
					],
					"outlettype": [
						"",
						"",
						"float"
					],
					"fontsize": 10,
					"appearance": 1,
					"lcdbgcolor": [
						0.019608,
						0.019608,
						0.019608,
						1
					],
					"textcolor": [
						0.627451,
						0.627451,
						0.627451,
						1
					],
					"bordercolor": [
						0.258824,
						0.258824,
						0.258824,
						1
					],
					"parameter_enable": 1,
					"saved_attribute_attributes": {
						"valueof": {
							"parameter_enum": [
								"Faible 200 ms",
								"Équilibrée 400 ms",
								"Stable 800 ms"
							],
							"parameter_type": 2,
							"parameter_unitstyle": 10,
							"parameter_mmin": 0,
							"parameter_mmax": 2,
							"parameter_initial": [
								1
							],
							"parameter_initial_enable": 1,
							"parameter_shortname": "Latence",
							"parameter_longname": "Latence",
							"parameter_invisible": 1,
							"parameter_modmode": 0,
							"parameter_modmin": 0,
							"parameter_modmax": 127,
							"parameter_linknames": 0,
							"parameter_order": 0,
							"parameter_speedlim": 0,
							"parameter_steps": 0,
							"parameter_exponent": 1,
							"parameter_annotation_name": "",
							"parameter_info": "",
							"parameter_units": ""
						}
					}
				}
			},
			{
				"box": {
					"id": "url-label",
					"maxclass": "live.comment",
					"varname": "url-label",
					"numinlets": 1,
					"numoutlets": 0,
					"patching_rect": [
						620,
						40,
						52,
						18
					],
					"presentation": 1,
					"presentation_rect": [
						8,
						40,
						52,
						18
					],
					"text": "Relais",
					"fontsize": 10,
					"textcolor": [
						0.501961,
						0.501961,
						0.501961,
						1
					]
				}
			},
			{
				"box": {
					"id": "url-field",
					"maxclass": "textedit",
					"varname": "url-field",
					"numinlets": 1,
					"numoutlets": 4,
					"outlettype": [
						"",
						"int",
						"",
						""
					],
					"patching_rect": [
						620,
						60,
						248,
						18
					],
					"presentation": 1,
					"presentation_rect": [
						64,
						40,
						248,
						18
					],
					"fontsize": 10,
					"bgcolor": [
						0.019608,
						0.019608,
						0.019608,
						1
					],
					"textcolor": [
						0.627451,
						0.627451,
						0.627451,
						1
					],
					"bordercolor": [
						0.258824,
						0.258824,
						0.258824,
						1
					]
				}
			},
			{
				"box": {
					"id": "token-label",
					"maxclass": "live.comment",
					"varname": "token-label",
					"numinlets": 1,
					"numoutlets": 0,
					"patching_rect": [
						620,
						85,
						52,
						18
					],
					"presentation": 1,
					"presentation_rect": [
						8,
						62,
						52,
						18
					],
					"text": "Token",
					"fontsize": 10,
					"textcolor": [
						0.501961,
						0.501961,
						0.501961,
						1
					]
				}
			},
			{
				"box": {
					"id": "token-field",
					"maxclass": "textedit",
					"varname": "token-field",
					"numinlets": 1,
					"numoutlets": 4,
					"outlettype": [
						"",
						"int",
						"",
						""
					],
					"patching_rect": [
						620,
						105,
						248,
						18
					],
					"presentation": 1,
					"presentation_rect": [
						64,
						62,
						248,
						18
					],
					"fontsize": 10,
					"bgcolor": [
						0.019608,
						0.019608,
						0.019608,
						1
					],
					"textcolor": [
						0.627451,
						0.627451,
						0.627451,
						1
					],
					"bordercolor": [
						0.258824,
						0.258824,
						0.258824,
						1
					]
				}
			},
			{
				"box": {
					"id": "save-button",
					"maxclass": "live.text",
					"varname": "save-button",
					"numinlets": 1,
					"numoutlets": 2,
					"patching_rect": [
						620,
						130,
						120,
						15
					],
					"presentation": 1,
					"presentation_rect": [
						64,
						86,
						120,
						15
					],
					"outlettype": [
						"",
						""
					],
					"parameter_enable": 0,
					"mode": 0,
					"outputmode": 1,
					"appearance": 2,
					"lcdbgcolor": [
						0.019608,
						0.019608,
						0.019608,
						1
					],
					"textcolor": [
						0.627451,
						0.627451,
						0.627451,
						1
					],
					"fontsize": 10,
					"text": "Enregistrer"
				}
			},
			{
				"box": {
					"id": "check-button",
					"maxclass": "live.text",
					"varname": "check-button",
					"numinlets": 1,
					"numoutlets": 2,
					"patching_rect": [
						750,
						130,
						120,
						15
					],
					"presentation": 1,
					"presentation_rect": [
						192,
						86,
						120,
						15
					],
					"outlettype": [
						"",
						""
					],
					"parameter_enable": 0,
					"mode": 0,
					"outputmode": 1,
					"appearance": 2,
					"lcdbgcolor": [
						0.019608,
						0.019608,
						0.019608,
						1
					],
					"textcolor": [
						0.627451,
						0.627451,
						0.627451,
						1
					],
					"fontsize": 10,
					"text": "Tester le relais"
				}
			},
			{
				"box": {
					"id": "relay-line",
					"maxclass": "live.comment",
					"varname": "relay-line",
					"numinlets": 1,
					"numoutlets": 0,
					"patching_rect": [
						620,
						155,
						250,
						18
					],
					"presentation": 1,
					"presentation_rect": [
						8,
						103,
						304,
						18
					],
					"text": "relais non testé",
					"fontsize": 10,
					"textcolor": [
						0.501961,
						0.501961,
						0.501961,
						1
					]
				}
			},
			{
				"box": {
					"id": "bridge-line",
					"maxclass": "live.comment",
					"varname": "bridge-line",
					"numinlets": 1,
					"numoutlets": 0,
					"patching_rect": [
						620,
						175,
						250,
						18
					],
					"presentation": 1,
					"presentation_rect": [
						8,
						121,
						304,
						18
					],
					"text": "encodeur en attente",
					"fontsize": 10,
					"textcolor": [
						0.501961,
						0.501961,
						0.501961,
						1
					]
				}
			},
			{
				"box": {
					"id": "foot-rule",
					"maxclass": "live.line",
					"varname": "foot-rule",
					"numinlets": 1,
					"numoutlets": 0,
					"patching_rect": [
						40,
						100,
						160,
						8
					],
					"presentation": 1,
					"presentation_rect": [
						8,
						139,
						304,
						8
					],
					"justification": 1,
					"linecolor": [
						0.258824,
						0.258824,
						0.258824,
						1
					]
				}
			},
			{
				"box": {
					"id": "config-line",
					"maxclass": "live.comment",
					"varname": "config-line",
					"numinlets": 1,
					"numoutlets": 0,
					"patching_rect": [
						40,
						120,
						250,
						18
					],
					"presentation": 1,
					"presentation_rect": [
						8,
						147,
						304,
						18
					],
					"text": "configuration inconnue",
					"fontsize": 10,
					"textcolor": [
						0.501961,
						0.501961,
						0.501961,
						1
					]
				}
			},
			{
				"box": {
					"id": "live-prepend",
					"maxclass": "newobj",
					"text": "prepend live",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						40,
						260,
						90,
						22
					]
				}
			},
			{
				"box": {
					"id": "lock",
					"maxclass": "message",
					"text": "0",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						150,
						260,
						32,
						22
					]
				}
			},
			{
				"box": {
					"id": "unlock",
					"maxclass": "message",
					"text": "1",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						190,
						260,
						32,
						22
					]
				}
			},
			{
				"box": {
					"id": "toggle-reset",
					"maxclass": "message",
					"text": "set 0",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						240,
						260,
						50,
						22
					]
				}
			},
			{
				"box": {
					"id": "page-reset",
					"maxclass": "message",
					"text": "set 0",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						300,
						260,
						50,
						22
					]
				}
			},
			{
				"box": {
					"id": "active-prepend",
					"maxclass": "newobj",
					"text": "prepend active",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						150,
						300,
						100,
						22
					]
				}
			},
			{
				"box": {
					"id": "quality-fan",
					"maxclass": "newobj",
					"text": "t i i",
					"numinlets": 1,
					"numoutlets": 2,
					"outlettype": [
						"int",
						"int"
					],
					"patching_rect": [
						40,
						340,
						60,
						22
					]
				}
			},
			{
				"box": {
					"id": "quality-node",
					"maxclass": "newobj",
					"text": "prepend quality",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						40,
						380,
						110,
						22
					]
				}
			},
			{
				"box": {
					"id": "quality-encoder",
					"maxclass": "newobj",
					"text": "prepend quality",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						160,
						380,
						110,
						22
					]
				}
			},
			{
				"box": {
					"id": "latency-int",
					"maxclass": "newobj",
					"text": "t i",
					"numinlets": 1,
					"numoutlets": 1,
					"outlettype": [
						"int"
					],
					"patching_rect": [
						290,
						340,
						50,
						22
					]
				}
			},
			{
				"box": {
					"id": "latency-node",
					"maxclass": "newobj",
					"text": "prepend latency",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						290,
						380,
						110,
						22
					]
				}
			},
			{
				"box": {
					"id": "url-prepend",
					"maxclass": "newobj",
					"text": "prepend relayurl",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						250,
						430,
						120,
						22
					]
				}
			},
			{
				"box": {
					"id": "token-prepend",
					"maxclass": "newobj",
					"text": "prepend relaytoken",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						390,
						430,
						130,
						22
					]
				}
			},
			{
				"box": {
					"id": "save-fan",
					"maxclass": "newobj",
					"text": "t b b b",
					"numinlets": 1,
					"numoutlets": 3,
					"outlettype": [
						"bang",
						"bang",
						"bang"
					],
					"patching_rect": [
						560,
						380,
						70,
						22
					]
				}
			},
			{
				"box": {
					"id": "save-message",
					"maxclass": "message",
					"text": "saveconfig",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						560,
						420,
						80,
						22
					]
				}
			},
			{
				"box": {
					"id": "check-fan",
					"maxclass": "newobj",
					"text": "t b",
					"numinlets": 1,
					"numoutlets": 1,
					"outlettype": [
						"bang"
					],
					"patching_rect": [
						700,
						380,
						40,
						22
					]
				}
			},
			{
				"box": {
					"id": "check-message",
					"maxclass": "message",
					"text": "checkrelay",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						700,
						420,
						80,
						22
					]
				}
			},
			{
				"box": {
					"id": "node",
					"maxclass": "newobj",
					"text": "node.script node/index.js @autostart 1",
					"numinlets": 1,
					"numoutlets": 2,
					"outlettype": [
						"",
						""
					],
					"patching_rect": [
						420,
						300,
						300,
						22
					]
				}
			},
			{
				"box": {
					"id": "node-route",
					"maxclass": "newobj",
					"text": "route port publisher encoder config saved relay status urlfield",
					"numinlets": 1,
					"numoutlets": 9,
					"outlettype": [
						"",
						"",
						"",
						"",
						"",
						"",
						"",
						""
					],
					"patching_rect": [
						420,
						340,
						420,
						22
					]
				}
			},
			{
				"box": {
					"id": "audio-in",
					"maxclass": "newobj",
					"text": "plugin~",
					"numinlets": 2,
					"numoutlets": 2,
					"outlettype": [
						"signal",
						"signal"
					],
					"patching_rect": [
						40,
						500,
						60,
						22
					]
				}
			},
			{
				"box": {
					"id": "audio-out",
					"maxclass": "newobj",
					"text": "plugout~",
					"numinlets": 2,
					"numoutlets": 2,
					"outlettype": [
						"signal",
						"signal"
					],
					"patching_rect": [
						40,
						620,
						65,
						22
					]
				}
			},
			{
				"box": {
					"id": "port-prepend",
					"maxclass": "newobj",
					"text": "prepend port",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						200,
						520,
						90,
						22
					]
				}
			},
			{
				"box": {
					"id": "encoder",
					"maxclass": "newobj",
					"text": "vassi.encoder~",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						200,
						560,
						110,
						22
					]
				}
			},
			{
				"box": {
					"id": "meter-active",
					"maxclass": "newobj",
					"text": "prepend active",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						340,
						500,
						100,
						22
					]
				}
			},
			{
				"box": {
					"id": "state-split",
					"maxclass": "newobj",
					"text": "zl slice 1",
					"numinlets": 2,
					"numoutlets": 2,
					"outlettype": [
						"",
						""
					],
					"patching_rect": [
						460,
						480,
						80,
						22
					]
				}
			},
			{
				"box": {
					"id": "state-select",
					"maxclass": "newobj",
					"text": "sel STOPPED CONNECTING LIVE RECONNECTING ERROR",
					"numinlets": 1,
					"numoutlets": 6,
					"outlettype": [
						"bang",
						"bang",
						"bang",
						"bang",
						"bang",
						""
					],
					"patching_rect": [
						460,
						520,
						300,
						22
					]
				}
			},
			{
				"box": {
					"id": "state-word-0",
					"maxclass": "message",
					"text": "Arrêté",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						460,
						560,
						64,
						22
					]
				}
			},
			{
				"box": {
					"id": "state-word-1",
					"maxclass": "message",
					"text": "Connexion",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						530,
						560,
						64,
						22
					]
				}
			},
			{
				"box": {
					"id": "state-word-2",
					"maxclass": "message",
					"text": "Live",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						600,
						560,
						64,
						22
					]
				}
			},
			{
				"box": {
					"id": "state-word-3",
					"maxclass": "message",
					"text": "Reconnexion",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						670,
						560,
						64,
						22
					]
				}
			},
			{
				"box": {
					"id": "state-word-4",
					"maxclass": "message",
					"text": "Erreur",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						740,
						560,
						64,
						22
					]
				}
			},
			{
				"box": {
					"id": "state-set",
					"maxclass": "newobj",
					"text": "prepend set",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						460,
						600,
						80,
						22
					]
				}
			},
			{
				"box": {
					"id": "detail-set",
					"maxclass": "newobj",
					"text": "prepend set",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						560,
						600,
						80,
						22
					]
				}
			},
			{
				"box": {
					"id": "config-set",
					"maxclass": "newobj",
					"text": "prepend set",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						880,
						480,
						80,
						22
					]
				}
			},
			{
				"box": {
					"id": "relay-set",
					"maxclass": "newobj",
					"text": "prepend set",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						980,
						480,
						80,
						22
					]
				}
			},
			{
				"box": {
					"id": "bridge-name",
					"maxclass": "newobj",
					"text": "prepend Encodeur",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						1080,
						480,
						120,
						22
					]
				}
			},
			{
				"box": {
					"id": "bridge-set",
					"maxclass": "newobj",
					"text": "prepend set",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						1080,
						520,
						80,
						22
					]
				}
			},
			{
				"box": {
					"id": "url-set",
					"maxclass": "newobj",
					"text": "prepend set",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						1220,
						480,
						80,
						22
					]
				}
			},
			{
				"box": {
					"id": "saved-split",
					"maxclass": "newobj",
					"text": "zl slice 1",
					"numinlets": 2,
					"numoutlets": 2,
					"outlettype": [
						"",
						""
					],
					"patching_rect": [
						880,
						540,
						80,
						22
					]
				}
			},
			{
				"box": {
					"id": "saved-ok",
					"maxclass": "newobj",
					"text": "sel 1",
					"numinlets": 2,
					"numoutlets": 2,
					"outlettype": [
						"bang",
						""
					],
					"patching_rect": [
						880,
						580,
						60,
						22
					]
				}
			},
			{
				"box": {
					"id": "token-clear",
					"maxclass": "message",
					"text": "clear",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						880,
						620,
						50,
						22
					]
				}
			},
			{
				"box": {
					"id": "page-select",
					"maxclass": "newobj",
					"text": "sel 0 1",
					"numinlets": 1,
					"numoutlets": 3,
					"outlettype": [
						"bang",
						"bang",
						""
					],
					"patching_rect": [
						880,
						260,
						70,
						22
					]
				}
			},
			{
				"box": {
					"id": "show-live",
					"maxclass": "message",
					"text": "script hide url-label, script hide url-field, script hide token-label, script hide token-field, script hide save-button, script hide check-button, script hide relay-line, script hide bridge-line, script show state-label, script show state-detail, script show meter-left, script show meter-right, script show band-rule, script show live-title, script show start-toggle, script show quality-label, script show quality-menu, script show latency-label, script show latency-menu",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						880,
						300,
						300,
						22
					]
				}
			},
			{
				"box": {
					"id": "show-settings",
					"maxclass": "message",
					"text": "script hide state-label, script hide state-detail, script hide meter-left, script hide meter-right, script hide band-rule, script hide live-title, script hide start-toggle, script hide quality-label, script hide quality-menu, script hide latency-label, script hide latency-menu, script show url-label, script show url-field, script show token-label, script show token-field, script show save-button, script show check-button, script show relay-line, script show bridge-line",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						880,
						340,
						300,
						22
					]
				}
			},
			{
				"box": {
					"id": "pages",
					"maxclass": "newobj",
					"text": "thispatcher",
					"numinlets": 1,
					"numoutlets": 2,
					"outlettype": [
						"",
						""
					],
					"patching_rect": [
						880,
						380,
						90,
						22
					]
				}
			},
			{
				"box": {
					"id": "device-ready",
					"maxclass": "newobj",
					"text": "live.thisdevice",
					"numinlets": 1,
					"numoutlets": 3,
					"outlettype": [
						"bang",
						"int",
						"int"
					],
					"patching_rect": [
						1180,
						260,
						110,
						22
					]
				}
			},
			{
				"box": {
					"id": "ready-delay",
					"maxclass": "newobj",
					"text": "delay 1500",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						"bang"
					],
					"patching_rect": [
						1180,
						300,
						90,
						22
					]
				}
			},
			{
				"box": {
					"id": "ready-fan",
					"maxclass": "newobj",
					"text": "t b b b b",
					"numinlets": 1,
					"numoutlets": 4,
					"outlettype": [
						"bang",
						"bang",
						"bang",
						"bang"
					],
					"patching_rect": [
						1180,
						340,
						90,
						22
					]
				}
			},
			{
				"box": {
					"id": "ask-port",
					"maxclass": "message",
					"text": "getport",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						1180,
						400,
						60,
						22
					]
				}
			},
			{
				"box": {
					"id": "ask-config",
					"maxclass": "message",
					"text": "config",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"patching_rect": [
						1260,
						400,
						60,
						22
					]
				}
			}
		],
		"lines": [
			{
				"patchline": {
					"source": [
						"audio-in",
						0
					],
					"destination": [
						"audio-out",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"audio-in",
						1
					],
					"destination": [
						"audio-out",
						1
					]
				}
			},
			{
				"patchline": {
					"source": [
						"audio-in",
						0
					],
					"destination": [
						"encoder",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"audio-in",
						1
					],
					"destination": [
						"encoder",
						1
					]
				}
			},
			{
				"patchline": {
					"source": [
						"audio-in",
						0
					],
					"destination": [
						"meter-left",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"audio-in",
						1
					],
					"destination": [
						"meter-right",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"node",
						0
					],
					"destination": [
						"node-route",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"node-route",
						0
					],
					"destination": [
						"port-prepend",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"node-route",
						1
					],
					"destination": [
						"state-split",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"node-route",
						2
					],
					"destination": [
						"encoder",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"node-route",
						3
					],
					"destination": [
						"config-set",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"node-route",
						4
					],
					"destination": [
						"saved-split",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"node-route",
						5
					],
					"destination": [
						"relay-set",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"node-route",
						6
					],
					"destination": [
						"bridge-name",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"node-route",
						7
					],
					"destination": [
						"url-set",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"state-split",
						0
					],
					"destination": [
						"state-select",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"state-split",
						1
					],
					"destination": [
						"detail-set",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"detail-set",
						0
					],
					"destination": [
						"state-detail",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"state-select",
						0
					],
					"destination": [
						"state-word-0",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"state-select",
						1
					],
					"destination": [
						"state-word-1",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"state-select",
						2
					],
					"destination": [
						"state-word-2",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"state-select",
						3
					],
					"destination": [
						"state-word-3",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"state-select",
						4
					],
					"destination": [
						"state-word-4",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"state-word-0",
						0
					],
					"destination": [
						"state-set",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"state-word-1",
						0
					],
					"destination": [
						"state-set",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"state-word-2",
						0
					],
					"destination": [
						"state-set",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"state-word-3",
						0
					],
					"destination": [
						"state-set",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"state-word-4",
						0
					],
					"destination": [
						"state-set",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"state-set",
						0
					],
					"destination": [
						"state-label",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"config-set",
						0
					],
					"destination": [
						"config-line",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"relay-set",
						0
					],
					"destination": [
						"relay-line",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"bridge-name",
						0
					],
					"destination": [
						"bridge-set",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"bridge-set",
						0
					],
					"destination": [
						"bridge-line",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"url-set",
						0
					],
					"destination": [
						"url-field",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"saved-split",
						0
					],
					"destination": [
						"saved-ok",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"saved-split",
						1
					],
					"destination": [
						"config-set",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"saved-ok",
						0
					],
					"destination": [
						"token-clear",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"token-clear",
						0
					],
					"destination": [
						"token-field",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"port-prepend",
						0
					],
					"destination": [
						"encoder",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"start-toggle",
						0
					],
					"destination": [
						"live-prepend",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"live-prepend",
						0
					],
					"destination": [
						"node",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"state-select",
						0
					],
					"destination": [
						"unlock",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"state-select",
						1
					],
					"destination": [
						"lock",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"state-select",
						2
					],
					"destination": [
						"lock",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"state-select",
						3
					],
					"destination": [
						"lock",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"state-select",
						4
					],
					"destination": [
						"unlock",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"lock",
						0
					],
					"destination": [
						"active-prepend",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"unlock",
						0
					],
					"destination": [
						"active-prepend",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"active-prepend",
						0
					],
					"destination": [
						"quality-menu",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"active-prepend",
						0
					],
					"destination": [
						"latency-menu",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"state-select",
						0
					],
					"destination": [
						"toggle-reset",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"state-select",
						4
					],
					"destination": [
						"toggle-reset",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"toggle-reset",
						0
					],
					"destination": [
						"start-toggle",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"quality-menu",
						0
					],
					"destination": [
						"quality-fan",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"quality-fan",
						1
					],
					"destination": [
						"quality-encoder",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"quality-fan",
						0
					],
					"destination": [
						"quality-node",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"quality-encoder",
						0
					],
					"destination": [
						"encoder",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"quality-node",
						0
					],
					"destination": [
						"node",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"latency-menu",
						0
					],
					"destination": [
						"latency-int",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"latency-int",
						0
					],
					"destination": [
						"latency-node",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"latency-node",
						0
					],
					"destination": [
						"node",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"save-button",
						0
					],
					"destination": [
						"save-fan",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"save-fan",
						2
					],
					"destination": [
						"url-field",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"save-fan",
						1
					],
					"destination": [
						"token-field",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"save-fan",
						0
					],
					"destination": [
						"save-message",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"save-message",
						0
					],
					"destination": [
						"node",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"url-field",
						0
					],
					"destination": [
						"url-prepend",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"token-field",
						0
					],
					"destination": [
						"token-prepend",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"url-prepend",
						0
					],
					"destination": [
						"node",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"token-prepend",
						0
					],
					"destination": [
						"node",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"check-button",
						0
					],
					"destination": [
						"check-fan",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"check-fan",
						0
					],
					"destination": [
						"check-message",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"check-message",
						0
					],
					"destination": [
						"node",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"page-tabs",
						0
					],
					"destination": [
						"page-select",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"page-select",
						0
					],
					"destination": [
						"show-live",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"page-select",
						1
					],
					"destination": [
						"show-settings",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"show-live",
						0
					],
					"destination": [
						"pages",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"show-settings",
						0
					],
					"destination": [
						"pages",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"device-ready",
						0
					],
					"destination": [
						"show-live",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"device-ready",
						0
					],
					"destination": [
						"toggle-reset",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"device-ready",
						0
					],
					"destination": [
						"page-reset",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"page-reset",
						0
					],
					"destination": [
						"page-tabs",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"device-ready",
						1
					],
					"destination": [
						"meter-active",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"meter-active",
						0
					],
					"destination": [
						"meter-left",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"meter-active",
						0
					],
					"destination": [
						"meter-right",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"device-ready",
						0
					],
					"destination": [
						"ready-delay",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"ready-delay",
						0
					],
					"destination": [
						"ready-fan",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"ready-fan",
						3
					],
					"destination": [
						"ask-port",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"ready-fan",
						2
					],
					"destination": [
						"quality-menu",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"ready-fan",
						1
					],
					"destination": [
						"latency-menu",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"ready-fan",
						0
					],
					"destination": [
						"ask-config",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"ask-port",
						0
					],
					"destination": [
						"node",
						0
					]
				}
			},
			{
				"patchline": {
					"source": [
						"ask-config",
						0
					],
					"destination": [
						"node",
						0
					]
				}
			}
		]
	}
}
