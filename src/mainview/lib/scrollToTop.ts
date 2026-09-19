/**
 * The status bar's scroll to the top, done in the page (ios.md §7).
 *
 * The scroller is found under the middle of the screen, so it is whatever the
 * phone is showing: the note, the note list, an overlay's results.
 */

/** One element on the way up from the probed point, innermost first. */
export interface ScrollerLink {
  /** It clips vertically and has more content than room. */
  scrolls: boolean;
  scrollTop: number;
}

/**
 * Which link to scroll: the outermost that is off its top. Outermost, because a
 * run's output inside a note is a scroller too, and the note is what the tap
 * means. -1 when everything under the point is already at the top.
 */
export function scrollerToTop(chain: ScrollerLink[]): number {
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].scrolls && chain[i].scrollTop > 0) return i;
  }
  return -1;
}

export function scrollToTop(doc: Document = document): void {
  const view = doc.defaultView;
  if (!view) return;
  const chain: Element[] = [];
  for (let el = doc.elementFromPoint(view.innerWidth / 2, view.innerHeight / 2); el; el = el.parentElement) {
    chain.push(el);
  }
  const at = scrollerToTop(
    chain.map((el) => {
      const overflow = view.getComputedStyle(el).overflowY;
      return {
        scrolls: (overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight,
        scrollTop: el.scrollTop,
      };
    }),
  );
  if (at >= 0) chain[at].scrollTo({ top: 0, behavior: "smooth" });
}
