# Notes for Claude sessions in this repo

## Who you're working with
- The owner does not code. Explain everything in plain language: what you did, what it means for them, what they should try.
- Don't use jargon without a one-line explanation. Keep replies short; put detail in the docs.
- Talk first, build second: when the owner asks to discuss, don't write code or files until they say go.

## Rules
- Work only in this repo. Never read or take anything from the owner's other repos without asking first.
- No images, ever: no generated or downloaded pictures, texture files, sprites or sound files. Models, sand, water, sky, icons and sounds are all made in code. Code may paint textures (wood grain, ripples) at startup; the owner agreed on 2026-11-01.
- Each game lives in its own folder (currently only `sandcastle-cays/`).
- Before sending the owner a build, run that game's checks (see its README) and say plainly what passed, what failed, and what you couldn't test.
- Send every build as a link, not only as a file to download (the owner asked, 2026-11-01): republish the game's claude.ai artifact (same link each time; its slug is in the game's README) and give the owner the link. Still keep each version in `builds/`.

## Repo layout
- `sandcastle-cays/`: the sailboat-living game (beachcombing, sandcastles, upkeep, gardening, sailing). Start with `sandcastle-cays/README.md`, then `sandcastle-cays/docs/PLAN.md` (the agreed plan) and `sandcastle-cays/docs/DECISIONS.md` (why things are the way they are).
- Every version sent to the owner is kept in `sandcastle-cays/builds/`, with notes in `sandcastle-cays/docs/CHANGELOG.md`.
