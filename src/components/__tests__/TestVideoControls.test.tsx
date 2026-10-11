// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TestVideoControls } from '../TestVideoControls';

afterEach(cleanup);

describe('TestVideoControls', () => {
  it('offers only the picker when no video is open', () => {
    const send = vi.fn();
    render(<TestVideoControls video={null} send={send} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play a video' }));
    expect(send).toHaveBeenCalledWith({ type: 'open' });
  });

  it('pauses, skips, seeks and goes back to the screenshot', () => {
    const send = vi.fn();
    const video = { name: 'match.mkv', time: 65, duration: 3092.4, playing: true, error: null };
    render(<TestVideoControls video={video} send={send} />);
    expect(screen.getByText('1:05 / 51:32')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(send).toHaveBeenLastCalledWith({ type: 'pause' });
    fireEvent.click(screen.getByRole('button', { name: 'Back 10 seconds' }));
    expect(send).toHaveBeenLastCalledWith({ type: 'seek', to: 55 });
    fireEvent.click(screen.getByRole('button', { name: 'Forward 10 seconds' }));
    expect(send).toHaveBeenLastCalledWith({ type: 'seek', to: 75 });
    fireEvent.change(screen.getByLabelText('Video position'), { target: { value: '300' } });
    expect(send).toHaveBeenLastCalledWith({ type: 'seek', to: 300 });
    fireEvent.click(screen.getByRole('button', { name: 'Back to screenshot' }));
    expect(send).toHaveBeenLastCalledWith({ type: 'close' });
  });

  it('shows Play when paused and the error when the file will not play', () => {
    const send = vi.fn();
    const video = { name: 'x.mkv', time: 0, duration: 0, playing: false, error: 'This video will not play (code 4)' };
    render(<TestVideoControls video={video} send={send} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(send).toHaveBeenLastCalledWith({ type: 'play' });
    expect(screen.getByRole('alert').textContent).toBe('This video will not play (code 4)');
  });
});
