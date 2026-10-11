import { formatVideoTime, type TestVideo, type TestVideoAction } from '../brawl/testVideo';

/** Test mode video controls (manual check only): pick a video for the dummy window, then play, pause, skip and seek.
 *  Only this button ever starts a video; no test or harness does. */
export function TestVideoControls({
  video,
  send,
}: {
  video: TestVideo | null;
  send: (action: TestVideoAction) => void;
}) {
  if (!video)
    return (
      <button className="btn" onClick={() => send({ type: 'open' })}>
        Play a video
      </button>
    );
  const seek = (to: number) => send({ type: 'seek', to });
  return (
    <div className="brawl-testvideo" aria-label="Test video">
      <span className="brawl-testvideo-name" title={video.name}>
        {video.name}
      </span>
      <button className="btn" onClick={() => send({ type: video.playing ? 'pause' : 'play' })}>
        {video.playing ? 'Pause' : 'Play'}
      </button>
      <button className="btn" onClick={() => seek(video.time - 10)} aria-label="Back 10 seconds">
        -10 s
      </button>
      <button className="btn" onClick={() => seek(video.time + 10)} aria-label="Forward 10 seconds">
        +10 s
      </button>
      <input
        type="range"
        aria-label="Video position"
        min={0}
        max={Math.max(1, Math.floor(video.duration))}
        step={1}
        value={Math.floor(video.time)}
        onChange={(e) => seek(Number(e.target.value))}
      />
      <span className="brawl-testvideo-time">
        {formatVideoTime(video.time)} / {formatVideoTime(video.duration)}
      </span>
      <button className="btn" onClick={() => send({ type: 'open' })}>
        Other video
      </button>
      <button className="btn" onClick={() => send({ type: 'close' })}>
        Back to screenshot
      </button>
      {video.error && (
        <span className="brawl-testmode-message" role="alert">
          {video.error}
        </span>
      )}
    </div>
  );
}
