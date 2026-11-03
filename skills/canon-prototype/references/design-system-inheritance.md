# Inheriting the existing UI

Any mockup, prototype or visual spec in a project that already has a UI starts from **two inventories**: the design system (tokens, components) and the surface architecture (layouts, interaction patterns). Using the right tokens is not enough: variants that use the project's colours but move primary content somewhere else are still "breaking everything we have".

## 1. Inventory the design system (before the first mockup)

Look for the token and component sources, for example:

```bash
find . -maxdepth 3 \( -name 'globals.css' -o -name 'tailwind.config*' -o -name '*ui-standards*' -o -name '*design-system*' \) -not -path './node_modules/*'
ls src/components/ui components/ui 2>/dev/null
```

Any hit: read the canonical token source (a `@theme` block, a tokens file, a standards document), look at at least one existing screen to absorb the visual language, and use those tokens for every colour, font, radius, shadow and spacing value. A colour or radius that is not in the token source is invented; stop. No hits: the project has no system yet, and the tokens of the chosen variant become one (record them with the decision).

## 2. Inventory the surfaces the work touches

For every existing surface the new design touches (anything other than a brand-new isolated screen), read its components and note:

- **Container**: where it renders (sidebar section, timeline row, canvas panel, overlay).
- **Interaction pattern**: how it expands, collapses, focuses, dismisses (inline accordion, sheet, popover, modal, side panel, hover).
- **State model**: how open or focused state is tracked (store key, local state, URL param).
- **Content slots**: which slots already take extra content (`children`, a `secondary` or `meta` slot, a `detail` prop).

## 3. Default: minimal additive change

Add content to existing slots without changing layout or interaction:

- A brief in an approval row → the row's existing metadata slot; do not redesign the row.
- A new event on a timeline → a new event type in the existing renderer; do not re-architect the timeline.
- New settings → a new section in the existing settings pattern.
- A status chip in the top bar → the existing chip cluster.

## 4. Breaking changes need a direction decision

A change is **breaking** if it does any of these:

- replaces a layout primitive (3 columns → 4; sidebar-dominant → canvas-dominant);
- changes the primary interaction pattern of a surface (inline expand → overlay sheet; click to focus → hover popover);
- adds a top-level mechanism the app does not have (toast stack, command palette, notification centre);
- moves a component's role (approval content shown mainly in the canvas instead of the sidebar);
- promotes a secondary surface to primary, or demotes a primary one.

Each breaking change is asked of the humans **before** it is drawn, framed as "this changes existing X to Y": `canon human ask "..." --option "保持现有,改成 Y"`, one question per change. Until answered, build the additive version. Variants on an existing screen keep the architecture stable and differ only visually and in density (`../SKILL.md` §3).

| Rationalisation | Reality |
|---|---|
| "The user asked for 3 variants" | Three variants default to visual and density alternatives over the same architecture |
| "Linear / Slack are valid inspiration" | Inspiration informs tokens and micro-interactions, not architecture; "Slack-style toasts" in an app without toasts is a new mechanism |
| "The structural version is better UX" | Until a human chose it, it is still a breaking change; build the additive one first |
| "It is just a rough sketch" | Rough sketches anchor expectations; a wrong anchor becomes a wrong decision |

## 5. Out-of-scope regions are frozen

A scoped prototype shows more than the designed region (surrounding sidebar, canvas, navigation) for context. Those regions are a **frozen frame**, not an invitation to design.

1. **Default: an empty frame.** Out-of-scope regions keep only their real geometry (column widths, breakpoints, taken from the source) and are otherwise empty: a dashed inner border and a centred muted label "既有 UI 区域 · 非本次设计范围". This is cheaper than replicating them and makes the designed region unambiguous.
2. **Faithful replication only on request**, and then from a live screenshot or DOM of the running app, never from a text description of the source code (text-derived frames do not look like the real app).
3. **One canonical frame, passed verbatim.** Whoever builds the variants (you, or subagents in parallel) receives the same exact frame spec. **Never tell builders "simplified placeholder"**: they will invent content (fake sections, loading skeletons, simulated data), redesign out-of-scope UI, and make the frames differ so the comparison is polluted.
4. **Identical across variants**: only the designed region differs.

## Checkpoints

| About to | Check |
|---|---|
| Write the first mockup or variant | Token and surface inventories done? |
| Use any colour, radius, shadow or font | Is it in the token source? |
| Propose a variant that uses an existing surface differently | Breaking? Ask before drawing |
| Write "re-imagine", "becomes the primary surface", "promote X to the main canvas" | That is the breaking-change signal; stop and ask |
| Hand a builder "placeholder" for out-of-scope regions | Give the frozen frame spec instead |
