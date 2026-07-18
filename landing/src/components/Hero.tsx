import { useEffect, useState } from 'react';
import { useTypewriter } from '../hooks/useTypewriter';

const EMAIL = 'hello@stellarviking.ai';

interface Pill {
  label: string;
  href?: string;
  action?: 'demo';
}

const PILLS: Pill[] = [
  { label: 'Launch a voice agent', href: '/test.html' },
  { label: 'Automate WhatsApp leads', action: 'demo' },
  { label: 'Book a live demo', action: 'demo' },
  { label: 'See the dashboard', href: '/admin.html' },
];

const TYPEWRITER_TEXT =
  'Glad you stopped in. Your leads hate waiting. Now, what are we automating?';

interface Props {
  onDemo: () => void;
}

export default function Hero({ onDemo }: Props) {
  const { displayed, done } = useTypewriter(TYPEWRITER_TEXT);
  const [pillsVisible, setPillsVisible] = useState(false);
  const [copied, setCopied] = useState(false);

  // Pills appear 400ms after load, independent of the typewriter
  useEffect(() => {
    const t = setTimeout(() => setPillsVisible(true), 400);
    return () => clearTimeout(t);
  }, []);

  const copyEmail = () => {
    navigator.clipboard.writeText(EMAIL).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const pillBase =
    'inline-flex items-center justify-center rounded-full text-[13px] sm:text-[15px] px-4 sm:px-5 py-[0.3em] mx-[0.2em] mb-[0.4em] whitespace-nowrap transition-colors duration-200';

  return (
    <section className="relative h-screen flex flex-col justify-end pb-12 md:justify-center md:pb-0 px-5 sm:px-8 md:px-10 overflow-hidden" style={{ zIndex: 1 }}>
      <div className="max-w-xl relative z-10">
        {/* Blurred intro label */}
        <div
          className="pointer-events-none select-none mb-5 sm:mb-6"
          style={{
            fontSize: 'clamp(18px, 4vw, 26px)',
            lineHeight: 1.3,
            fontWeight: 400,
            color: '#000',
            filter: 'blur(4px)',
          }}
        >
          Hey there, meet Zara,
          <br />
          Stellar Viking's Voice &amp; WhatsApp AI Agent
        </div>

        {/* Typewriter text */}
        <p
          className="text-black mb-5 sm:mb-6"
          style={{
            fontSize: 'clamp(18px, 4vw, 26px)',
            lineHeight: 1.35,
            fontWeight: 400,
            minHeight: '54px',
          }}
        >
          {displayed}
          {!done && (
            <span className="cursor-blink inline-block w-[2px] h-[1.1em] bg-black align-middle ml-[2px]" />
          )}
        </p>

        {/* Action pill buttons */}
        <div
          className="flex flex-wrap gap-y-1"
          style={{
            opacity: pillsVisible ? 1 : 0,
            transform: pillsVisible ? 'translateY(0)' : 'translateY(8px)',
            transition: 'opacity 0.4s ease, transform 0.4s ease',
          }}
        >
          {PILLS.map((pill) =>
            pill.href ? (
              <a
                key={pill.label}
                href={pill.href}
                className={`${pillBase} bg-white text-black border border-black/10 hover:bg-black hover:text-white`}
              >
                {pill.label}
              </a>
            ) : (
              <button
                key={pill.label}
                onClick={onDemo}
                className={`${pillBase} bg-white text-black border border-black/10 hover:bg-black hover:text-white`}
              >
                {pill.label}
              </button>
            ),
          )}

          {/* Outline email pill */}
          <button
            onClick={copyEmail}
            className={`${pillBase} gap-2 sm:gap-3 text-white bg-transparent border border-white hover:bg-white hover:text-black`}
          >
            <span>
              {copied ? 'Copied!' : (
                <>
                  Reach us:{' '}
                  <span className="underline underline-offset-1">{EMAIL}</span>
                </>
              )}
            </span>
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            >
              <rect x="3.5" y="3.5" width="7" height="7" rx="1" />
              <rect x="1" y="1" width="7" height="7" rx="1" />
            </svg>
          </button>
        </div>
      </div>
    </section>
  );
}
