/** False means the overlay must show nothing (no panel, no circles, no text) and its window can stay hidden: it
 *  draws only while the item draft screen is on the frame (`draft`) or the ability tip is running (`tip`).
 *  Kept free of DOM types so the Electron main process can use it too. */
export const overlayHasContent = (s: { draft: boolean; tip: unknown } | null): boolean => !!s && (s.draft || !!s.tip);
