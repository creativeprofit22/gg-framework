import { payloadHash } from "./ui-registry.js";

export const MOUSE_CARD_SOURCE_HASH =
  "3a1a1c3308214e69a6a1129e2d1191cae87b6d071b70a8a1ded0253b263d7483";

/** Reviewed cleanup recipe: retain the repeating animation's own cancellation handle. */
export function patchMouseCard(source: string): string {
  if (payloadHash(source) !== MOUSE_CARD_SOURCE_HASH)
    throw new Error(
      "Mouse Effect Card source differs from reviewed snapshot; review before patching",
    );
  const replace = (from: string, to: string): void => {
    if (source.split(from).length !== 2)
      throw new Error("Ambiguous Mouse Effect Card cleanup patch");
    source = source.replace(from, to);
  };
  replace(
    'import { motion, useMotionValue, useSpring, useTransform } from "motion/react";',
    'import { animate, motion, useMotionValue, useSpring, useTransform } from "motion/react";',
  );
  replace(
    "  const delay = (index * OPACITY_DELAY_STEP) % OPACITY_DELAY_CYCLE;",
    `  const delay = (index * OPACITY_DELAY_STEP) % OPACITY_DELAY_CYCLE;
  const opacity = useSpring(minOpacityWithBoost, {
    stiffness: 150,
    damping: 25,
  });

  useEffect(() => {
    // A following spring can replace MotionValue.animation. Keep a separate
    // handle for the repeating pulse so unmount always stops its frame driver.
    const pulse = animate(opacity, [baseMinOpacity, baseMaxOpacity, baseMinOpacity], {
      duration: OPACITY_DURATION_BASE + (index % 4) * OPACITY_DURATION_VARIATION,
      repeat: Number.POSITIVE_INFINITY,
      ease: OPACITY_EASE,
      delay,
      times: [0, 0.5, 1],
    });
    return () => pulse.stop();
  }, [opacity, baseMinOpacity, baseMaxOpacity, index, delay]);`,
  );
  replace(
    "      animate={{\n        opacity: [baseMinOpacity, baseMaxOpacity, baseMinOpacity],\n      }}\n",
    "",
  );
  replace(
    "        opacity: useSpring(minOpacityWithBoost, {\n          stiffness: 150,\n          damping: 25,\n        }),",
    "        opacity,",
  );
  replace(
    "      transition={{\n        opacity: {\n          duration:\n            OPACITY_DURATION_BASE + (index % 4) * OPACITY_DURATION_VARIATION,\n          repeat: Number.POSITIVE_INFINITY,\n          ease: OPACITY_EASE,\n          delay,\n          times: [0, 0.5, 1],\n        },\n      }}\n",
    "",
  );
  return source;
}

export function compatibilityPatch(id: string, sourcePath: string, content: string) {
  if (id !== "kokonut:mouse-effect-card" || !sourcePath.endsWith("/mouse-effect-card.tsx"))
    return { content };
  const originalHash = payloadHash(content);
  if (originalHash !== MOUSE_CARD_SOURCE_HASH)
    return {
      content,
      notice:
        "Mouse Effect Card cleanup recipe not applied: unreviewed source hash. Verify animation teardown independently.",
    };
  const patched = patchMouseCard(content);
  return {
    content: patched,
    notice: `Mouse Effect Card owned-animation cleanup: original SHA256 ${originalHash}; patched SHA256 ${payloadHash(patched)}. Import relocation is a separate subsequent transformation.`,
  };
}
