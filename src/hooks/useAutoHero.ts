import { useCallback, useRef, useState } from 'react';

/** A saved selection is a starting value; only an explicit user selection overrides this match's detection. */
export function useAutoHero(setHero: (id: number) => void) {
  const manual = useRef(false);
  const detected = useRef<number | null>(null);
  const [pinned, setPinned] = useState(false);
  const [source, setSource] = useState<'detected' | 'manual'>('manual');
  const choose = useCallback(
    (id: number, nextSource: 'detected' | 'manual' = 'manual') => {
      if (nextSource === 'detected') {
        detected.current = id;
        if (manual.current) return;
      } else {
        manual.current = true;
        setPinned(true);
      }
      setHero(id);
      setSource(nextSource);
    },
    [setHero],
  );
  const newMatch = useCallback(
    (heroId?: number) => {
      manual.current = false;
      setPinned(false);
      if (heroId) detected.current = heroId;
      if (detected.current) {
        setHero(detected.current);
        setSource('detected');
      }
    },
    [setHero],
  );
  const resumeAuto = useCallback(() => {
    manual.current = false;
    setPinned(false);
    if (detected.current) {
      setHero(detected.current);
      setSource('detected');
    }
  }, [setHero]);
  return { source, pinned, choose, newMatch, resumeAuto };
}
