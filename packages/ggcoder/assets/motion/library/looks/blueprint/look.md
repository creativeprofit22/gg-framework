# Blueprint

A technical drawing, not a sci-fi dashboard. Use this look to explain a mechanism, relationship or measured change.

## System

- Deep cobalt field, pale drafting lines and white ink. Yellow marks the one measurement being explained, never every node.
- Wide Hubot Sans headlines; Martian Mono only for dimensions, units and title-block details.
- Keep a 96px safe area. Align annotations to drawing geometry and leave the left third available for the explanation.
- Grid lines stay subordinate to the object. Leader lines terminate at actual features, not decorative points.

## Motion

Draw the object first in 0.6–1.2s with `power2.inOut`, then add dimensions in reading order. Hold the completed diagram for at least 2s. Use a clean cut or a line-led wipe between mechanisms. Never animate measurements independently of the thing being measured.

## Scene recipes

1. **Mechanism:** headline left, large line drawing right, one highlighted ratio below the copy. The sample explains a 2:1 gear reduction.
2. **System flow:** `blueprint-grid` behind `flow-nodes`; reveal each connection only after its source exists.
3. **Layer breakdown:** `stack-layers` with numbered annotations, then a `chapter-card` to introduce the next subsystem.

Avoid glows, tiny fake telemetry, unreadable formula wallpaper, gratuitous labels and more than one signal color. Replace all sample measurements with verified values for the subject.
