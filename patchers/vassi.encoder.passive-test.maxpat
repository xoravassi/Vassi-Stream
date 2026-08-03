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
    "rect": [100.0, 100.0, 760.0, 460.0],
    "bglocked": 0,
    "openinpresentation": 0,
    "default_fontsize": 12.0,
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
    "devicewidth": 0.0,
    "description": "",
    "digest": "",
    "tags": "",
    "style": "",
    "subpatcher_template": "",
    "boxes": [
      {
        "box": {
          "id": "comment-1",
          "maxclass": "comment",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [60.0, 40.0, 500.0, 20.0],
          "text": "Test passif : plugin~ va directement vers plugout~ et aussi vers vassi.encoder~."
        }
      },
      {
        "box": {
          "id": "plugin",
          "maxclass": "newobj",
          "numinlets": 0,
          "numoutlets": 2,
          "outlettype": ["signal", "signal"],
          "patching_rect": [80.0, 100.0, 60.0, 22.0],
          "text": "plugin~"
        }
      },
      {
        "box": {
          "id": "plugout",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 0,
          "patching_rect": [80.0, 250.0, 65.0, 22.0],
          "text": "plugout~"
        }
      },
      {
        "box": {
          "id": "encoder",
          "maxclass": "newobj",
          "numinlets": 2,
          "numoutlets": 1,
          "outlettype": [""],
          "patching_rect": [260.0, 180.0, 105.0, 22.0],
          "text": "vassi.encoder~"
        }
      },
      {
        "box": {
          "id": "bang",
          "maxclass": "button",
          "numinlets": 1,
          "numoutlets": 1,
          "outlettype": ["bang"],
          "patching_rect": [260.0, 100.0, 24.0, 24.0]
        }
      },
      {
        "box": {
          "id": "reset",
          "maxclass": "message",
          "numinlets": 2,
          "numoutlets": 1,
          "outlettype": [""],
          "patching_rect": [305.0, 101.0, 42.0, 22.0],
          "text": "reset"
        }
      },
      {
        "box": {
          "id": "active-on",
          "maxclass": "message",
          "numinlets": 2,
          "numoutlets": 1,
          "outlettype": [""],
          "patching_rect": [365.0, 101.0, 58.0, 22.0],
          "text": "active 1"
        }
      },
      {
        "box": {
          "id": "active-off",
          "maxclass": "message",
          "numinlets": 2,
          "numoutlets": 1,
          "outlettype": [""],
          "patching_rect": [440.0, 101.0, 58.0, 22.0],
          "text": "active 0"
        }
      },
      {
        "box": {
          "id": "print",
          "maxclass": "newobj",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [260.0, 250.0, 150.0, 22.0],
          "text": "print vassi.encoder"
        }
      },
      {
        "box": {
          "id": "comment-2",
          "maxclass": "comment",
          "numinlets": 1,
          "numoutlets": 0,
          "patching_rect": [260.0, 300.0, 385.0, 20.0],
          "text": "bang doit afficher blocks total gauche droite samples dans la console Max."
        }
      }
    ],
    "lines": [
      {
        "patchline": {
          "source": ["plugin", 0],
          "destination": ["plugout", 0]
        }
      },
      {
        "patchline": {
          "source": ["plugin", 1],
          "destination": ["plugout", 1]
        }
      },
      {
        "patchline": {
          "source": ["plugin", 0],
          "destination": ["encoder", 0]
        }
      },
      {
        "patchline": {
          "source": ["plugin", 1],
          "destination": ["encoder", 1]
        }
      },
      {
        "patchline": {
          "source": ["bang", 0],
          "destination": ["encoder", 0]
        }
      },
      {
        "patchline": {
          "source": ["reset", 0],
          "destination": ["encoder", 0]
        }
      },
      {
        "patchline": {
          "source": ["active-on", 0],
          "destination": ["encoder", 0]
        }
      },
      {
        "patchline": {
          "source": ["active-off", 0],
          "destination": ["encoder", 0]
        }
      },
      {
        "patchline": {
          "source": ["encoder", 0],
          "destination": ["print", 0]
        }
      }
    ]
  }
}
