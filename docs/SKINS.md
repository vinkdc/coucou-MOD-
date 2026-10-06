# Skin bundles

A skin bundle gives Mochi a new hairstyle without touching the app: **Settings → Character → Import skin…** (a `.zip`) or **Folder…**. It is kept in `%LOCALAPPDATA%\Kotoba\skins\<id>\` and listed in the Character menu; **Remove** deletes it. This is for Windows and Linux (`windows/`).

**Mochi keeps its own body, eyes, blinks and every mood.** A skin is only what goes on top: hair behind the head, a fringe and side locks over it, a bow. Every skin is therefore built the same way, and every mood and animation Mochi has carries into the hair (it sways with head turns, swings on hops, bends when Mochi tilts).

A bundle is **data only**: one `manifest.json` and some PNG pictures. It can't run code, and Kotoba checks all of it before keeping anything (see the limits below). Before an import is kept, Settings shows its name, author, note and chat persona.

Art you didn't make is your responsibility: only import pictures you have the right to use. Bundles are never part of the app, the installer or the repo.

## Make one with the skin editor

**Settings → Character → Create…** opens the skin editor; **Edit…** opens the selected imported skin in it. No file needs to be written by hand:

1. **Pictures.** Drop the hair of your character (PNG with transparency is best; a plain white or single-colour background is removed automatically, and **Restore original** brings it back). One picture is enough. Add more for parts that should move on their own — a fringe, side locks, a ponytail, a bow — drawn on the same canvas, or drag and resize them into place.
2. **Each picture:** where it goes — *Behind Mochi*, *Over the head* (over the head but under the eyes) or *Over the eyes* (glasses, a mask; it can follow the eyes as Mochi looks around) — and how it moves (*Still*, *Swings* from a point — a bow —, or *Bends like hair*), with a feel (*Floppy*, *Bouncy*, *Subtle*). Drag the orange dots to set where it swings or bends from. **From example** (next to New) starts from the bundled flat-colour skin instead of an empty page.
3. **Fit on Mochi.** A blue Mochi outline with its eyes is drawn over your pictures. Drag it (ring), widen it (dot) and heighten it (square) until its eyes sit where your character's face goes and the hair covers the top of the head. The numbers are also editable; a smaller width or height makes the hair bigger on Mochi. The first picture gets a good first guess.
4. **Colours.** The skin colour of Mochi's body while this skin is worn: a few swatches (Mochi grey, skin tones, pink, mint, lavender, sky) or any colour. The preview follows as you pick.
5. **About.** Author, a note, and how it talks in the chat.

The **live preview** is the real character engine wearing your skin: it follows your pointer, and the mood buttons play every state. **Save and use** installs it and puts it on the island; **Export .zip…** writes a file anyone can import. Undo and redo: Ctrl+Z, Ctrl+Y.

## Try it

```
cd windows
node scripts/make-example-skin.mjs        # writes docs/examples/skin-example/
```

Then Import skin… → Folder… → pick `docs/examples/skin-example`: flat-colour hair, a bending ponytail and a swinging bow, the smallest skin that moves like a real one.

## Layout of a bundle

```
my-skin.zip   (or a folder; a zip may have one top-level folder)
  manifest.json
  back.png  fringe.png  tail.png  glasses.png  bow.png …
```

Every picture has the **same size** (`size`), drawn in the same coordinates, so a layer is just the artwork of one part on a transparent background. Nothing is cut at runtime.

## manifest.json

```jsonc
{
  "format": 2,                  // older bundles (format 1) drew a whole figure; make them again in the editor
  "id": "my-skin",              // a-z, 0-9, "-", max 32. Not "mochi" or "ribbon". Same id = update.
  "name": "My skin",            // max 40
  "author": "Me",               // optional
  "note": "Shown on import",    // optional
  "persona": "How it talks in chat",   // optional, max 2000 characters

  "size": { "w": 512, "h": 512 },      // pixels of every picture (max 4096 each way)
  "crop": { "x": 0, "y": 0, "w": 512, "h": 512 },  // optional: the part of the picture that is drawn

  "layers": [                           // drawn in this order; 1 to 16 pictures
    { "id": "tail", "src": "tail.png", "role": "back",
      "behavior": { "type": "bend", "root": [410, 120], "tipY": 470,
                    "bounds": [330, 60, 500, 500], "grid": [4, 8], "spring": "hair" } },
    { "id": "back", "src": "back.png", "role": "back", "parallax": 0.35 },
    { "id": "fringe", "src": "fringe.png", "role": "front" },
    { "id": "bow", "src": "bow.png", "role": "front",
      "behavior": { "type": "pivot", "pivot": [257, 89], "spring": "bow", "rotate": 0.5 } }
  ],

  "fit": { "width": 150, "height": 200, "centerX": 256, "eyeLine": 324 },
  "skinColor": "#efbf9a",       // optional: Mochi's body colour while worn; leave out for Mochi's grey

  "springs": {                          // optional overrides; the defaults are hair, bow, locks
    "hair": { "k": 30, "c": 3.6, "max": 0.32, "idle": [0.035, 1.1], "yaw": -2.6, "tilt": -3.6, "oy": 2.0, "sy": 2.0 }
  }
}
```

**Roles.** `back` layers sit behind Mochi's body. `front` layers are drawn over the body but under Mochi's eyes, so a fringe never covers them. `top` layers are drawn over the eyes as well (glasses, a mask); their `parallax` says how closely they follow the eyes as Mochi looks around (1, the default, slides with them; 0 stays put). A `front` layer with a `pivot` behavior (a bow) is also drawn on top, in layer order.

**Fit.** Mochi's head is squat and wide, so the pictures are placed on it by four numbers. `width` and `height` are picture pixels per Mochi radius, across and down: the smaller they are, the bigger the hair is on Mochi (height may be smaller than width to squat the hair onto the head). `centerX` is the picture x of the middle of the face and `eyeLine` the picture y of the eyes: that point lands on Mochi's eyes. Good starting values for hair drawn around a head: `width` ≈ the hair's width ÷ 3.2, `height` ≈ its height ÷ 2.2, `eyeLine` about 65 % of the way down. The editor shows Mochi's outline so you can set them by eye.

**Behaviors.** `bend` warps a layer on a grid so its tip whips while the root stays put (ponytails, side locks). `pivot` swings a layer about a point and can squash on hops (bows). No behavior: the layer just follows its role.

**Springs.** A spring is a damped pendulum pushed by the head turn (`yaw`), tilt, hops (`oy`) and squash (`sy`). `max` is the furthest it swings, `idle` a gentle sway `[amplitude, frequency]`. The hair itself barely slides when Mochi looks around (the body never moves, only its eyes do), so it keeps covering the head.

## Limits

Checked when importing, nothing is kept if one fails: only `manifest.json` and `.png` files (no folders, no other types); at most 24 files, 8 MB per picture, 32 MB in all; pictures at most 4096×4096; every picture named in the manifest must be present; zips with `..`, absolute paths or links are refused.
