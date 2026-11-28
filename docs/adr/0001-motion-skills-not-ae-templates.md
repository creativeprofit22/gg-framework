# ADR 0001: GG Motion uses skills, not After Effects templates

**Status:** Accepted, 2026-09-29

## Context

GG Motion shipped templates rebuilt from purchased After Effects packs (Mixkit
split text, Mobile Notification, Kinetic Text), made with a private extraction
pipeline. Each pack took hours, needed approximations of native effects, and
still had visible differences from the original. Only matched requests could
use them. Meanwhile, the Motion agent's own custom designs, driven by skills
and a clear quality bar, produced its strongest results. The packs also carried
unresolved redistribution questions.

## Decision

Motion ships no After Effects–derived templates, no extraction tooling and no
template-use rules. The agent designs every video itself from its skills, the
motion-language guide and the style library, planning each video in
`frame.md`. Reusable craft is added as skills and library pieces written by GG,
not reconstructed from third-party projects.

## Rejected alternative

Converting the packs into mixable style-library pieces. It would keep their
look, but still needs the per-pack reconstruction effort and the same rights
review, for designs the agent can already match or exceed. The removed packs
and pipeline are archived locally (Git-ignored) if the question reopens.
