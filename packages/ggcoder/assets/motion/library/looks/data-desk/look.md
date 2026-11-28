# Data desk

A readable research page in motion. Lead with the finding, then show the evidence that supports it.

## System

Sage paper and forest ink replace a glowing dashboard. Schibsted Grotesk carries the finding; Martian Mono carries units, tick labels and source notes. Use straight rules, square geometry and a 96px perimeter. Reserve the right two-thirds for the chart and the left third for a single takeaway. No decorative cards around every number.

## Motion

Draw axes before data. Reveal series over 1.2s with `power2.inOut`, then reveal the conclusion. Keep baselines fixed. Hold the complete plot for 2–3s. For comparisons, animate bars from zero with a common scale. Never use easing or cropping to exaggerate a result.

## Scene recipes

1. **Trend:** a single large change at left, an annotated line plot at right, source and period below. The sample uses explicitly illustrative indexed data.
2. **Comparison:** `comparison-bars`, one emphasized category, a common zero baseline and visible units.
3. **Composition:** `donut-fill` paired with a plain-language fraction and denominator. Follow with `stat-grid` only when the audience needs the additional metrics.

Avoid invented factual claims, unlabeled axes, red/green-only distinctions, fake precision, giant dashboards and numbers counting forever. Replace sample values and source notes before publishing.
