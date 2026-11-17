// むぎ's portrait: her body picture with the mouth overlay on top, the box from tutor.json. The lip-sync runs in a small clock
// (game/tutorFace.ts TutorFaceClock) that reads the voice bus every 40 ms and only re-renders when what is drawn changes.
// She is faceless: the body is the whole figure, the mouth overlays are the only thing that moves.
import { useEffect, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react';
import { TutorFaceClock, mouthPlacement, overlayFile, portraitPlacement, type TutorArt, type TutorFaceInput, type TutorFrame } from '../game/tutorFace';
import { voiceLevel, voicePlaying, voiceViseme } from '../game/voiceBus';
import type { ZoomState } from '../game/tutorZoom';
import type { CustomPortrait } from '../game/customArt';
import { useFigureZoom, type FigureZoomRange } from './useFigureZoom';
import type { FigureAnchor } from '../game/tutorScene';

const TICK_MS = 40;
const VISEME_NAMES = ['a', 'e', 'i', 'o', 'u', 'm'] as const;

/** the folder a character's art is served from (public/<artDir>/, made by hand from the art source) */
export function tutorArtDir(artDir: string): string {
  return `${import.meta.env.BASE_URL}${artDir}/`;
}

/** fetch the art's pictures ahead of time, so a new mouth shape never waits for a download */
export function preloadTutorArt(art: TutorArt, dir: string) {
  const files: string[] = [];
  for (const t of art.takes) for (const v of VISEME_NAMES) files.push(overlayFile(t, v));
  for (const f of files) new Image().src = dir + f;
  if (art.figure) new Image().src = dir + art.figure.file;
}

/** whether a body picture keeps its own background (a photo) or is a cut-out with alpha. The corners decide: a cut-out's
 *  corners are transparent. Resolves false when the picture cannot be read. */
export function detectBackdrop(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = 64;
        const h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * w));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(false);
        ctx.drawImage(img, 0, 0, w, h);
        const px = ctx.getImageData(0, 0, w, h).data;
        const alphaAt = (x: number, y: number) => px[(y * w + x) * 4 + 3];
        const corners = [alphaAt(0, 0), alphaAt(w - 1, 0), alphaAt(0, h - 1), alphaAt(w - 1, h - 1)];
        resolve(corners.every((a) => a > 200));
      } catch {
        resolve(false);
      }
    };
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

/** zoom: the free zoom / pan state (自由縮放), kept by the view. custom: the player's own picture (人設圖片) in place of the
 *  hamster; null = the hamster (ui/TutorPortrait) */
/** anchor: the lectern of the classroom picture (game/tutorScene): the figure stands on it, its width and feet set by the scene
 *  (in %, of the scene box it sits in); null = the figure stands at the stage's bottom, as it always did */
export function TutorPortrait(props: { art: TutorArt | null; artDir: string; label: string;
  zoom: { state: ZoomState; set: Dispatch<SetStateAction<ZoomState>>; range?: FigureZoomRange }; custom?: CustomPortrait | null; anchor?: FigureAnchor | null;
  /** an added character with no picture yet: a silhouette stands in her place */
  placeholder?: boolean;
  /** An isolated practice portrait can supply its own playback clock. */
  faceInput?: (now: number) => TutorFaceInput }) {
  const { art, label, artDir, zoom, custom = null, anchor = null, placeholder = false } = props;
  const boxRef = useRef<HTMLDivElement>(null);
  useFigureZoom(boxRef, zoom.state, zoom.set, zoom.range);
  const dir = tutorArtDir(artDir);
  // a photo body (its own background) is framed as a card; a cut-out stands on the stage. The art decides (figure.backdrop),
  // else the picture's corners (detectBackdrop); until that is known the figure is shown as a cut-out.
  const [detected, setDetected] = useState<boolean | null>(null);
  const [frame, setFrame] = useState<TutorFrame>({ closed: false, mouth: null });

  useEffect(() => {
    const clock = new TutorFaceClock(performance.now(), { takes: art?.takes });
    const id = setInterval(() => {
      const now = performance.now();
      const next = clock.frame(now, props.faceInput?.(now) ?? {
        speaking: voicePlaying(),
        cue: voiceViseme(),
        level: voiceLevel(),
      });
      // the mouth is drawn only with overlays (the hamster) or a picture of the player's (the render decides)
      const mouth = next.mouth;
      setFrame((prev) => (prev.closed === next.closed && sameMouth(prev.mouth, mouth) ? prev : { closed: next.closed, mouth }));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [art, props.faceInput]);

  // preload the overlays, so a new mouth shape never waits for a download
  useEffect(() => { if (art) preloadTutorArt(art, dir); }, [art, dir]);
  // and the player's frames, so switching never flashes
  const customUrls = custom?.urls;
  useEffect(() => { for (const u of customUrls ?? []) new Image().src = u; }, [customUrls]);
  const figFile = art?.figure?.file ?? null;
  const flagged = art?.figure?.backdrop ?? null;
  useEffect(() => {
    if (flagged !== null || !figFile) return;
    let live = true;
    void detectBackdrop(dir + figFile).then((v) => { if (live) setDetected(v); });
    return () => { live = false; };
  }, [flagged, figFile, dir]);
  const backdrop = flagged ?? detected ?? false;

  // the player's own picture: no body, no overlays. Its picture follows the same clock: a frame per mouth shape (frames), or the
  // one picture that bobs while she speaks (single). Silent: the m frame, else the first.
  // a character the player added, with no picture yet: a standing silhouette in her place, until a picture is chosen
  if (placeholder && !custom) {
    return (
      <div ref={boxRef} className={`tutor-portrait placeholder${anchor ? ' anchored' : ''}`} role="img" aria-label={`${label}（尚未選圖片）`}
        style={anchor ? anchorBoxStyle(anchor, 2) : undefined}>
        <svg viewBox="0 0 100 200" preserveAspectRatio="xMidYMax meet" className="tutor-silhouette" aria-hidden="true">
          <circle cx="50" cy="40" r="26" fill="currentColor" />
          <path d="M22 80 Q50 66 78 80 L84 150 L70 200 L30 200 L16 150 Z" fill="currentColor" />
        </svg>
      </div>
    );
  }

  if (custom) {
    const talking = frame.mouth !== null;
    const src = custom.pictureFor(custom.mode === 'frames' ? (frame.mouth?.viseme ?? null) : null);
    // on the lectern: the box is as wide as the anchor and as tall as the picture (the anchor's point at its place); no fixed square
    const anchored = anchor !== null;
    return (
      <div
        ref={boxRef}
        className={`tutor-portrait custom${anchored ? ' anchored' : ''}${zoom.state.on ? ' zoom-on' : ''}`} role="img" aria-label={`${label}（說話中：${talking ? '是' : '否'}）`}
        style={anchored ? anchorBoxStyle(anchor) : undefined}
      >
        <div className={`tutor-zoom${zoom.state.dragging ? ' dragging' : ''}${anchored ? ' in-flow' : ''}`}
          style={{ transform: `translate(${zoom.state.view.x}px, ${zoom.state.view.y}px) scale(${zoom.state.view.scale})` }}>
          {src && (
            <img className={`tutor-custom${custom.mode === 'single' && talking ? ' talking' : ''}${anchored ? ' in-flow' : ''}`} src={src} alt=""
              draggable={false} decoding="async" />
          )}
        </div>
      </div>
    );
  }

  const fig = art?.figure ?? null;
  const mouth = art ? mouthPlacement(art) : null;
  // the figure's frame (body px) sets the aspect; the portrait layer sits in it at the placement from tutor.json.
  const place = art ? portraitPlacement(art) : { left: 0, top: 0, width: 100, height: 100 };
  return (
    <div
      ref={boxRef}
      className={`tutor-portrait${fig ? ' figured' : ''}${backdrop ? ' backdrop' : ''}${anchor ? ' anchored' : ''}${zoom.state.on ? ' zoom-on' : ''}`} role="img" aria-label={`${label}（說話中：${art && frame.mouth ? '是' : '否'}）`}
      style={fig ? ({ aspectRatio: `${fig.w} / ${fig.h}`, '--hw': fig.h / fig.w, ...(anchor ? anchorBoxStyle(anchor, fig.h / fig.w) : {}) } as CSSProperties) : undefined}
    >
      {/* the body and the mouth share one wrapper: the free zoom / pan (自由縮放) moves them together */}
      <div className={`tutor-zoom${zoom.state.dragging ? ' dragging' : ''}`}
        style={{ transform: `translate(${zoom.state.view.x}px, ${zoom.state.view.y}px) scale(${zoom.state.view.scale})` }}>
        {fig && <img className="tutor-body" src={dir + fig.file} alt="" draggable={false} decoding="async" />}
        <div className="tutor-face-layer" style={{ left: `${place.left}%`, top: `${place.top}%`, width: `${place.width}%`, height: `${place.height}%` }}>
          {art && frame.mouth && mouth && (
            <img
              className="tutor-mouth" alt="" draggable={false} decoding="async"
              src={dir + overlayFile(frame.mouth.take, frame.mouth.viseme)}
              style={{ left: `${mouth.left}%`, top: `${mouth.top}%`, width: `${mouth.width}%`, height: `${mouth.height}%` }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** the figure's box on the lectern, in % of the layer it sits in (the default scene box): its width, its centre x, and the point
 *  pictureAnchor down the picture at anchorY. The same numbers as tutorScene's figureAnchorBox, which the tests check in px. */
function anchorBoxStyle(anchor: FigureAnchor, figAspect?: number): CSSProperties {
  return {
    left: `${anchor.centerX * 100}%`,
    top: `${anchor.anchorY * 100}%`,
    transform: `translate(-50%, -${anchor.pictureAnchor * 100}%)`,
    width: `${anchor.width * 100}%`,
    height: 'auto',
    aspectRatio: figAspect ? `1 / ${figAspect}` : 'auto',
  };
}

function sameMouth(a: TutorFrame['mouth'], b: TutorFrame['mouth']): boolean {
  if (!a || !b) return a === b;
  return a.take === b.take && a.viseme === b.viseme;
}
