import { useEffect, useRef, useState } from 'react';
import Navbar from './components/Navbar';
import Hero from './components/Hero';
import LeadModal from './components/LeadModal';

const VIDEO_SRC =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260530_042513_df96a13b-6155-4f6e-8b93-c9dee66fba08.mp4';

const SENSITIVITY = 0.8;

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [demoOpen, setDemoOpen] = useState(false);

  // Mouse-scrub: horizontal movement seeks the video forward/backward.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let prevX: number | null = null;
    let targetTime = 0;
    let seeking = false;

    const seekTo = (t: number) => {
      seeking = true;
      video.currentTime = t;
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!video.duration || isNaN(video.duration)) return;
      if (prevX === null) {
        prevX = e.clientX;
        return;
      }
      const delta = e.clientX - prevX;
      prevX = e.clientX;

      const offset = (delta / window.innerWidth) * SENSITIVITY * video.duration;
      targetTime = Math.min(video.duration, Math.max(0, targetTime + offset));

      // Only start a seek if one isn't in flight; onSeeked queues the rest
      if (!seeking) seekTo(targetTime);
    };

    const onSeeked = () => {
      // If the target moved while we were seeking, chase it; else settle.
      if (Math.abs(video.currentTime - targetTime) > 0.01) {
        seekTo(targetTime);
      } else {
        seeking = false;
      }
    };

    const onLoadedMetadata = () => {
      targetTime = video.currentTime;
    };

    window.addEventListener('mousemove', onMouseMove);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('loadedmetadata', onLoadedMetadata);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
    };
  }, []);

  return (
    <>
      <video
        ref={videoRef}
        src={VIDEO_SRC}
        muted
        playsInline
        preload="auto"
        className="fixed inset-0 w-full h-full"
        style={{ zIndex: 0, objectFit: 'cover', objectPosition: '70% center' }}
      />
      <Navbar onDemo={() => setDemoOpen(true)} />
      <Hero onDemo={() => setDemoOpen(true)} />
      <LeadModal open={demoOpen} onClose={() => setDemoOpen(false)} />
    </>
  );
}
