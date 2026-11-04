/** Coordinate transform from the installed 0.2.0 ultrawide fix. The game's HUD stays centred at 16:9 on wide
 *  screens; ordinary and slightly stretched 16:9 captures retain the original independent x/y scaling. */
export function hudLayout(width: number, height: number) {
  const sy = height / 1440;
  const wide = width / height > (2560 / 1440) * 1.05;
  const sx = wide ? sy : width / 2560;
  return { sx, sy, offsetX: wide ? (width - 2560 * sx) / 2 : 0 };
}
