# Diagrams

Editable **Excalidraw** sources for the diagrams used in the project `README.md`, plus
their exported images.

| Source | Exported image | Used in |
| ------ | -------------- | ------- |
| `how-it-works.excalidraw` | `how-it-works.png` ✅ | README → **How it works** (the hero diagram) |
| `architecture.excalidraw` | `architecture.png` ⬜ | README → **Architecture** (service topology) |
| `model-routing.excalidraw` | `model-routing.png` ⬜ | README → **Settings / Task Models** (roles → providers) |
| `egress-isolation.excalidraw` | `egress-isolation.png` ⬜ | README → **Security notes** (agent holds no raw secret; proxy injects it) |

✅ exported & embedded · ⬜ awaiting your PNG export

## Exporting a `.excalidraw` source to PNG (~2 min)

1. Open <https://excalidraw.com> in your browser (scenes stay local to your browser —
   nothing is uploaded).
2. **Menu (☰) → Open**, pick the `.excalidraw` file — or just drag the file onto the
   canvas.
3. **Menu (☰) → Export image…** (shortcut `Ctrl/Cmd + Shift + E`).
4. Choose **PNG**, keep **Background** on, set scale to **2×** for a crisp image, then
   **Export**.
5. Save it into this folder with the matching name (e.g. `how-it-works.png`).

Tip: leave **Embed scene** enabled on export so the PNG stays re-editable if you open it
in Excalidraw again later.

Once `how-it-works.png` exists, the README's **How it works** section can point at it
with:

```markdown
![How AI Fleet works](diagrams/how-it-works.png)
```

## Re-editing

Open the `.excalidraw` file at <https://excalidraw.com> (or via the Excalidraw VS Code
extension), edit, then re-export the PNG over the old one.
