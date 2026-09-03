# Design canvas

The console's design lives here as two Claude Design artboards plus the canvas
manifest that lays them out:

| File             | Artboard                                                         |
| ---------------- | ---------------------------------------------------------------- |
| `Main.dc.html`   | Desktop 1440×900 — app shell, list, graph editor                 |
| `Mobile.dc.html` | Phone 390×844 — the same definition, read rather than rearranged |
| `canvas.json`    | Positions, titles and the sticky notes beside them               |

Both artboards are interactive: the graph editor adds, moves and wires nodes,
triggers are edited a row at a time, and the list filters by tag.

Published at
<https://claude.ai/code/artifact/c1aeb5b5-afe2-4a3a-b2cd-ddcb08c7fd8d>.

## Changing it

Edit the `.dc.html` files here, then re-seed a **fresh** copy of the payload and
republish to the same URL. The seeder ships with Claude Code's `design` skill;
run `/design` first if its directory is not extracted.

```bash
D=<design skill base directory>
node "$D/seed-canvas.mjs" \
  --template "$D/payload.template.html" \
  --out bearclaw-console.html \
  --title "BearClaw Console" \
  --artboard Main.dc.html --artboard Mobile.dc.html \
  --canvas canvas.json

node "$D/seed-canvas.mjs" --check bearclaw-console.html
```

Then publish `bearclaw-console.html` with the Artifact tool, passing the
existing artifact URL, `contract: "0.1.31"` and the same favicon. Never edit a
seeded output file — always re-seed from these sources.

The seeded page is ~2.7 MB (it embeds the editor) and is not checked in; it is
regenerated from these three files.

## Keeping it honest

The canvas is documentation, so it should describe what `web/` actually does.
When a shipped screen changes shape — a new surface, a renamed workflow, a
different count — update the artboard in the same pass.
