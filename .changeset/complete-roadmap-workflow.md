---
"@kenkaiiii/gg-core": minor
"@kenkaiiii/ggcoder": minor
---

Complete the Roadmap phase workflow across shared contracts, the coding-agent runtime, and desktop authority boundaries. gg-core now publishes validated roadmap draft, lifecycle, verification, blocker-resolution, completion-review, and durable phase-advancement checkpoint contracts through the new `@kenkaiiii/gg-core/roadmap-workflow` entry point. ggcoder adds draft-first roadmap tools and approval routes, requires criterion-aligned verification before review, records explicit external actions for blockers, and drives Ken and Autopilot Ken final review through persisted completion gates. Submitted implementation plans now survive restart as exact snapshots that only a typed human checkpoint approval can accept; Ken may request revisions or report readiness but cannot begin implementation. Accepted Done reviews persist a next-phase checkpoint atomically, and only the desktop's explicit **Start next phase** confirmation can consume it and bind the next planning session—Autopilot completion, daemon recovery, generic prompts, and legacy phase-start routes cannot bypass either human boundary.
