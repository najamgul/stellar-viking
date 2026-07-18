import { useState } from 'react';

interface NavLink {
  label: string;
  href?: string;
  action?: 'demo';
}

const LINKS: NavLink[] = [
  { label: 'Voice', href: '/test.html' },
  { label: 'WhatsApp', action: 'demo' },
  { label: 'Dashboard', href: '/admin.html' },
  { label: 'Login', href: '/login.html' },
];

interface Props {
  onDemo: () => void;
}

export default function Navbar({ onDemo }: Props) {
  const [open, setOpen] = useState(false);

  const linkClick = (link: NavLink) => (e: React.MouseEvent) => {
    if (link.action === 'demo') {
      e.preventDefault();
      setOpen(false);
      onDemo();
    } else {
      setOpen(false);
    }
  };

  return (
    <>
      <header className="fixed top-0 left-0 w-full z-10 px-5 sm:px-8 py-4 sm:py-5 flex justify-between items-center">
        {/* Logo */}
        <div className="flex items-center gap-3">
          <span
            className="text-[21px] sm:text-[26px] tracking-tight text-black"
            style={{ fontFamily: 'var(--font-heading)' }}
          >
            Stellar Viking&reg;
          </span>
          <span
            className="text-[25px] sm:text-[30px] text-black select-none"
            style={{ letterSpacing: '-0.02em' }}
          >
            &#x2733;&#xFE0E;
          </span>
        </div>

        {/* Desktop nav links */}
        <nav className="hidden md:flex flex-row text-[23px] text-black">
          {LINKS.map((link, i) => (
            <span key={link.label}>
              <a
                href={link.href || '#'}
                onClick={linkClick(link)}
                className="hover:opacity-60 transition-opacity"
              >
                {link.label}
              </a>
              {i < LINKS.length - 1 && <span>,&nbsp;</span>}
            </span>
          ))}
        </nav>

        {/* Desktop CTA */}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onDemo();
          }}
          className="hidden md:inline text-[23px] text-black underline underline-offset-2 hover:opacity-60 transition-opacity"
        >
          Get in touch
        </a>

        {/* Mobile hamburger */}
        <button
          aria-label="Menu"
          onClick={() => setOpen((v) => !v)}
          className="md:hidden flex flex-col gap-[5px] p-1"
        >
          <span
            className="w-6 h-[2px] bg-black transition-transform duration-300"
            style={{ transform: open ? 'rotate(45deg) translateY(7px)' : 'none' }}
          />
          <span
            className="w-6 h-[2px] bg-black transition-opacity duration-300"
            style={{ opacity: open ? 0 : 1 }}
          />
          <span
            className="w-6 h-[2px] bg-black transition-transform duration-300"
            style={{ transform: open ? 'rotate(-45deg) translateY(-7px)' : 'none' }}
          />
        </button>
      </header>

      {/* Mobile overlay */}
      <div
        className="fixed inset-0 bg-white/95 backdrop-blur-sm flex flex-col justify-center items-start px-8 gap-8 md:hidden transition-opacity duration-300"
        style={{
          zIndex: 9,
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
        }}
      >
        {LINKS.map((link) => (
          <a
            key={link.label}
            href={link.href || '#'}
            className="text-[32px] font-medium text-black"
            onClick={linkClick(link)}
          >
            {link.label}
          </a>
        ))}
        <a
          href="#"
          className="text-[32px] font-medium text-black underline underline-offset-2"
          onClick={(e) => {
            e.preventDefault();
            setOpen(false);
            onDemo();
          }}
        >
          Get in touch
        </a>
      </div>
    </>
  );
}
