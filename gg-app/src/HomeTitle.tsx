import { PRODUCT_DISPLAY_NAME } from "./brand";
// Local Fork: the same lettering, spelling the fork's product name
// (`python3 scripts/gen-home-title.py "Supah Coder" src/assets/home/supah-coder-title.png`).
import title from "./assets/home/supah-coder-title.png";

/** The title art's size in its own pixels (see scripts/gen-home-title.py). */
export const HOME_TITLE_W = 285;
export const HOME_TITLE_H = 48;
export { title as HOME_TITLE_SRC };

/**
 * The home screen's product title, lettered like GG Royale's "Royale" (gold
 * Alagard at 48px with an ink outline). A still image shown at a whole number
 * of screen pixels per art pixel, so it stays crisp; no looping motion.
 */
export function HomeTitle(): React.ReactElement {
  return (
    <h1 className="home-title">
      <img
        className="home-title-art"
        src={title}
        alt={PRODUCT_DISPLAY_NAME}
        width={HOME_TITLE_W}
        height={HOME_TITLE_H}
        draggable={false}
      />
    </h1>
  );
}
