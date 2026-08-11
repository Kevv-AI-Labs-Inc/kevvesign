import { useEffect, useRef, useState } from 'react';
import { Check, PenLine, Type, X } from 'lucide-react';

export function SignaturePad({
  name,
  close,
  adopt,
}: {
  name: string;
  close: () => void;
  adopt: (value: { kind: 'typed' | 'drawn'; value: string }) => void;
}) {
  const [mode, setMode] = useState<'typed' | 'drawn'>('typed');
  const [typed, setTyped] = useState(name);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ratio = devicePixelRatio;
    element.width = element.clientWidth * ratio;
    element.height = element.clientHeight * ratio;
    const context = element.getContext('2d');
    context?.scale(ratio, ratio);
    if (context) {
      context.strokeStyle = '#123c33';
      context.lineWidth = 2.2;
      context.lineCap = 'round';
    }
  }, [mode]);
  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }
  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    drawing.current = true;
    const context = event.currentTarget.getContext('2d');
    const value = point(event);
    context?.beginPath();
    context?.moveTo(value.x, value.y);
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const context = event.currentTarget.getContext('2d');
    const value = point(event);
    context?.lineTo(value.x, value.y);
    context?.stroke();
  }
  function finish() {
    drawing.current = false;
  }
  function confirm() {
    if (mode === 'typed') {
      if (typed.trim()) adopt({ kind: 'typed', value: typed.trim() });
    } else if (canvas.current)
      adopt({ kind: 'drawn', value: canvas.current.toDataURL('image/png') });
  }
  return (
    <div className="modal-backdrop">
      <div className="modal signature-modal">
        <button className="icon-button modal-close" onClick={close}>
          <X />
        </button>
        <span className="eyebrow">Signature adoption</span>
        <h2>Create your signature</h2>
        <p>
          This mark is paired with your explicit intent, consent, finish action, and the exact
          document digest.
        </p>
        <div className="signature-tabs">
          <button className={mode === 'typed' ? 'active' : ''} onClick={() => setMode('typed')}>
            <Type /> Type
          </button>
          <button className={mode === 'drawn' ? 'active' : ''} onClick={() => setMode('drawn')}>
            <PenLine /> Draw
          </button>
        </div>
        {mode === 'typed' ? (
          <div className="typed-signature">
            <input
              aria-label="Typed signature"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
            <span>{typed || 'Your name'}</span>
          </div>
        ) : (
          <div className="draw-signature">
            <canvas
              ref={canvas}
              onPointerDown={start}
              onPointerMove={move}
              onPointerUp={finish}
              onPointerCancel={finish}
            />
            <button
              onClick={() => {
                const context = canvas.current?.getContext('2d');
                if (canvas.current)
                  context?.clearRect(0, 0, canvas.current.width, canvas.current.height);
              }}
            >
              Clear
            </button>
          </div>
        )}
        <label className="intent-check">
          <input type="checkbox" required defaultChecked />
          <span>
            I intend this electronic mark to be my signature for the records assigned to me.
          </span>
        </label>
        <div className="modal-actions">
          <button className="button secondary" onClick={close}>
            Cancel
          </button>
          <button className="button primary" onClick={confirm}>
            <Check /> Adopt signature
          </button>
        </div>
      </div>
    </div>
  );
}
