# Landing Hero Animation — Spec (planning)

> Companion to `docs/design-system.md`. This defines the hero's signature animation for the Laterlist landing. **Status: planning — do not implement yet.** Some layout values depend on the Figma frame (see §7 Open items).

## 1. Intent

One signature moment that tells the whole story wordlessly: **an overwhelming Watch Later pile resolves itself into a few tidy, colored folders.** It plays once when the page loads, then rests on the sorted "after" state. Subtle, transform/opacity only, Notion-calm — not flashy.

## 2. Stage

Inside the hero's "product frame" — the bottom rectangle in the Figma (a rounded, bordered surface, `--card` on `--background`, that reads as a small product window). Everything below happens *inside* that frame, which stays fixed in size. Two layers occupy the same box:

- **Layer A — the pile:** a tall vertical strip of ~24 monochrome "video rows" (thumbnail block + 2 text lines), grayscale only (`--secondary`/`--muted`), so there is zero color during the pile phase.
- **Layer B — the folders:** 4 colored folder shapes, hidden at start.

## 3. Beat sheet (total ≈ 2.4s)

| # | Time | What | How (transform/opacity only) |
|---|------|------|------|
| 1 | 0.0–1.0s | **Accelerating scroll.** The pile scrolls up, easing from calm into a fast blur — "endless videos." | Layer A `translateY` ramps with `power2.in` (slow→fast); `filter: blur()` 0→5px over the last 0.4s; optional `scaleY(.98)` squash at peak. |
| 2 | 1.0–1.35s | **Collapse.** The speeding pile compresses into a single neutral surface — the chaos resolving. | Layer A `scale` 1→0.92 + `opacity` 1→0, blur clears; a neutral placeholder card holds the box so it never looks empty. |
| 3 | 1.35–2.35s | **Folders deal out, staggered.** 4 colored folders pop in one after another (1‑2‑3‑4). | Layer B folders: each `opacity` 0→1 + `translateY` 14→0 + `scale` 0.9→1, `back.out(1.6)`, **stagger 0.16s**. |
| 4 | 2.35s+ | **Rest.** Settles on the 4 tidy folders. A tiny idle (optional): folders breathe `scale` ±0.01 once, or nothing. | — |

Easing tokens: entrance `back.out(1.6)`, scroll ramp `power2.in`, collapse `power2.inOut`. Nothing linear.

## 4. The four folders

Literal folder shapes (tab + body), each tinted with its category color, with a label and a small count. Pop order left→right:

| Pop | Category | Colour token | Label |
|----|----------|--------------|-------|
| 1 | Learn | `--cat-learn` `#6695F7` | Worth learning |
| 2 | Watch | `--cat-watch` `#70B665` | Worth watching |
| 3 | Music | `--cat-music` `#FFBAC3` | Music |
| 4 | Fun | `--cat-entertainment` `#FFDE66` | Just for fun |

(Outdated is intentionally excluded — it's the discard pile, not a selling point.) Folder shape: a rounded body with a raised tab on the top-left, filled with the category colour; label in `--background`-on-tint or dark ink for contrast (Lightpink/Dandelion need dark text). These folders are a **hero illustration**, so they may be more skeuomorphic than the flat product UI — that's allowed; the category colors keep them on-system.

## 5. Reduced motion

`@media (prefers-reduced-motion: reduce)`: **skip the animation entirely** and render the rest state — the 4 folders visible, no scroll, no blur. The story still reads (pile → folders) as a static "after." No autoplay, no motion.

## 6. Tech

- **Recommended: GSAP timeline.** The accelerate → collapse → staggered-deal choreography is a natural `gsap.timeline()` with a `stagger` on the folders. Trigger: play on load; if the hero can start below the fold, gate it with `ScrollTrigger { once: true, start: "top 80%" }` so it fires when seen. Load the `gsap-timeline` (and `gsap-scrolltrigger` if gating) skills before implementing.
- **Dependency note:** the landing (`web/index.html`) currently ships **zero JS libraries** (only tiny inline vanilla for the theme toggle). GSAP is ~a new dependency/CDN. If we want to stay dependency-free, this is implementable with the **Web Animations API** (`element.animate()` + a small timeline sequencer) — more code, no library. **Decision needed** (see §7).
- Animate only `transform`, `opacity`, `filter`. Set `will-change: transform` on the two layers during play; clear after. Blur is the one expensive property — keep it ≤5px and only during phase 1.
- Respect the theme: the frame + pile use theme tokens, so the animation looks right in both dark and light automatically. Folder colors are theme-independent (category tints).

## 7. Open items (need the Figma / a decision)

- **Landing layout** — the overall Notion-style page (hero copy, nav, section rhythm, where the product frame sits, its exact size/aspect). I couldn't read the Figma (Dev Mode MCP was off). Need the frame opened in Figma with Dev Mode MCP enabled, or a screenshot, to spec the layout precisely.
- **GSAP vs dependency-free** (§6) — pick one before implementation.
- **Exact frame dimensions / aspect ratio** from the Figma.
- **Folder count/count-badges** — do folders show a number (e.g. "312")? Optional polish.
- **Loop vs truly-once** — confirmed once + rest for now; revisit if it feels too fleeting.
