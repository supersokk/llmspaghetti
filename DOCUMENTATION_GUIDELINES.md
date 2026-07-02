# Documentation Guidelines

Where documentation belongs and how it's organized. Goal: keep the repo easy to
navigate, avoid duplication, and keep docs accurate as the project evolves.

## General principles

Before creating a new document:

- Check whether the information already exists elsewhere.
- Update existing documentation before creating a new file.
- Prefer linking to documentation instead of copying content.
- Keep one topic per document.
- Keep documentation synchronized with the current state of the project.

Documentation should answer questions once, in one place.

## Repository structure

```
/
├── README.md                   landing page
├── PROJECT-SCOPE.md            vision
├── CHANGELOG.md                history
├── TODO.md                     active work
├── CONTRIBUTING.md             contributor guide
├── DISCLAIMER.md               legal
├── LICENSE                     legal
├── DOCUMENTATION_GUIDELINES.md this file
└── docs/
    ├── README.md               documentation index
    ├── install.md              install, configure, run, troubleshoot
    ├── technical.md            architecture & implementation
    ├── PLANNED-*.md            unimplemented feature designs
    └── images (svg, png)
```

> Naming: root community-health files stay UPPERCASE (GitHub recognizes
> `README`, `LICENSE`, `CONTRIBUTING`, `CHANGELOG`). Files in `docs/` are
> lowercase (`install.md`, `technical.md`). Planning docs use `PLANNED-<name>.md`.

## Root documents

- **README.md** — landing page: what the project is, why it exists, current
  status, milestones, credits, and links onward. **Not** long install steps,
  architecture, or planned-feature specs — link to those instead.
- **PROJECT-SCOPE.md** — vision: goals, non-goals, target users, philosophy,
  long-term direction. Avoid implementation detail.
- **CHANGELOG.md** — history: releases, milestones, important/breaking changes.
  Don't keep changelog entries in the README.
- **TODO.md** — active work. Completed items use ✅. Remove obsolete tasks. Not a
  place for design documentation.
- **CONTRIBUTING.md** — development workflow, PR guidelines, coding/commit
  conventions, documentation expectations.
- **LICENSE / DISCLAIMER.md** — legal only. No technical/project docs mixed in.

## docs/

Anything too detailed for the README.

- **docs/README.md** — the index; links to every doc. No duplicated content.
- **install.md** — requirements, dependencies, install methods, first run,
  updating, troubleshooting.
- **technical.md** — architecture, request flow, components, tech stack.
- **PLANNED-\*.md** — features not yet implemented: problem statement, proposed
  solution, alternatives, open questions. Once built, update to the final design
  or fold into permanent docs and remove stale notes. Planning docs must never
  go stale.
- **Images** — architecture diagrams, logos, mockups live in `docs/`, never the
  repo root.

## Adding new documentation

Only create a new file if: the topic doesn't already exist, an existing document
can't simply be expanded, the information is useful long-term, and it belongs in
`docs/` rather than the root. Avoid vague names (`notes.md`, `misc.md`,
`ideas.md`). Prefer clear ones (`install.md`, `configuration.md`, `architecture.md`).

## Writing style

Clear, short, scannable, accurate, current. Use headings and bullet lists over
long paragraphs. Don't repeat the same information across documents.

## Documentation ownership

Update docs as part of the same change that alters behaviour. Code and docs
evolve together — a feature isn't complete until its docs are updated.

## Golden rule

Every piece of information has one canonical location. If multiple documents
need it, write it once and link to it.
