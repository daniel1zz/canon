---
name: canon-domains
description: "Use when deciding how the baseline is divided into domains: a new project's baseline, a domain over the split hint or mixing vocabularies, a behaviour that fits no domain, or reorganising. Triggers: 'design the baseline', 'split this domain', 'which domain does this belong to', '划分领域', '拆领域', '领域设计', 'baseline 目录'. NOT for writing rules (canon-rules) or code architecture (canon-design)."
---

# Dividing the baseline into domains (canon)

A canon domain (`canon/rules/<domain>/`) is a subdomain of the product and also the boundary of one vocabulary. With `code_root`, code directories mirror the domain tree one to one, so a wrong division is wrong twice: in the rules and in the code. Sources: Evans' DDD Reference, Fowler's bliki, DDD Crew, EventStorming.

## 1. When this applies

- Writing a new project's baseline before any code: do this first, then write rules.
- A domain is over the split hint (`canon rule domains`), or its `## 术语` needs one word defined two ways.
- A new behaviour fits no domain, or you hesitate between two.
- Reorganising: a domain is named after a layer or a command.

If the behaviour clearly belongs to an existing domain, skip this skill and write the rule.

## 2. Discover

1. Read `canon/product.md`, `canon search` the notes and existing rules.
2. List what the product does as business capabilities (verb + object a user would say: "refund an order", "install canon into a project") and what it reacts to, as past-tense events ("order refunded") and the commands that cause them. A rule is one trigger and one outcome (canon-rules): the triggers and outcomes you already have are the raw material.
3. Cluster. Put together what changes together and shares one vocabulary. Put apart what changes for different reasons, is owned by different people, or uses the same word in different senses.
4. Name the few events or capabilities every other part depends on. They mark the seams.

## 3. Classify and spend effort accordingly

| Kind | Test | What it gets |
|------|------|--------------|
| Core | the reason the product exists; what the promises in `product.md` rest on | the deepest rules: every boundary, failure and repeat spelled out; the strictest tests |
| Supporting | necessary, specific to this product, not why anyone uses it | normal rule depth |
| Generic | any product needs it (auth, config parsing, git, storage) | few rules; prefer a library; keep it out of core domains; do not hand-model it |

Say the classification in the domain README or the decision. Keep the core small.

## 4. Name

The brief's rule applies (business capability, not command name or technical layer). Beyond it:

- Placeholder and layer names are out: cli, api, config, db, ui, utils, common, core, shared. A technical-layer domain cuts one capability across every directory, so each product change touches all of them; a `common` domain grows until it is the biggest and nobody owns it.
- A screen is not a capability either; one capability has several entry points.
- Not one domain per entity (order, user, invoice): a business rule crosses entities and would have no home.
- Subdomains split a domain by what it is about, not by step number or size.

## 5. Write the README of each domain

`canon rule domain <domain>[/<sub>]` creates it. Fill:

- **Purpose**: what business area it covers, and what it does not (name the neighbour that owns it).
- **Subdomains**: one line each.
- **`## 术语`**: only words whose meaning is specific to this context. When a word means something else in another domain, define it here and say "不同于 <domain> 的 X". Do not duplicate terms across domains; if two READMEs need the same definition, one of them depends on the other.
- **依赖**: one line naming the upstream domains this one relies on (`依赖：work/claims`). Keep the graph one-directional; a cycle means the boundary is wrong, merge or extract the shared concept. Compare with `canon context <file>`, which shows the domains a file imports.

## 6. Decide the boundary

Check each candidate boundary against these signals; any two pointing the same way justify a split or merge.

| Signal | Split | Merge |
|--------|-------|-------|
| Cohesion | two groups of rules refer within the group, rarely across | rules must change together and keep citing each other's terms |
| Change | one part changes often, the other is stable, or for different reasons | always changes together |
| Language | one word needs two definitions | same words, same meanings |
| Ownership | different people decide | same people |
| Class | core mixed with generic | same class |
| Size | weak: more than ~25 rules is a prompt to check the rows above, not a reason | a domain of 1-3 rules is usually a rule of another domain |

Cross-domain relations to use: upstream/downstream (the downstream depends, the upstream does not know it); shared kernel (`shared:`, keep small, a hint appears above 20% of the code); published language (a rule or format both sides name); separate ways (no relation at all, and so no import).

Record the division as a decision: `canon decision new --title "..."`. List every alternative division you rejected with the reason (for example: keep as is; split by layer; one domain per entity) and the evidence from the signals above.

## 7. Map to code

- With `code_root`, `<code_root>/<domain path>` is the domain's code; create the directory when you create the domain, or `canon check` reports `code-layout`.
- `shared:` is for code that belongs to no business domain, and stays small. A helper used by two domains is not shared by default: first ask whether one domain should own it and the other depend on it.
- A domain imports another only for what that domain's README publishes, never its internals.

## 8. Splitting or moving existing rules

- There is no move command. Move a rule file with `git mv canon/rules/<old>/BR-n.md canon/rules/<new>/BR-n.md`: the id stays, the content stays. A moved file with identical content is not re-reviewed; edit it in a later change, not the same one.
- Move the code directory and its tests with it, and the README `## 术语` entries that go with the rules. All in one change, so `canon check` is green at every commit.
- Update the references that name the old path, then run `canon check` and `canon work test`.
- Rule ids in tests and comments do not change.

## Example

A project sells subscriptions. First draft: `api`, `database`, `billing`. Capabilities: start a subscription, charge each month, refund, cancel, send invoices. Events: subscription started, payment failed, subscription cancelled. "Account" means a login in one place and a billing ledger in another, so those are two domains: `identity` (generic: use a library) and `billing`. Core: `billing`, split into `billing/charging` and `billing/refunds` because refunds change for legal reasons and are owned by finance. `api` and `database` disappear: their rules go into the domains they serve. `identity` is upstream of `billing`; the README says so.
