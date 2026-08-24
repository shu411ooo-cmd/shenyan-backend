import { useEffect, useRef, useState } from 'react';

const PORTRAIT_CHANGED_EVENT = 'ringdonut-call-portrait-changed';
const STORAGE_KEY = 'ringdonut-call-portrait';

function readStoredPortrait() {
  try { return localStorage.getItem(STORAGE_KEY) || ''; }
  catch { return ''; }
}

function cropPortrait(file) {
  return new Promise((resolve, reject) => {
    const sourceUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const size = Math.min(image.naturalWidth, image.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 640;
      const context = canvas.getContext('2d');
      if (!context) {
        URL.revokeObjectURL(sourceUrl);
        reject(new Error('Could not process this image'));
        return;
      }
      context.drawImage(
        image,
        (image.naturalWidth - size) / 2,
        (image.naturalHeight - size) / 2,
        size,
        size,
        0,
        0,
        640,
        640,
      );
      URL.revokeObjectURL(sourceUrl);
      resolve(canvas.toDataURL('image/jpeg', 0.88));
    };
    image.onerror = () => {
      URL.revokeObjectURL(sourceUrl);
      reject(new Error('Could not read this image'));
    };
    image.src = sourceUrl;
  });
}

export default function CallPortrait({ speaking = false }) {
  const inputRef = useRef(null);
  const [customPortrait, setCustomPortrait] = useState(readStoredPortrait);

  useEffect(() => {
    const syncPortrait = (event) => setCustomPortrait(event.detail?.portrait || '');
    window.addEventListener(PORTRAIT_CHANGED_EVENT, syncPortrait);
    return () => window.removeEventListener(PORTRAIT_CHANGED_EVENT, syncPortrait);
  }, []);

  const choosePortrait = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const portrait = await cropPortrait(file);
      localStorage.setItem(STORAGE_KEY, portrait);
      setCustomPortrait(portrait);
      window.dispatchEvent(new CustomEvent(PORTRAIT_CHANGED_EVENT, { detail: { portrait } }));
    } catch (error) {
      console.warn('Could not update call portrait:', error);
    }
  };

  const portraitStyle = customPortrait ? { '--call-portrait': `url("${customPortrait}")` } : undefined;
  return (
    <div className={`call-portrait${speaking ? ' is-speaking' : ''} is-editable`} style={portraitStyle}>
      <div className="call-portrait-slot" />
      <span className="call-presence-dot" />
      <button type="button" className="call-portrait-edit" onClick={() => inputRef.current?.click()} aria-label="Change companion portrait">
        <span className="call-portrait-edit-badge" aria-hidden="true">✎</span>
      </button>
      <input ref={inputRef} className="call-portrait-file" type="file" accept="image/*" onChange={choosePortrait} tabIndex="-1" aria-hidden="true" />
    </div>
  );
}
