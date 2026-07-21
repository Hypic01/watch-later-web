# Laterlist — Design System

> Reference documentation for the Laterlist visual language — **already implemented across this repo** (web app, landing, legal pages, Chrome extension). Use it to keep future work consistent. The canonical token values live in `web/src/styles.css` (`:root` + `:root[data-theme="light"]`) with a hand-mirrored copy in the landing `web/index.html` inline `<style>`. **Any token change must be made in both places.**

---

## 1. Philosophy

Laterlist is a fast, modern **utility** that clears a user's YouTube Watch Later backlog — not a library, not a luxury product. The system expresses that with two rules:

1. **The interface is monochrome.** Black & white only (specifically Woodsmoke `#191919` and Gainsboro `#D9D9D9`). No brand hue. The dark/light toggle simply swaps which is background and which is foreground.
2. **Colour means one thing: category.** The only colour anywhere is the five category/shelf tints. If something is coloured, it is telling you which shelf a video belongs to. Nothing else — no coloured buttons, no coloured links, no gradients, no glows.

Dark is the default. Type is set in a condensed display face (Fjalla One) over a neutral workhorse (Inter), with a monospace for data. No serif, no texture, no decoration.

---

## 2. Color tokens

Semantic tokens (shadcn-style: every surface travels with the foreground legible on it). **Consume tokens, never raw hex, in component code.** A legacy `--color-*` alias layer exists in the app CSS so older rules keep resolving — new code should prefer the short names below.

### Dark theme — `:root` (default)

```css
--background: #191919;   /* Woodsmoke */
--foreground: #D9D9D9;   /* Gainsboro */
--card:       #212121;
--popover:    #292929;
--secondary:  #2E2E2E;
--muted:      #9A9A9A;
--faint:      #6E6E6E;
--border:        rgba(217,217,217,.10);
--border-strong: rgba(217,217,217,.18);

/* Brand is monochrome: the accent IS the foreground, so it flips with the theme */
--accent:            var(--foreground);
--accent-hover:      color-mix(in srgb, var(--foreground) 82%, var(--background));
--accent-foreground: var(--background);
--primary:           var(--accent);
--ring:              var(--accent);

--destructive: #EC614B;          /* Coral — the one functional-danger hue */
--success:     var(--foreground);/* "done" is monochrome + a check glyph, not green */
--warning:     #D9A441;
```

### Light theme — `:root[data-theme="light"]`

```css
--background: #D9D9D9;   /* Gainsboro canvas */
--foreground: #191919;   /* Woodsmoke ink */
--card:       #EDEDED;   /* raised surfaces go LIGHTER than the canvas so cards lift */
--popover:    #F4F4F4;
--secondary:  #E4E4E4;
--muted:      #5A5A5A;
--faint:      #7C7C7C;
--border:        rgba(25,25,25,.14);
--border-strong: rgba(25,25,25,.24);
--destructive: #D8452C;
--warning:     #9A6B12;
/* --accent, --success inherit --foreground → flip to Woodsmoke automatically */
```

### Category tints — the ONLY colour (identical in both themes)

Copied exactly from the source palette. Used for shelf identity: the 4px shelf tab, the category dot/icon, and category pills. Every coloured element is always paired with a text label, so colour is supplementary (never the sole signal).

| Category | Token | Colour | Hex |
|---|---|---|---|
| Learn — "Worth learning from" | `--cat-learn` | Cornflowerblue | `#6695F7` |
| Watch — "Worth watching" | `--cat-watch` | Fern | `#70B665` |
| Music | `--cat-music` | Lightpink | `#FFBAC3` |
| Fun / Entertainment — "Just for fun" | `--cat-entertainment` (app) / `--cat-fun` (landing) | Dandelion | `#FFDE66` |
| Outdated | `--cat-outdated` | Coral | `#EC614B` |

> Note: on the light (Gainsboro) canvas, Lightpink and Dandelion dots are low-contrast. That's acceptable because the shelf label always carries the meaning. If a design calls for a coloured chip with coloured *text* on light, darken the text via `color-mix` to hold 4.5:1 — don't change the tab/dot hue.

---

## 3. Typography

Load once (shared across app + landing + legal pages):

```html
<link href="https://fonts.googleapis.com/css2?family=Fjalla+One&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```

```css
--font-display: 'Fjalla One', -apple-system, BlinkMacSystemFont, sans-serif;
--font-body:    'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
--font-mono:    'JetBrains Mono', ui-monospace, monospace;
```

- **Fjalla One** — brand wordmark + all headings. **It ships only weight 400.** Do NOT set `font-weight: 300/500/600/700` on display elements expecting a change — it won't render. It reads bold/condensed by nature. Control hierarchy with **size** and **letter-spacing** (condensed faces want slightly looser tracking at large sizes; the wordmark uses tight negative tracking, e.g. `-.01em`).
- **Inter** — all body copy, UI labels, buttons, paragraphs. Weights 400/500/600/700.
- **JetBrains Mono** — data only: counts, durations, timestamps, token strings, eyebrow labels, code. Use `font-variant-numeric: tabular-nums` for anything that updates.

Wordmark is lowercase: **`laterlist`**. Descriptor **"for YouTube"** sits beside it as a small mono pill (never put "YouTube" *in* the name). Product name in prose/titles is **"Laterlist"**.

---

## 4. Spacing, radius, shadow, motion

```css
--space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
--space-5: 24px; --space-6: 32px; --space-7: 48px;

--radius-sm: 4px; --radius-md: 7px; --radius-lg: 11px; --radius-pill: 999px;

/* neutral shadows only — no coloured glow, ever */
--shadow-card:   0 1px 2px rgba(0,0,0,.5);      /* light theme: rgba(25,25,25,.08) */
--shadow-raised: 0 12px 32px rgba(0,0,0,.55);   /* light theme: rgba(25,25,25,.16) */

--speed: 200ms;
--ease:  cubic-bezier(.2,.7,.3,1);
```

Motion is restrained: 150–250ms transitions on `transform`/`opacity`/colour only. One quiet entrance (a small rise/fade) per view. Respect `prefers-reduced-motion` (the app already disables transitions under it). The landing hero animation is the single "signature moment" and is speced separately.

---

## 5. Theming mechanism

- Preference key: `localStorage['laterlist:theme']`, values `'dark'` (default) | `'light'`.
- Light is applied by stamping `document.documentElement.dataset.theme = 'light'` (i.e. `<html data-theme="light">`). Dark = no attribute (it's the `:root` default).
- **FOUC guard** — first thing in every page `<head>`, before the stylesheet:
  ```html
  <script>try{if(localStorage.getItem('laterlist:theme')==='light')document.documentElement.dataset.theme='light'}catch(e){}</script>
  ```
- On toggle: flip the attribute, write localStorage, and update `<meta name="theme-color">` (`#191919` dark / `#D9D9D9` light).
- The landing and the app share the same key, so the choice carries across `/` → `/app`.
- Controls: an icon button in the app topbar and landing nav (sun shown in dark = "switch to light"; moon in light), plus an "Appearance" segmented control in Settings.

---

## 6. Components

- **Primary button** — `background: var(--accent); color: var(--accent-foreground)`. In dark that's a Gainsboro button with Woodsmoke text; in light, the inverse. Hover → `--accent-hover` + a neutral `--shadow-card`. Never a coloured button.
- **Ghost button** — `background: var(--secondary); border: 1px solid var(--border); color: var(--foreground)`. Hover raises border/background one step.
- **Card** (video) — `background: var(--card)`, `1px solid var(--border)`, `--radius-lg`, `--shadow-card`. Hover: `translateY(-3px)`, `--shadow-raised`, border tints toward the row's category (`--row-tint`).
- **Category pill / dot / shelf tab** — the only coloured elements. Use `--cat-*` (or a per-row `--row-tint` var set to it). Pill background = `color-mix(in srgb, var(--row-tint) 12%, transparent)`, text = the tint (darken on light theme if needed).
- **Reason line** (AI explanation on a card) — `--muted`, plain Inter, no italic, no hue.
- **Chips / selects / inputs** — `--card`/`--secondary` fill, `--border`, `--radius-pill` (chips) or `--radius-md` (inputs); focus → `--ring`.
- **Brand mark** — a list-with-check glyph, stroked in `currentColor` (monochrome). Source: `BrandMark` in `web/src/components/icons.jsx`; also the favicons and extension icons.
  ```
  <path d="M4 6h10M4 12h10M4 18h6"/><path d="M15 15l3 3 4-5"/>   (viewBox 0 0 24 24, stroke 2.1, round caps/joins)
  ```
- **Icons** — Lucide-style: 24×24 viewBox, `fill="none"`, `stroke="currentColor"`, stroke-width 2, round caps/joins. One family, consistent weight. No emoji.

---

## 7. Voice

Neutral **tool voice** — there is no mascot or persona (the old "librarian" character is gone). Where a subject is needed, say **"Laterlist"** or **"AI"**; otherwise write plainly ("Sorts your backlog into shelves"). Joon's copy rules apply: no dashes as punctuation, no AI-tell words, casual and specific.

---

## 8. Do / Don't

**Do**
- Keep all chrome monochrome; reach for colour only to identify a category.
- Drive heading hierarchy with size + tracking (Fjalla One is single-weight).
- Make every token change in **both** `web/src/styles.css` and the landing inline `<style>`.
- Check contrast in both themes independently.

**Don't**
- Add a coloured accent, gradient, or glow anywhere in the UI chrome.
- Set `font-weight` on Fjalla One expecting a visible change.
- Use a category colour for a non-category purpose (except `--destructive`, which deliberately reuses Coral for danger).
- Reintroduce serif type, film-grain, or the brass/pink/slate legacy colours.

---

## 9. Source-of-truth files

| Concern | File |
|---|---|
| App tokens + all component CSS | `web/src/styles.css` |
| Landing tokens (mirrored) + page CSS | `web/index.html` (inline `<style>`) |
| App shell (fonts, favicon, FOUC, title) | `web/app/index.html` |
| Icons incl. `BrandMark`, `SunIcon`, `MoonIcon` | `web/src/components/icons.jsx` |
| Theme toggle (topbar) | `web/src/App.jsx` (`ThemeToggle`) |
| Theme control (Settings) | `web/src/components/Settings.jsx` (Appearance block) |
| Extension popup (standalone, hardcoded palette) | `extension/popup.html` |

---

## 10. Landing hero animation

**Speced separately** in `docs/landing-hero-animation.md` (in planning). Do not implement from this doc — the animation choreography, triggers, and performance/reduced-motion rules are defined there.
