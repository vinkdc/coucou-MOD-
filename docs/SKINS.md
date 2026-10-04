# Skin bundles

A skin bundle changes how Mochi looks without touching the app: **Settings → Character → Import skin…** (a `.zip`) or **Folder…**. It is kept in `%LOCALAPPDATA%\Coucou\skins\<id>\` and listed in the Character menu; **Remove** deletes it. This is for Windows and Linux (`windows/`).

A bundle is **data only**: one `manifest.json` and some PNG pictures. It can't run code, and Coucou checks all of it before keeping anything (see the limits below). Before an import is kept, Settings shows its name, author, note and chat persona.

Art you didn't make is your responsibility: only import pictures you have the right to use. Bundles are never part of the app, the installer or the repo.

## Make one with the skin editor

**Settings → Character → Create…** opens the skin editor; **Edit…** opens the selected imported skin in it. No file needs to be written by hand:

1. **Pictures.** Drop a picture of your character (PNG with transparency is best; a plain white or single-colour background is removed automatically, and **Restore original** brings it back). One picture is enough. Add more for parts that should move on their own — hair, a tail, arms, a bow — drawn on the same canvas, or drag and resize them into place.
2. **Each picture:** what it is (*Head*, *Behind the head*, *In front*, or *Irises*, which follow the pointer) and how it moves (*Still*, *Swings* from a point, or *Bends like hair*), with a feel (*Floppy*, *Bouncy*, *Subtle*). Drag the orange dots to set where it swings or bends from.
3. **Face.** Drag the head circle, the eyes (where it blinks), the chin (where it squashes and tilts from) and the cheeks onto your picture. *Pick from picture* takes the skin colour for the eyelids.
4. **Expressions** (optional). Drop a drawn face on a mood — happy, asleep, dizzy, in love… The purple face area is painted over first, then the face goes on. Moods without a picture use Mochi's eyes.
5. **About.** Author, a note, and how it talks in the chat.

The **live preview** is the real character engine wearing your skin: it follows your pointer, and the mood buttons play every state. **Save and use** installs it and puts it on the island; **Export .zip…** writes a file anyone can import. Undo and redo: Ctrl+Z, Ctrl+Y.

## Try it

```
cd windows
node scripts/make-example-skin.mjs        # writes docs/examples/skin-example/
```

Then Import skin… → Folder… → pick `docs/examples/skin-example`.

## Layout of a bundle

```
my-skin.zip   (or a folder; a zip may have one top-level folder)
  manifest.json
  head.png  tail.png  bow.png  iris.png …
```

Every picture has the **same size** (`size`), drawn in the same coordinates, so a layer is just the artwork of one part on a transparent background. Nothing is cut at runtime.

## manifest.json

```jsonc
{
  "format": 1,
  "id": "my-skin",              // a-z, 0-9, "-", max 32. Not "mochi" or "ribbon". Same id = update.
  "name": "My skin",            // max 40
  "author": "Me",               // optional
  "note": "Shown on import",    // optional
  "persona": "How it talks in chat",   // optional, max 2000 characters

  "size": { "w": 1306, "h": 1844 },    // pixels of every picture (max 4096 each way)
  "head": { "cx": 552, "cy": 672, "r": 486 },  // head circle; Mochi's size is matched to it
  "crop": { "x": 60, "y": 60, "w": 1190, "h": 1440 },  // optional: the part of the picture that is drawn
  "chin": 1156,                         // squash and tilt base (y)
  "tiltPivot": [552, 1160],

  "layers": [                           // drawn in this order; at least one "head"
    { "id": "tail", "src": "tail.png", "role": "back",
      "behavior": { "type": "bend", "root": [1030, 480], "tipY": 1490,
                    "bounds": [780, 380, 1250, 1500], "grid": [4, 8], "spring": "hair" } },
    { "id": "bow", "src": "bow.png", "role": "back", "parallax": 0.35,
      "behavior": { "type": "pivot", "pivot": [940, 350], "spring": "hair", "rotate": 0.15,
                    "squash": { "x": 0.18, "y": 0.14 }, "squashSpring": "bow" } },
    { "id": "head", "src": "head.png", "role": "head" },
    { "id": "lock", "src": "lock.png", "role": "front",
      "behavior": { "type": "pivot", "pivot": [255, 1005], "spring": "locks" } }
  ],

  "eyes": [                             // up to 2: where the eyelid and expression eyes go
    { "cx": 340, "cy": 900, "x0": 282, "x1": 400, "top": 848, "bottom": 966, "sd": -1 },
    { "cx": 714, "cy": 890, "x0": 656, "x1": 772, "top": 838, "bottom": 958, "sd": 1 }
  ],
  "iris": { "src": "iris.png", "follow": 30 },   // optional: irises slide to follow the cursor
  "lid": "rgb(255, 246, 224)",          // skin colour the eyelid is painted with
  "lash": "rgb(35, 22, 26)",
  "cheeks": [[350, 1030], [705, 1020]],
  "blush": { "rx": 50, "ry": 34, "color": "rgb(255, 140, 155)" },

  "expressions": {                      // optional: a drawn face per mood (Mochi's eye names)
    "happy": "face-happy.png", "closed": "face-closed.png", "spiral": "face-spiral.png"
  },
  "cover": [300, 820, 800, 1060],       // the face area painted with "lid" before an expression goes on
  "coverShape": "oval",                 // "rect" (pixel art) or "oval" (soft edge, painted art)

  "springs": {                          // optional overrides; the defaults are hair, bow, locks
    "hair": { "k": 30, "c": 3.6, "max": 0.32, "idle": [0.035, 1.1], "yaw": -2.6, "tilt": -3.6, "oy": 2.0, "sy": 2.0 }
  }
}
```

**Roles.** `head` layers turn and nod with the character and carry the face (irises, eyelids, blush are drawn on the last one). `back` layers sit behind it and slide the other way when it turns (`parallax`). `front` layers turn with the head and are drawn over it.

**Behaviors.** `bend` warps a layer on a grid so its tip whips while the root stays put (ponytails). `pivot` swings a layer about a point and can squash on hops (bows, side locks). No behavior: the layer just follows its role.

**Springs.** A spring is a damped pendulum pushed by the head turn (`yaw`), tilt, hops (`oy`) and squash (`sy`). `max` is the furthest it swings, `idle` a gentle sway `[amplitude, frequency]`.

**Expressions.** Every state Mochi has (happy, love, sleeping, thinking…) still works. The engine names an eye shape for each one — `pill` (open), `wide`, `flat`, `happy`, `closed`, `spiral`, `heart`, `star`, `tired`, `wink`, `line`, `dot` — and a skin can give a picture for any of them in `expressions`. A blink shows `closed` when there is one. Shapes without a picture are drawn as Mochi's eye, in `lash` colour, over your eyes.

## Limits

Checked when importing, nothing is kept if one fails: only `manifest.json` and `.png` files (no folders, no other types); at most 24 files, 8 MB per picture, 32 MB in all; pictures at most 4096×4096; every picture named in the manifest must be present; zips with `..`, absolute paths or links are refused.
