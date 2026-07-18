import { useEffect, useState } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
}

type Status = 'idle' | 'sending' | 'done' | 'error';

export default function LeadModal({ open, onClose }: Props) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [whatsappLink, setWhatsappLink] = useState<string | null>(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Reset when reopened
  useEffect(() => {
    if (open) {
      setStatus('idle');
      setError('');
      setWhatsappLink(null);
    }
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (status === 'sending') return;
    if (!name.trim() || !phone.trim()) {
      setError('Name and WhatsApp number are required.');
      return;
    }
    setStatus('sending');
    setError('');
    try {
      const res = await fetch('/api/leads/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.trim(),
          message: message.trim() || undefined,
          metadata: { source: 'landing-hero' },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Something went wrong');
      setWhatsappLink(data.whatsappLink || null);
      setStatus('done');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Something went wrong');
    }
  };

  const inputCls =
    'w-full rounded-full border border-black/15 bg-white px-5 py-2.5 text-[15px] text-black outline-none focus:border-black/50 transition-colors';

  return (
    <div
      className="fixed inset-0 flex items-center justify-center px-5 transition-opacity duration-300"
      style={{
        zIndex: 20,
        background: 'rgba(0,0,0,0.35)',
        backdropFilter: 'blur(4px)',
        opacity: open ? 1 : 0,
        pointerEvents: open ? 'auto' : 'none',
      }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-white rounded-3xl border border-black/10 p-7 sm:p-9"
        onClick={(e) => e.stopPropagation()}
      >
        {status === 'done' ? (
          <div className="text-center">
            <p className="text-[22px] text-black mb-2">Got it, {name.trim().split(' ')[0]}.</p>
            {whatsappLink ? (
              <>
                <p className="text-[15px] text-black/60 mb-6">
                  Tap below and send the pre-filled message — Zara will pick it up instantly.
                </p>
                <a
                  href={whatsappLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center rounded-full bg-black text-white text-[15px] px-6 py-2.5 hover:opacity-80 transition-opacity"
                >
                  Continue on WhatsApp
                </a>
              </>
            ) : (
              <p className="text-[15px] text-black/60">
                We've got your details — the team will reach out shortly.
              </p>
            )}
            <button
              onClick={onClose}
              className="block mx-auto mt-5 text-[13px] text-black/50 underline underline-offset-2 hover:text-black transition-colors"
            >
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <p className="text-[22px] text-black mb-1">Book a live demo</p>
            <p className="text-[14px] text-black/55 mb-6">
              Leave your WhatsApp number — our own AI agent will show you what it does. That's the demo.
            </p>
            <div className="flex flex-col gap-3">
              <input
                className={inputCls}
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
              <input
                className={inputCls}
                placeholder="WhatsApp number (e.g. +92 300 1234567)"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                inputMode="tel"
              />
              <textarea
                className="w-full rounded-2xl border border-black/15 bg-white px-5 py-2.5 text-[15px] text-black outline-none focus:border-black/50 transition-colors resize-none"
                placeholder="What are we automating? (optional)"
                rows={2}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>
            {error && <p className="text-[13px] text-red-600 mt-3">{error}</p>}
            <button
              type="submit"
              disabled={status === 'sending'}
              className="w-full mt-5 rounded-full bg-black text-white text-[15px] py-2.5 hover:opacity-80 transition-opacity disabled:opacity-40"
            >
              {status === 'sending' ? 'Sending…' : 'Get my demo'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
