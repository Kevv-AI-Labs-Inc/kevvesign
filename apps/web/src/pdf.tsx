import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { FieldType, FieldValue, TemplateField } from '@esign/contracts';
import { Check, PenLine } from 'lucide-react';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface PdfCanvasProps {
  url: string;
  fields: TemplateField[];
  selectedId: string | undefined;
  editable: boolean;
  onSelect: (id: string) => void;
  onChange: (id: string, update: Partial<TemplateField>) => void;
  onAddField: (type: FieldType, page: number, x: number, y: number) => void;
}

export function PdfCanvas({
  url,
  fields,
  selectedId,
  editable,
  onSelect,
  onChange,
  onAddField,
}: PdfCanvasProps) {
  const [pages, setPages] = useState<
    Array<{ page: pdfjs.PDFPageProxy; width: number; height: number }>
  >([]);
  useEffect(() => {
    let active = true;
    const task = pdfjs.getDocument({ url, withCredentials: true });
    void task.promise
      .then(async (document) => {
        const loaded = await Promise.all(
          Array.from({ length: document.numPages }, async (_, index) => {
            const page = await document.getPage(index + 1);
            const viewport = page.getViewport({ scale: 1.2 });
            return { page, width: viewport.width, height: viewport.height };
          }),
        );
        if (active) setPages(loaded);
      })
      .catch((error: unknown) => {
        if (active) console.error('Unable to load PDF preview.', error);
      });
    return () => {
      active = false;
      void task.destroy();
    };
  }, [url]);
  return (
    <div className="pdf-stack">
      {pages.map((item, index) => (
        <EditorPage
          key={index}
          page={item.page}
          width={item.width}
          height={item.height}
          pageNumber={index + 1}
          fields={fields.filter((field) => field.page === index + 1)}
          selectedId={selectedId}
          editable={editable}
          onSelect={onSelect}
          onChange={onChange}
          onAddField={onAddField}
        />
      ))}
    </div>
  );
}

function EditorPage({
  page,
  width,
  height,
  pageNumber,
  fields,
  selectedId,
  editable,
  onSelect,
  onChange,
  onAddField,
}: {
  page: pdfjs.PDFPageProxy;
  width: number;
  height: number;
  pageNumber: number;
  fields: TemplateField[];
  selectedId: string | undefined;
  editable: boolean;
  onSelect: (id: string) => void;
  onChange: (id: string, update: Partial<TemplateField>) => void;
  onAddField: (type: FieldType, page: number, x: number, y: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const viewport = page.getViewport({ scale: 1.2 });
    const context = canvas.current.getContext('2d');
    if (!context) return;
    canvas.current.width = viewport.width * devicePixelRatio;
    canvas.current.height = viewport.height * devicePixelRatio;
    canvas.current.style.width = `${viewport.width}px`;
    canvas.current.style.height = `${viewport.height}px`;
    const transform: [number, number, number, number, number, number] = [
      devicePixelRatio,
      0,
      0,
      devicePixelRatio,
      0,
      0,
    ];
    const render = page.render({
      canvasContext: context,
      viewport,
      transform,
      canvas: canvas.current,
    });
    void render.promise.catch((error: unknown) => {
      if ((error as { name?: string }).name !== 'RenderingCancelledException') {
        console.error('Unable to render PDF preview.', error);
      }
    });
    return () => render.cancel();
  }, [page]);
  function dragStart(event: React.PointerEvent, field: TemplateField) {
    if (!editable) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = field.rect;
    const move = (moveEvent: PointerEvent) => {
      onChange(field.id, {
        rect: {
          ...origin,
          x: Math.max(
            0,
            Math.min(1 - origin.width, origin.x + (moveEvent.clientX - startX) / width),
          ),
          y: Math.max(
            0,
            Math.min(1 - origin.height, origin.y + (moveEvent.clientY - startY) / height),
          ),
        },
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  function resizeStart(event: React.PointerEvent, field: TemplateField) {
    if (!editable) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = field.rect;
    const move = (moveEvent: PointerEvent) => {
      onChange(field.id, {
        rect: {
          ...origin,
          width: Math.max(
            0.04,
            Math.min(1 - origin.x, origin.width + (moveEvent.clientX - startX) / width),
          ),
          height: Math.max(
            0.025,
            Math.min(1 - origin.y, origin.height + (moveEvent.clientY - startY) / height),
          ),
        },
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  function dropField(event: React.DragEvent<HTMLDivElement>) {
    if (!editable) return;
    event.preventDefault();
    const type = event.dataTransfer.getData('application/x-esign-field') as FieldType;
    if (!type) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const fieldWidth = type === 'signature' ? 0.28 : 0.2;
    const fieldHeight = 0.045;
    const x = Math.max(0, Math.min(1 - fieldWidth, (event.clientX - bounds.left) / bounds.width));
    const y = Math.max(0, Math.min(1 - fieldHeight, (event.clientY - bounds.top) / bounds.height));
    onAddField(type, pageNumber, x, y);
  }
  return (
    <div
      className="pdf-page"
      style={{ width, height }}
      onDragOver={(event) => {
        if (editable) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={dropField}
    >
      <canvas ref={canvas} />
      <span className="page-number">Page {pageNumber}</span>
      {fields.map((field) => (
        <button
          type="button"
          key={field.id}
          onPointerDown={(event) => dragStart(event, field)}
          onClick={() => onSelect(field.id)}
          className={`placed-field ${field.id === selectedId ? 'selected' : ''} type-${field.type}`}
          style={{
            left: `${field.rect.x * 100}%`,
            top: `${field.rect.y * 100}%`,
            width: `${field.rect.width * 100}%`,
            height: `${field.rect.height * 100}%`,
          }}
        >
          <span>
            {field.type === 'signature' ? (
              <PenLine />
            ) : field.type === 'checkbox' ? (
              <Check />
            ) : null}
            {field.label}
          </span>
          {editable && (
            <span
              className="resize-handle"
              aria-hidden="true"
              onPointerDown={(event) => resizeStart(event, field)}
            />
          )}
        </button>
      ))}
    </div>
  );
}

interface SigningDocumentProps {
  url: string;
  fields: TemplateField[];
  values: Record<string, FieldValue>;
  signature: string | undefined;
  onValue: (id: string, value: FieldValue) => void;
  onSignature: () => void;
}

export function SigningDocument({
  url,
  fields,
  values,
  signature,
  onValue,
  onSignature,
}: SigningDocumentProps) {
  const [pages, setPages] = useState<
    Array<{ page: pdfjs.PDFPageProxy; width: number; height: number }>
  >([]);
  useEffect(() => {
    let active = true;
    const task = pdfjs.getDocument({ url, withCredentials: true });
    void task.promise
      .then(async (document) => {
        const loaded = await Promise.all(
          Array.from({ length: document.numPages }, async (_, index) => {
            const page = await document.getPage(index + 1);
            const viewport = page.getViewport({
              scale: Math.min(
                1.25,
                (window.innerWidth - 32) / page.getViewport({ scale: 1 }).width,
              ),
            });
            return { page, width: viewport.width, height: viewport.height };
          }),
        );
        if (active) setPages(loaded);
      })
      .catch((error: unknown) => {
        if (active) console.error('Unable to load signing PDF.', error);
      });
    return () => {
      active = false;
      void task.destroy();
    };
  }, [url]);
  return (
    <div className="pdf-stack signing-pdf">
      {pages.map((item, index) => (
        <SigningPageCanvas
          key={index}
          {...item}
          pageNumber={index + 1}
          fields={fields.filter((field) => field.page === index + 1)}
          values={values}
          signature={signature}
          onValue={onValue}
          onSignature={onSignature}
        />
      ))}
    </div>
  );
}

function SigningPageCanvas({
  page,
  width,
  height,
  pageNumber,
  fields,
  values,
  signature,
  onValue,
  onSignature,
}: {
  page: pdfjs.PDFPageProxy;
  width: number;
  height: number;
  pageNumber: number;
  fields: TemplateField[];
  values: Record<string, FieldValue>;
  signature: string | undefined;
  onValue: (id: string, value: FieldValue) => void;
  onSignature: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const base = page.getViewport({ scale: 1 });
    const scale = width / base.width;
    const viewport = page.getViewport({ scale });
    const context = canvas.current.getContext('2d');
    if (!context) return;
    canvas.current.width = viewport.width * devicePixelRatio;
    canvas.current.height = viewport.height * devicePixelRatio;
    canvas.current.style.width = `${viewport.width}px`;
    canvas.current.style.height = `${viewport.height}px`;
    const render = page.render({
      canvasContext: context,
      viewport,
      transform: [devicePixelRatio, 0, 0, devicePixelRatio, 0, 0],
      canvas: canvas.current,
    });
    void render.promise.catch((error: unknown) => {
      if ((error as { name?: string }).name !== 'RenderingCancelledException') {
        console.error('Unable to render signing PDF.', error);
      }
    });
    return () => render.cancel();
  }, [page, width]);
  return (
    <div className="pdf-page signing-page" style={{ width, height }}>
      <canvas ref={canvas} />
      <span className="page-number">Page {pageNumber}</span>
      {fields.map((field) => (
        <div
          key={field.id}
          className={`sign-field type-${field.type} ${field.required ? 'required' : ''}`}
          style={{
            left: `${field.rect.x * 100}%`,
            top: `${field.rect.y * 100}%`,
            width: `${field.rect.width * 100}%`,
            minHeight: `${field.rect.height * 100}%`,
          }}
        >
          {field.type === 'signature' || field.type === 'initials' ? (
            <button onClick={onSignature}>
              {signature ? (
                <span className="signature-value">
                  {signature.startsWith('data:') ? 'Signed ✓' : signature}
                </span>
              ) : (
                <>
                  <PenLine /> {field.label}
                </>
              )}
            </button>
          ) : field.type === 'checkbox' ? (
            <label className="sign-checkbox">
              <input
                type="checkbox"
                checked={values[field.id] === true}
                onChange={(event) => onValue(field.id, event.target.checked)}
              />
              <span>{field.label}</span>
            </label>
          ) : field.readOnly ? (
            <span className="merge-value">{String(values[field.id] ?? '')}</span>
          ) : (
            <input
              aria-label={field.label}
              placeholder={field.label}
              value={String(values[field.id] ?? '')}
              onChange={(event) => onValue(field.id, event.target.value)}
            />
          )}
        </div>
      ))}
    </div>
  );
}
