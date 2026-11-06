import { useEffect, useRef, useState } from "react";
import { useApp, type CameraMode, type LightMode } from "../store";

const LIGHT_MODES: { id: LightMode; label: string }[] = [
  { id: "daytime", label: "Gündüz" },
  { id: "golden_hour", label: "Altın saat" },
  { id: "night", label: "Gece" },
];

const CAMERA_MODES: { id: CameraMode; label: string }[] = [
  { id: "aerial", label: "Havadan" },
  { id: "orbit", label: "Yörünge" },
  { id: "walk", label: "Sokak" },
];

const HELP: Record<CameraMode, string> = {
  aerial: "Sol tuş: kaydır · Sağ tuş: döndür · Tekerlek: yakınlaş",
  orbit: "Sol tuş: döndür · Sağ tuş: kaydır · Tekerlek: yakınlaş",
  walk: "WASD: yürü · Shift: koş · Sürükle: etrafa bak",
};

function Segmented<T extends string>({ options, value, onChange, label, disabled = [] }: { options: { id: T; label: string }[]; value: T; onChange: (id: T) => void; label: string; disabled?: T[] }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} type="button" aria-pressed={value === option.id} className={value === option.id ? "active" : ""} disabled={disabled.includes(option.id)} onClick={() => onChange(option.id)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Hud() {
  const cameraMode = useApp((state) => state.cameraMode);
  const pointerLocked = useApp((state) => state.pointerLocked);
  const collision = useApp((state) => state.collision);
  const lightMode = useApp((state) => state.lightMode);
  const lightPending = useApp((state) => state.lightModePending);
  const { setCameraMode, setLightMode } = useApp.getState();
  const [open, setOpen] = useState(true);

  return (
    <>
      <aside className="panel controls" aria-label="Görünüm ayarları">
        <header>
          <h1>CityScene</h1>
          <button type="button" className="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Gizle" : "Ayarlar"}
          </button>
        </header>
        {open && (
          <>
            <p className="note">Blender şehir sahnesi</p>
            <h2>Işık</h2>
            <Segmented options={LIGHT_MODES} value={lightMode} onChange={setLightMode} label="Işık modu" />
            {/* The first switch to a mode loads its sky and prepares its shaders: a few seconds on some machines. */}
            {lightPending && (
              <p className="note" role="status">
                Işık hazırlanıyor…
              </p>
            )}
            <h2>Kamera</h2>
            {/* Walking needs the collision mesh; until it is built (or if it failed) the street button stays off. */}
            <Segmented options={CAMERA_MODES} value={cameraMode} onChange={setCameraMode} label="Kamera modu" disabled={collision === "ready" ? [] : ["walk"]} />
          </>
        )}
      </aside>
      <div className="help" aria-live="polite">
        {HELP[cameraMode]}
        {collision === "failed" && " · Sokak modu kullanılamıyor: çarpışma verisi yüklenemedi"}
        {cameraMode === "walk" && !pointerLocked && (
          <button type="button" className="ghost lock" onClick={() => document.querySelector("canvas")?.requestPointerLock()}>
            Fareyi kilitle
          </button>
        )}
        {pointerLocked && " · Çıkmak için Esc"}
      </div>
      <FpsMeter />
    </>
  );
}

/** A small live readout, also published on window.__csFps for automated checks. */
function FpsMeter() {
  const [text, setText] = useState("");
  const frames = useRef({ count: 0, last: performance.now() });
  useEffect(() => {
    let handle = 0;
    const tick = () => {
      frames.current.count++;
      const now = performance.now();
      if (now - frames.current.last >= 1000) {
        const fps = (frames.current.count * 1000) / (now - frames.current.last);
        frames.current = { count: 0, last: now };
        const info = (window as unknown as { __cs?: { calls: number; triangles: number } }).__cs;
        setText(`${fps.toFixed(0)} FPS${info ? ` · ${info.calls} çizim · ${(info.triangles / 1000).toFixed(0)}k üçgen` : ""}`);
        (window as unknown as { __csFps?: number }).__csFps = fps;
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, []);
  return <div className="fps">{text}</div>;
}
