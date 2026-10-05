import { describe, expect, it } from 'vitest';
import { DraftOfferLock } from '../draftOfferLock';
const initial = { key: '1,2,3', round: 3, choice: 2 };
const locked = () => {
  const lock = new DraftOfferLock();
  lock.observe(initial, 0);
  lock.observe(initial, 250);
  lock.observe(initial, 500);
  return lock;
};
describe('committed draft transitions', () => {
  it('keeps independently confirmed forward-round labels through unread round glyphs during item OCR', () => {
    const lock = new DraftOfferLock();
    for (const time of [0, 250, 500]) lock.observe({ ...initial, choice: 1 }, time);
    const next = { round: 5, choice: 1, key: '4,5,6' };
    lock.observe({ ...next, key: '' }, 1000, false, { frame: 1, labelsOnly: true });
    lock.observe({ ...next, key: '' }, 1100, false, { frame: 2, labelsOnly: true });
    expect(lock.pendingLabels).toMatchObject({ round: 5, choice: 1 });
    expect(
      lock.observe({ ...next, round: 0 }, 1200, false, { frame: 3, nameCorroborated: true, changedSlots: 3 }),
    ).toBe(false);
    expect(
      lock.observe({ ...next, round: 0 }, 1400, false, { frame: 4, nameCorroborated: true, changedSlots: 3 }),
    ).toBe(false);
    expect(
      lock.observe({ ...next, round: 0 }, 1600, false, { frame: 5, nameCorroborated: true, changedSlots: 3 }),
    ).toBe(true);
    expect(lock.current).toEqual(next);
    expect(lock.transition).toBe('round');
  });
  it('supersedes a stale same-round reacquisition with two fresh forward-round labels and never commits at the old round', () => {
    const lock = new DraftOfferLock();
    const old = { ...initial, choice: 1 };
    for (const time of [0, 250, 500]) lock.observe(old, time);
    const next = { key: '4,5,6', round: 5, choice: 1 };
    const evidence = { nameCorroborated: true, changedSlots: 3, visual: 2 };
    expect(lock.observe({ ...next, round: 0 }, 1000, false, { ...evidence, frame: 1 })).toBe(false);
    expect(lock.pendingLabels).toMatchObject({ round: 3, reason: 'reacquire' });
    expect(lock.observe(next, 1100, false, { ...evidence, frame: 2 })).toBe(false);
    expect(lock.observe(next, 1200, false, { ...evidence, frame: 3 })).toBe(false);
    expect(lock.pendingLabels).toMatchObject({ round: 5, reason: 'round' });
    expect(lock.observe({ ...next, round: 0 }, 1400, false, { ...evidence, frame: 4 })).toBe(false);
    expect(lock.observe({ ...next, round: 0 }, 1700, false, { ...evidence, frame: 5 })).toBe(true);
    expect(lock.current).toEqual(next);
  });
  it('withholds an old-round correction after one positive later-round label while subsequent ROUND glyphs are unread', () => {
    const lock = new DraftOfferLock();
    const old = { ...initial, choice: 1 };
    for (const time of [0, 250, 500]) lock.observe(old, time);
    const next = { key: '4,5,6', round: 5, choice: 1 };
    const evidence = { nameCorroborated: true, changedSlots: 3 };
    expect(lock.observe(next, 1000, false, { ...evidence, frame: 1 })).toBe(false);
    for (const frame of [2, 3, 4, 5])
      expect(lock.observe({ ...next, round: 0 }, 1000 + frame * 250, false, { ...evidence, frame })).toBe(false);
    expect(lock.current).toEqual(old);
    expect(lock.observe(next, 2500, false, { ...evidence, frame: 6 })).toBe(false);
    expect(lock.pendingLabels).toMatchObject({ round: 5 });
  });
  it('keeps the highest confirmed pending labels and preserves reroll spending when the target advances', () => {
    const lock = locked();
    lock.armReroll();
    const next = { key: '4,5,6', round: 5, choice: 3 };
    lock.observe({ ...next, key: '' }, 1000, false, { frame: 1, labelsOnly: true });
    lock.observe({ ...next, key: '' }, 1100, false, { frame: 2, labelsOnly: true });
    expect(lock.pendingLabels).toMatchObject({ round: 5, choice: 3, reason: 'reroll' });
    for (const [frame, round, choice] of [
      [3, 4, 3],
      [4, 4, 3],
      [5, 5, 2],
      [6, 5, 2],
    ])
      expect(lock.observe({ ...next, round: round!, choice: choice! }, 1100 + frame! * 100, false, { frame })).toBe(
        false,
      );
    expect(lock.pendingLabels).toMatchObject({ round: 5, choice: 3, reason: 'reroll' });
    for (const [frame, time] of [
      [7, 2000],
      [8, 2200],
      [9, 2500],
    ])
      lock.observe({ ...next, round: 0 }, time!, false, { frame });
    expect(lock.current).toEqual(next);
    expect(lock.transition).toBe('reroll');
    expect(lock.awaitingReroll).toBe(false);
  });
  it.each([
    { round: 5, choice: 1 },
    { round: 4, choice: 3 },
  ])('reacquires a later round after unobserved draft choices: %j', (labels) => {
    const lock = locked();
    const next = { ...labels, key: '4,5,6' };
    expect(lock.observe({ ...next, key: '' }, 1000, false, { frame: 1, labelsOnly: true })).toBe(false);
    expect(lock.observe({ ...next, key: '' }, 1100, false, { frame: 2, labelsOnly: true })).toBe(false);
    expect(lock.settling).toBe(true);
    expect(lock.observe(next, 1200, false, { frame: 3, nameCorroborated: true, changedSlots: 3 })).toBe(false);
    expect(lock.observe(next, 1400, false, { frame: 4, nameCorroborated: true, changedSlots: 3 })).toBe(false);
    expect(lock.observe(next, 1600, false, { frame: 5, nameCorroborated: true, changedSlots: 3 })).toBe(true);
    expect(lock.current).toEqual(next);
  });
  it('requires a complete initial tuple with fresh stable pixels for500ms before publishing', () => {
    const lock = new DraftOfferLock();
    expect(lock.observe({ ...initial, key: '' }, 0)).toBe(false);
    expect(lock.observe(initial, 100)).toBe(false);
    expect(lock.observe(initial, 200)).toBe(false);
    expect(lock.observe(initial, 599)).toBe(false);
    expect(lock.observe(initial, 600)).toBe(true);
  });
  it('holds ordinary tooltip/partial/false backwards evidence without spending or changing labels', () => {
    const lock = locked();
    for (let time = 2000; time < 4000; time += 100)
      expect(lock.observe({ ...initial, key: '9,9,9' }, time)).toBe(false);
    expect(lock.observe({ ...initial, key: '' }, 4100)).toBe(false);
    expect(lock.observe({ ...initial, round: 1 }, 4200)).toBe(false);
    expect(lock.current).toEqual(initial);
  });
  it('confirms advancing labels independently of partial cards and does not publish old cards under new labels', () => {
    const lock = locked();
    const next = { ...initial, choice: 3, key: '' };
    lock.observe(next, 1000);
    lock.observe(next, 1100);
    expect(lock.settling).toBe(true);
    expect(lock.current).toEqual(initial);
    const complete = { ...next, key: '4,5,6' };
    expect(lock.observe(complete, 1200)).toBe(false);
    expect(lock.observe(complete, 1400)).toBe(false);
    expect(lock.observe(complete, 1600)).toBe(true);
    expect(lock.current).toEqual(complete);
  });
  it('finishes a correction candidate begun near the window boundary and corrects strong late full-card contradiction', () => {
    const lock = locked();
    const next = { ...initial, choice: 3, key: '4,5,6' };
    for (const time of [1000, 1100, 1300, 1500]) lock.observe(next, time);
    expect(lock.current).toEqual(next);
    const corrected = { ...next, key: '7,8,9' };
    const evidence = { direct: true, changedSlots: 1, visual: 2 };
    lock.observe(corrected, 2400, false, evidence);
    lock.observe(corrected, 2500, false, evidence);
    expect(lock.observe(corrected, 2800, false, evidence)).toBe(true);
    expect(lock.transition).toBe('reacquire');
    const late = { ...next, key: '10,11,12' };
    const full = { direct: true, changedSlots: 3, visual: 3 };
    lock.observe(late, 10_000, false, full);
    lock.observe(late, 10_150, false, full);
    expect(lock.observe(late, 10_300, false, full)).toBe(true);
    expect(lock.transition).toBe('reacquire');
    expect(lock.awaitingReroll).toBe(false);
  });
  it('requires fresh stable post-decrement frames even for all identical reroll IDs', () => {
    const lock = locked();
    lock.armReroll();
    expect(lock.observe(initial, 1000)).toBe(false);
    expect(lock.observe(initial, 1250)).toBe(false);
    expect(lock.observe(initial, 1500)).toBe(true);
    expect(lock.transition).toBe('reroll');
  });
  it('requires independent evidence for every replacement during reacquisition and can restore original pixels', () => {
    const lock = locked();
    const strong = { ...initial, key: '4,5,6' };
    lock.observe(strong, 10_000, false, { direct: true, changedSlots: 3 });
    const weak = { ...initial, key: '7,8,9' };
    for (const time of [10_100, 10_300, 10_600])
      expect(lock.observe(weak, time, false, { changedSlots: 3 })).toBe(false);
    expect(lock.current).toEqual(initial);
    lock.restoreCurrent();
    expect(lock.settling).toBe(false);
    const names = { nameCorroborated: true, changedSlots: 3 };
    lock.observe(weak, 11_000, false, names);
    lock.observe(weak, 11_150, false, names);
    expect(lock.observe(weak, 11_300, false, names)).toBe(true);
    expect(lock.transition).toBe('reacquire');
    expect(lock.awaitingReroll).toBe(false);
  });
  it('keeps the confirmed new-choice target when a reroll is spent during settling', () => {
    const lock = locked();
    const next = { ...initial, choice: 3, key: '' };
    lock.observe(next, 1000);
    lock.observe(next, 1100);
    lock.armReroll();
    const full = { ...next, key: '4,5,6' };
    lock.observe(full, 1200);
    lock.observe(full, 1400);
    expect(lock.observe(full, 1700)).toBe(true);
    expect(lock.current).toEqual(full);
    expect(lock.transition).toBe('reroll');
  });
  it('permits genuine identical-card advances without inventory only after settling, and restores false-label blinks', () => {
    const lock = locked();
    const next = { ...initial, choice: 3 };
    for (const time of [1000, 1100, 1300, 1500]) expect(lock.observe(next, time, true)).toBe(false);
    expect(lock.observe(next, 2500, true)).toBe(true);
    const other = locked();
    other.observe(next, 1000);
    other.observe(next, 1100);
    expect(other.observe(initial, 1200)).toBe(true);
    expect(other.transition).toBe('metadata');
    expect(other.current).toEqual(initial);
    expect(other.settling).toBe(false);
  });
  it('establishes an unknown round and counts pending/final outputs from one frame only once', () => {
    const lock = new DraftOfferLock();
    const unknown = { ...initial, round: 0 };
    for (const time of [0, 250, 500]) lock.observe(unknown, time);
    for (const time of [1000, 1250, 1500]) lock.observe(initial, time);
    expect(lock.current).toEqual(initial);
    const next = { ...initial, choice: 3, key: '' };
    lock.observe(next, 2000, false, { frame: 1 });
    lock.observe({ ...next, key: '4,5,6' }, 2050, false, { frame: 1 });
    expect(lock.settling).toBe(false);
    lock.observe(next, 2100, false, { frame: 2 });
    expect(lock.settling).toBe(true);
  });
});
