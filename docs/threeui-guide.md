# Build premium interactive websites with ThreeUI

Saved reference copy of the ThreeUI guide. How it applies to *this* repo lives in
`CLAUDE.md` → "Visual effects (ThreeUI / Three.js)". Where the two differ, `CLAUDE.md` wins.

ThreeUI (threeui.com/browse) is a free library of copy-ready Three.js components,
landing-page templates, WebGL backgrounds, hero sections, buttons, text animations,
UI effects and variants. Pick one interaction that fits the site, copy its prompt,
give it to a coding agent with the project, and make it yours.

## Categories

| If you need… | Category | Look for |
| --- | --- | --- |
| A full visual starting point | Landing Pages | Complete pages to adapt |
| A memorable first screen | Hero | Product heroes, editorial layouts, 3D hero scenes |
| A real 3D scene | Three.js | Interactive worlds, objects, fields, structures, landscapes |
| Depth without changing the layout | Backgrounds | Liquid forms, globes, CRT, constellations, portal fields, lasers |
| A detail people can feel | Buttons | Liquid metal, shader, circle, rectangle interactions |
| Motion around copy | Text Animation | Gallery headings, typography effects, text paths |
| Premium product details | UI Elements | Carousels, galleries, forms, toggles, diagnostics |
| Small details without a 3D scene | CSS | Lightweight effects and polish |

Picking:
- Portfolio / agency → Hero, then one Background.
- Product / SaaS → one Background or UI Element around a clean, readable hero.
- Expressive (music, fashion, gaming, film) → Three.js or Text Animation.
- Existing finished site → don't replace the layout; add one interaction to the section that feels flat.

**Don't make every section move.** One strong interaction in the right place beats ten
effects fighting for attention.

## Workflow

1. **Browse and choose one interaction.** Play with it: move the cursor, test variants
   and controls, decide where it belongs (hero, background, button, heading, product
   section). Choose for the product, not for complexity.
2. **Copy the component's prompt.** Also save: the component link, a screenshot of the
   component, and a screenshot of the section of *your* site where it goes.
3. **Paste into the coding agent** with the project open, followed by:

   ```
   I want to use this ThreeUI interaction inside my existing website.

   Put it in: [hero / background / button / product section]

   My website is for: [what your product or portfolio is]

   Keep my existing copy, layout, buttons, and sections intact.
   Make this interaction match my brand colours: [add your colours].

   On mobile, make it smooth, readable, and lighter if needed.
   Do not change unrelated parts of the website.

   Run the project after adding it and fix any errors before you finish.
   ```

   Attach both screenshots.
4. **Customise until it feels like yours.** Follow-up prompts:
   - Colours: "Keep the same interaction, but use [YOUR COLOURS]. Remove any default demo colours and make it feel like the rest of my website."
   - Calmer: "Keep the interaction, but make the motion slower and more subtle. It should feel premium and intentional, not distracting."
   - Readable: "Keep the visual behind the content, but make sure my heading, paragraph, and CTA are always readable. Do not let the interaction overlap the important copy."
   - Mobile: "Optimise this interaction for mobile. Reduce heavy effects if needed, preserve the main feeling, keep the text readable, and respect reduced-motion settings."
5. **Ship it.** Make sure the build/tests pass, push to GitHub, import the repo in Vercel
   (Add New → Project → Deploy). Every later push redeploys automatically.

## Make it look expensive, not generic

1. **Put it behind a strong idea.** The effect must support the product's mood
   (finance/SaaS → calm grid, soft globe, controlled data-style effect).
2. **Change more than one colour:** also intensity, speed, spacing around the headline,
   lighting/contrast, scale, and where the cursor interaction sits.
3. **Keep one "wow" moment** — the first screen or one important scroll moment.

## Common mistakes

- *Agent changed the whole site* → "Modify only this section. Preserve every other section, route, component, and style exactly as it is."
- *Bad on mobile* → reduce particle count, motion, or density; keep colour and mood.
- *Effect covers text* → move it behind content; add a subtle contrast layer only where needed. Never sacrifice the CTA.
- *Feels like a copied demo* → change colours, speed, spacing, headline, hierarchy, and how the interaction enters.
- *Site got slow* → one heavy effect at a time, non-essential effects below the fold, lighter on mobile, respect `prefers-reduced-motion`.
