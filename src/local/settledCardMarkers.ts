import { cardSquares, readMarkers, type CardRead, type RGBImage } from '../brawl/recognise';
/** Positive modifiers belong to the accepted source and survive hover occlusion. */
export function refreshCardMarkers(
  img: RGBImage,
  reads: CardRead[],
  sameSource: readonly boolean[],
  markers = readMarkers,
) {
  let changed = false;
  const squares = cardSquares(img.width, img.height);
  const next = reads.map((read, slot) => {
    if (!sameSource[slot]) return read;
    const observed = markers(img, { ...read.match, ...squares[slot]! });
    const rare = read.rare || observed.rare;
    const enhanced = read.enhanced || observed.enhanced;
    if (rare === read.rare && enhanced === read.enhanced) return read;
    changed = true;
    return { ...read, rare, enhanced };
  });
  return { reads: changed ? next : reads, changed };
}
