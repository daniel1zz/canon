# UI prototype

A few UI variants rendered on one route, switchable from a floating bottom bar. Flip between them, pick one (or borrow parts from several), throw the rest away.

If the question is about logic or state, use `logic.md`. How different the variants may be is fixed by `../SKILL.md` §3: on an existing screen, visual and density only.

## Where the variants live

A variant is much easier to judge **against the rest of the app**: real header, real sidebar, real data, real density. On an empty route every variant looks fine.

- **Existing page (default).** Render the variants on the page's own route, gated by a `?variant=` search param. Data fetching, params and auth stay as they are; only the rendered subtree swaps. Something that would naturally live inside an existing page (a new section, card or step) is still this case: mount the variants inside the host page.
- **New page (last resort).** Only when there is genuinely no existing page to live in. Create a throwaway route under the project's routing convention, with `prototype` in its path or file name, same `?variant=` pattern. Check first that it really cannot be embedded somewhere: an empty route hides problems a populated one exposes.

## 1. State the question and pick N

Default 3 variants, at most 5 (beyond that they stop being different and become noise). Write the plan as one line at the top of the file, for example: "3 density variants of the settings page, switchable via `?variant=`, on the existing `/settings` route."

## 2. Draft the variants

Each variant serves the page's purpose with the data it actually has, uses the project's component library and design tokens (see `design-system-inheritance.md`), and is a clearly named export (`VariantA`, `VariantB`, ...).

Variants must genuinely differ along the axes they are allowed to vary. On an existing screen that means visibly different density, emphasis and visual treatment over the same layout; three near-identical copies are not a comparison. Structural differences only for a new screen or after a human chose them.

Out-of-scope regions of the page are a frozen frame identical across variants (`design-system-inheritance.md`, "Out-of-scope regions are frozen").

## 3. Wire the switcher

```tsx
// pseudo-code: adapt to the project's framework
const variant = searchParams.get('variant') ?? 'A';
return (
  <>
    {variant === 'A' && <VariantA {...data} />}
    {variant === 'B' && <VariantB {...data} />}
    {variant === 'C' && <VariantC {...data} />}
    <PrototypeSwitcher variants={['A', 'B', 'C']} current={variant} />
  </>
);
```

On an existing page, keep all existing data fetching above the switcher.

## 4. The floating switcher

A small fixed bar at the bottom centre: left arrow (previous, wraps), the variant label (key plus name, e.g. `B — compact rows`), right arrow (next, wraps).

- Arrows update the URL search param through the framework's router, so a variant is shareable and survives reload.
- `←` and `→` also cycle, except while an `<input>`, `<textarea>` or `[contenteditable]` has focus.
- Visually distinct from the design under evaluation (a high-contrast pill, a subtle shadow).
- **Hidden in production builds**: gate on `process.env.NODE_ENV !== 'production'` or the framework's equivalent, so a stray merge cannot ship it.
- One shared component, placed wherever the project keeps shared UI.

## 5. Hand it over and judge

Give the URL and the `?variant=` keys. Capture each variant (a screenshot per variant, or the URL) for the decision. Feedback such as "the header from B with the list from C" is usually the real design. Record the pick as `../SKILL.md` §4 describes, then clean up per §5.

## Anti-patterns

- Variants that differ only in copy: that is a tweak, not a comparison.
- Sharing so much between variants that they cannot differ on the allowed axes.
- Wiring variants to real mutations: read-only is fine; point anything that must write at a stub.
- Promoting variant code straight to production: it was written without tests; rewrite it when folding it in.
