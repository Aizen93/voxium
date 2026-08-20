import { useState, useEffect, useCallback } from 'react';
import { computeContentRect, type ContentRect } from '../utils/annotationGeometry';

function rectsEqual(a: ContentRect, b: ContentRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * Tracks where an object-contain <video>'s CONTENT actually renders, relative
 * to its position:relative wrapper. Watches every way the rect can move:
 * element resize (layout, fullscreen, floating-panel resize), source
 * resolution change (the video 'resize' event — window switching mid-share),
 * metadata arrival, and window resize (covers DPR/zoom changes).
 *
 * Shared by AnnotationCanvas (render) and AnnotationEditorLayer (input) so
 * drawn pixels land exactly where the pointer was.
 */
export function useVideoContentRect(videoRef: React.RefObject<HTMLVideoElement | null>): ContentRect {
  const [rect, setRect] = useState<ContentRect>({ x: 0, y: 0, w: 0, h: 0 });

  const recompute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const inner = computeContentRect(video.clientWidth, video.clientHeight, video.videoWidth, video.videoHeight);
    const next = { x: video.offsetLeft + inner.x, y: video.offsetTop + inner.y, w: inner.w, h: inner.h };
    setRect((prev) => (rectsEqual(prev, next) ? prev : next));
  }, [videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(video);
    if (video.parentElement) observer.observe(video.parentElement);
    video.addEventListener('loadedmetadata', recompute);
    video.addEventListener('resize', recompute);
    window.addEventListener('resize', recompute);
    return () => {
      observer.disconnect();
      video.removeEventListener('loadedmetadata', recompute);
      video.removeEventListener('resize', recompute);
      window.removeEventListener('resize', recompute);
    };
  }, [videoRef, recompute]);

  return rect;
}
