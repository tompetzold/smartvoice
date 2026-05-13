import type {RefObject} from "react";

type SentenceSegment = {
  id: string;
  text: string;
  pageNumber: number;
  pageNumbers: number[];
  wordIds: string[];
  lineBoxes: number[][];
  type: string;
  readMode: string;
  pauseAfterMs: number;
};

type PlayerBarProps = {
  audioRef: RefObject<HTMLAudioElement | null>;
  activeSegment: SentenceSegment | null;
  activeSegmentIndex: number;
  segmentCount: number;
  isPlaying: boolean;
  isLoadingAudio: boolean;
  onPlayPause: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSeekSegment: (index: number) => void;
  onAudioEnded: () => void;
};

function formatSegmentLabel(activeSegmentIndex: number, segmentCount: number): string {
  if (segmentCount <= 0) {
    return "Kein Segment";
  }

  return `Segment ${activeSegmentIndex + 1} / ${segmentCount}`;
}

export default function PlayerBar({
  audioRef,
  activeSegment,
  activeSegmentIndex,
  segmentCount,
  isPlaying,
  isLoadingAudio,
  onPlayPause,
  onPrevious,
  onNext,
  onSeekSegment,
  onAudioEnded,
}: PlayerBarProps) {
  return (
    <section className="player-shell">
      <audio ref={audioRef} onEnded={onAudioEnded} />

      <div className="player-main">
        <button
          className="player-button secondary"
          type="button"
          onClick={onPrevious}
          disabled={segmentCount === 0 || activeSegmentIndex <= 0 || isLoadingAudio}
        >
          Zurück
        </button>

        <button
          className="player-button primary"
          type="button"
          onClick={onPlayPause}
          disabled={segmentCount === 0 || isLoadingAudio}
        >
          {isLoadingAudio ? "Lädt..." : isPlaying ? "Pause" : "Play"}
        </button>

        <button
          className="player-button secondary"
          type="button"
          onClick={onNext}
          disabled={segmentCount === 0 || activeSegmentIndex >= segmentCount - 1 || isLoadingAudio}
        >
          Weiter
        </button>
      </div>

      <div className="player-meta">
        <strong>{formatSegmentLabel(activeSegmentIndex, segmentCount)}</strong>
        <span>{activeSegment?.text ?? "Keine TTS-Segmente geladen."}</span>
      </div>

      <input
        className="player-seeker"
        type="range"
        min="0"
        max={Math.max(0, segmentCount - 1)}
        value={segmentCount > 0 ? activeSegmentIndex : 0}
        onChange={(event) => onSeekSegment(Number(event.target.value))}
        disabled={segmentCount === 0 || isLoadingAudio}
      />
    </section>
  );
}