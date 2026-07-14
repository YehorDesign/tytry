"use client";

// Карточка-группа правой панели: цветная полоска слева, иконка, заголовок,
// сворачивание кликом по шапке. Чисто визуальная обёртка — открытость
// запоминается в localStorage и ни на что больше не влияет.
import React, { useEffect, useState } from "react";

export const PanelCard: React.FC<{
  /** ключ для localStorage (tytry-card-<id>) */
  id: string;
  icon: string;
  title: string;
  /** цвет полоски-акцента слева */
  tone?: "captions" | "montage" | "iter" | "overlay" | "music";
  /** короткий текст справа в шапке (счётчик, имя трека…) */
  badge?: string | null;
  children: React.ReactNode;
}> = ({ id, icon, title, tone, badge, children }) => {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(`tytry-card-${id}`);
      if (saved !== null) setOpen(saved === "1");
    } catch {
      // приватный режим и т.п. — просто не запоминаем
    }
  }, [id]);

  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(`tytry-card-${id}`, o ? "0" : "1");
      } catch {
        // ignore
      }
      return !o;
    });
  };

  return (
    <section className={`panel-card ${tone ? `pc-${tone}` : ""} ${open ? "open" : ""}`}>
      <button className="panel-card-head" type="button" onClick={toggle}>
        <span className="panel-card-icon">{icon}</span>
        <span className="panel-card-title">{title}</span>
        {badge ? <span className="panel-card-badge">{badge}</span> : null}
        <span className={`panel-card-chevron ${open ? "open" : ""}`}>▾</span>
      </button>
      {open && <div className="panel-card-body">{children}</div>}
    </section>
  );
};
