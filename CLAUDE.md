# Notes for Claude sessions in this repo

## Who you're working with
- The owner does not code. Explain everything in plain language: what you did, what it means for them, what they should try.
- Don't use jargon without a one-line explanation. Keep replies short; put detail in the docs.
- Talk first, build second: when the owner asks to discuss, don't write code or files until they say go.

## Rules
- Work only in this repo. Never read or take anything from the owner's other repos without asking first.
- No images, ever: no generated or downloaded pictures, textures, sprites or sound files. Models, sand, water, sky, icons and sounds are all made in code.
- Each game lives in its own folder (currently only `sandcastle-cays/`).
- Before sending the owner a build, run that game's checks (see its README) and say plainly what passed, what failed, and what you couldn't test.

## Repo layout
- `sandcastle-cays/`: the sandcastle sailing game. Start with `sandcastle-cays/README.md`, then `sandcastle-cays/docs/PLAN.md` (the agreed plan) and `sandcastle-cays/docs/DECISIONS.md` (why things are the way they are).
- Every version sent to the owner is kept in `sandcastle-cays/builds/`, with notes in `sandcastle-cays/docs/CHANGELOG.md`.
