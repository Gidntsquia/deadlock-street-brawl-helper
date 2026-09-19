/** False means the overlay must show nothing (no panel, no circles, no text) and its window can stay hidden: it
 *  draws only while the item draft screen is on the frame (`draft`) or the ability panel is up (`panel`, ~15 s
 *  after the draft closes). Kept free of DOM types so the Electron main process can use it too. */
export const overlayHasContent = (s: { draft: boolean; panel: unknown } | null): boolean =>
  !!s && (s.draft || !!s.panel);
