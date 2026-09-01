import { useState } from "react";
import type { Client } from "../game/clients";
import { sfx } from "../game/audio";

interface Props {
  client: Client;
  index: number;
  total: number;
  onClose: () => void;
}

const Check = ({ className = "w-4 h-4" }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className}>
    <path d="M4 12.5l5.2 5L20 6.5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const Lock = () => (
  <svg viewBox="0 0 24 24" fill="none" className="w-3.5 h-3.5 shrink-0">
    <rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
    <path d="M8 10V7a4 4 0 018 0v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

export function ClientModal({ client, index, total, onClose }: Props) {
  const [sent, setSent] = useState(false);

  const send = () => {
    if (sent) return;
    setSent(true);
    sfx.tick();
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center p-3 md:p-6">
      <div className="absolute inset-0 bg-[rgba(5,8,16,0.62)] backdrop-blur-[3px] anim-fade" onClick={onClose} />

      <div className="relative w-full max-w-2xl max-h-full overflow-y-auto rounded-lg border border-night-600 bg-night-800 shadow-[0_30px_90px_rgba(0,0,0,0.65)] anim-pop">
        {/* браузерная строка */}
        <div className="flex items-center gap-2 px-4 py-2.5 bg-night-900 border-b border-night-700">
          <span className="w-3 h-3 rounded-full bg-[#ff6b5e]" />
          <span className="w-3 h-3 rounded-full bg-[#f2c230]" />
          <span className="w-3 h-3 rounded-full bg-[#3ddc84]" />
          <div className="flex-1 mx-3 flex items-center justify-center gap-2 bg-night-700 rounded-full px-3 py-1.5 text-xs text-slate-400 min-w-0">
            <Lock />
            <span className="truncate">{client.domain}</span>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-[#f2ecdf] transition-colors p-1"
            aria-label="Закрыть"
          >
            <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* пометка «реклама» */}
        <div className="stripes-amber flex items-center justify-between px-5 py-1.5 bg-night-900/60 border-b border-night-700">
          <span className="font-display text-[10px] tracking-[0.22em] text-amber-glow">РЕКЛАМА</span>
          <span className="text-[11px] text-slate-500">
            билборд <span className="text-slate-300 font-semibold">{index}</span> из {total} · клиент подписан
          </span>
        </div>

        {/* навигация «сайта» */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-night-700">
          <div
            className="w-10 h-10 rounded-md flex items-center justify-center font-display text-sm shadow-inner"
            style={{ background: client.color, color: client.ink }}
          >
            {client.mark}
          </div>
          <div>
            <div className="font-display text-sm text-slate-200 leading-tight">{client.name}</div>
            <div className="text-[11px] text-slate-500">{client.category} · {client.domain}</div>
          </div>
          <div className="ml-auto hidden md:flex items-center gap-5 text-sm text-slate-400">
            <span className="hover:text-amber-glow cursor-default transition-colors">Услуги</span>
            <span className="hover:text-amber-glow cursor-default transition-colors">Цены</span>
            <span className="hover:text-amber-glow cursor-default transition-colors">Контакты</span>
          </div>
        </div>

        {/* герой-блок в фирменном цвете */}
        <div className="px-6 md:px-10 py-8 md:py-10" style={{ background: client.color, color: client.ink }}>
          <span
            className="inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em]"
            style={{ borderColor: `${client.ink}66` }}
          >
            {client.category}
          </span>
          <h2 className="font-display text-3xl md:text-[42px] leading-[1.05] mt-4">{client.name}</h2>
          <p className="mt-2 text-lg md:text-xl font-medium opacity-90">{client.tagline}</p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <button
              onClick={send}
              className={`rounded-md px-6 py-3.5 font-display text-sm tracking-wide transition-all duration-200 shadow-[0_8px_24px_rgba(0,0,0,0.35)] inline-flex items-center gap-2 ${
                sent ? "cursor-default" : "hover:-translate-y-0.5 active:translate-y-0"
              }`}
              style={{ background: "rgba(9,12,22,0.88)", color: sent ? "#7fe6ac" : "#f2ecdf" }}
            >
              {sent ? (
                <>
                  <Check className="w-4 h-4" /> Заявка принята · демо
                </>
              ) : (
                "Оставить заявку"
              )}
            </button>
            <button
              onClick={send}
              className="rounded-md px-5 py-3 font-display text-sm tracking-wide border-2 transition-colors hover:opacity-80"
              style={{ borderColor: `${client.ink}88` }}
            >
              Позвонить нам
            </button>
          </div>
        </div>

        {/* предложение */}
        <div className="px-6 md:px-10 py-6">
          <div className="text-[11px] uppercase tracking-[0.22em] font-bold text-amber-glow">
            Предложение с билборда
          </div>
          <p className="mt-2.5 text-slate-300 leading-relaxed">{client.offer}</p>
          <div className="mt-4 grid sm:grid-cols-2 gap-2.5">
            <div className="flex items-center gap-2.5 text-sm text-slate-400">
              <span className="text-[#3ddc84]">
                <Check />
              </span>
              Промокод активируется автоматически
            </div>
            <div className="flex items-center gap-2.5 text-sm text-slate-400">
              <span className="text-[#3ddc84]">
                <Check />
              </span>
              Действует до конца месяца
            </div>
          </div>
        </div>

        {/* подвал */}
        <div className="px-6 py-4 border-t border-night-700 flex flex-wrap items-center justify-between gap-4">
          <p className="text-xs text-slate-500 max-w-xs leading-relaxed">
            Это заглушка лендинга: сюда подключится настоящий сайт клиента, как только билборд выйдет в продажу.
          </p>
          <button
            onClick={onClose}
            className="rounded-md bg-amber-glow text-night-950 font-display text-sm tracking-wide px-6 py-3 hover:brightness-110 hover:-translate-y-0.5 active:translate-y-0 transition-all duration-200 shadow-[0_6px_20px_rgba(255,180,84,0.35)]"
          >
            Вернуться за руль
          </button>
        </div>
      </div>
    </div>
  );
}
