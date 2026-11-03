# Mode: decompose

Expand a *validated* solution into the steps a user actually walks (Jeff Patton's story mapping), so the rules are read off a map instead of invented while writing them. A validated tree leaf is one sentence, and one sentence is not a scope: the twenty decisions inside it (on failure, on return, with nothing to show) are where the product is actually decided.

**Decompose only what survived validation.** Mapping a refuted or untested solution is elaborate fiction, and the elaboration makes it more convincing, not less wrong.

## Step 1: the backbone

The user's activities left to right, in their words, present tense, describing the journey **as it will be**:

```
Connect a source → See what's possible → Build a first view → Trust the number → Share it
```

- Steps are user activities, never system components ("authenticate" is a step, "auth service" is not).
- 4–8 steps. More is implementation; fewer is a slogan.
- **Include the steps you are not changing.** Scope decided without the surrounding journey visible is how a feature ships into a flow that cannot reach it.

## Step 2: tasks under each step

Under each step, what the user must accomplish there, most essential at the top. Then ask four questions of **every** step; a map without their rows is a demo script, and the missing rows become production defects:

| Question | Row it produces |
|----------|-----------------|
| What if it fails? | "retry after a failure" |
| What if they leave and come back? | "resume tomorrow" |
| What if there is nothing yet? | "understand why there are no suggestions" |
| What if there is far too much? | "find one item among sixty" |

## Step 3: slice

Draw one horizontal line; everything above it is the first release. A valid slice is a **thin walk of the whole backbone**: the user gets from the first step to the last, badly. An invalid slice builds one step completely while a later step has nothing. Only a walking slice can be put in front of a user, so only it produces evidence.

Rows below the line are kept in the note with the reason; they are the next slice, and writing them down stops them coming back mid-build as "new requirements".

## Step 4: read off the rules

Each row above the line that the product commits to becomes a candidate rule, carrying its origin and validation state:

| Map row | Candidate rule | Origin | Validation |
|---------|----------------|--------|------------|
| see suggestions from my data | Schemas that can be inferred get suggested views | tree O1/S1, step 2 | validated (ledger row 1) |
| understand why there are no suggestions | Empty state names the reason | step 2, unhappy path | unvalidated: derived from the map, never tested |

Rows produced by the four questions are usually `unvalidated`: validation tested the happy path. Tag them honestly instead of letting them inherit the parent's `validated`; that is the most common way a ledger's credibility is laundered onto untested scope.

Once the direction is answered, write the rules through the normal change flow (`canon rule new`), one trigger and one outcome each, with examples on both sides of the boundary. The backbone is also the screen flow for `canon-prototype`; the unhappy-path rows are the states to prototype.

## Exit checks

- [ ] Backbone of 4–8 user activities in the user's words, including unchanged steps.
- [ ] All four questions asked of every step, their rows on the map.
- [ ] The slice above the line walks the whole backbone; rows below it recorded with reasons.
- [ ] Every row above the line carries its origin and validation state.
