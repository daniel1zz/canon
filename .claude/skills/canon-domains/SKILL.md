---
name: canon-domains
description: "Use when deciding how the baseline is divided into domains: a new project's baseline, a domain over the split hint or mixing vocabularies, a behaviour that fits no domain, or reorganising. Triggers: 'design the baseline', 'split this domain', 'which domain does this belong to', '划分领域', '拆领域', '领域设计', 'baseline 目录'. NOT for writing rules (canon-rules) or code architecture (canon-design)."
---

# Dividing the baseline into domains (canon)

With `code_root`, code directories mirror the domain tree one to one, so a wrong division is wrong twice: in the rules and in the code. Sources: Evans' DDD Reference (2015), Fowler's bliki, DDD Crew (context-mapping, core-domain-charts, bounded-context-canvas). The "~25 rules" and "1-3 rules" figures below are canon's own heuristics, not DDD.

## 1. When this applies

- A new project's baseline, before any code: divide first, then write rules.
- A domain is over the split hint (`canon rule domains`), or its `## 术语` needs one word defined two ways.
- A new behaviour fits no domain, or you hesitate between two.
- A domain is named after a layer or a command.

If the behaviour clearly belongs to an existing domain, skip this skill and write the rule.

## 2. Subdomain and context: one thing in canon

DDD has two notions: a subdomain (a part of the business, problem space) and a bounded context (the boundary inside which one model and one vocabulary hold, solution space). In canon one domain is both, because code mirrors domains and the README `## 术语` is the vocabulary. Aim for one-to-one. When it does not fit:

- One context would cover several subdomains: keep one domain and make the subdomains its sub-domains (`<domain>/<sub>`), as long as they share one vocabulary. If their vocabularies differ, they are separate domains.
- One subdomain would be split across contexts: pick one owner domain. The other domain refers to the owner's rules and terms (imports: section 11); do not copy the rules.

## 3. Discover

1. Existing project: read `canon/product.md`, then `canon search` notes and rules. `canon/architecture.md` names the container each domain's code belongs to: use it to see where a new or split domain fits. New project: `canon search` finds nothing; start from the PRD or `product.md`.
2. List what the product does as capabilities (verb + object a user would say) and what it reacts to as past-tense events with the commands that cause them. A rule is one trigger and one outcome: your triggers and outcomes are the raw material.
3. Cluster what changes together and shares a vocabulary; separate what changes for different reasons or uses one word in two senses. The few events everything else waits for mark the seams.
4. Product promises that are cross-cutting qualities ("documents never lie", "safe under concurrency") are not domains. Map each onto the domains whose rules must deliver it; a quality with its own domain becomes a layer.

## 4. Find one term with two meanings

Run this on the PRD (or the existing READMEs and rules) before fixing the boundaries:

1. List the nouns that recur. Ignore one-off words.
2. For each, write down every sentence it appears in, and the verbs and outcomes attached to it ("an account is charged" vs "an account is locked after three failures").
3. Try to write one definition that fits all the sentences. If two definitions cannot replace each other in those sentences, it is two contexts or two terms: split the domain, or rename one use.
4. Record the result in each domain's `## 术语`: define the word there and say "不同于 <domain> 的 X".

## 5. Classify and spend effort

Core, supporting and generic are placed on the DDD Crew core domain chart by two axes: business differentiation (product judgement: does it set us apart, how hard for a competitor to match) and model complexity (engineering judgement: how hard to model and build). High on both is core. The crew says both are subjective; the value is the discussion.

| Kind | Chart position | In practice |
|------|----------------|-------------|
| Core | high differentiation, high complexity; what the product promises rest on | build in-house, deepest rules (every boundary, failure, repeat), strictest tests, your best people; keep it small |
| Supporting | specific to this product, little differentiation | build simply, normal rule depth |
| Generic | no differentiation (auth, git, storage, parsing) | use a library or service behind an anticorruption layer; few rules, only about how you use it |

Write the class in the domain README.

## 6. Name

The brief's rule applies (business capability, not command or layer). Beyond it, these are out as domain names: cli, api, config, db, ui, utils, common, core, shared, and one domain per entity (order, user, invoice) or per screen. A screen is an entry point; a rule crosses entities.

## 7. Decide the boundary

Any two signals pointing the same way justify a split or merge.

| Signal | Split | Merge |
|--------|-------|-------|
| Cohesion | two groups refer within the group, rarely across | rules change together and cite each other's terms |
| Change | one part changes often or for other reasons | always changes together |
| Language | one word needs two definitions | same words, same meanings |
| Class | core mixed with generic | same class |
| Ownership | different people decide (a signal only, see below) | same people |
| Size | weak: over ~25 rules is a prompt to check the rows above | a domain of 1-3 rules is usually part of another |

Anti-patterns:

- Big ball of mud / god domain: one domain that everything touches and no vocabulary fits. Mark it, split by language and change, do not model it finely.
- Splitting for hypothetical reuse: two domains because "someone may reuse this". Split on today's language and change, not on a guess.
- Splitting by team only: Conway's law explains where boundaries tend to form, it does not justify them; ownership is a signal, the vocabulary is the reason.
- Counter-example, a division that looks like capabilities but is layers: `ingestion`, `processing`, `reporting` for an analytics product. Each is a pipeline stage, and "a report is wrong" touches all three. Correction: cut by what the business decides: `usage-metering` (core: what counts as usage), `billing` (supporting), `export` (generic, uses a library). Stages become code inside each domain.

## 8. Context map: who depends on whom

Put one `依赖：` line in each README naming upstream domains. It is a hint kept true by hand; `canon check` does not verify it. When changing a domain, compare it with `canon context <file>`, which lists the domains a file imports. Keep the graph one-way: a cycle means the boundary is wrong.

| Relation | Meaning | In canon |
|----------|---------|----------|
| Anticorruption layer | downstream translates upstream's model into its own | a generic domain wraps git, GitHub or a third-party API in its own types; others import only that domain, never the API |
| Conformist | downstream adopts upstream's model as is | import upstream's types directly; fine when you cannot change them and they fit |
| Customer/supplier | downstream needs feed into upstream's plan | upstream's README publishes what downstream may use; a downstream need becomes an upstream rule |
| Open host service | upstream offers one stable protocol to all | upstream exposes a small public entry (one module or format) and README lists it |
| Published language | a documented format both sides name | a rule or file format; neither side owns internals |
| Partnership | two sides succeed or fail together | rare; change both in one change |
| Shared kernel | small model both agree to share | `shared:`, small, hint above 20% of the code |
| Separate ways | no relation | no import |

## 9. Done when

Stop dividing and start writing rules when all hold:

- every product promise and capability maps to a domain (qualities: section 3);
- every domain is classed core, supporting or generic;
- every domain name passes section 6;
- section 4 left no unresolved term conflict (resolved or listed as a known context difference);
- every behaviour in the PRD fits exactly one domain.

## 10. Record it

The division is a decision (`canon decision new`). It must contain: the domains, each with class and one-line purpose; the alternative divisions you rejected, with why (keep as is, by layer, per entity, by team); the term-conflict list; the context map (who depends on whom, relation type).

Unsure about a boundary: `canon human ask` with two or three candidate divisions, then carry on as `canon-rules` §5 says.

## 11. Map to code and move rules

- With `code_root`, create `<code_root>/<domain path>` with the domain, or `canon check` reports `code-layout`.
- `shared:` is code that belongs to no business domain. A helper used by two domains is not shared by default: first ask which domain should own it.
- A domain imports another only for what its README publishes.
- Moving: there is no move command. `git mv canon/rules/<old>/BR-n.md canon/rules/<new>/BR-n.md` keeps id and content; edit it in a later change, not the same one. Move the code, tests and matching `## 术语` entries in the same change, then run `canon check` and `canon work test`.

## Example

A project sells subscriptions. First draft: `api`, `database`, `billing`. "Account" means a login in one place and a ledger in another, so there are two domains: `identity` (generic: a library behind an anticorruption layer) and `billing` (core), with `billing/charging` and `billing/refunds` split because refunds change for legal reasons. `api` and `database` disappear into the domains they serve. `billing` depends on `identity`; its README says so.
